/**
 * index.ts — Gate Worker: confirm page, expiry sweep, browser-action transport (D4-03).
 *
 * Architecture:
 * - fetch(): serves GET/POST /confirm (token-gated confirm page) + /browser/poll + /browser/ack
 * - scheduled(): runs sweepExpired() — pending gates past expires_at become 'expired'
 *
 * Security invariants (threat model T-04-11 through T-04-17):
 * - T-04-11: decideGate atomic batch commits BEFORE any side effect (fail-closed)
 * - T-04-12: isSameOrigin() fail-closed 403 on POST /confirm (CSRF guard)
 * - T-04-13: getGate requires status='pending'; expires_at checked; 410 on expired/decided
 * - T-04-14: constant-time Bearer check for /browser/poll + /browser/ack
 * - T-04-17: NO queues.consumers — gate is Wire PRODUCER only (Pillar 1)
 *
 * Pillar 1: this Worker is a Wire PRODUCER only. It does NOT consume atlas-wire or
 * atlas-incidents. Steward remains the sole atlas-wire consumer.
 *
 * Note: NTFY_TOPIC/NTFY_TOKEN are intentionally absent — the confirm-push SEND lives in
 * openGate() (04-01), called by the AGENTS. apps/gate is the RECIPIENT side only.
 */

import { flag } from "@atlas/shared";
import type { RawIncident } from "@atlas/shared";
import {
  getGate,
  decideGate,
  sweepExpired,
  sha256,
  timingSafeEqual,
  renderConfirmPage,
  renderOutcomePage,
  renderExpiredPage,
  authHtmlResponse,
  authResponse,
  isSameOrigin,
} from "@atlas/gate";
import type { GatePendingRow, BrowserActionOutcome } from "@atlas/gate/schema";

// ─── Env type ─────────────────────────────────────────────────────────────────

/** SecretsStoreSecret-compatible interface (fail-closed if binding unseeded). */
interface SecretBinding {
  get(): Promise<string | null | undefined>;
}

/**
 * Gate Worker's local Env — bindings declared in wrangler.jsonc.
 * No NTFY bindings — the confirm-push SEND lives in openGate on the AGENTS.
 */
export interface Env {
  /** D1 atlas-db (gate_pending + browser_action_outbox + audit_log). */
  DB: D1Database;
  /** Wire PRODUCER binding — gate emits no Wire events directly (agents do after re-invoke). */
  WIRE: Queue<unknown>;
  /** Incidents PRODUCER binding — for P2/P3 flag() calls. */
  INCIDENTS: Queue<RawIncident>;
  /** KV config/flags. */
  CONFIG: KVNamespace;
  /** Bearer token for /browser/poll + /browser/ack (Secrets Store async binding). */
  GATE_CONFIRM_TOKEN?: SecretBinding;
  /** Stable confirm-page base URL (from [vars], not a secret). */
  GATE_BASE_URL?: string;
  /** Service binding to apps/usher — re-invoked on gate approval for Usher actions. */
  USHER?: {
    register(params: { gateId: string; eventId: string; eventUrl: string }): Promise<unknown>;
    onOutcome(params: { eventId: string; eventUrl: string; outcome: unknown }): Promise<unknown>;
  };
  /** Service binding to apps/envoy — re-invoked on gate approval for Envoy actions. */
  ENVOY?: {
    onApproved(params: {
      gateId: string;
      projectSlug: string;
      approvedTargets: string[];
      editedArtifact: string | null;
    }): Promise<unknown>;
  };
  /** Service binding to apps/sundial — re-invoked on gate approval for calendar removals. */
  SUNDIAL?: {
    applyRemoval(params: { gateId: string; eventId: string }): Promise<unknown>;
  };
}

// ─── Bearer auth helper ────────────────────────────────────────────────────────

/**
 * Validate the Bearer token for /browser/poll + /browser/ack.
 * Returns the token if valid, null if invalid/unseeded.
 * Fail-closed: returns null if the binding is unseeded (so caller returns 401).
 */
