---
phase: 04-outward-gated
reviewed: 2026-06-08T00:00:00Z
depth: standard
files_reviewed: 12
files_reviewed_list:
  - apps/gate/src/index.ts
  - daemon/src/browser-drain.ts
  - daemon/src/browser-runner.ts
  - daemon/src/main.ts
  - apps/sundial/src/index.ts
  - apps/usher/src/index.ts
  - apps/usher/src/fill.ts
  - apps/usher/src/calendar.ts
  - apps/envoy/src/index.ts
  - apps/envoy/src/draft.ts
  - apps/envoy/src/github.ts
  - apps/envoy/src/browser.ts
findings:
  critical: 2
  warning: 7
  info: 4
  total: 13
status: issues_found
---

# Phase 4: Code Review Report

**Reviewed:** 2026-06-08
**Depth:** standard
**Files Reviewed:** 12
**Status:** issues_found

## Summary

Phase 4 builds the owner-confirmation gate surface for irreversible outward actions
(Usher event registration, Envoy brand publish, Sundial calendar removal). I reviewed
the gate Worker, the gate library it calls, the local daemon browser drain/runner, and
the three owning agents.

The good news: the **gate-enforcement core is sound**. `decideGate` commits the
`status=pending → approved/rejected` transition behind an `AND status='pending'` guard
before any side effect, `getGate` only resolves `status='pending'` rows, `sweepExpired`
shares the same mutual-exclusion guard, the Bearer and CSRF checks fail closed, Pillar 1
holds (no `consumers` block on `atlas-wire` anywhere), and the Usher/Envoy continuation
paths carry the hardened RPC-authorization + single-shot + distinct-key pattern described
in the context. The browser runner never auto-submits Envoy prefills and hard-stops
captcha/payment before any irreversible step.

The bad news: **two of the three gate→approve→re-invoke wirings are broken end-to-end.**

1. The gate re-invokes Envoy via a **method that does not exist on Envoy** (`publish`
   instead of `onApproved`), with the wrong argument shape — so **no Envoy publish ever
   fires after approval**, and the per-target approve/skip selections are silently dropped.
2. Sundial's `applyRemoval` is the **one continuation that does NOT replicate the
   hardened pattern**: it performs no `gate_pending.status='approved'` authorization check
   and has no single-shot replay lock — its only protection is the gate Worker calling it.
   It is also dead on the happy path because the gate never injects the required
   `RemovalTools`.

Separately, **`Usher.onOutcome` has no caller anywhere** — the Calendar-add + Wire-increment
half of a successful registration is unreachable, so a registered event never lands on the
calendar or bumps the counter. None of these are fail-open (the failure direction is
"nothing happens"), so Pillar 2 is not violated, but the feature is non-functional and the
broken wiring masks the agents' otherwise-correct authorization logic.

## Critical Issues

### CR-01: Gate re-invokes a non-existent Envoy method (`publish`) — every Envoy approval is dead, and per-target owner choices are dropped

**File:** `apps/gate/src/index.ts:164-169` (and the `ENVOY` binding type at `67-75`)
**Issue:**
The gate's `reinvokeAgent` calls the Envoy service binding like this:

```ts
await env.ENVOY.publish({
  gateId: row.id,
  projectSlug: artifact.projectSlug ?? row.target,
  approvedTargets: artifact.approvedTargets ?? [],
  editedArtifact: editedArtifact ?? row.edited_artifact,
});
```

But Envoy's `WorkerEntrypoint` exposes two methods (`apps/envoy/src/index.ts:527`, `:549`):
- `publish(params: { projectName: string })` — the **initial** call from Atlas, and
- `onApproved(params: { gateId, projectSlug, approvedTargets, editedArtifact })` — the
  **gate-approved continuation** the gate is supposed to invoke.

The gate calls `publish`, not `onApproved`, and passes continuation params. At runtime
`publish` reads `params.projectName` (= `undefined`) and calls `slugify(undefined)`
(`draft.ts:58`), which throws on `undefined.toLowerCase()`. The throw is caught by
`reinvokeAgent`'s `try/catch` → a P2 flag is recorded, the gate stays `approved`, and
**no brand publish ever happens**. The owner's per-target approve/skip selections
(`approvedTargets`) and any edited drafts are silently discarded.

