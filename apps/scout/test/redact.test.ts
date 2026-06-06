/**
 * redact.test.ts — M2 security defense-in-depth backstop (gap-closure pass 4/5).
 *
 * Scout ingests UNTRUSTED RSS / HTML / Gmail content. A feed title, description,
 * or url carrying a secret-shaped token (2FA code, login/reset URL) must be
 * redacted BEFORE it reaches:
 *   1. D1 `events` table (persist path)
 *   2. The per-event Wire upsert payload (emit path)
 *   3. The digest summary Wire payload (emit path)
 *
 * Mirror of Herald's guardrail CI-test pattern (CLAUDE.md defense-in-depth invariant:
 * "A prompt instruction alone is NOT sufficient.").
 */

import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import type { WireEvent } from "@atlas/wire";
import type { RawIncident } from "@atlas/shared";
import { runWeekly } from "../src/index.js";
import type { Env } from "../src/index.js";
import type { ScoutSources, EventCandidate } from "../src/sources.js";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeEnv(overrides: Partial<Env> = {}): {
  testEnv: Env;
  wireEvents: WireEvent[];
  incidents: RawIncident[];
} {
  const wireEvents: WireEvent[] = [];
  const incidents: RawIncident[] = [];

  const wireSend = vi.fn(async (event: WireEvent) => {
    wireEvents.push(event);
  });

  const incidentsSend = vi.fn(async (incident: RawIncident) => {
    incidents.push(incident);
  });

  const testEnv: Env = {
    ...(env as unknown as Env),
    WIRE: { send: wireSend } as unknown as Queue<WireEvent>,
    INCIDENTS: { send: incidentsSend } as unknown as Queue<RawIncident>,
    CONFIG: {
      get: vi.fn(async (key: string) => {
        // Pass-all floors so every candidate is surfaced
        if (key === "scout/min_relevance") return "0";
        if (key === "scout/relaxed_min_relevance") return "0";
        if (key === "scout/max_per_digest") return "15";
        if (key === "scout/dedupe_window_weeks") return "4";
        if (key === "scout/sparse_floor") return "3";
        return null;
      }),
    } as unknown as KVNamespace,
    ...overrides,
  };

  return { testEnv, wireEvents, incidents };
}

function makeSourcesWith(candidates: EventCandidate[]): ScoutSources {
  let callCount = 0;
  return {
    async fetchRss(_url) { return []; },
    async fetchHtml(_url) { return []; },
    async fetchGmailEvents(_query) {
      callCount++;
      return callCount === 1 ? candidates : [];
    },
  };
}

// ── secret-shaped candidates ───────────────────────────────────────────────────

/** A candidate whose title carries a 6-digit code in a cued context. */
const candidateWithCodeInTitle: EventCandidate = {
  title: "Your verification code is 482913 — AI Summit 2026",
  start: "2026-08-10",
  url: "https://example.com/ai-summit",
  source: "gmail",
  online: false,
};

/** A candidate whose description carries a reset-password URL. */
const candidateWithResetInDescription: EventCandidate = {
  title: "Tech Meetup Toronto",
  description: "Register now: https://accounts.example.com/reset-password?token=xyzabc",
  start: "2026-08-12",
  url: "https://example.com/meetup",
  source: "rss",
  online: true,
};

/** A candidate whose url is a login/magic-link URL. */
const candidateWithLoginUrl: EventCandidate = {
  title: "Developer Conference 2026",
  start: "2026-08-15",
  url: "https://events.example.com/login/AbCdEfGhIjKlMn",
  source: "html",
  online: false,
};

const MASK = "[REDACTED]";

// ── RED TESTS — M2 security backstop ─────────────────────────────────────────

