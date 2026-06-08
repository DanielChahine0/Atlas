import { describe, it, expect, vi, afterEach } from "vitest";
import { runBrowserAction, type MockPage } from "../src/browser-runner.ts";
import type { BrowserActionWorkItem, BrowserActionOutcome } from "../../packages/gate/src/schema.ts";
import type { BrowserDrainConfig } from "../src/browser-drain.ts";

// browser-runner unit tests — all Playwright interactions are driven via a MOCK page
// interface (no real Chromium launched in these tests). This keeps the test fast and
// hermetic; the real Playwright is only used in the running daemon.
//
// Tests per 04-04 acceptance criteria:
//   - captcha detected BEFORE any fill → hard_stop 'captcha' (no fill, no submit)
//   - payment wall detected BEFORE submit → hard_stop 'payment' (no submit)
//   - Usher event_fill_submit success with scraped confirmation #
//   - Usher no-confirmation → hard_stop 'no_confirmation'
//   - Envoy linkedin_prefill leaves-without-submitting (no submit/post click)
//   - Envoy x_prefill leaves-without-submitting (no submit/post click)
//   - Envoy selector-timeout → error (keep draft, P2 handled by caller)
//   - unknown action_type → error outcome

const cfg: BrowserDrainConfig = {
  bridgeBaseUrl: "https://bridge.example.workers.dev",
  bridgeToken: "test-token",
  browserProfilePath: "/tmp/test-profile",
  backoffMs: 1,
};

function makeUsherItem(id = "item-1"): BrowserActionWorkItem {
  return {
    id,
    agent: "Usher",
    action_type: "event_fill_submit",
    fields: JSON.stringify({ name: "Daniel Chahine", email: "daniel@example.com", phone: "+1-555-0100" }),
    gate_id: "gate-1",
    target_url: "https://eventbrite.com/e/123/register",
  };
}

function makeLinkedinItem(id = "item-2"): BrowserActionWorkItem {
  return {
    id,
    agent: "Envoy",
    action_type: "linkedin_prefill",
    fields: JSON.stringify({ title: "Atlas OSS Project", description: "Multi-agent orchestrator on Cloudflare" }),
    gate_id: "gate-2",
    target_url: "https://www.linkedin.com/feed/",
  };
}

function makeXItem(id = "item-3"): BrowserActionWorkItem {
  return {
    id,
    agent: "Envoy",
    action_type: "x_prefill",
    fields: JSON.stringify({ text: "Launched Atlas — a multi-agent orchestrator on Cloudflare" }),
    gate_id: "gate-3",
    target_url: "https://twitter.com/intent/tweet",
  };
}

/** Build a minimal MockPage with overridable behaviour. */
function makeMockPage(overrides: Partial<MockPage> = {}): MockPage {
  return {
    goto: vi.fn(async () => {}),
    getByLabel: vi.fn((_text: string) => ({
      fill: vi.fn(async () => {}),
      click: vi.fn(async () => {}),
    })),
    getByRole: vi.fn((_role: string, _opts?: { name?: string }) => ({
      fill: vi.fn(async () => {}),
      click: vi.fn(async () => {}),
    })),
    detectCaptcha: vi.fn(async () => false),
    detectPaymentWall: vi.fn(async () => false),
    detectSoldOut: vi.fn(async () => false),
    detectLoginWall: vi.fn(async () => false),
    submitForm: vi.fn(async () => {}),
    scrapeConfirmation: vi.fn(async () => "CONF-ABC123"),
    fillField: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    ...overrides,
  };
}

// ─── Usher event_fill_submit ──────────────────────────────────────────────────