Worse, `gate.Env.ENVOY` *declares* `publish(params: { gateId; projectSlug; approvedTargets;
editedArtifact })` (lines 68-75), which does **not** match the real `Envoy.publish`
signature — but because this crosses a service-binding boundary, `tsc` does not catch the
mismatch, so the bug is invisible at typecheck time. (For comparison, the Usher branch at
`:135` correctly calls `env.USHER.register(...)`, which is a real Usher method.)

**Fix:** Call `onApproved` and fix the binding type to match the real method:
```ts
// Env interface
ENVOY?: {
  onApproved(params: {
    gateId: string;
    projectSlug: string;
    approvedTargets: string[];
    editedArtifact: string | null;
  }): Promise<unknown>;
};

// reinvokeAgent, Envoy branch
await env.ENVOY.onApproved({
  gateId: row.id,
  projectSlug: artifact.projectSlug ?? row.target,
  approvedTargets: artifact.approvedTargets ?? [],
  editedArtifact: editedArtifact ?? row.edited_artifact,
});
```
Add an integration test that drives a real (or test-double) Envoy binding through the
gate so the method-name contract is exercised, not just the loosely-typed interface.

### CR-02: Sundial `applyRemoval` performs no gate-approval authorization and has no replay lock (unlike Usher/Envoy)

**File:** `apps/sundial/src/index.ts:213-252`
**Issue:**
Usher's `runContinuation` (`apps/usher/src/index.ts:276-298`) and Envoy's `runOnApproved`
(`apps/envoy/src/index.ts:257-277`) both re-query `gate_pending` and assert
`status === 'approved'` before doing anything, then claim a single-shot lock. Sundial's
`applyRemoval` does **neither**:

```ts
async applyRemoval(params: { gateId; eventId; tools? }) {
  ...
  await injectedTools.removeEvent(eventId);   // no gate lookup, no status check, no lock
  return { removed: true, eventId };
}
```

It accepts `gateId` but never reads `gate_pending`, never verifies the gate is approved,
and has no `INSERT OR IGNORE` single-shot guard. Today the only thing standing between a
caller and an autonomous **irreversible calendar delete** is the gate Worker choosing to
call `applyRemoval` only after `decideGate`. That is exactly the single-point-of-trust the
Usher/Envoy hardening was added to remove — `applyRemoval` is a public `WorkerEntrypoint`
RPC method, so any binding holder (or a future caller bug) can invoke it with an arbitrary
`eventId` and delete a calendar event with no approved gate. Because `decideGate` returns
`void` and the gate calls `reinvokeAgent` unconditionally on approve (see WR-03), a
TOCTOU double-POST could also drive a second `applyRemoval` for the same `gateId` with no
local lock to stop it.

(Note: this path is also currently inert because the gate never injects `RemovalTools` —
see WR-01 — so removal always fails closed with a P2. That masks the missing
authorization but does not fix it; once `RemovalTools` is wired the gap is live.)

**Fix:** Mirror the Usher/Envoy pattern inside `applyRemoval`, before calling
`removeEvent`:
```ts
// Guard 1: RPC authorization — the gate must be approved AND target this eventId
const gateRow = await this.env.DB.prepare(
  "SELECT status, target FROM gate_pending WHERE id = ?",
).bind(gateId).first<{ status: string; target: string }>();
if (!gateRow || gateRow.status !== "approved" || gateRow.target !== eventId) {
  await flag(this.env, "P1",
    `Sundial: removal attempted without approved gate (gateId=${gateId})`,
    `status=${gateRow?.status ?? "not found"} target=${gateRow?.target ?? "?"} eventId=${eventId}`,
    { sourceAgent: "Sundial", kind: "calendar_remove_without_confirmation" });
  return; // abort — no delete
}
// Guard 2: single-shot replay lock (DISTINCT key, not the openGate idempotencyKey)
const lock = await this.env.DB.prepare(
  "INSERT OR IGNORE INTO idempotency_keys (key, agent, type, entity, op, applied_at) VALUES (?, 'Sundial', 'calendar.remove', 'calendar', 'delete', ?)",
).bind(`sundial:remove:${eventId}:applied`, Date.now()).run();
if (lock.meta.changes === 0) return; // already removed for this gate
```
Add a failure-path test asserting that a non-`approved` gate (or mismatched target) yields
the P1 flag and **no** `removeEvent` call.

