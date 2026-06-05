---
phase: 01-core-loop-morning-pipeline
reviewed: 2026-06-05T00:00:00Z
depth: standard
files_reviewed: 35
files_reviewed_list:
  - apps/atlas/src/env.ts
  - apps/atlas/src/index.ts
  - apps/atlas/src/invoke-agent.ts
  - apps/atlas/src/localtime.ts
  - apps/atlas/src/morning-chain.ts
  - apps/atlas/wrangler.jsonc
  - apps/compass/src/grid.ts
  - apps/compass/src/index.ts
  - apps/compass/src/plan.ts
  - apps/compass/src/score.ts
  - apps/compass/wrangler.jsonc
  - apps/filer/src/classify.ts
  - apps/filer/src/cursor.ts
  - apps/filer/src/index.ts
  - apps/filer/src/taxonomy.ts
  - apps/filer/wrangler.jsonc
  - apps/forge/src/deadline.ts
  - apps/forge/src/extract.ts
  - apps/forge/src/index.ts
  - apps/forge/src/lock.ts
  - apps/forge/wrangler.jsonc
  - apps/herald/src/bucket.ts
  - apps/herald/src/digest.ts
  - apps/herald/src/guardrail.ts
  - apps/herald/src/index.ts
  - apps/herald/wrangler.jsonc
  - apps/mcp-google/src/index.ts
  - apps/mcp-google/src/scopes.ts
  - apps/sundial/src/block.ts
  - apps/sundial/src/index.ts
  - apps/sundial/src/reconcile.ts
  - apps/sundial/wrangler.jsonc
  - migrations/0003_tasks.sql
  - packages/tasks/src/dedupe.ts
  - packages/tasks/src/index.ts
  - packages/tasks/src/store.ts
findings:
  critical: 1
  warning: 6
  info: 6
  total: 13
status: issues_found
---

# Phase 1: Code Review Report

**Reviewed:** 2026-06-05
**Depth:** standard
**Files Reviewed:** 35
**Status:** issues_found

## Summary

This is a strong, security-conscious implementation. The seven project hard invariants are, on the whole, well respected and enforced by construction rather than prose:

- **Pillar 1 (one consumer):** Verified all five Phase-1 `wrangler.jsonc` files (atlas, compass, filer, forge, herald, sundial) declare `queues.producers` ONLY — no agent declares a `consumers` block on `atlas-wire`. Clean.
- **Pillar 2 (suggest-don't-destroy):** mcp-google registers NO `gmail_send`, NO delete/archive/trash, and NO `calendar_delete_event` tool — destructive paths are unreachable by construction. Scope floors are per-tool and fail-closed. Filer's `GmailTools` interface has no delete method; Sundial's `ReconcileAction` union has no delete verb (duplicates → gated `propose-removal` + P2). Clean.
- **Security redaction:** `safeToolOutput` funnels every mcp-google tool egress through `redact()`; Herald's `guardDigestOutput` blocks the draft + raises P2 on an output leak; Forge `shouldSecuritySkip` + `sanitizeExtracted` enforce the skip/scrub. Code-enforced, not prompt-only. Clean.
- **Idempotency:** All scheduled keys are stable and structured (`filer:sweep:<date>`, `herald:daily:<date>`, `sundial-<date>`, `compass:plan:<date>`, `morning-<date>`, per-task `taskId`). No `crypto.randomUUID()` on a replayable path.
- **D1 discipline:** `store.ts` binds positional `?` params throughout; the unique dedupe index exists; merge-on-collision (not error) is implemented with an `ON CONFLICT DO NOTHING` race guard.
- **Timezone:** Owner-local dates derive via `Intl` with `America/Toronto`; the cron is UTC; in-Workflow gates use `step.sleepUntil`.
- **Workflow discipline:** `morning-chain.ts` awaits each step (start-after-success), passes state forward via `carry` (never mutates `event.payload`), halts downstream on failure, and emits exactly one `chain.halted` P2.

The defects below are mostly robustness/correctness gaps rather than invariant violations. The single Critical is a real idempotency/concurrency hole: the ForgeLock DO that the whole dedupe-serialization design depends on is **never engaged on the live path**.

## Critical Issues

### CR-01: ForgeLock is never engaged on the live morning path — dedupe critical section runs unserialized

**File:** `apps/forge/src/index.ts:197-212` (and `:141-166`, `apps/forge/src/lock.ts`)
**Issue:** `runMorning()` accepts a `runUnderLock` parameter that defaults to the identity function `(fn) => fn()`. The live `Forge.morning()` entrypoint calls `runMorning(this.env, db, today, candidates, extractor)` **without passing a lock closure**, so the dedupe+upsert batch executes with NO serialization. `ForgeLock` is exported and bound in `wrangler.jsonc` (`FORGE_LOCK`) but `env.FORGE_LOCK.getByName(...)` / `withLock(...)` is never called anywhere on the runtime path. The module-level docs and `lock.ts` explicitly state the dedupe check and insert "must be serialized so two overlapping morning runs cannot both miss the dedupe check and double-insert" — but that protection is absent in production.

In practice the `ON CONFLICT(dedupe_key) DO NOTHING` + merge-on-`changes===0` path in `store.ts` does absorb a true DB-level race for a single row, so this is not a guaranteed data-corruption bug. But: (a) the documented concurrency invariant is unmet; (b) two overlapping runs can each emit a `task inserted` Wire event for the same row if both observe an app-side miss before either commits (the second's `upsertTask` returns `merged`, but only after a window where both could mis-count), and (c) subtask unioning across concurrent merges is not atomic. The whole point of the DO lock — single-threaded `blockConcurrencyWhile` around the date's writes — is bypassed.

**Fix:** Wire the lock in the entrypoint so the critical section actually runs under it:
```ts
async morning(params?: {...}): Promise<MorningResult> {
  const today = params?.date ?? localDate(this.env);
  const candidates = params?.candidates ?? [];
  const extractor = params?.extractor;
  if (!extractor || candidates.length === 0) {
    return { inserted: 0, merged: 0, skipped: 0, phishing: 0, taskIds: [] };
  }
  const db = (this.env as unknown as { DB: D1Database }).DB;
  const lockNs = (this.env as Env).FORGE_LOCK;
  const runUnderLock = lockNs
    ? <T>(fn: () => Promise<T>) => (lockNs.getByName(today) as unknown as { withLock<U>(f: () => Promise<U>): Promise<U> }).withLock(fn)
    : undefined;
  return await runMorning(this.env, db, today, candidates, extractor, runUnderLock);
}
```
(Note: the Wire `send` calls in `runMorning` happen *outside* the closure today, which is correct per the "slow work outside the lock" rule — keep them outside.)

## Warnings

### WR-01: Compass overcommitment P3 asserts "demand exceeds free" but fires on bin-pack fragmentation

**File:** `apps/compass/src/index.ts:90-104`, `apps/compass/src/plan.ts:90`
**Issue:** `plan.overcommitted` is defined as `couldntFit.length > 0` (plan.ts:90), i.e. "at least one task didn't fit a gap." But the P3 flag detail (index.ts:98) states `"Demand ${demand}m exceeds free ${free}m"`. These are not equivalent: with fixed 45-minute task estimates and a fragmented grid (e.g. free = three 30-minute gaps = 90m total, demand = 90m for two tasks), a task can fail to fit *even though total demand ≤ total free*. The flag then reports a false "demand exceeds free" relationship (`demand 90m exceeds free 90m` reads as a contradiction), misdiagnosing the cause. The owner's suggested action ("extend working hours") is also wrong for a fragmentation case (the fix is reordering/splitting, not more hours).
**Fix:** Either (a) rename the condition and message to reflect the true cause ("N task(s) could not be placed in the available gaps"), and only claim demand>free when `demand > free` actually holds; or (b) compute `overcommitted` from the genuine `demandMinutes(tasks) > freeMinutes(grid)` comparison and treat fragmentation overflow as a separate, distinctly-worded surface.

### WR-02: `dedupeKey` separator is a plain space, contradicting the comment and weakening boundary-collision protection

**File:** `packages/tasks/src/dedupe.ts:48-50`
**Issue:** The inline comment claims `"A NUL separator that cannot appear in any of the three fields prevents boundary-collision ambiguity"`, but the code interpolates a literal space: `` `${thread} ${normalizedTitle} ${dueDate}` ``. A space absolutely *can* appear in `normalizedTitle` (titles are normalized to space-collapsed words) and in the (formerly) raw thread id. So `(thread="a b", title="c")` and `(thread="a", title="b c")` can collide on the same material string — exactly the ambiguity the comment claims to prevent. Thread ids are opaque Gmail ids (no spaces in practice), so the real-world collision risk is low, but the code does not match its own stated contract and the protection is illusory.
**Fix:** Use an actual control separator that cannot occur in any field:
```ts
const SEP = " ";
const material = `${thread}${SEP}${normalizedTitle}${SEP}${dueDate}`;
```
Changing the separator changes every dedupe hash, so coordinate it as a one-time migration (the index re-derives on the next run; old rows simply won't dedupe against new ones until re-seen).

### WR-03: `taskIdFor` truncates the dedupe hash to 16 hex chars — collision risk and id/dedupe divergence

**File:** `apps/forge/src/index.ts:50-52`
**Issue:** `taskIdFor(key)` returns `` `task-${key.slice(0, 16)}` `` — only 64 bits of the SHA-256. The `id` is the table PRIMARY KEY and the Wire `idempotencyKey`, while `dedupe_key` (the full 256-bit hash) is a separate UNIQUE column. Two distinct tasks whose full dedupe_keys differ but share the first 16 hex chars would produce the same `id` (PK), causing the second `INSERT` to fail the PK constraint (not the dedupe path) — and because `upsertTask` keys its existence check on `dedupe_key`, not `id`, it would attempt an INSERT with a duplicate `id` and the `ON CONFLICT(dedupe_key)` clause would NOT catch a PK collision. The result is an unhandled D1 constraint error rather than a clean merge. 64-bit truncation makes this astronomically unlikely but not impossible, and the failure mode is an exception, not a no-op.
**Fix:** Either derive the id from the full key (`task-${key}`) or add a defensive `ON CONFLICT(id)` handling path. At minimum, document that PK uniqueness depends on 64-bit hash uniqueness and accept it explicitly; preferably widen the slice or key the id off the same column the conflict clause guards.

### WR-04: `localTime` budget gates can compute an instant in the PAST, collapsing the chain's stagger

**File:** `apps/atlas/src/localtime.ts:32-39`, `apps/atlas/src/morning-chain.ts:92-94`
**Issue:** `step.sleepUntil(name, localTime(date, "08:00", tz))` computes an absolute instant for 08:00 owner-local *on the chain's `date`*. The chain is created at 07:45. But if a step is slow (Filer retries for several minutes, or the instance is resumed after a kill near 08:30) the gate time for a later step is already in the past — `sleepUntil` with a past instant resolves immediately, so the 08:00/08:15/08:20/08:30 stagger silently collapses and all remaining steps run back-to-back. That is arguably acceptable (they're "budget gates," not hard SLAs), but it is undocumented behavior and there is no guard: a clock/`date` mismatch (e.g. the cron fires at 23:50 EDT near a date boundary and `localDate` rolls to the next day) could also produce a gate ~24h in the future, stalling the chain. Worth an explicit clamp + comment.
**Fix:** Document that past gates resolve immediately (intended), and clamp the gate to a sane window relative to "now" so a date-rollover bug cannot park the chain for ~24h:
```ts
const target = localTime(date, s.gate, tz);
const now = Date.now();
// never sleep into the past (collapse stagger) or absurdly far into the future
if (target.getTime() > now) await step.sleepUntil(`budget-${s.codename}`, target);
```

### WR-05: Sundial all-day block uses owner-local date as the all-day `start.date` but timed blocks use a UTC `toISOString()` — mixed timezone semantics

**File:** `apps/sundial/src/block.ts:76-94`
**Issue:** For a date-only due, `start.date = due` (an owner-local `YYYY-MM-DD`) — correct for an all-day event. For a datetime due, `start/end.dateTime = new Date(due).toISOString()` produces a **UTC** (`...Z`) timestamp. Google Calendar accepts a `dateTime` with an explicit offset; converting the owner-local ISO (e.g. `2026-06-06T23:59:00-04:00`) to `Z` form is technically the same instant, so this is *not* an instant-shift bug. However, the event will render in UTC in some clients unless a `timeZone` field accompanies it, and a 15-minute marker `ending at 23:59 local` shown as `03:59Z` is confusing. More importantly `upcoming7d` (index.ts:39-49) and `score.ts` parse `new Date(task.due)` / `new Date(\`${today}T00:00:00Z\`)` mixing a zoned `due` against a `Z`-anchored `today`, which can be off by the offset at the day boundary.
**Fix:** Attach an explicit `timeZone` to the timed block (`start: { dateTime, timeZone: "America/Toronto" }`) or preserve the original offset string instead of round-tripping through `toISOString()`. Audit the `new Date(\`${today}T00:00:00Z\`)` vs zoned-`due` comparisons in `score.ts:15-17` and `index.ts:40-41` for day-boundary off-by-one.

### WR-06: `safeToolOutput` hardcodes `sourceAgent: "Filer"` for every leak P1, even on Herald/Forge/Sundial/Compass tools

**File:** `apps/mcp-google/src/index.ts:112-118`
**Issue:** The redaction-block P1 flag always attributes `{ sourceAgent: "Filer" }`. But `safeToolOutput` is now the egress for Phase-1 tools driven by Herald, Forge, Sundial, and Compass (`gmail_search_threads`, `gmail_get_thread`, `gmail_create_draft`, `calendar_*`). A leak caught on, say, `gmail_get_thread` (Herald/Forge input) is misattributed to Filer in the incident feed, which will mislead triage and the Flagger trust model. The flag is best-effort and the redaction still works, so this is not a security hole — but it corrupts the audit/incident attribution that the security model relies on.
**Fix:** Thread the calling tool/agent through to `safeToolOutput` (e.g. `safeToolOutput(body, env, sourceAgent)`), or derive the agent from the granted-scope context, and use a neutral `sourceAgent: "mcp-google"` if the true caller is unknown rather than a hardcoded wrong one.

## Info

### IN-01: `containsSecret(body)` runs twice on Herald's clean path

**File:** `apps/herald/src/guardrail.ts:37` then `apps/herald/src/index.ts:104` → `send`
**Issue:** `guardDigestOutput` runs `containsSecret(body)`; the body it returns on the clean path is the *unredacted* original (`text: body`). The pre-synthesis `stripSnippet`/`redact` already ran per-thread in `digest.ts`, so the full body is scanned again here — fine and intended (defense-in-depth), just noting the redundant scan is deliberate, not a bug.
**Fix:** None required; consider a comment clarifying the clean-path returns the unredacted (already-pre-stripped) body by design.

### IN-02: `offsetMinutes` / `ownerOffset` silently fall back to a fixed offset on a regex miss

**File:** `apps/atlas/src/localtime.ts:21-25`, `apps/forge/src/deadline.ts:35-38`
**Issue:** Both offset parsers fall back to a hardcoded default (`GMT+00:00` → 0 in localtime; `-04:00` in deadline) if the `longOffset` token fails to match. For `America/Toronto` the format is stable (`GMT-04:00`/`GMT-05:00`, verified), so this never triggers in practice. But a half-hour zone (`GMT+05:30`) is handled by localtime and a future tz change would silently use the wrong offset in `deadline.ts` (defaults to EDT `-04:00`). Low risk given the single owner tz.
**Fix:** Log/flag on the fallback path rather than silently defaulting, so a format drift is observable.

### IN-03: `MORNING_CHAIN_DO` binds a second name to `AtlasCoordinator` but is unused in the reviewed code

**File:** `apps/atlas/wrangler.jsonc:16`
**Issue:** `MORNING_CHAIN_DO` is declared as a second DO binding to `AtlasCoordinator`, but no reviewed source references `env.MORNING_CHAIN_DO`. It may be wired in `coordinator.ts` (out of scope), but if not, it is dead binding surface that invites confusion with the `MORNING_CHAIN` Workflow binding (similar name, different primitive).
**Fix:** Confirm it is consumed; if not, drop it or add a comment pointing to its consumer.

### IN-04: `reminders` popup `minutes: 0` for a timed marker fires at the deadline, not before

**File:** `apps/sundial/src/block.ts:71-74, 86-94`
**Issue:** The single popup override is `minutes: 0`, meaning the reminder fires *at* the due time. For a "short block leading up to the deadline" the owner likely wants a lead-time nudge (the block already starts 15 min before; a 0-minute reminder at the end is the latest-possible warning). Behavioral preference, not a bug.
**Fix:** Consider a small positive lead (e.g. `minutes: 10`) or make it CONFIG-tunable.

### IN-05: `fridayOf` returns a past date when run on Saturday

**File:** `apps/forge/src/deadline.ts:54-59`
**Issue:** `fridayOf` computes `5 - dow`; for Saturday (`dow=6`) `delta = -1`, yielding *yesterday's* Friday. `inferDeadline` uses this for `Due/ThisWeek → Fri 17:00`, so a Saturday run would infer an already-past deadline. The morning chain runs Mon–Fri only (cron `* * 1-5`), so this is not reachable on the live path, but the helper is exported and could be misused. The comment acknowledges "clamp to it" but does not actually clamp.
**Fix:** Clamp to a non-negative delta (`Math.max(0, 5 - dow)` or roll to next Friday) so the helper is safe regardless of caller day.

### IN-06: `upcoming7d` horizon comparison `dueMs <= horizon` includes already-overdue tasks with no lower bound

**File:** `apps/sundial/src/index.ts:39-49`
**Issue:** `upcoming7d` counts any task with `dueMs <= todayMs + 7d`, including tasks already overdue (`dueMs < todayMs`). For an "upcoming 7d" glance this conflates overdue with upcoming. Minor semantic imprecision in a display counter.
**Fix:** Add a lower bound (`dueMs >= todayMs && dueMs <= horizon`) or rename to reflect it includes overdue.

---

_Reviewed: 2026-06-05_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