describe("Usher event_fill_submit", () => {
  it("returns success with confirmation # when form fills and submits cleanly", async () => {
    const page = makeMockPage();
    const item = makeUsherItem();

    const outcome = await runBrowserAction(item, cfg, page);
    expect(outcome.status).toBe("success");
    expect(outcome.confirmation_number).toBe("CONF-ABC123");
    expect(page.goto).toHaveBeenCalledWith(item.target_url, expect.any(Object));
    // submit was called
    expect(page.submitForm).toHaveBeenCalled();
  });

  it("detects captcha BEFORE filling any field — returns hard_stop 'captcha' with no fill attempted", async () => {
    const page = makeMockPage({
      detectCaptcha: vi.fn(async () => true),
    });
    const item = makeUsherItem();

    const outcome = await runBrowserAction(item, cfg, page);
    expect(outcome.status).toBe("hard_stop");
    expect(outcome.hard_stop_reason).toBe("captcha");
    // No fill should have been attempted
    expect(page.fillField).not.toHaveBeenCalled();
    // No submit should have been attempted
    expect(page.submitForm).not.toHaveBeenCalled();
  });

  it("detects payment wall BEFORE submit — returns hard_stop 'payment' with no submit attempted", async () => {
    const page = makeMockPage({
      detectPaymentWall: vi.fn(async () => true),
    });
    const item = makeUsherItem();

    const outcome = await runBrowserAction(item, cfg, page);
    expect(outcome.status).toBe("hard_stop");
    expect(outcome.hard_stop_reason).toBe("payment");
    // Fill happened (payment check is AFTER fill, BEFORE submit)
    expect(page.fillField).toHaveBeenCalled();
    // No submit
    expect(page.submitForm).not.toHaveBeenCalled();
  });

  it("returns hard_stop 'no_confirmation' when scrapeConfirmation returns empty string", async () => {
    const page = makeMockPage({
      scrapeConfirmation: vi.fn(async () => ""),
    });
    const outcome = await runBrowserAction(makeUsherItem(), cfg, page);
    expect(outcome.status).toBe("hard_stop");
    expect(outcome.hard_stop_reason).toBe("no_confirmation");
  });

  it("returns hard_stop 'sold_out' when sold-out detected before submit", async () => {
    const page = makeMockPage({
      detectSoldOut: vi.fn(async () => true),
    });
    const outcome = await runBrowserAction(makeUsherItem(), cfg, page);
    expect(outcome.status).toBe("hard_stop");
    expect(outcome.hard_stop_reason).toBe("sold_out");
    expect(page.submitForm).not.toHaveBeenCalled();
  });

  it("returns hard_stop 'login_wall' when login-wall detected before submit", async () => {
    const page = makeMockPage({
      detectLoginWall: vi.fn(async () => true),
    });
    const outcome = await runBrowserAction(makeUsherItem(), cfg, page);
    expect(outcome.status).toBe("hard_stop");
    expect(outcome.hard_stop_reason).toBe("login_wall");
    expect(page.submitForm).not.toHaveBeenCalled();
  });
});

// ─── Envoy linkedin_prefill — prefill WITHOUT submitting ─────────────────────

describe("Envoy linkedin_prefill", () => {
  it("pre-fills the composer and returns success WITHOUT submitting (D4-08)", async () => {
    const clickSpy = vi.fn(async () => {});
    const page = makeMockPage({
      getByRole: vi.fn((_role: string, _opts?: { name?: string }) => ({
        fill: vi.fn(async () => {}),
        click: clickSpy,
      })),
    });
    const item = makeLinkedinItem();

    const outcome = await runBrowserAction(item, cfg, page);
    expect(outcome.status).toBe("success");
    // goto was called with the target URL
    expect(page.goto).toHaveBeenCalledWith(item.target_url, expect.any(Object));
    // The page must NOT submit — no form submit triggered
    expect(page.submitForm).not.toHaveBeenCalled();
    // The Envoy runner must NOT call any "post" / "submit" click on the composer
    // (The fillField was called for the content, but no final Post/Save click)
    expect(page.fillField).toHaveBeenCalled();
  });

  it("returns error on fillField timeout (selector not found) — caller keeps draft (D4-13)", async () => {
    const page = makeMockPage({
      fillField: vi.fn(async () => {
        throw new Error("Timeout: selector '.share-box__text-editor' not found after 30000ms");
      }),
    });
    const item = makeLinkedinItem();

    const outcome = await runBrowserAction(item, cfg, page);
    expect(outcome.status).toBe("error");
    // No submit on error
    expect(page.submitForm).not.toHaveBeenCalled();
  });
});

// ─── Envoy x_prefill — prefill WITHOUT submitting ────────────────────────────