## Warnings

### WR-01: Sundial gate approval can never execute — gate Worker never injects `RemovalTools`

**File:** `apps/gate/src/index.ts:184-187`, `apps/sundial/src/index.ts:213-235`
**Issue:** The gate calls `env.SUNDIAL.applyRemoval({ gateId, eventId })` with **no
`tools`**. Sundial's `applyRemoval` requires `params.tools` (`RemovalTools`); when absent
it flags P2 and throws ("no removal tools injected"). The gate's `SUNDIAL` binding type
(`apps/gate/src/index.ts:77-79`) does not even include a `tools` field, and a service
binding cannot pass a live function object across the RPC boundary anyway. Result: **every
approved Sundial calendar-removal fails closed with a P2** — the feature is non-functional.
This is fail-safe (no wrong delete), but the calendar-removal capability does not work.
**Fix:** Wire the live removal inside Sundial itself (resolve the OAuth-backed
`calendar.events` delete tool from env/binding in `applyRemoval`) rather than expecting the
gate Worker to inject a callback. The gate cannot serialize a `RemovalTools` object over RPC.

### WR-02: `Usher.onOutcome` is never invoked — Calendar add + Wire increment are unreachable (registration counter never bumps, event never lands on calendar)

**File:** `apps/usher/src/index.ts:569` (definition), `apps/gate/src/index.ts:342-387` (ack handler)
**Issue:** The daemon acks browser outcomes to `POST /browser/ack`, which only updates the
`browser_action_outbox` row (`status`, `outcome`). Nothing — not the gate Worker, not the
daemon, not Atlas — ever calls `Usher.onOutcome`. A repo-wide search finds zero callers
outside Usher's own file/tests. So after a successful event registration the daemon scrapes
the confirmation number, but `addEventToCalendar()` and the `events-registered` Wire
increment (steps 3 of the documented flow) never run: no calendar event, no counter bump,
`events.status` stays unset. The well-written authorization/idempotency logic inside
`runOutcome` (lines 415-466) is dead code as wired.
**Fix:** In the gate Worker's `/browser/ack` handler, after marking the outbox row
terminal, look up the row's `agent`/`gate_id` and re-invoke the owning agent
(`env.USHER.onOutcome({ eventId, eventUrl, outcome })`) for `agent='Usher'`,
`action_type='event_fill_submit'`, mirroring the approval re-invoke pattern. Add an
integration test covering ack → onOutcome → calendar + Wire.

### WR-03: `decideGate` returns `void`; gate re-invokes the agent even when the decision was a no-op (concurrent double-POST → double re-invoke)

**File:** `apps/gate/src/index.ts:270-292`, `packages/gate/src/index.ts:318-339`
**Issue:** `decideGate` UPDATEs under `AND status='pending'` and silently returns when
`meta.changes === 0` (already decided). But it returns `void`, so the POST handler cannot
tell a real transition from a no-op, and it calls `reinvokeAgent` **unconditionally** on
`decision === "approve"` (line 284). `getGate` blocks a *sequential* second POST (it only
returns `status='pending'`), but two **concurrent** POSTs can both pass `getGate`, both
reach `decideGate` (one updates, one no-ops), and **both** call `reinvokeAgent`. The
downstream single-shot locks (Usher `usher:<id>:enqueued`, Envoy per-target) absorb this,
but Sundial has none (CR-02), and relying on downstream locks for a TOCTOU the gate could
detect is fragile.
**Fix:** Have `decideGate` return whether it actually transitioned (e.g.
`Promise<boolean>` from `updateResult.meta.changes === 1`), and only call `reinvokeAgent`
when the transition was real:
```ts
const transitioned = await decideGate(env, row, decision, editedArtifact);
if (decision === "approve" && transitioned) {
  await reinvokeAgent(env, row, editedArtifact);
}
```