describe("M2 — Scout redact() backstop: secret-shaped tokens are masked before persist + emit", () => {
  it("masks a cued 6-digit code in title BEFORE persisting to D1", async () => {
    const { testEnv } = makeEnv();
    const date = "2026-08-01";
    await runWeekly(testEnv, date, makeSourcesWith([candidateWithCodeInTitle]));

    const { results } = await testEnv.DB.prepare(
      "SELECT title FROM events WHERE digest_date = ?",
    )
      .bind(date)
      .all<{ title: string }>();

    expect(results.length).toBeGreaterThanOrEqual(1);
    // The raw code "482913" must NOT appear in the persisted title
    for (const row of results) {
      expect(row.title).not.toContain("482913");
      expect(row.title).toContain(MASK);
    }
  });

  it("masks a cued 6-digit code in title BEFORE emitting the per-event Wire upsert", async () => {
    const { testEnv, wireEvents } = makeEnv();
    const date = "2026-08-02";
    await runWeekly(testEnv, date, makeSourcesWith([candidateWithCodeInTitle]));

    const upserts = wireEvents.filter((e) => e.type === "event.upsert");
    expect(upserts.length).toBeGreaterThanOrEqual(1);
    for (const e of upserts) {
      const titleInPayload = String((e.payload as Record<string, unknown>).title ?? "");
      expect(titleInPayload).not.toContain("482913");
      expect(titleInPayload).toContain(MASK);
    }
  });

  it("masks a cued 6-digit code in title BEFORE emitting the digest summary Wire event", async () => {
    const { testEnv, wireEvents } = makeEnv();
    const date = "2026-08-03";
    await runWeekly(testEnv, date, makeSourcesWith([candidateWithCodeInTitle]));

    const digest = wireEvents.find((e) => e.type === "events.digest");
    expect(digest).toBeDefined();
    const payloadStr = JSON.stringify(digest!.payload);
    expect(payloadStr).not.toContain("482913");
    expect(payloadStr).toContain(MASK);
  });

  it("masks a reset-password URL in description BEFORE persisting to D1", async () => {
    const { testEnv } = makeEnv();
    const date = "2026-08-04";
    await runWeekly(testEnv, date, makeSourcesWith([candidateWithResetInDescription]));

    // why column carries the description-derived context (or title); check
    // that the raw reset URL did NOT reach D1 verbatim in any text column.
    const { results } = await testEnv.DB.prepare(
      "SELECT title, why FROM events WHERE digest_date = ?",
    )
      .bind(date)
      .all<{ title: string; why: string }>();

    // title is clean already, but ensure the reset URL in description is not echoed
    // into any text column that could reach the Vault
    for (const row of results) {
      expect(row.why).not.toContain("reset-password");
    }
  });

  it("masks a reset-password URL in description BEFORE emitting Wire upsert payload", async () => {
    const { testEnv, wireEvents } = makeEnv();
    const date = "2026-08-05";
    await runWeekly(testEnv, date, makeSourcesWith([candidateWithResetInDescription]));

    const upserts = wireEvents.filter((e) => e.type === "event.upsert");
    expect(upserts.length).toBeGreaterThanOrEqual(1);
    for (const e of upserts) {
      const payloadStr = JSON.stringify(e.payload);
      expect(payloadStr).not.toContain("reset-password");
    }
  });

  it("masks a login-path URL BEFORE persisting to D1 url column", async () => {
    const { testEnv } = makeEnv();
    const date = "2026-08-06";
    await runWeekly(testEnv, date, makeSourcesWith([candidateWithLoginUrl]));

    const { results } = await testEnv.DB.prepare(
      "SELECT url FROM events WHERE digest_date = ?",
    )
      .bind(date)
      .all<{ url: string | null }>();

    expect(results.length).toBeGreaterThanOrEqual(1);
    for (const row of results) {
      // The opaque magic-path /login/AbCdEfGhIjKlMn must be masked
      expect(row.url ?? "").not.toContain("/login/AbCdEfGhIjKlMn");
      // The url column should be the mask token or null after redaction
      if (row.url !== null) {
        expect(row.url).toContain(MASK);
      }
    }
  });

  it("masks a login-path URL BEFORE emitting per-event Wire upsert url field", async () => {
    const { testEnv, wireEvents } = makeEnv();
    const date = "2026-08-07";
    await runWeekly(testEnv, date, makeSourcesWith([candidateWithLoginUrl]));

    const upserts = wireEvents.filter((e) => e.type === "event.upsert");
    expect(upserts.length).toBeGreaterThanOrEqual(1);
    for (const e of upserts) {
      const urlField = String((e.payload as Record<string, unknown>).url ?? "");
      expect(urlField).not.toContain("/login/AbCdEfGhIjKlMn");
      if (urlField !== "null" && urlField !== "") {
        expect(urlField).toContain(MASK);
      }
    }
  });

  it("does NOT mask a benign title (no over-redaction)", async () => {
    const { testEnv } = makeEnv();
    const date = "2026-08-08";
    const benignCandidate: EventCandidate = {
      title: "AI Summit Toronto — 3 Day Intensive",
      description: "Featuring 120 speakers across 5 tracks.",
      start: "2026-09-01",
      url: "https://aisummit.example.com/toronto",
      source: "rss",
      online: false,
    };
    await runWeekly(testEnv, date, makeSourcesWith([benignCandidate]));

    const { results } = await testEnv.DB.prepare(
      "SELECT title, url FROM events WHERE digest_date = ?",
    )
      .bind(date)
      .all<{ title: string; url: string | null }>();

    expect(results.length).toBe(1);
    // Benign title must be preserved (no [REDACTED] introduced)
    expect(results[0]!.title).toBe("AI Summit Toronto — 3 Day Intensive");
    expect(results[0]!.url).toBe("https://aisummit.example.com/toronto");
  });
});