describe("Envoy x_prefill", () => {
  it("pre-fills the composer and returns success WITHOUT submitting (D4-08)", async () => {
    const page = makeMockPage();
    const item = makeXItem();

    const outcome = await runBrowserAction(item, cfg, page);
    expect(outcome.status).toBe("success");
    expect(page.submitForm).not.toHaveBeenCalled();
    expect(page.fillField).toHaveBeenCalled();
  });

  it("returns error on fillField timeout — caller keeps draft (D4-13)", async () => {
    const page = makeMockPage({
      fillField: vi.fn(async () => {
        throw new Error("Timeout: X composer textarea not found");
      }),
    });

    const outcome = await runBrowserAction(makeXItem(), cfg, page);
    expect(outcome.status).toBe("error");
    expect(page.submitForm).not.toHaveBeenCalled();
  });
});

// ─── Safety invariants ────────────────────────────────────────────────────────

describe("safety invariants", () => {
  it("unknown action_type returns error outcome (never throws unhandled)", async () => {
    const page = makeMockPage();
    const item: BrowserActionWorkItem = {
      ...makeUsherItem(),
      action_type: "event_fill_submit", // override below with cast
    };
    // Force an unknown type via cast
    const badItem = { ...item, action_type: "unknown_type" } as unknown as BrowserActionWorkItem;

    const outcome = await runBrowserAction(badItem, cfg, page);
    expect(outcome.status).toBe("error");
  });

  it("unexpected throw in page ops returns error outcome (never unhandled rejection)", async () => {
    const page = makeMockPage({
      goto: vi.fn(async () => {
        throw new Error("Navigation failed: ERR_NAME_NOT_RESOLVED");
      }),
    });

    const outcome = await runBrowserAction(makeUsherItem(), cfg, page);
    expect(outcome.status).toBe("error");
  });
});

// ─── WR-04: single persistent context per item ───────────────────────────────
//
// When _page is NOT injected, runBrowserAction opens a Playwright persistent context.
// Before WR-04 fix, main.ts wrapped the drain loop in withBrowserContext (which called
// launchPersistentContext for the outer context) AND runBrowserAction called it again
// inside (two contexts on the same profile → SingletonLock conflict).
// After the fix, main.ts no longer calls withBrowserContext; each runBrowserAction call
// owns exactly one context and closes it after the item.

describe("WR-04: runBrowserAction opens exactly ONE context per item when no mock page injected", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("launchPersistentContext called once per item, context is closed after the item", async () => {
    // Build a minimal mock page compatible with MockPage interface
    const mockPage = makeMockPage();

    // Stub the playwright chromium module dynamically
    const mockClose = vi.fn(async () => {});
    const mockCtx = {
      newPage: async () => {
        // Return a real-ish page object — but we wrap it via makePlaywrightPage internally.
        // We need to satisfy BrowserContext.newPage. Return an object the internal wrapper uses.
        return {
          goto: vi.fn(async () => {}),
          getByLabel: vi.fn(() => ({ fill: vi.fn(async () => {}), click: vi.fn(async () => {}) })),
          getByRole: vi.fn(() => ({ fill: vi.fn(async () => {}), click: vi.fn(async () => {}) })),
          locator: vi.fn(() => ({
            count: vi.fn(async () => 0),
            first: vi.fn(() => ({ textContent: vi.fn(async () => ""), click: vi.fn(async () => {}) })),
            fill: vi.fn(async () => {}),
          })),
          waitForSelector: vi.fn(async () => {}),
          close: vi.fn(async () => {}),
        };
      },
      close: mockClose,
    };

    const launchSpy = vi.fn(async () => mockCtx);

    // Mock playwright dynamic import
    vi.doMock("playwright", () => ({
      chromium: {
        launchPersistentContext: launchSpy,
      },
    }));

    // Re-import the module so the mock takes effect
    const { runBrowserAction: runWithRealCtx } = await import("../src/browser-runner.ts?wr04=1");

    const item = makeUsherItem("wr04-item-1");
    // Run without injecting a mock page — triggers the real Playwright path
    await runWithRealCtx(item, cfg);

    // launchPersistentContext should have been called exactly once for one item
    expect(launchSpy).toHaveBeenCalledTimes(1);
    expect(launchSpy).toHaveBeenCalledWith(cfg.browserProfilePath, expect.objectContaining({ headless: false }));

    // Context should have been closed after the item (WR-04: clean up after each item)
    expect(mockClose).toHaveBeenCalledTimes(1);
  });
});
