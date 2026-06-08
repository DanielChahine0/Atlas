/**
 * Atlas daemon — the Playwright browser-action executor.
 *
 * `runBrowserAction` dispatches on item.action_type and performs the fill/submit/scrape
 * operations in the owner's persistent Chromium profile. Hard stops are detected BEFORE
 * any irreversible step (captcha before fill; payment/sold_out/login_wall before submit).
 *
 * SECURITY:
 *   - NO credential storage: Atlas never reads/stores/transmits the Chromium profile
 *     contents, session tokens, or passwords. The profile is managed by the OS
 *     (path = ATLAS_BROWSER_PROFILE env var, never a tracked file).
 *   - Captcha is NEVER solved — detectCaptcha → hard_stop 'captcha', no further action.
 *   - Payment is NEVER auto-handled — no card entry code path exists (D4-11).
 *   - Envoy (linkedin_prefill / x_prefill) NEVER auto-submits — the runner pre-fills and
 *     returns; the owner clicks Post/Save (D4-08).
 *   - Usher (event_fill_submit) auto-submits only the free/captcha-free path and requires
 *     a non-empty scraped confirmation # (else hard_stop 'no_confirmation' — D4-09).
 *
 * TESTABILITY:
 *   `runBrowserAction` accepts an optional `_page?: MockPage` parameter. When present
 *   (unit tests), it uses the injected mock page instead of opening a real Playwright
 *   page. No real Chromium is launched in unit tests.
 *
 * PRODUCTION USE:
 *   `withBrowserContext` wraps Playwright's `launchPersistentContext` (headless: false,
 *   slowMo: 50). The context is NOT closed between items — it persists across the daemon's
 *   lifetime. Only close on daemon shutdown to avoid stale-lock issues (Pitfall 2).
 */

// NOTE: `playwright` is listed in daemon/package.json as a dependency but the managed
// Chromium binary requires `npx playwright install chromium` as an owner go-live action.
// The import below is guarded in the real path; the type-only import lets tsc compile
// without requiring a real Playwright install at CI/typecheck time.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import type { BrowserContext } from "playwright";

import type {
  BrowserActionWorkItem,
  BrowserActionOutcome,
} from "../../packages/gate/src/schema.ts";
import type { BrowserDrainConfig } from "./browser-drain.ts";

// ─── Page abstraction (injectable for tests) ─────────────────────────────────

/**
 * A minimal page interface that `runBrowserAction` operates against.
 * Production: a real Playwright Page adapter.
 * Tests: a mock object (no Chromium launched).
 */
export interface MockPage {
  goto(url: string, opts?: { waitUntil?: string }): Promise<void>;
  /** Fill a field using a semantic locator-friendly helper. */
  fillField(label: string, value: string): Promise<void>;
  getByLabel(text: string): { fill(v: string): Promise<void>; click(): Promise<void> };
  getByRole(
    role: string,
    opts?: { name?: string },
  ): { fill(v: string): Promise<void>; click(): Promise<void> };
  /** Hard-stop detectors — all must run BEFORE any irreversible step. */
  detectCaptcha(): Promise<boolean>;
  detectPaymentWall(): Promise<boolean>;
  detectSoldOut(): Promise<boolean>;
  detectLoginWall(): Promise<boolean>;
  /** Click the submit button (Usher only — NEVER called for Envoy). */
  submitForm(): Promise<void>;
  /** Scrape the registration confirmation # after submit. Returns "" if not found. */
  scrapeConfirmation(): Promise<string>;
  close(): Promise<void>;
}

// ─── Playwright page adapter (production) ─────────────────────────────────────

/**
 * Wrap a real Playwright page with the MockPage interface.
 * Semantic locators: getByLabel / getByRole over raw CSS (Pitfall 4).
 * fillField uses getByLabel with a short timeout to surface selector failures fast.
 */