async function validateBearerToken(
  request: Request,
  env: Env,
): Promise<boolean> {
  const token = await env.GATE_CONFIRM_TOKEN?.get();
  if (!token) return false; // fail-closed: unseeded binding → 401
  const auth = request.headers.get("Authorization") ?? "";
  return timingSafeEqual(auth, `Bearer ${token}`);
}

// ─── Agent re-invoke helper ────────────────────────────────────────────────────

/**
 * Re-invoke the owning agent after a gate approval.
 * The service binding RPC call is executed AFTER decideGate commits.
 * If the re-invoke throws: records a P2 flag but does NOT roll back the gate decision.
 * The gate decision (status=approved) is permanent — the re-invoke is a best-effort side effect.
 *
 * Returns true on success, false on error (caller renders appropriate outcome page).
 */
async function reinvokeAgent(
  env: Env,
  row: GatePendingRow,
  editedArtifact: string | null,
): Promise<boolean> {
  try {
    switch (row.agent) {
      case "Usher": {
        if (!env.USHER) {
          // Binding absent — flag P2, record as error but don't fail-open
          await flag(
            env,
            "P2",
            `Gate approval: USHER service binding absent for gate ${row.id}`,
            `action=${row.action}, target=${row.target}`,
            { sourceAgent: "Gate", kind: "gate_reinvoke_failed" },
          ).catch(() => {});
          return false;
        }
        // Parse artifact for Usher re-invoke params
        let artifact: { eventId?: string; eventUrl?: string } = {};
        try {
          artifact = JSON.parse(row.artifact) as { eventId?: string; eventUrl?: string };
        } catch {
          // artifact may not be JSON — use target as eventId fallback
        }
        await env.USHER.register({
          gateId: row.id,
          eventId: artifact.eventId ?? row.target,
          eventUrl: artifact.eventUrl ?? row.target,
        });
        return true;
      }

      case "Envoy": {
        if (!env.ENVOY) {
          await flag(
            env,
            "P2",
            `Gate approval: ENVOY service binding absent for gate ${row.id}`,
            `action=${row.action}, target=${row.target}`,
            { sourceAgent: "Gate", kind: "gate_reinvoke_failed" },
          ).catch(() => {});
          return false;
        }
        // Parse artifact for Envoy re-invoke params
        let artifact: { projectSlug?: string; approvedTargets?: string[] } = {};
        try {
          artifact = JSON.parse(row.artifact) as {
            projectSlug?: string;
            approvedTargets?: string[];
          };
        } catch {
          // fallback
        }
        await env.ENVOY.onApproved({
          gateId: row.id,
          projectSlug: artifact.projectSlug ?? row.target,
          approvedTargets: artifact.approvedTargets ?? [],
          editedArtifact: editedArtifact ?? row.edited_artifact ?? null,
        });
        return true;
      }

      case "Sundial": {
        if (!env.SUNDIAL) {
          await flag(
            env,
            "P2",
            `Gate approval: SUNDIAL service binding absent for gate ${row.id}`,
            `action=${row.action}, target=${row.target}`,
            { sourceAgent: "Gate", kind: "gate_reinvoke_failed" },
          ).catch(() => {});
          return false;
        }
        await env.SUNDIAL.applyRemoval({
          gateId: row.id,
          eventId: row.target,
        });
        return true;
      }

      default:
        // Unknown agent — flag P2, no re-invoke
        await flag(
          env,
          "P2",
          `Gate approval: unknown agent ${String(row.agent)} for gate ${row.id}`,
          `action=${row.action}, target=${row.target}`,
          { sourceAgent: "Gate", kind: "gate_reinvoke_failed" },
        ).catch(() => {});
        return false;
    }
  } catch (err) {
    // Re-invoke threw — flag P2, record error. The gate decision is already committed.
    await flag(
      env,
      "P2",
      `Gate re-invoke failed after approval: ${row.agent}/${row.action}`,
      String(err),
      { sourceAgent: "Gate", kind: "gate_reinvoke_failed" },
    ).catch(() => {});
    return false;
  }
}