### WR-04: Daemon opens TWO persistent Chromium contexts on the same profile dir (SingletonLock conflict)

**File:** `daemon/src/main.ts:46-58`, `daemon/src/browser-runner.ts:224-232`
**Issue:** `main()` wraps the browser loop in `withBrowserContext(browserCfg.browserProfilePath, ...)`,
which `launchPersistentContext(profilePath)` and clears the stale lock. But the injected
`runBrowserAction: (item, cfg) => runBrowserAction(item, cfg)` passes **no** `_page`, so
each item causes `runBrowserAction` to call `chromium.launchPersistentContext(cfg.browserProfilePath, ...)`
**again** on the same profile dir (`browser-runner.ts:226`). Two persistent contexts on one
Chromium profile contend on `SingletonLock` — the second launch typically fails or corrupts
the profile. The outer `_ctx` from `withBrowserContext` is never actually used (the callback
ignores it). The "context persists across items" comment in `main.ts:51-53` is not what the
code does — every item opens (and the `finally` closes) its own fresh context.
**Fix:** Pass the persistent context's page into `runBrowserAction` instead of letting it
open a second context. Either thread `_ctx` through (open one page per item from the shared
context) or drop `withBrowserContext` in `main.ts` and let `runBrowserAction` own the single
context. Do not launch two persistent contexts against the same profile path.

### WR-05: `/browser/ack` ignores the row's claimed `agent` and trusts the daemon's `outcome.status` to set terminal state without validating the `outcome.id` matches `id`

**File:** `apps/gate/src/index.ts:349-386`
**Issue:** Two related robustness gaps:
(a) The body is cast `outcome = body.outcome as BrowserActionOutcome` with no validation —
a missing/garbage `outcome` makes `outcome?.status` `undefined`, which falls through to
`terminalStatus = "failed"` (acceptable) but is then `JSON.stringify`'d and stored as the
row outcome with no schema check.
(b) The ack matches only on `id` + `status='claimed'`; it never checks that
`outcome.id === id`. A daemon (or a replayed body) can ack item A's row with item B's
outcome payload, persisting a mismatched `confirmation_number`/status onto the wrong row.
Since the (future) `onOutcome` consumer reads `outcome` from this row, a swapped payload
could attach the wrong confirmation to the wrong event.
**Fix:** Validate `outcome` against the `BrowserActionOutcome` zod schema, and reject
(400) when `typeof outcome !== "object"` or `outcome.id !== id`. Keep the
`AND status='claimed'` lease guard.

### WR-06: Envoy partial-failure lock rollback can race a concurrent retry (lock deleted while another invocation believes it holds it)

**File:** `apps/envoy/src/index.ts:441-449`
**Issue:** On a per-target failure, `runOnApproved` `DELETE`s the per-target lock so a
future retry can re-attempt. But the lock is the single-shot guard: if two approval
re-invokes run concurrently (see WR-03), invocation #1 can `INSERT OR IGNORE` the lock
(wins), start publishing, fail, and `DELETE` the lock — meanwhile invocation #2's
`INSERT OR IGNORE` saw the lock present (skipped, counted as "succeeded" at line 339) and
returned without publishing. Net result: the target is reported succeeded by #2 but was
actually rolled back by #1, and never published. The rollback-on-failure pattern is unsafe
under concurrency.
**Fix:** Do not delete the lock on failure. Instead, record per-target outcome state
(e.g. a `status` column or a distinct `:failed` marker) so a retry is an explicit
operation, not an implicit "lock is gone, try again." Combine with WR-03's
transition-gated single re-invoke to remove the concurrency in the first place.

### WR-07: `serializeFields` 2FA stripper only catches bare 6–8 digit strings; `redactSensitive` only catches keyworded codes — neither covers all field shapes

