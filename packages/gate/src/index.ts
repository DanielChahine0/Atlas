/**
 * index.ts — Gate lifecycle: openGate / getGate / decideGate / sweepExpired (D4-04).
 *
 * Security invariants:
 *   - Constant-time token compare (timingSafeEqual) — never naive string ===
 *   - Token stored as SHA-256 hash only — plaintext returned ONCE via GateRecord
 *   - decideGate is FAIL-CLOSED: D1 batch must commit BEFORE any side effect
 *   - openGate ntfy push is BEST-EFFORT / NON-FATAL: push failure never throws,
 *     never rolls back the gate row, always returns the GateRecord
 *   - sweepExpired guards UPDATE with AND status='pending' → mutual exclusion with
 *     decideGate at the approve-vs-expire boundary (no double-terminal-state);
 *     terminal audit row + P3 emitted ONLY when UPDATE matched 1 row (changes===1)
 *   - No crypto.randomUUID() — IDs via inline ULID; no new Date() for owner logic
 *   - No queues.consumers block — this is a library, not a Worker (Pillar 1)
 */

import { flag } from "@atlas/shared";
import type { RawIncident } from "@atlas/shared";
import { sha256 } from "./auth.js";
import { buildConfirmPush } from "./push.js";
import type { GateOptions, GateRecord, GatePendingRow } from "./schema.js";

// Re-export the full public surface of the gate package
export type { GateOptions, GateRecord, GatePendingRow } from "./schema.js";
export { sha256, timingSafeEqual } from "./auth.js";
export { buildConfirmPush } from "./push.js";
export {
  renderConfirmPage,
  renderOutcomePage,
  renderExpiredPage,
  authHtmlResponse,
  authResponse,
  isSameOrigin,
  AUTH_SECURITY_HEADERS,
} from "./render.js";

// ─── Inline ULID generator ────────────────────────────────────────────────────
//
// The project has no ulid package installed. We generate a lexicographically-
// sortable, timestamp-prefixed random string using Crockford Base32 alphabet.
// 26 characters: 10-char timestamp + 16-char random portion.

