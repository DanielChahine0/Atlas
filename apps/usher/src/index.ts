/**
 * Usher (apps/usher) — on-demand gated event-registration agent (OUTWARD-01).
 *
 * Flow:
 *   1. register({ eventId, eventUrl }) — initial call:
 *      a. Short-circuit if idempotency_key usher:<eventId>:registered already exists
 *         → return { status: "already_registered" } (no gate, no browser action, no counter)
 *      b. Build artifact (price FIRST, event, date, location, account, notes from Codex)
 *      c. Call openGate() — writes gate_pending + dispatches ntfy confirm push
 *      d. Return { status: "gate_opened", gateId }
 *   2. register({ eventId, eventUrl, gateId }) — gate-approved re-invocation (from apps/gate):
 *      a. Assert gate_pending.status='approved' for gateId (P1 self-flag if not approved)
 *      b. INSERT browser_action_outbox event_fill_submit row
 *      c. Return { status: "browser_action_enqueued" }
 *   3. onOutcome({ eventId, eventUrl, outcome }) — called after daemon drains and acks:
 *      a. hard_stop → flag() with severity from the table → return (no Calendar, no Wire)
 *      b. success with empty confirmation_number → P2, no Calendar, no Wire
 *      c. success with non-empty confirmation_number:
 *         → addEventToCalendar()
 *         → UPDATE events SET status='registered' WHERE id=?
 *         → send() Wire event (events-registered increment, stable key)
 *
 * Pillar 1: NO queues.consumers block on atlas-wire. Wire PRODUCER only.
 * Pillar 2: Gate BEFORE any registration; hard stops ALWAYS override.
 * Security: T-04-29..T-04-35 (see threat model in 04-06-PLAN.md).
 *
 * Shape: WorkerEntrypoint (RPC target from Atlas or apps/gate service binding).
 * No own cron, no own Workflow — purely on-demand.
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import { send } from "@atlas/wire";
import { flag, localDate } from "@atlas/shared";
import type { RawIncident } from "@atlas/shared";
import { openGate } from "@atlas/gate";
import type { GateOptions } from "@atlas/gate";
import { buildRegistrationFields, serializeFields } from "./fill.js";
import type { CodexRegistrationFields } from "./fill.js";
import { addEventToCalendar } from "./calendar.js";
import type { CalendarTools } from "./calendar.js";

// ─── Env type ──────────────────────────────────────────────────────────────────

/** SecretsStoreSecret-compatible interface (accept null/undefined from test stubs). */
interface SecretBinding {
  get(): Promise<string | null | undefined>;
}

/**
 * Usher's env surface. Includes NTFY_TOPIC/NTFY_TOKEN so they are passed through to
 * openGate() which dispatches the confirm push (04-01). Usher never reads them directly.
 */
export interface Env {
  /** D1 atlas-db — events, idempotency_keys, gate_pending, browser_action_outbox, audit_log. */
  DB: D1Database;
  /** Wire PRODUCER — events-registered counter increment. */
  WIRE: Queue<unknown>;
  /** Incidents PRODUCER — for flag() calls. */
  INCIDENTS: Queue<RawIncident>;
  /** KV config knobs — gates.timeout_usher_ms (default 86400000 = 24h). */
  CONFIG: KVNamespace;
  /** Confirm page base URL (plaintext [vars], NOT a secret). */
  GATE_BASE_URL?: string;
  /** NTFY_TOPIC — Secrets Store binding; passed to openGate for the confirm push. */
  NTFY_TOPIC?: SecretBinding;
  /** NTFY_TOKEN — Secrets Store binding; passed to openGate for the confirm push. */
  NTFY_TOKEN?: SecretBinding;
  /**
   * GATE service binding to apps/gate — Usher uses the gate Worker as a transport
   * for browser_action_outbox (apps/gate serves /browser/poll + /browser/ack).
   * Not called directly in the registration flow — the gate Worker re-invokes Usher.
   */
  GATE?: {
    poll(): Promise<unknown>;
  };
  /**
   * MCP_GOOGLE service binding — calendar.events add after confirmed registration.
   * In prod this is the mcp-google Worker; in tests inject a CalendarTools stub.
   */
  MCP_GOOGLE?: CalendarTools;
}