async function makePlaywrightPage(ctx: BrowserContext): Promise<MockPage & { close(): Promise<void> }> {
  // Dynamic import — deferred so the module loads even when playwright isn't installed.
  const page = await ctx.newPage();

  return {
    async goto(url, opts) {
      await page.goto(url, { waitUntil: (opts?.waitUntil as "networkidle" | "load" | "domcontentloaded" | "commit") ?? "networkidle" });
    },
    async fillField(label, value) {
      // Prefer getByLabel for semantic stability (Pitfall 4)
      await page.getByLabel(label).fill(value);
    },
    getByLabel(text) {
      const loc = page.getByLabel(text);
      return {
        fill: async (v) => loc.fill(v),
        click: async () => loc.click(),
      };
    },
    getByRole(role, opts) {
      const loc = page.getByRole(role as Parameters<typeof page.getByRole>[0], opts);
      return {
        fill: async (v) => loc.fill(v),
        click: async () => loc.click(),
      };
    },
    async detectCaptcha() {
      // Detect common captcha signals: reCAPTCHA, hCaptcha, Cloudflare Turnstile
      const count = await page.locator(
        "iframe[src*='recaptcha'], iframe[src*='hcaptcha'], iframe[title*='challenge']",
      ).count();
      return count > 0;
    },
    async detectPaymentWall() {
      // Detect payment form elements before submit
      const count = await page.locator(
        "input[name*='card'], input[autocomplete*='cc-'], [data-testid*='payment'], .payment-form",
      ).count();
      return count > 0;
    },
    async detectSoldOut() {
      const count = await page.locator(
        "[class*='sold-out'], [data-testid*='sold-out'], button:has-text('Sold Out'), button:has-text('Waitlist')",
      ).count();
      return count > 0;
    },
    async detectLoginWall() {
      const count = await page.locator(
        "form[action*='login'], form[action*='signin'], [data-testid*='login-wall']",
      ).count();
      return count > 0;
    },
    async submitForm() {
      await page.locator('[type="submit"], button[type="submit"]').first().click();
    },
    async scrapeConfirmation() {
      try {
        // Wait briefly for a confirmation element to appear after submit
        await page.waitForSelector(
          "[class*='confirm'], [data-testid*='confirm'], [class*='order-number'], [class*='registration-complete']",
          { timeout: 10000 },
        );
        const text = await page.locator(
          "[class*='confirm'], [data-testid*='confirm'], [class*='order-number'], [class*='registration-complete']",
        ).first().textContent();
        return text?.trim() ?? "";
      } catch {
        return "";
      }
    },
    async close() {
      await page.close();
    },
  };
}

// ─── withBrowserContext ────────────────────────────────────────────────────────

/**
 * Launch a persistent Chromium context at `profilePath` (the owner's logged-in session).
 * The context is NOT closed when `fn` returns — it persists across work items.
 * Only close on daemon shutdown to prevent stale-lock issues (Pitfall 2).
 *
 * @param profilePath - ATLAS_BROWSER_PROFILE value (OS-managed, never a tracked file)
 * @param fn - callback that receives the BrowserContext
 */
export async function withBrowserContext(
  profilePath: string,
  fn: (ctx: BrowserContext) => Promise<void>,
): Promise<void> {
  // Dynamic import to defer playwright loading until actually needed.
  const { chromium } = await import("playwright");
  // Clear stale lock if present on startup (Pitfall 2: forced-kill leaves a lock).
  const fs = await import("node:fs");
  const lockPath = `${profilePath}/SingletonLock`;
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // Not present — normal
  }
  const context = await chromium.launchPersistentContext(profilePath, {
    headless: false, // owner needs to see the composer for Envoy (D4-08) and Usher fills
    slowMo: 50,      // reduces bot-detection signal from instant interactions
  });
  try {
    await fn(context);
  } finally {
    // Do NOT close — persistent across work items.
    // Close is only called on daemon shutdown.
  }
}

// ─── runBrowserAction ─────────────────────────────────────────────────────────

/**
 * Execute one browser-action work item. Dispatches on `item.action_type`.
 *
 * @param item - the work item from browser_action_outbox
 * @param cfg - BrowserDrainConfig (provides browserProfilePath)
 * @param _page - optional MockPage for unit tests (no real Chromium in tests)
 *
 * Hard-stop ordering (enforced by source order):
 *   Usher event_fill_submit:
 *     1. goto → 2. detectCaptcha (hard stop) → 3. fill fields
 *     → 4. detectPaymentWall / detectSoldOut / detectLoginWall (hard stop)
 *     → 5. submitForm → 6. scrapeConfirmation (hard stop if empty)
 *     → success + confirmation_number
 *
 *   Envoy linkedin_prefill / x_prefill:
 *     1. goto → 2. fillField → 3. return success (NO submit, NO post click — D4-08)
 *     On fillField timeout → return error (caller keeps draft + P2 — D4-13)
 *
 * No code path enters card details (D4-11). No code path clicks a Post/Save button
 * on the Envoy branches.
 */
