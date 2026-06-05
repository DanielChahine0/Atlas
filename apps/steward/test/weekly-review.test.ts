import { describe, it, expect, vi } from "vitest";
import { WireEvent } from "@atlas/wire";
import { buildWeeklyReviewEvent, weeklyReview, type WeeklyReviewInput } from "../src/weekly-review.js";
import type { Env } from "../src/steward-consumer.js";

// Plan 02-07 Task 3 — the Fri 16:30 weekly-review build (D2-11).
//
// weeklyReview(env, date) compiles ONE weekly-review note from the week's surfaced Scout
// events + Herald week-in-review digest + jobs-funnel snapshot + open flags, and writes it
// through the EXISTING vault path: a single op:"upsert" Wire event on atlas-wire that
// Steward's own (sole) consumer applies via applyEvent → vault_outbox. No new Vault writer,
// no new consumer (Pillar 1). Re-running for the same date REPLACES the weekly note
// (op:"upsert" → last-writer-wins), idempotent like compass:plan:<date> replaces Today.

/** A synthetic env whose WIRE.send + INCIDENTS.send record what the build emitted. */
function makeEnv() {
  const sent: unknown[] = [];
  const incidents: unknown[] = [];
  const env = {
    WIRE: { send: vi.fn(async (e: unknown) => { sent.push(e); }) },
    INCIDENTS: { send: vi.fn(async (inc: unknown) => { incidents.push(inc); }) },
  } as unknown as Env;
  return { env, sent, incidents };
}

const SAMPLE: WeeklyReviewInput = {
  events: [
    { title: "RustConf 2026", start: "2026-06-12", relevance: 80, url: "https://rustconf.test" },
    { title: "Local TS Meetup", start: "2026-06-10", relevance: 55, url: "https://tsmeetup.test" },
  ],
  heraldDigest: { mode: "weekly", actionRequired: 3, waitingOn: 2, slipped: 1, draftId: "draft-xyz" },
  funnel: { applied: 12, oa: 4, interview: 2, offer: 1, rejection: 3 },
  openFlags: [
    { id: "flg-1", severity: "P2", title: "calendar sync failed" },
    { id: "flg-2", severity: "P3", title: "counter drift" },
  ],
};

describe("buildWeeklyReviewEvent — §6.4 Wire-contract (CLAUDE.md DoD #1)", () => {
  it("emits a canonical op:upsert event with a STABLE structured idempotencyKey", () => {
    const evt = buildWeeklyReviewEvent("2026-06-12", SAMPLE);
    // Validates against the single §6.4 schema.
    const parsed = WireEvent.parse(evt);
    expect(parsed.agent).toBe("Steward");
    expect(parsed.op).toBe("upsert"); // REPLACE the weekly note (never append)
    // Structured + date-keyed — NEVER crypto.randomUUID() (scheduled work must re-derive it).
    expect(parsed.idempotencyKey).toBe("steward:weekly-review:2026-06-12");
    expect(parsed.idempotencyKey).toMatch(/^steward:weekly-review:\d{4}-\d{2}-\d{2}$/);
  });

  it("routes the upsert to the Weekly Review note (op-mapping note/field present)", () => {
    const evt = buildWeeklyReviewEvent("2026-06-12", SAMPLE);
    // The op-mapping `upsert` path reads payload.note (→ /vault/<note>.md). It must target the
    // Dashboard/Weekly Review note (docs/05-dashboard.md) — NOT a per-event note.
    expect(evt.payload.note).toBe("Dashboard/Weekly Review");
    expect(typeof evt.payload.field).toBe("string");
  });

  it("compiles all FOUR sections into the note body (events, digest, funnel, flags)", () => {
    const evt = buildWeeklyReviewEvent("2026-06-12", SAMPLE);
    const body = String(evt.payload.body ?? "");
    // Section 1 — surfaced events.
    expect(body).toContain("RustConf 2026");
    // Section 2 — Herald week-in-review digest counts.
    expect(body).toMatch(/action.?required/i);
    // Section 3 — jobs funnel snapshot.
    expect(body).toMatch(/applied/i);
    expect(body).toContain("12"); // applied count
    // Section 4 — open flags.
    expect(body).toContain("calendar sync failed");
  });

  it("renders a graceful empty-week note when there is nothing to report", () => {
    const evt = buildWeeklyReviewEvent("2026-06-12", {
      events: [],
      heraldDigest: null,
      funnel: { applied: 0, oa: 0, interview: 0, offer: 0, rejection: 0 },
      openFlags: [],
    });
    const body = String(evt.payload.body ?? "");
    // Not a stub/placeholder — a real (if quiet) summary. No "coming soon"/"TODO" leakage.
    expect(body.length).toBeGreaterThan(0);
    expect(body).not.toMatch(/coming soon|placeholder|TODO|FIXME/i);
  });
});

describe("weeklyReview — writes via the existing Wire/vault path (Pillar 1)", () => {
  it("emits EXACTLY ONE op:upsert Wire event (the build's only side effect)", async () => {
    const { env, sent } = makeEnv();
    await weeklyReview(env, "2026-06-12", SAMPLE);
    // The build's only outbound write is ONE upsert event — Steward's own consumer applies it.
    expect(sent).toHaveLength(1);
    const evt = WireEvent.parse(sent[0]);
    expect(evt.op).toBe("upsert");
    expect(evt.agent).toBe("Steward");
    expect(evt.idempotencyKey).toBe("steward:weekly-review:2026-06-12");
  });

  it("is idempotent: re-running for the same date emits the SAME stable key (REPLACE, not append)", async () => {
    const { env, sent } = makeEnv();
    await weeklyReview(env, "2026-06-12", SAMPLE);
    await weeklyReview(env, "2026-06-12", SAMPLE);
    // Two runs → two emits, but BOTH carry the SAME idempotencyKey + same op:upsert, so the
    // downstream apply REPLACES the note / dedups in the ledger (meta.changes===0 on replay).
    expect(sent).toHaveLength(2);
    const a = WireEvent.parse(sent[0]);
    const b = WireEvent.parse(sent[1]);
    expect(a.idempotencyKey).toBe(b.idempotencyKey);
    expect(a.op).toBe("upsert");
    expect(b.op).toBe("upsert");
  });
});