// ─── Result types ──────────────────────────────────────────────────────────────

export type UsherStatus =
  | "already_registered"
  | "gate_opened"
  | "browser_action_enqueued"
  | "already_enqueued"
  | "gate_not_approved"
  | "outcome_handled"
  | "already_handled";

export interface UsherResult {
  status: UsherStatus;
  gateId?: string;
  calendarEventId?: string;
}

// ─── D1 row types ─────────────────────────────────────────────────────────────

interface EventRow {
  id: string;
  title: string;
  start: string | null;
  end: string | null;
  location: string | null;
  url: string | null;
  status: string;
}

// ─── ULID generator (inline, no new dep — same inline as packages/gate/src/index.ts) ────

const CROCKFORD_CHARS = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function ulid(): string {
  const now = Date.now();
  let ms = now;
  const tChars: string[] = new Array(10);
  for (let i = 9; i >= 0; i--) {
    tChars[i] = CROCKFORD_CHARS[ms & 0x1f]!;
    ms = Math.floor(ms / 32);
  }
  const rand = crypto.getRandomValues(new Uint8Array(10));
  let bits = BigInt(0);
  for (const byte of rand) {
    bits = (bits << 8n) | BigInt(byte);
  }
  const rChars: string[] = new Array(16);
  for (let i = 15; i >= 0; i--) {
    rChars[i] = CROCKFORD_CHARS[Number(bits & 0x1fn)]!;
    bits >>= 5n;
  }
  return tChars.join("") + rChars.join("");
}

// ─── Hard-stop severity table ─────────────────────────────────────────────────

/** D4-09: hard-stop reason → Flagger severity mapping. */
export const HARD_STOP_SEVERITY: Record<string, "P1" | "P2" | "P3"> = {
  captcha: "P3",
  payment: "P2",
  sold_out: "P3",
  login_wall: "P3",
  tos_block: "P2",
  no_confirmation: "P2",
};

// ─── Core register function ────────────────────────────────────────────────────

/**
 * Register params: initial call or gate-approved re-invocation.
 * - Initial call: eventId + eventUrl (no gateId) → open gate
 * - Re-invocation: eventId + eventUrl + gateId → assert approval, enqueue browser action
 */
export interface RegisterParams {
  eventId: string;
  eventUrl: string;
  gateId?: string;
  /** Injected for tests — skips real Codex read. */
  _codexFields?: CodexRegistrationFields;
  /** Injected for tests — skips real event row lookup. */
  _eventRow?: EventRow;
}

/**
 * runRegister — the core registration logic (testable, injected env).
 *
 * Two modes:
 *   - No gateId: short-circuit check → build artifact → openGate → return gate_opened
 *   - With gateId: assert gate_pending.status='approved' → INSERT browser_action_outbox → return browser_action_enqueued
 */