**File:** `apps/usher/src/fill.ts:104-128`, `apps/envoy/src/browser.ts:129-138`
**Issue:** These are the last-line defenses that put values into `browser_action_outbox.fields`
(what the daemon types into live forms). Usher's `stripSensitive` only blanks values matching
`/^\d{6,8}$/` (a *whole* string of 6–8 digits) — a value like `"code 123456"` or
`"123456 "` (trailing space) or a 5- or 9-digit code passes through. Envoy's `redactSensitive`
only redacts digits preceded by `code|otp|pin|2fa|token` keywords. Per CLAUDE.md the
security posture is "a prompt/regex alone is NOT sufficient." These are defense-in-depth and
the field set is structurally constrained to Codex brand/registration fields (so the real
risk is low), but the guards are narrower than their doc comments claim ("any value that
looks like a 2FA code").
**Fix:** Tighten the Usher matcher to also catch embedded codes
(`/(?<!\d)\d{6,8}(?!\d)/` after trimming) and document the precise coverage. Better: rely
primarily on the structural guarantee (only known Codex keys are ever serialized) and treat
the regex as a tripwire that *flags* (P2) when it fires, rather than silently blanking.

## Info

### IN-01: ULID generator duplicated verbatim across four files

**File:** `apps/usher/src/index.ts:112-135`, `apps/envoy/src/index.ts:107-130`, `apps/envoy/src/browser.ts:18-41`, `packages/gate/src/index.ts:43-68`
**Issue:** The identical inline `ulid()` (and `CROCKFORD_CHARS`) is copy-pasted four times.
The gate package already exports gate types; a shared `ulid()` would avoid drift.
**Fix:** Export `ulid()` from a shared package (e.g. `@atlas/shared` or `@atlas/gate`) and
import it; delete the copies.

### IN-02: Daemon poll/ack Bearer is `GATE_CONFIRM_TOKEN` (secret `gate-confirm-token`) but the daemon sends `ATLAS_BRIDGE_TOKEN` — same value required, different names

**File:** `apps/gate/wrangler.jsonc:46`, `daemon/src/browser-drain.ts:65,86`
**Issue:** The gate validates `/browser/poll` + `/browser/ack` against the Secrets Store
binding `GATE_CONFIRM_TOKEN` (secret name `gate-confirm-token`), while the daemon sends
`Bearer ${ATLAS_BRIDGE_TOKEN}` (the same token it uses for the Obsidian bridge). These are
two differently-named values that must hold the **identical** secret for the browser drain
to authenticate. This is a deploy-time footgun, not a code bug.
**Fix:** Document the equality requirement at the binding site, or rename one so the
coupling is explicit (e.g. both `ATLAS_BRIDGE_TOKEN`). Add a startup self-check or a
comment in `wrangler.jsonc` pinning the invariant.

### IN-03: `loadBrowserConfig` backoff `Number(...) || 5000` treats `0` as "use default"

**File:** `daemon/src/browser-drain.ts:71`
**Issue:** `Number(env.ATLAS_DRAIN_BACKOFF_MS ?? "5000") || 5000` — if an operator sets
`ATLAS_DRAIN_BACKOFF_MS=0` (a legitimate "no backoff" intent), the `|| 5000` silently
overrides it to 5s. Also `Number("abc")` → `NaN` → `5000` (fine), but the `0` case is a
surprise.
**Fix:** Use `Number.isFinite(parsed) ? parsed : 5000` so an explicit `0` is honored, or
document that `0` is not supported.

### IN-04: Pre-go-live hardcoded owner PII fallbacks (name/email) embedded in agent code

**File:** `apps/usher/src/index.ts:218-221,321-324`, `apps/envoy/src/index.ts:181-190`
**Issue:** Several `_codexFields` / `codex` fallbacks hardcode `"Daniel Chahine"` /
`"chahinedaniel0@gmail.com"` and social URLs as pre-go-live stand-ins (flagged with TODOs).
These are PII (not secrets), and the TODOs correctly mark them as go-live wiring points, but
they will silently fill real registration forms / drafts with these values if Codex wiring
is not completed before go-live.
**Fix:** Gate the fallback behind an explicit "pre-go-live" flag that hard-fails (rather
than silently using the stub) once a go-live env var is set, so a missing Codex wiring
surfaces loudly instead of submitting stub PII to a live form.

---

_Reviewed: 2026-06-08_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