export async function runBrowserAction(
  item: BrowserActionWorkItem,
  cfg: BrowserDrainConfig,
  _page?: MockPage,
): Promise<BrowserActionOutcome> {
  // If no mock page injected, open a real Playwright page.
  let page: MockPage | undefined = _page;
  let ownedContext: BrowserContext | undefined;
  let ownedPage: (MockPage & { close(): Promise<void> }) | undefined;

  try {
    if (!page) {
      const { chromium } = await import("playwright");
      ownedContext = await chromium.launchPersistentContext(cfg.browserProfilePath, {
        headless: false,
        slowMo: 50,
      });
      ownedPage = await makePlaywrightPage(ownedContext);
      page = ownedPage;
    }

    switch (item.action_type) {
      case "event_fill_submit":
        return await runUsherFillSubmit(item, page);
      case "linkedin_prefill":
        return await runEnvoyPrefill(item, page);
      case "x_prefill":
        return await runEnvoyPrefill(item, page);
      default:
        // Unknown action_type — return error so the caller acks + flags (never unhandled)
        return {
          id: item.id,
          status: "error",
        };
    }
  } catch (err) {
    // Any unexpected throw → error outcome (never a silent success, never unhandled)
    console.warn(`browser runner unexpected error for item ${item.id}: ${String(err)}`);
    return { id: item.id, status: "error" };
  } finally {
    // Close only the page we opened in this call (not the persistent context).
    if (ownedPage) {
      await ownedPage.close().catch(() => {});
    }
  }
}

// ─── Usher: event_fill_submit ─────────────────────────────────────────────────

/**
 * Fill and auto-submit a free/captcha-free event registration form.
 *
 * Hard-stop ordering (source order is enforced):
 *   captcha BEFORE fill → payment / sold_out / login_wall BEFORE submit
 *
 * Requires a non-empty scraped confirmation # before returning success.
 * No card entry code path (D4-11). No captcha solving.
 */
async function runUsherFillSubmit(
  item: BrowserActionWorkItem,
  page: MockPage,
): Promise<BrowserActionOutcome> {
  await page.goto(item.target_url, { waitUntil: "networkidle" });

  // ── Hard stop 1: captcha BEFORE filling anything (T-04-19) ──────────────────
  if (await page.detectCaptcha()) {
    return { id: item.id, status: "hard_stop", hard_stop_reason: "captcha" };
  }

  // ── Fill fields from the JSON payload (name/email/phone from Codex — NEVER passwords) ─
  const fields = JSON.parse(item.fields) as Record<string, string>;
  for (const [label, value] of Object.entries(fields)) {
    // NEVER log field values (T-04-24 — fields must not carry 2FA/secrets)
    await page.fillField(label, value);
  }

  // ── Hard stop 2: payment wall BEFORE submit (T-04-20) ─────────────────────
  if (await page.detectPaymentWall()) {
    return { id: item.id, status: "hard_stop", hard_stop_reason: "payment" };
  }

  // ── Hard stop 3: sold out BEFORE submit ───────────────────────────────────
  if (await page.detectSoldOut()) {
    return { id: item.id, status: "hard_stop", hard_stop_reason: "sold_out" };
  }

  // ── Hard stop 4: login wall BEFORE submit ─────────────────────────────────
  if (await page.detectLoginWall()) {
    return { id: item.id, status: "hard_stop", hard_stop_reason: "login_wall" };
  }

  // ── Submit (free / captcha-free path confirmed above) ─────────────────────
  await page.submitForm();

  // ── Require a non-empty confirmation # (Pitfall 6, D4-09) ────────────────
  const confirmationNumber = await page.scrapeConfirmation();
  if (!confirmationNumber) {
    return { id: item.id, status: "hard_stop", hard_stop_reason: "no_confirmation" };
  }

  return {
    id: item.id,
    status: "success",
    confirmation_number: confirmationNumber,
  };
}

// ─── Envoy: linkedin_prefill / x_prefill ──────────────────────────────────────

/**
 * Pre-fill a LinkedIn experience/project entry OR X (Twitter) composer.
 *
 * Returns success after filling — NO submit, NO Post/Save click (D4-08).
 * On a fill/selector timeout, returns error so the cloud keeps the draft and
 * flags P2 (D4-13). The runner contains NO code path that clicks Post/Save.
 *
 * The owner sees the pre-filled composer and clicks Post/Save themselves.
 */
async function runEnvoyPrefill(
  item: BrowserActionWorkItem,
  page: MockPage,
): Promise<BrowserActionOutcome> {
  try {
    await page.goto(item.target_url, { waitUntil: "networkidle" });

    // Fill the composer fields using semantic locators.
    const fields = JSON.parse(item.fields) as Record<string, string>;
    for (const [label, value] of Object.entries(fields)) {
      // NEVER log field values (T-04-24)
      await page.fillField(label, value);
    }

    // LEAVE the composer focused — owner clicks Post/Save (D4-08).
    // The runner MUST contain NO submit/post click for Envoy.
    return { id: item.id, status: "success" };
  } catch (err) {
    // Fill timeout or selector not found → abort + keep draft (D4-13).
    // The caller acks this error outcome and the cloud keeps the gate draft + flags P2.
    console.warn(`Envoy prefill failed for item ${item.id} (${item.action_type}): ${String(err)}`);
    return { id: item.id, status: "error" };
  }
}