export async function runRegister(
  env: Env,
  params: RegisterParams,
  date: string,
): Promise<UsherResult> {
  const { eventId, eventUrl, gateId, _codexFields, _eventRow } = params;
  const idemKey = `usher:${eventId}:registered`;

  // ── Already-registered short-circuit ────────────────────────────────────────
  // Check idempotency_keys table FIRST — if the registration already happened,
  // return immediately with no gate, no browser action, no counter.
  const existing = await env.DB.prepare(
    "SELECT 1 FROM idempotency_keys WHERE key = ?",
  )
    .bind(idemKey)
    .first();
  if (existing) {
    return { status: "already_registered" };
  }

  // ── Gate-approved re-invocation (gateId present) ───────────────────────────
  if (gateId) {
    return runContinuation(env, params, gateId, idemKey, date);
  }

  // ── Initial call: resolve event, build artifact, open gate ─────────────────
  // Resolve the event row from D1 (or use the injected override for tests).
  const eventRow: EventRow | null = _eventRow ?? await env.DB.prepare(
    "SELECT id, title, start, end, location, url, status FROM events WHERE id = ?",
  )
    .bind(eventId)
    .first<EventRow>();

  // If the event is unknown in D1, use the URL as the title fallback
  const eventTitle = eventRow?.title ?? eventId;
  const eventStart = eventRow?.start ?? null;
  const eventLocation = eventRow?.location ?? null;
  const eventDate = eventStart ? eventStart.split("T")[0] : date;

  // Read gate timeout from CONFIG (default 24h)
  const timeoutRaw = await env.CONFIG.get("gates.timeout_usher_ms");
  const expiresInMs = timeoutRaw ? parseInt(timeoutRaw, 10) : 86400000;

  // Resolve Codex registration fields (injected in tests; no real Codex call yet)
  // TODO: wire up real readCodex() at go-live (requires drive.readonly token from KV)
  const codexFields: CodexRegistrationFields = _codexFields ?? {
    full_name: "Daniel Chahine",
    email: "chahinedaniel0@gmail.com",
  };

  const registrationFields = buildRegistrationFields(codexFields);

  // Build the gate artifact (price FIRST per UI-SPEC, event, date, location, account, notes)
  // Price is surfaced as "TBD" unless the event row includes a price field (not yet in schema).
  const artifact = JSON.stringify({
    price: "TBD",
    event: eventTitle,
    date: eventDate,
    location: eventLocation ?? "TBD",
    account: codexFields.email,
    notes: `Registration URL: ${eventUrl}`,
    // eventId included for gate Worker re-invoke
    eventId,
    eventUrl,
  });

  const gateBaseUrl = env.GATE_BASE_URL ?? "https://gate.atlas.workers.dev";

  const gateOpts: GateOptions = {
    agent: "Usher",
    action: "event.register",
    target: eventId,
    artifact,
    idempotencyKey: idemKey,
    expiresInMs,
    confirmBaseUrl: gateBaseUrl,
    scopeUsed: "calendar.events",
  };

  // openGate writes gate_pending row + pending audit row atomically,
  // THEN dispatches the ntfy confirm push (best-effort, non-fatal).
  // NTFY_TOPIC and NTFY_TOKEN are passed through via this.env (Usher's env carries them).
  const gate = await openGate(env, gateOpts);

  return { status: "gate_opened", gateId: gate.id };
}

/**
 * runContinuation — handles the gate-approved re-invocation.
 *
 * Security-critical: asserts gate_pending.status='approved' BEFORE any side effect.
 * A continuation invoked without an approved gate row → P1 self-flag + abort (T-04-29).
 */
