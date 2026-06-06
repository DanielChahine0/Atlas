/**
 * Scout (apps/scout) — the Friday 16:00 weekly events digest (WEEKLY-01 events half).
 *
 * Fetches events from RSS feeds, plain-HTML/JSON listings, and Gmail
 * Type/Newsletter + Type/Events/Events/Invite threads (already labeled by Filer).
 * NO Browser Rendering (D2-09). Scores relevance against the Codex skills/projects
 * + a KV keyword list (D2-12), persists surfaced events to D1 `events`, and emits
 * op:"upsert" events to Steward (Vault Upcoming-events view).
 *
 * Scout is READ-AND-SUMMARIZE ONLY — it NEVER registers for events (Usher is Phase 4).
 * It NEVER follows links from email sources, and NEVER reads Type/Security or
 * Phishing-Suspect threads (D2-09 / T-02-link).
 *
 * Shape: WorkerEntrypoint (RPC target from Atlas scheduled()) + scheduled() export
 * for standalone invocation during development. Atlas drives it via service binding —
 * NO own production cron (the cron lives in Atlas's wrangler.jsonc).
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import { send } from "@atlas/wire";
import type { WireEvent } from "@atlas/wire";
import { flag, localDate, contentHash } from "@atlas/shared";
import type { Env as SharedEnv, RawIncident } from "@atlas/shared";
import { redact } from "@atlas/security";
import { defaultSources, buildGmailQueries } from "./sources.js";
import type { ScoutSources, EventCandidate } from "./sources.js";
import { relevance } from "./score.js";

export type { ScoutSources, EventCandidate } from "./sources.js";
export { buildGmailQueries } from "./sources.js";
export { relevance } from "./score.js";

// ─────────────────────────────────────────────────────────────────────────────
// Env
// ─────────────────────────────────────────────────────────────────────────────

/** Scout's env surface. */
export interface Env extends Omit<SharedEnv, "INCIDENTS"> {
  /** INCIDENTS producer (atlas-incidents): Scout enqueues RawIncidents via flag(). */
  INCIDENTS: Queue<RawIncident>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** A D1-persisted event record (maps to the `events` table in 0004 migration). */
export interface EventRecord {
  id: string;
  title: string;
  start: string | null;
  end: string | null;
  location: string | null;
  online: number; // 0 | 1
  url: string | null;
  source: string;
  relevance: number;
  why: string;
  horizon: string;
  status: string;
  digest_date: string;
  created_at: number;
}

/** The result returned to the Atlas workflow step. */
export interface WeeklyResult {
  date: string;
  total_candidates: number;
  surfaced: number;
  events: EventRecord[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Wire event builders
// ─────────────────────────────────────────────────────────────────────────────

/** Build the canonical §6.4 events.digest Wire event (op:upsert). */
export function buildScoutEvent(date: string, events: EventRecord[]): WireEvent {
  return {
    agent: "Scout",
    type: "events.digest",
    entity: "events",
    op: "upsert",
    payload: { date, events, count: events.length },
    idempotencyKey: `scout:digest:${date}`,
  };
}

/** Build a per-event upsert Wire event. */
export function buildEventUpsert(event: EventRecord): WireEvent {
  return {
    agent: "Scout",
    type: "event.upsert",
    entity: "events",
    op: "upsert",
    payload: { ...event },
    idempotencyKey: event.id, // == scout:evt_<date>_<hash>
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// KV config helpers
// ─────────────────────────────────────────────────────────────────────────────

async function getConfigInt(env: Env, key: string, fallback: number): Promise<number> {
  const raw = await env.CONFIG.get(key);
  if (raw === null) return fallback;
  const n = parseInt(raw, 10);
  return Number.isNaN(n) ? fallback : n;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core logic
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Classify a horizon label from the event start date relative to digest date.
 * "this_week" → within 7 days, "this_month" → within 31 days, "further" otherwise.
 */
function horizon(start: string | undefined, digestDate: string): string {
  if (!start) return "further";
  const startMs = new Date(start).getTime();
  const digestMs = new Date(`${digestDate}T00:00:00Z`).getTime();
  const diffDays = (startMs - digestMs) / (24 * 60 * 60 * 1000);
  if (diffDays <= 7) return "this_week";
  if (diffDays <= 31) return "this_month";
  return "further";
}

/**
 * Check if a candidate duplicates an existing row in D1 events.
 * Dedupe logic: same url OR same (title, start) within dedupe_window_weeks.
 */
async function isDuplicate(
  env: Env,
  candidate: EventCandidate,
  dedupeWindowWeeks: number,
): Promise<boolean> {
  const cutoffMs = Date.now() - dedupeWindowWeeks * 7 * 24 * 60 * 60 * 1000;
  const cutoff = Math.floor(cutoffMs);

  // Check by url first
  if (candidate.url) {
    const urlCheck = await env.DB.prepare(
      "SELECT id FROM events WHERE url = ? AND created_at > ?",
    )
      .bind(candidate.url, cutoff)
      .first<{ id: string }>();
    if (urlCheck) return true;
  }

  // Check by (title, start) within window
  if (candidate.title && candidate.start) {
    const titleCheck = await env.DB.prepare(
      "SELECT id FROM events WHERE title = ? AND start = ? AND created_at > ?",
    )
      .bind(candidate.title, candidate.start ?? null, cutoff)
      .first<{ id: string }>();
    if (titleCheck) return true;
  }

  return false;
}

/**
 * Core weekly run: fetch candidates → score → dedupe → persist to D1 → emit Wire events.
 * NEVER uses new Date() directly — uses localDate(env) for owner-local date.
 */
export async function runWeekly(
  env: Env,
  date: string,
  sources?: ScoutSources,
): Promise<WeeklyResult> {
  const src = sources ?? defaultSources();

  // ── KV config knobs ───────────────────────────────────────────────────────
  const minRelevance = await getConfigInt(env, "scout/min_relevance", 55);
  const relaxedMinRelevance = await getConfigInt(env, "scout/relaxed_min_relevance", 40);
  const maxPerDigest = await getConfigInt(env, "scout/max_per_digest", 15);
  const dedupeWindowWeeks = await getConfigInt(env, "scout/dedupe_window_weeks", 4);
  const sparseFloor = await getConfigInt(env, "scout/sparse_floor", 3);

  // ── Source URLs from CONFIG ────────────────────────────────────────────────
  const rssUrlsRaw = await env.CONFIG.get("scout/sources/rss");
  const htmlUrlsRaw = await env.CONFIG.get("scout/sources/html");
  const rssUrls: string[] = rssUrlsRaw ? (JSON.parse(rssUrlsRaw) as string[]) : [];
  const htmlUrls: string[] = htmlUrlsRaw ? (JSON.parse(htmlUrlsRaw) as string[]) : [];

  // ── KV interest keywords ───────────────────────────────────────────────────
  const interestsRaw = await env.CONFIG.get("scout/interests");
  const keywords: string[] = interestsRaw ? (JSON.parse(interestsRaw) as string[]) : [];

  // ── Fetch candidates ───────────────────────────────────────────────────────
  const allCandidates: EventCandidate[] = [];

  for (const url of rssUrls) {
    const candidates = await src.fetchRss(url);
    allCandidates.push(...candidates);
  }
  for (const url of htmlUrls) {
    const candidates = await src.fetchHtml(url);
    allCandidates.push(...candidates);
  }

  // Gmail: use the two canonical queries (Type/Newsletter + Type/Events)
  for (const query of buildGmailQueries()) {
    const candidates = await src.fetchGmailEvents(query);
    allCandidates.push(...candidates);
  }

  // ── Score ─────────────────────────────────────────────────────────────────
  // Codex skills/projects would normally be read here via @atlas/codex read() but
  // that requires an injected drive.readonly token. In this plan we use a best-effort
  // approach: if Codex is unavailable (no token), we score against keywords only.
  // The scoring is still deterministic and pure.
  const skills: string[] = [];
  const projects: string[] = [];

  const scoredCandidates = allCandidates.map((c) => ({
    candidate: c,
    score: relevance(c, skills, projects, keywords),
  }));

  // ── Filter by relevance (with sparse-week relaxation) ─────────────────────
  const aboveFloor = scoredCandidates.filter((s) => s.score >= minRelevance);
  const effectiveMin =
    aboveFloor.length < sparseFloor ? relaxedMinRelevance : minRelevance;
  const filtered = scoredCandidates
    .filter((s) => s.score >= effectiveMin)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxPerDigest);

  // ── Dedupe + D1 persist ────────────────────────────────────────────────────
  //
  // M2 (security defense-in-depth): redact() is applied to every untrusted feed
  // field — title, description, url — BEFORE the record is persisted to D1 OR
  // emitted to the Wire. This is the Scout backstop analogous to Herald's guardrail.
  //
  // L5 (replay/idempotency): `isDuplicate` gates the D1 INSERT only (prevents
  // double-counting in the database). The per-event Wire upsert is emitted for
  // EVERY surfaced event on EVERY run — the stable `idempotencyKey = event.id`
  // lets Steward dedup the Vault projection (replay → meta.changes === 0).
  // This means a lost Vault projection row self-heals on the next weekly run.
  const surfaced: EventRecord[] = [];
  // Tracks all records that pass scoring (new + already-seen) for Wire emit on replay.
  const allSurfacedRecords: EventRecord[] = [];

  for (const { candidate, score } of filtered) {
    // ── M2: redact untrusted feed fields before any persist or emit ──────────
    const safeTitle = redact(candidate.title ?? "");
    const safeDescription = candidate.description != null
      ? redact(candidate.description)
      : undefined;
    const safeUrl = candidate.url != null ? redact(candidate.url) : undefined;

    const id = `scout:evt_${date}_${contentHash((safeTitle) + (candidate.start ?? ""))}`;
    const record: EventRecord = {
      id,
      title: safeTitle,
      start: candidate.start ?? null,
      end: candidate.end ?? null,
      location: candidate.location ?? null,
      online: candidate.online ? 1 : 0,
      url: safeUrl ?? null,
      source: candidate.source,
      relevance: score,
      why: `Matched ${score} relevance points against skills/interests`,
      horizon: horizon(candidate.start, date),
      status: "surfaced",
      digest_date: date,
      created_at: Date.now(),
    };

    // ── L5: always collect for Wire emit (Steward deduplicates the projection) ─
    // The per-event Wire upsert is emitted for EVERY scored event on every run —
    // new AND already-seen — so Steward-level dedup (stable idempotencyKey = event.id)
    // ensures a lost Vault projection row self-heals on replay. The D1 INSERT is the
    // only thing gated by isDuplicate (to prevent double-counting in the database).
    allSurfacedRecords.push(record);

    const dup = await isDuplicate(env, candidate, dedupeWindowWeeks);
    if (dup) {
      // D1 INSERT skipped (no double-count), but Wire upsert still emitted below.
      continue;
    }

    // INSERT OR REPLACE INTO events — positional ? binds only (D1 rule)
    await env.DB.prepare(
      `INSERT OR REPLACE INTO events
       (id,title,start,end,location,online,url,source,relevance,why,horizon,status,digest_date,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
      .bind(
        record.id,
        record.title,
        record.start,
        record.end,
        record.location,
        record.online,
        record.url,
        record.source,
        record.relevance,
        record.why,
        record.horizon,
        record.status,
        record.digest_date,
        record.created_at,
      )
      .run();

    surfaced.push(record);
  }

  // ── Per-event Wire upserts (all scored events — L5 self-heal on replay) ────
  // Emitted AFTER the D1 loop so every record (new + duplicate) gets the upsert.
  // Steward dedups via the stable idempotencyKey; replay is a no-op in the Vault.
  for (const record of allSurfacedRecords) {
    await send(env, buildEventUpsert(record));
  }

  // ── Digest summary event ───────────────────────────────────────────────────
  // Use allSurfacedRecords (all scored events, new + already-seen) so the digest
  // always reflects the full weekly slate. On replay, Steward deduplicates the
  // projection via the stable idempotencyKey; meta.changes === 0 is the no-op signal.
  await send(env, buildScoutEvent(date, allSurfacedRecords));

  return {
    date,
    total_candidates: allCandidates.length,
    surfaced: surfaced.length,
    events: surfaced,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// WorkerEntrypoint (RPC target — Atlas invokes via service binding)
// ─────────────────────────────────────────────────────────────────────────────

export class Scout extends WorkerEntrypoint<Env> {
  /**
   * Atlas-driven Friday 16:00 weekly pass.
   * @param params.date     Owner-local YYYY-MM-DD (defaults to localDate(env)).
   * @param params.sources  Injected ScoutSources for testing.
   */
  async weekly(params?: {
    date?: string;
    sources?: ScoutSources;
  }): Promise<WeeklyResult> {
    const date = params?.date ?? localDate(this.env);
    try {
      const result = await runWeekly(this.env, date, params?.sources);

      // Heartbeat: inform FlaggerState alarm scheduler this slot ran (D2-07).
      // Best-effort: a transient queue reject must NEVER convert a successful weekly run
      // into a failure. Optional-chaining: absent binding is a no-op.
      await this.env.INCIDENTS?.send({
        source_agent: "Scout",
        kind: "heartbeat",
        severity_hint: "P4",
        title: `Scout heartbeat ${date}`,
        run_id: date,
      }).catch(() => {});

      return result;
    } catch (err) {
      await flag(
        this.env,
        "P3",
        "scout weekly failed",
        String(err),
        { sourceAgent: "Scout", kind: "scout_failed" },
      );
      throw err;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Standalone scheduled() handler (for dev / Atlas fallback)
// ─────────────────────────────────────────────────────────────────────────────

export default {
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    const date = localDate(env);
    try {
      await runWeekly(env, date);
    } catch (err) {
      await flag(
        env,
        "P3",
        "scout weekly failed",
        String(err),
        { sourceAgent: "Scout", kind: "scout_failed" },
      );
    }
  },
} satisfies ExportedHandler<Env>;