// ─── Main Worker ───────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // ── /confirm ──────────────────────────────────────────────────────────────
    if (url.pathname === "/confirm") {
      // Both GET and POST start by looking up the gate via token hash.
      // Missing token → 410 (indistinguishable from expired/unknown — fail-closed)
      const token = url.searchParams.get("t");
      if (!token) {
        return authHtmlResponse(renderExpiredPage(), { status: 410 });
      }

      const tokenHash = await sha256(token);
      const row = await getGate(env, tokenHash);

      // Unknown token, already decided/expired gate → 410
      if (!row || Date.now() > row.expires_at) {
        return authHtmlResponse(renderExpiredPage(), { status: 410 });
      }

      // ── GET /confirm ──────────────────────────────────────────────────────
      if (request.method === "GET") {
        return authHtmlResponse(renderConfirmPage(row));
      }

      // ── POST /confirm ─────────────────────────────────────────────────────
      if (request.method === "POST") {
        // T-04-12: CSRF guard — must be same-origin
        if (!isSameOrigin(request)) {
          return authResponse("Forbidden", { status: 403 });
        }

        // Parse form body
        let decision: string | null = null;
        let editedArtifact: string | null = null;
        try {
          const form = await request.formData();
          decision = form.get("decision") as string | null;
          editedArtifact = form.get("edited_artifact") as string | null;
        } catch {
          return authResponse("Bad Request: malformed form body", { status: 400 });
        }

        // Validate decision ∈ {approve, reject}
        if (decision !== "approve" && decision !== "reject") {
          return authResponse("Bad Request: decision must be 'approve' or 'reject'", {
            status: 400,
          });
        }

        // T-04-11: Commit gate decision BEFORE any side effect.
        // decideGate rethrows on D1 error → caller returns 500 → fail-closed.
        // Returns true when the status actually transitioned; false on no-op (already-decided).
        let transitioned: boolean;
        try {
          transitioned = await decideGate(env, row, decision, editedArtifact);
        } catch (err) {
          console.error("gate: decideGate failed", row.id, err);
          return authHtmlResponse(
            renderOutcomePage("error"),
            { status: 500 },
          );
        }

        // On approve: re-invoke the owning agent via service binding ONLY when the
        // status actually transitioned (WR-03: concurrent double-POST → only one re-invoke).
        // The gate decision is already committed. A failed re-invoke is non-fatal
        // (recorded as P2 flag) — we do NOT roll back the gate decision.
        if (decision === "approve") {
          if (transitioned) {
            await reinvokeAgent(env, row, editedArtifact);
          }
          return authHtmlResponse(renderOutcomePage("approved"));
        }

        // On reject: no re-invoke, return rejected outcome
        return authHtmlResponse(renderOutcomePage("rejected"));
      }

      return authResponse("Method Not Allowed", { status: 405 });
    }

    // ── /browser/poll ─────────────────────────────────────────────────────────
    if (url.pathname === "/browser/poll" && request.method === "GET") {
      // T-04-14: constant-time Bearer auth
      if (!(await validateBearerToken(request, env))) {
        return new Response("Unauthorized", { status: 401 });
      }

      const now = Date.now();
      // Claim pending browser_action_outbox rows (UPDATE + SELECT)
      const rows = await env.DB.prepare(
        "SELECT * FROM browser_action_outbox WHERE status = 'pending' LIMIT 10",
      ).all<{
        id: string;
        agent: string;
        action_type: string;
        fields: string;
        gate_id: string;
        target_url: string;
        status: string;
      }>();

      // Claim each row (UPDATE status='claimed', claimed_at=now, AND status='pending' for lease guard)
      const claimed: typeof rows.results = [];
      for (const row of rows.results) {
        const result = await env.DB.prepare(
          "UPDATE browser_action_outbox SET status = 'claimed', claimed_at = ? WHERE id = ? AND status = 'pending'",
        )
          .bind(now, row.id)
          .run();
        if (result.meta.changes === 1) {
          claimed.push(row);
        }
      }

      return new Response(JSON.stringify({ items: claimed }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    // ── /browser/ack ──────────────────────────────────────────────────────────
    if (url.pathname === "/browser/ack" && request.method === "POST") {
      // T-04-14: constant-time Bearer auth
      if (!(await validateBearerToken(request, env))) {
        return new Response("Unauthorized", { status: 401 });
      }

      let id: string;
      let outcome: BrowserActionOutcome;
      try {
        const body = await request.json<unknown>();
        if (
          typeof body !== "object" ||
          body === null ||
          typeof (body as Record<string, unknown>).id !== "string"
        ) {
          return new Response("Bad Request: `id` must be a string", { status: 400 });
        }
        id = (body as Record<string, unknown>).id as string;
        const rawOutcome = (body as Record<string, unknown>).outcome;
        // WR-05: validate outcome is a non-null object
        if (typeof rawOutcome !== "object" || rawOutcome === null) {
          return new Response(
            "Bad Request: `outcome` must be a non-null object",
            { status: 400 },
          );
        }
        // WR-05: validate outcome.id matches the row id to prevent mismatched payloads
        const outcomeId = (rawOutcome as Record<string, unknown>).id;
        if (outcomeId !== id) {
          return new Response(
            "Bad Request: `outcome.id` must match `id`",
            { status: 400 },
          );
        }
        outcome = rawOutcome as BrowserActionOutcome;
      } catch {
        return new Response("Bad Request: malformed JSON", { status: 400 });
      }

      if (!id) {
        return new Response("Bad Request: `id` is required", { status: 400 });
      }

      const terminalStatus =
        outcome?.status === "success"
          ? "done"
          : outcome?.status === "hard_stop"
            ? "failed"
            : "failed";

      // Idempotent ack: AND status='claimed' guard (lease check — prevents double-ack)
      const ackResult = await env.DB.prepare(
        `UPDATE browser_action_outbox
           SET status = ?, outcome = ?
         WHERE id = ? AND status = 'claimed'`,
      )
        .bind(terminalStatus, JSON.stringify(outcome), id)
        .run();

      // WR-02: re-invoke the owning agent so the registration flow completes.
      // For Usher event_fill_submit rows: call onOutcome so addEventToCalendar + Wire
      // increment run. Only invoke if the UPDATE actually matched (ackResult.meta.changes===1)
      // to avoid double-invoke on replayed acks.
      if (ackResult.meta.changes === 1 && env.USHER) {
        try {
          // Look up the acked row's agent and gate_id to resolve eventId
          const ackedRow = await env.DB.prepare(
            "SELECT agent, action_type, gate_id, target_url FROM browser_action_outbox WHERE id = ?",
          )
            .bind(id)
            .first<{ agent: string; action_type: string; gate_id: string; target_url: string }>();

          if (ackedRow?.agent === "Usher" && ackedRow.action_type === "event_fill_submit") {
            // Resolve eventId via gate_pending.target (the gate's target = eventId)
            const gateRow = await env.DB.prepare(
              "SELECT target FROM gate_pending WHERE id = ?",
            )
              .bind(ackedRow.gate_id)
              .first<{ target: string }>();

            if (gateRow) {
              await env.USHER.onOutcome({
                eventId: gateRow.target,
                eventUrl: ackedRow.target_url,
                outcome,
              });
            }
          }
        } catch (reinvokeErr) {
          // Re-invoke failure is non-fatal — flag P2 but do NOT roll back the ack.
          // The ack is durably committed; the onOutcome can be retried manually.
          await flag(
            env,
            "P2",
            `Gate ack: Usher.onOutcome re-invoke failed for outbox row ${id}`,
            String(reinvokeErr),
            { sourceAgent: "Gate", kind: "gate_reinvoke_failed" },
          ).catch(() => {});
        }
      }

      return new Response("OK", { status: 200 });
    }

    return new Response("Not found", { status: 404 });
  },

  /**
   * Scheduled cron handler — runs sweepExpired() to transition pending gates
   * past their expires_at to status='expired'.
   *
   * Fired by the hourly cron (0 * * * *) in wrangler.jsonc.
   * Not owner-local-time-sensitive (compares epoch ms, not local time).
   */
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await sweepExpired(env);
  },
} satisfies ExportedHandler<Env>;