async function runContinuation(
  env: Env,
  params: RegisterParams,
  gateId: string,
  idemKey: string,
  date: string,
): Promise<UsherResult> {
  const { eventId, eventUrl, _codexFields, _eventRow } = params;

  // Assert gate_pending.status='approved' BEFORE any browser action (T-04-29)
  const gateRow = await env.DB.prepare(
    "SELECT status FROM gate_pending WHERE id = ?",
  )
    .bind(gateId)
    .first<{ status: string }>();

  if (!gateRow || gateRow.status !== "approved") {
    // P1 self-flag: submit attempted without an approved gate row (T-04-29)
    await flag(
      env,
      "P1",
      `Usher: registration attempted without approved gate (gateId=${gateId})`,
      `Gate status: ${gateRow?.status ?? "not found"}. idempotencyKey=${idemKey}`,
      {
        sourceAgent: "Usher",
        kind: "usher:registration_attempted_without_confirmation",
        runId: date,
      },
    );
    // Abort — no browser action, no counter. Return a DISCRIMINATED failure status
    // (never a success-shaped value) so the caller can branch; the flag is the signal.
    return { status: "gate_not_approved" };
  }

  // ── Replay guard (gate-replay protection, T-04-29) ──────────────────────────
  // Atomically claim a single-shot enqueue lock BEFORE inserting the outbox row.
  // An approved gate stays 'approved' permanently, so a re-fired approval callback
  // could otherwise enqueue a SECOND browser action → double registration. The
  // INSERT OR IGNORE on a distinct, event-scoped key is the atomic single-shot:
  // exactly one continuation per event wins (meta.changes===1); replays no-op.
  // NOTE: this key is DISTINCT from `usher:<eventId>:registered` (Steward's counter
  // ledger key) — reusing that here would make Steward treat the increment as a
  // replay and skip the counter bump.
  const enqueueKey = `usher:${eventId}:enqueued`;
  const enqueueLock = await env.DB.prepare(
    "INSERT OR IGNORE INTO idempotency_keys (key, agent, type, entity, op, applied_at) VALUES (?, 'Usher', 'event.register', 'browser_action_outbox', 'append', ?)",
  )
    .bind(enqueueKey, Date.now())
    .run();
  if (enqueueLock.meta.changes === 0) {
    // Already enqueued for this event (approval replay) — do not enqueue again.
    return { status: "already_enqueued" };
  }

  // Resolve Codex registration fields (injected in tests)
  const codexFields: CodexRegistrationFields = _codexFields ?? {
    full_name: "Daniel Chahine",
    email: "chahinedaniel0@gmail.com",
  };

  const registrationFields = buildRegistrationFields(codexFields);
  const fieldsJson = serializeFields(registrationFields);

  // INSERT browser_action_outbox event_fill_submit row (positional ? params — D1 rule)
  const workItemId = ulid();
  await env.DB.prepare(
    `INSERT INTO browser_action_outbox (id, agent, action_type, fields, gate_id, target_url, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
  )
    .bind(workItemId, "Usher", "event_fill_submit", fieldsJson, gateId, eventUrl, Date.now())
    .run();

  return { status: "browser_action_enqueued" };
}

// ─── Outcome handler ───────────────────────────────────────────────────────────

export interface OutcomeParams {
  eventId: string;
  eventUrl: string;
  outcome: {
    status: "success" | "hard_stop" | "error";
    hard_stop_reason?: string;
    confirmation_number?: string;
  };
  /** Injected for tests — skips real Codex / Calendar calls. */
  _calendarTools?: CalendarTools;
  /** Injected for tests — override event title. */
  _eventRow?: EventRow;
}

/**
 * runOutcome — processes the browser action outcome after the daemon drains and acks.
 *
 * - hard_stop → flag() with severity from HARD_STOP_SEVERITY table → no Calendar, no Wire
 * - success with empty confirmation_number → P2 no_confirmation → no Calendar, no Wire
 * - success with non-empty confirmation_number:
 *     → addEventToCalendar() via MCP_GOOGLE binding
 *     → UPDATE events SET status='registered'
 *     → send() Wire increment (events-registered, stable key)
 *     Order: Calendar add + status update THEN Wire emit (never optimistic)
 */
export async function runOutcome(
  env: Env,
  params: OutcomeParams,
  date: string,
): Promise<UsherResult> {
  const { eventId, outcome, _calendarTools, _eventRow } = params;
  const idemKey = `usher:${eventId}:registered`;

  // ── Hard stop: map reason → severity, flag, return (no Calendar, no Wire) ───
  if (outcome.status === "hard_stop") {
    const reason = outcome.hard_stop_reason ?? "unknown";
    const severity = (HARD_STOP_SEVERITY[reason] as "P1" | "P2" | "P3") ?? "P2";
    await flag(
      env,
      severity,
      `Usher: registration hard stop — ${reason}`,
      `Event: ${eventId} | Reason: ${reason}`,
      {
        sourceAgent: "Usher",
        kind: `usher:hard_stop:${reason}`,
        runId: date,
      },
    );
    // No Calendar add, no Wire event, events.status NOT set to 'registered'
    return { status: "outcome_handled" };
  }

  // ── Success with empty confirmation number → P2, not registered ──────────────
  if (outcome.status === "success" && !outcome.confirmation_number) {
    await flag(
      env,
      "P2",
      "Usher: no confirmation number after submit (no_confirmation)",
      `Event: ${eventId} — form submitted but no confirmation # scraped`,
      {
        sourceAgent: "Usher",
        kind: "usher:hard_stop:no_confirmation",
        runId: date,
      },
    );
    // No Calendar add, no Wire event — same as hard_stop no_confirmation
    return { status: "outcome_handled" };
  }

  // ── Success with non-empty confirmation number ─────────────────────────────
  const confirmationNumber = outcome.confirmation_number!;

  // ── Authorization (T-04-30): a confirmation-bearing success must correspond to a
  //    REAL, owner-approved, completed gated browser action for this event. onOutcome
  //    is a side-effecting RPC; without this check a caller could fabricate a
  //    confirmation_number and trigger a Calendar add + counter bump with no gate.
  //    Evidence chain: a browser_action_outbox row (status='done') whose gate_id →
  //    a gate_pending row with target=eventId AND status='approved'.
  const authRow = await env.DB.prepare(
    `SELECT bo.id AS outbox_id
       FROM browser_action_outbox bo
       JOIN gate_pending gp ON gp.id = bo.gate_id
      WHERE bo.agent = 'Usher'
        AND bo.action_type = 'event_fill_submit'
        AND bo.status = 'done'
        AND gp.target = ?
        AND gp.status = 'approved'
      ORDER BY bo.created_at DESC
      LIMIT 1`,
  )
    .bind(eventId)
    .first<{ outbox_id: string }>();

  if (!authRow) {
    // No approved gate + completed browser action for this event → unauthorized/fabricated.
    await flag(
      env,
      "P1",
      `Usher: onOutcome success without an approved+completed browser action (eventId=${eventId})`,
      `confirmation=${confirmationNumber} — no gate_pending(approved)+browser_action_outbox(done) evidence`,
      {
        sourceAgent: "Usher",
        kind: "usher:outcome_without_authorized_action",
        runId: date,
      },
    );
    // Abort — no Calendar add, no counter, events.status untouched.
    return { status: "gate_not_approved" };
  }

  // ── Idempotency (T-04-31): single-shot the side effects so a duplicate outcome
  //    delivery does not double-add the Calendar event (the Wire increment is already
  //    deduped by Steward, but the Calendar add is NOT). Use a DISTINCT lock key —
  //    NOT `usher:<eventId>:registered`, which Steward inserts for the counter ledger.
  const outcomeLockKey = `usher:${eventId}:outcome`;
  const outcomeLock = await env.DB.prepare(
    "INSERT OR IGNORE INTO idempotency_keys (key, agent, type, entity, op, applied_at) VALUES (?, 'Usher', 'event.registered', 'browser_action_outbox', 'append', ?)",
  )
    .bind(outcomeLockKey, Date.now())
    .run();
  if (outcomeLock.meta.changes === 0) {
    // This outcome was already processed (replay) — no second Calendar add / counter.
    return { status: "already_handled" };
  }

  // Resolve event row for Calendar event details
  const eventRow: EventRow | null = _eventRow ?? await env.DB.prepare(
    "SELECT id, title, start, end, location, url, status FROM events WHERE id = ?",
  )
    .bind(eventId)
    .first<EventRow>();

  const eventTitle = eventRow?.title ?? eventId;
  const eventStart = eventRow?.start ?? `${date}T09:00:00-04:00`;
  const eventEnd = eventRow?.end ?? `${date}T10:00:00-04:00`;
  const eventLocation = eventRow?.location ?? undefined;

  // Step 1: Add event to Google Calendar via MCP_GOOGLE (calendar.events, NO delete)
  let calendarEventId: string | undefined;
  const calendarTools: CalendarTools = _calendarTools ?? (env.MCP_GOOGLE as unknown as CalendarTools);
  if (calendarTools) {
    try {
      calendarEventId = await addEventToCalendar(
        calendarTools,
        eventTitle,
        eventStart,
        eventEnd,
        confirmationNumber,
        eventLocation,
      );
    } catch (calErr) {
      // Calendar add failure → P2 flag, but do NOT abort the Wire emit
      // (the registration happened; counter must still reflect it)
      await flag(
        env,
        "P2",
        `Usher: Calendar add failed for ${eventId}`,
        String(calErr),
        { sourceAgent: "Usher", kind: "usher_calendar_failed", runId: date },
      );
    }
  }

  // Step 2: UPDATE events.status='registered' (positional ? params — D1 rule).
  // Guard `AND status != 'registered'` so a replayed outcome cannot churn the row
  // state (defense-in-depth alongside the outcomeLock single-shot above).
  await env.DB.prepare("UPDATE events SET status = ? WHERE id = ? AND status != 'registered'")
    .bind("registered", eventId)
    .run();

  // Step 3: Send Wire event (ONLY after Calendar + status update — never optimistic)
  // Stable idempotency key — Steward INSERT OR IGNORE → meta.changes===0 on replay (T-04-33)
  await send(env, {
    agent: "Usher",
    type: "event.registered",
    entity: "events",
    op: "increment",
    payload: {
      metric: "events-registered",
      by: 1,
      event: eventTitle,
      confirmation: confirmationNumber,
    },
    idempotencyKey: idemKey,
  });

  return { status: "outcome_handled", calendarEventId };
}