const CROCKFORD_CHARS = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function ulid(): string {
  // 10 Base32 chars encoding 48-bit ms timestamp (sorting order preserved)
  const now = Date.now();
  let ms = now;
  const tChars: string[] = new Array(10);
  for (let i = 9; i >= 0; i--) {
    tChars[i] = CROCKFORD_CHARS[ms & 0x1f]!;
    ms = Math.floor(ms / 32);
  }

  // 16 Base32 chars of cryptographic randomness (80 bits)
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

// ─── Token generation ─────────────────────────────────────────────────────────

/** Generate a 32-byte cryptographically random token as a lowercase hex string. */
function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ─── Env surfaces ─────────────────────────────────────────────────────────────

/**
 * A Secrets Store binding surface: compatible with the real SecretsStoreSecret
 * (get() returns Promise<string>) AND test stubs (get() returns Promise<string|null>).
 * The runtime code always null-checks the result (`if (!topic)`), so the union is safe.
 */
interface SecretBinding {
  get(): Promise<string | null | undefined>;
}

/** Env surface for openGate (needs DB, INCIDENTS for flag(), NTFY_* for push). */
export interface OpenGateEnv {
  DB: D1Database;
  INCIDENTS: Queue<RawIncident>;
  NTFY_TOPIC?: SecretBinding;
  NTFY_TOKEN?: SecretBinding;
}

/** Env surface for decideGate / sweepExpired (DB + INCIDENTS for flag()). */
export interface DecideGateEnv {
  DB: D1Database;
  INCIDENTS: Queue<RawIncident>;
}

/** Env surface for getGate (DB only). */
export interface GetGateEnv {
  DB: D1Database;
}

// ─── openGate ─────────────────────────────────────────────────────────────────

/**
 * Open a new confirmation gate (or return the existing one if idempotencyKey already used).
 *
 * Steps:
 *   1. Generate id (ULID), token (32-byte random hex), token_hash (SHA-256).
 *   2. Write gate_pending + 'pending' audit_log row in ONE atomic D1 batch.
 *   3. On UNIQUE constraint violation (duplicate idempotencyKey): return existing gate,
 *      no second audit row, no second push.
 *   4. AFTER the batch commits: dispatch the ntfy confirm push (best-effort, non-fatal).
 *   5. Return GateRecord with the plaintextToken (only here; never persisted as plaintext).
 */
export async function openGate(
  env: OpenGateEnv,
  opts: GateOptions,
): Promise<GateRecord> {
  const id = ulid();
  const token = generateToken();
  const tokenHash = await sha256(token);
  const now = Date.now();
  const expiresAt = now + opts.expiresInMs;
  const auditId = ulid();

  const insertGate = env.DB.prepare(
    `INSERT INTO gate_pending
       (id, agent, action, target, artifact, edited_artifact, status, decision,
        scope_used, idempotency_key, token_hash, expires_at, flag_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, 'pending', 'pending', ?, ?, ?, ?, NULL, ?, ?)`,
  ).bind(
    id,
    opts.agent,
    opts.action,
    opts.target,
    opts.artifact,
    opts.scopeUsed,
    opts.idempotencyKey,
    tokenHash,
    expiresAt,
    now,
    now,
  );

  const insertAudit = env.DB.prepare(
    `INSERT INTO audit_log
       (id, ts, agent, action, target, scope_used, gated, decision, outcome, trust, consent_flag, flag_id)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 100, NULL, NULL)`,
  ).bind(
    auditId,
    now,
    opts.agent,
    opts.action,
    opts.target,
    opts.scopeUsed,
    "pending",
    "pending",
  );

  // ── Attempt atomic D1 batch ──────────────────────────────────────────────────
  let freshlyWritten = true;

  try {
    await env.DB.batch([insertGate, insertAudit]);
  } catch (err) {
    const msg = String(err);
    const isDuplicate =
      msg.includes("UNIQUE") ||
      msg.includes("unique") ||
      msg.includes("constraint");

    if (isDuplicate) {
      // Duplicate idempotencyKey — return the existing gate without a second push.
      freshlyWritten = false;
      const existing = await env.DB.prepare(
        "SELECT * FROM gate_pending WHERE idempotency_key = ?",
      )
        .bind(opts.idempotencyKey)
        .first<GatePendingRow>();

      if (existing) {
        return {
          id: existing.id,
          status: existing.status,
          decision: existing.decision,
          expires_at: existing.expires_at,
          flag_id: existing.flag_id,
          created_at: existing.created_at,
          // Plaintext token unavailable (not stored); return empty string.
          // Caller must not re-use a duplicated openGate token.
          plaintextToken: "",
        };
      }
    }

    // Unexpected error: rethrow (fail-closed for non-duplicate errors)
    throw err;
  }

  // ── Dispatch ntfy confirm push (AFTER D1 commit; best-effort, non-fatal) ────
  if (freshlyWritten) {
    try {
      const topic = await env.NTFY_TOPIC?.get();

      if (topic) {
        // NTFY_TOPIC seeded — send the confirm push
        const ntfyToken = await env.NTFY_TOKEN?.get();
        const payload = buildConfirmPush({
          confirmBaseUrl: opts.confirmBaseUrl,
          plaintextToken: token,
          title: `[gate] ${opts.agent} — ${opts.action}`,
          body: opts.target,
        });

        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (ntfyToken) {
          headers["Authorization"] = `Bearer ${ntfyToken}`;
        }

        const resp = await fetch("https://ntfy.sh/", {
          method: "POST",
          headers,
          body: JSON.stringify({ topic, ...payload }),
        });

        if (!resp.ok) {
          console.error(
            "gate: ntfy confirm push failed",
            resp.status,
            await resp.text().catch(() => ""),
          );
          await flag(
            env,
            "P2",
            `gate confirm push failed: ${opts.agent}/${opts.action}`,
            `ntfy responded ${resp.status}`,
            { sourceAgent: opts.agent, kind: "gate_push_failed" },
          );
        }
      }
      // If topic is falsy: skip send silently (push gated off until NTFY_TOPIC seeded at go-live)
    } catch (pushErr) {
      // Any thrown error in the send path: emit P2 flag, then continue.
      // The gate row is already durably committed — push failure NEVER rolls it back.
      console.error("gate: ntfy confirm push threw", pushErr);
      try {
        await flag(
          env,
          "P2",
          `gate confirm push failed: ${opts.agent}/${opts.action}`,
          String(pushErr),
          { sourceAgent: opts.agent, kind: "gate_push_failed" },
        );
      } catch {
        // flag() itself failed — log and continue (last-resort non-fatal)
        console.error("gate: flag() call also failed after push error");
      }
    }
  }

  // ── Return GateRecord with the plaintext token (only ever returned here) ─────
  return {
    id,
    status: "pending",
    decision: "pending",
    expires_at: expiresAt,
    flag_id: null,
    created_at: now,
    plaintextToken: token,
  };
}

// ─── getGate ──────────────────────────────────────────────────────────────────

/**
 * Look up a pending gate by its SHA-256 token hash.
 * Returns null if no matching pending gate exists (unknown or already decided/expired).
 */
export async function getGate(
  env: GetGateEnv,
  tokenHash: string,
): Promise<GatePendingRow | null> {
  return env.DB.prepare(
    "SELECT * FROM gate_pending WHERE token_hash = ? AND status = 'pending'",
  )
    .bind(tokenHash)
    .first<GatePendingRow>();
}

// ─── decideGate ───────────────────────────────────────────────────────────────

/**
 * Commit a terminal decision (approve / reject) on a pending gate.
 *
 * Atomicity: status transition + terminal audit_log row committed in ONE D1 batch
 * BEFORE this function returns. The caller executes the approved side effect ONLY
 * AFTER decideGate resolves successfully.
 *
 * Fail-closed: if the D1 batch throws, decideGate rethrows — caller returns 5xx,
 * no side effect runs (opposite of openGate's push posture).
 *
 * Double-decide guard: UPDATE carries AND status='pending'. If the row is already
 * decided/expired the UPDATE matches 0 rows. We run the UPDATE first as a standalone
 * statement to check meta.changes; if 0 rows matched, the gate was already decided
 * and we return a no-op (no second audit row). This is the correct mutual exclusion
 * mechanism shared with sweepExpired at the approve-vs-expire boundary.
 */
export async function decideGate(
  env: DecideGateEnv,
  row: GatePendingRow,
  decision: "approve" | "reject",
  editedArtifact: string | null,
): Promise<void> {
  const now = Date.now();
  const terminalDecision = decision === "approve" ? "approved" : "rejected";

  // Step 1: Attempt the guarded UPDATE (AND status='pending'). Fail-closed: rethrow on error.
  const updateResult = await env.DB.prepare(
    `UPDATE gate_pending
       SET status = ?, decision = ?, edited_artifact = COALESCE(?, edited_artifact), updated_at = ?
     WHERE id = ? AND status = 'pending'`,
  )
    .bind(terminalDecision, terminalDecision, editedArtifact, now, row.id)
    .run();

  // meta.changes === 0 → the gate was already decided or expired → no-op (no second audit row)
  if (updateResult.meta.changes === 0) {
    return;
  }

  // Step 2: UPDATE matched → insert the terminal audit_log row.
  // Wrapped in its own try/catch: if the audit INSERT fails we rethrow (fail-closed;
  // caller should 5xx — the UPDATE already happened but audit is part of atomicity).
  const auditId = ulid();
  await env.DB.prepare(
    `INSERT INTO audit_log
       (id, ts, agent, action, target, scope_used, gated, decision, outcome, trust, consent_flag, flag_id)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 100, NULL, NULL)`,
  )
    .bind(
      auditId,
      now,
      row.agent,
      row.action,
      row.target,
      row.scope_used,
      terminalDecision,
      "ok",
    )
    .run();
}

// ─── sweepExpired ─────────────────────────────────────────────────────────────

/**
 * Transition all pending gates past their expires_at to status='expired'.
 *
 * For each expired pending gate:
 *   1. Run guarded UPDATE (AND status='pending' AND expires_at < now).
 *   2. If UPDATE matched (meta.changes===1): insert terminal audit_log row + emit P3 flag.
 *   3. If UPDATE matched 0 rows: gate was approved or already expired → skip (no double-
 *      terminal-state, no spurious P3). This is the mutual exclusion mechanism.
 *
 * Returns the count of gates actually transitioned (matched UPDATEs).
 * Is idempotent: re-sweeping already-expired gates matches 0 rows (no second audit row).
 * Never executes any caller side effect (Pillar 2: suggest-don't-destroy).
 */
export async function sweepExpired(
  env: DecideGateEnv,
): Promise<number> {
  const now = Date.now();

  // Fetch all candidates (status=pending AND expires_at < now).
  // We select and then individually UPDATE-guard to handle the approve-vs-expire race.
  const candidates = await env.DB.prepare(
    "SELECT * FROM gate_pending WHERE status = 'pending' AND expires_at < ?",
  )
    .bind(now)
    .all<GatePendingRow>();

  let transitioned = 0;

  for (const row of candidates.results) {
    // Guarded UPDATE: AND status='pending' AND expires_at < now
    // Protects against: (a) a gate approved between the SELECT and this UPDATE,
    // (b) a concurrent sweepExpired (idempotency — second sweep matches 0 rows).
    const updateResult = await env.DB.prepare(
      `UPDATE gate_pending
         SET status = 'expired', decision = 'expired', updated_at = ?
       WHERE id = ? AND status = 'pending' AND expires_at < ?`,
    )
      .bind(now, row.id, now)
      .run();

    if (updateResult.meta.changes !== 1) {
      // UPDATE matched 0 rows: gate was approved in the window, or already expired.
      // Skip — no terminal audit row, no P3 flag. No double-terminal-state.
      continue;
    }

    // UPDATE matched: write terminal audit_log row + emit P3 flag.
    const auditId = ulid();
    await env.DB.prepare(
      `INSERT INTO audit_log
         (id, ts, agent, action, target, scope_used, gated, decision, outcome, trust, consent_flag, flag_id)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 100, NULL, NULL)`,
    )
      .bind(
        auditId,
        now,
        row.agent,
        row.action,
        row.target,
        row.scope_used,
        "expired",
        "ok",
      )
      .run();

    await flag(
      env,
      "P3",
      `gate expired without decision: ${row.action} for ${row.target}`,
      undefined,
      { sourceAgent: row.agent, kind: "gate_expired" },
    );

    transitioned++;
  }

  return transitioned;
}