// ─── WorkerEntrypoint ─────────────────────────────────────────────────────────

/**
 * Usher WorkerEntrypoint — on-demand gated event registration.
 *
 * Invoked by Atlas or the gate Worker via service binding.
 * Methods: register() (initial + gate-approved re-invocation) + onOutcome() (after daemon ack).
 */
export class Usher extends WorkerEntrypoint<Env> {
  /**
   * register({ eventId, eventUrl[, gateId] }):
   *   - No gateId: short-circuit check → build artifact → openGate → return gate_opened
   *   - With gateId: assert approval → enqueue browser action → return browser_action_enqueued
   *
   * Called initially by Atlas and then again by apps/gate on owner approval.
   */
  async register(params: RegisterParams): Promise<UsherResult> {
    const date = localDate(this.env);
    try {
      return await runRegister(this.env, params, date);
    } catch (err) {
      await flag(
        this.env,
        "P2",
        `Usher register() failed: ${params.eventId}`,
        String(err),
        { sourceAgent: "Usher", kind: "usher_failed", runId: date },
      );
      throw err;
    }
  }

  /**
   * onOutcome({ eventId, eventUrl, outcome }):
   * Process the browser action outcome after the daemon drains and acks.
   * Hard stops → flag, no side effects. Success with confirmation → Calendar add + Wire increment.
   */
  async onOutcome(params: OutcomeParams): Promise<UsherResult> {
    const date = localDate(this.env);
    try {
      return await runOutcome(this.env, params, date);
    } catch (err) {
      await flag(
        this.env,
        "P2",
        `Usher onOutcome() failed: ${params.eventId}`,
        String(err),
        { sourceAgent: "Usher", kind: "usher_failed", runId: date },
      );
      throw err;
    }
  }
}

// ─── Default export (satisfies ExportedHandler) ───────────────────────────────

export default {
  // Usher has no own cron — Atlas drives it via service binding.
  fetch(): Response {
    return new Response("Usher runs via Atlas service binding.", { status: 200 });
  },
} satisfies ExportedHandler<Env>;
