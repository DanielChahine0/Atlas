---
phase: 05-meta-polish
reviewed: 2026-06-09T19:11:13Z
depth: standard
files_reviewed: 22
files_reviewed_list:
  - .claude/commands/switchboard.md
  - .claude/registry/mcp-registry.json
  - apps/librarian/package.json
  - apps/librarian/src/auth.ts
  - apps/librarian/src/dedupe.ts
  - apps/librarian/src/derive.ts
  - apps/librarian/src/env.ts
  - apps/librarian/src/index.ts
  - apps/librarian/test/apply-migrations.ts
  - apps/librarian/test/failure.test.ts
  - apps/librarian/test/replay.test.ts
  - apps/librarian/test/wire-contract.test.ts
  - apps/librarian/tsconfig.json
  - apps/librarian/vitest.config.ts
  - apps/librarian/wrangler.jsonc
  - apps/librarian/wrangler.test.jsonc
  - docs/10-switchboard.md
  - migrations/0008_prompts.sql
  - packages/model/src/claude.ts
  - packages/steward-core/src/op-mapping.ts
  - packages/steward-core/test/op-mapping.test.ts
  - test/mcp-registry.test.mjs
findings:
  critical: 1
  warning: 12
  info: 6
  total: 19
fix_pass:
  fixed_at: 2026-06-09T19:27:35Z
  scope: critical_warning
  fixed: 13
  deferred: 6
status: fixed
---

# Phase 5: Code Review Report

**Reviewed:** 2026-06-09T19:11:13Z
**Depth:** standard
**Files Reviewed:** 22
**Status:** fixed — all 13 Critical/Warning findings fixed (one atomic `fix(05):` commit each,
2026-06-09); the 6 Info findings are deferred (fix scope was Critical + Warning only).
Gate after fixes: `pnpm -r typecheck` exit 0, `pnpm test` exit 0 (all suites + registry test).

## Summary

Reviewed the Phase 5 (Meta/Polish) implementation: the Librarian Worker (Bearer-gated
`POST /prompt/save` → dedupe → Haiku derive → D1 → one Wire upsert), the steward-core
fullNote PUT branch, the Librarian TIER_MAP entry, the Switchboard slash-command +
machine-readable MCP registry, the prompts migration, and the registry schema test.

Verified live (not just read): `pnpm vitest run` in apps/librarian (23/23 green),
packages/steward-core (7/7 green), `node --test test/mcp-registry.test.mjs` (8/8 green),
and `tsc --noEmit` clean in both touched packages. The pillar invariants mostly hold:
Librarian is producer-only (no `queues.consumers`), auth is fail-closed constant-time
(HMAC-keyed compare from `@atlas/gate`), the `Prompts/<slug>.md` path allowlist in
op-mapping is traversal-proof, all D1 binds are positional `?`, and no secrets appear in
vars or logs.

However, the review found one Critical correctness defect — a same-day re-save of an
edited prompt returns 200 but its Vault update is silently swallowed by the idempotency
ledger (the bump key omits the content hash the repo's own key convention prescribes) —
plus a cluster of robustness gaps: `flag()` drops the `suggestedAction` the new docs and
callsites depend on, unhandled error paths violate the "every notable failure → Flagger"
pillar, the fullNote PUT branch bypasses the file's own SAFE_METHODS belt, and the
registry's `owning_agents` field conflates readers with writers — corrupting the very
input the Pillar-1 hard rule keys off.

## Critical Issues

### CR-01: Same-day re-save with changed content silently never reaches the Vault (bump key lacks a content hash)

**Fix status:** ✅ fixed in `c3573fc` — bump key is now `librarian:<slug>:save:<date>:<contentHash(noteBody)>` (replay test fixture updated to mirror the shape)
**File:** `apps/librarian/src/index.ts:161-174`
**Issue:** The bump-path idempotencyKey is date-granular: `librarian:${existingSlug}:save:${now}` where `now` is `localDate()` (`YYYY-MM-DD`). The comment frames this as replay protection ("replay same day = no-op"), but it conflates a *replay of the same event* with a *genuinely new save on the same day*. Flow: owner saves a prompt, edits it, re-saves within the same day (Jaccard ≥ 0.75, so it bumps the same slug). The D1 row is updated (`full_prompt`, `uses`, `last_used`) and a Wire event carrying the NEW `noteBody` is emitted — but Steward's `applyEvent` finds the key already in `idempotency_keys`, returns `{applied:false}`, and never enqueues the new content to `vault_outbox`. The endpoint returns `200 {"action":"bump"}` implying success, yet the Vault note — the entire user-visible product of Librarian — stays stale until a bump on a *later* date. D1 (authoritative) and the Vault projection silently diverge with no flag. The repo's own key convention solves exactly this: `forge:task:<date>:<contentHash>` includes a content hash so replays dedupe but new content flows.
**Fix:**
```typescript
import { flag, localDate, contentHash } from "@atlas/shared";
// ...bump path:
idempotencyKey: `librarian:${existingSlug}:save:${now}:${contentHash(noteBody)}`,
```
A true replay (identical noteBody → identical hash) still dedupes to a no-op; a same-day edited re-save gets a distinct key and its PUT reaches the Vault. Update the replay test's bump-key fixture accordingly.

## Warnings

### WR-01: `flag()` silently drops `suggestedAction` — the documented `suggested_action` RawIncident field never reaches the Flagger feed

**Fix status:** ✅ fixed in `77d6c1c` — optional `suggested_action` added to RawIncidentSchema/RawIncident, populated in `flag()`, threaded through Flagger's `upsertFlag` partial (backward-compatible; docs now true)
**File:** `.claude/commands/switchboard.md:125-157`, `docs/10-switchboard.md:269-300`, `apps/librarian/src/index.ts:199`, `packages/model/src/claude.ts:129,272,289`
**Issue:** Both reviewed Switchboard documents present a RawIncident JSON containing `"suggested_action": "..."` and call it "the exact shape that `flag()` in `@atlas/shared` enqueues" / "the exact payload `flag()` enqueues". That claim is false: `RawIncident` (`packages/shared/src/incident.ts:20-37`) has no `suggested_action` field, and `flag()` (`packages/shared/src/flag.ts:100-111`) accepts `options.suggestedAction` but never copies it into the enqueued incident. Even if it did, `RawIncidentSchema.parse` would strip the unknown key on the consumer side. Consequences inside this phase's own diff: the Librarian borderline-dedupe `suggestedAction` ("Review the two prompts and merge if appropriate") and all three `claude.ts` model-error `suggestedAction` strings are dead — they never land in the Flagger feed, despite `apps/flagger/src/state.ts` already modeling `suggested_action` on its output rows. Operators following the D-07 emit snippet will believe the field flows.
**Fix:** Add `suggested_action: z.string().optional()` to `RawIncidentSchema` / the `RawIncident` type, populate it in `flag()` (`suggested_action: options.suggestedAction`), and thread it through Flagger's partial. Alternatively (worse), delete the field from both docs and the command — but FlagRecord already carries it, so transporting it is the intended design.

### WR-02: Wire `agent` field is lowercase `"librarian"`, breaking the repo-wide capitalized-codename convention

**Fix status:** ✅ fixed in `5a8c0d5` — both `send()` calls emit `agent: "Librarian"`; wire-contract + replay tests updated (idempotency-key namespaces stay lowercase by design)
**File:** `apps/librarian/src/index.ts:164,262` (locked in by `apps/librarian/test/wire-contract.test.ts:159`; contradicted by `packages/steward-core/test/op-mapping.test.ts:15` which uses `"Librarian"`)
**Issue:** CLAUDE.md mandates "Wire `agent` field = the codename (`"Forge"`, `"Filer"`, `"Herald"`, …)" — and every other producer in the repo emits the capitalized codename (`"Archivist"`, `"Atlas"`, `"Compass"`, `"Echo"`, `"Envoy"`, `"Filer"`, `"Flagger"`, `"Forge"`, `"Herald"`). Librarian alone emits `"librarian"`. The value is persisted into `run_log.agent` by `applyEvent`, so run-log queries/dashboard groupings keyed on codenames will miss Librarian rows; elsewhere in the repo, agent identity comparisons are case-sensitive against capitalized codenames (`packages/gate/src/render.ts:173-216`). The phase's own two test files even disagree on the casing.
**Fix:** Emit `agent: "Librarian"` in both `send()` calls; update the wire-contract literal assertion. (Keys like `librarian:<slug>:save` are key-namespace strings, not the agent field — they may stay lowercase.)

### WR-03: fullNote PUT branch bypasses the SAFE_METHODS runtime belt, and its `as SafeMethod` cast defeats the compile-time guard too

**Fix status:** ✅ fixed in `4e8a02e` — `const fullNoteMethod: SafeMethod = "PUT"` (honest typing, no cast) + the same runtime belt before the early return; stale bottom-guard comment corrected
**File:** `packages/steward-core/src/op-mapping.ts:92-101` (stale claim at `:138-141`)
**Issue:** The new branch returns early, skipping the bottom `SAFE_METHODS.includes(method)` Pillar-2 assertion. Worse, `"PUT" as SafeMethod` is an unchecked cast: it compiles today (redundantly — `"PUT"` is already in the tuple) and would *keep compiling* if a future edit changed the literal to `"DELETE" as SafeMethod` or if `"PUT"` were removed from `SAFE_METHODS`. The file's own comment — "no op branch can yield one, and an accidental future edit that introduced one would throw here" — is no longer true for this branch: it has neither the runtime belt nor honest type checking.
**Fix:** Drop the cast (`method: "PUT" satisfies SafeMethod` or plain `"PUT"` typed against `SafeMethod`), and either route the early-return intent through the belt or add the same runtime assertion before returning:
```typescript
const method: SafeMethod = "PUT";
if (!SAFE_METHODS.includes(method)) throw new Error(`refusing non-safe outbound method: ${method}`);
```

### WR-04: fullNote PUT with missing/non-string `noteBody` silently overwrites an existing Prompts note with an empty file

**Fix status:** ✅ fixed in `bafad10` — throws NonRetryableError on missing/empty/non-string noteBody; 3 unit tests added (missing / "" / object)
**File:** `packages/steward-core/src/op-mapping.ts:100`
**Issue:** `body: String(e.payload.noteBody ?? "")` — an event with a valid `Prompts/<slug>.md` path but a missing `noteBody` produces a PUT that blanks the existing Vault note; a non-string `noteBody` (object) writes `"[object Object]"`. The branch fails loud on a bad path (NonRetryableError) but fails *silent and destructive* on a bad body — inconsistent with both the adjacent guard and "suggest, don't destroy." No current producer triggers it (Librarian always sets `noteBody`), but this map is the single shared op→REST source for all future producers.
**Fix:**
```typescript
if (typeof e.payload.noteBody !== "string" || e.payload.noteBody.length === 0) {
  throw new NonRetryableError(`fullNote upsert requires a non-empty string noteBody for "${notePath}"`);
}
```

### WR-05: No error handling around D1/Wire/derive failures — any throw is an unflagged 500 (Pillar 5: every notable failure → Flagger)

**Fix status:** ✅ fixed in `8cd138d` — claudeFor moved inside deriveRecord's try (construction failure → fallback), tags parse guarded, handleSave wrapped in a top-level catch emitting P3 kind:`save_failed` + structured 500
**File:** `apps/librarian/src/index.ts:62-295` (esp. `:144-148`, `:150`, `:254-272`), `apps/librarian/src/derive.ts:51`
**Issue:** Several failure paths escape as raw exceptions with no `flag()` and no structured response:
- `claudeFor("librarian", env)` is called *outside* `deriveRecord`'s try/catch. `claudeFor` throws on an unprovisioned gateway (`claude.ts:202-207`), so a missing/blank `AIG_*` var turns *every* new-prompt save into a 500 — even though the non-model fallback (prompt-derived title) would have produced a perfectly valid save. The docstring's "model call failure → fallback" claim does not cover construction failure.
- `JSON.parse(existing.tags)` (`index.ts:150`) is unguarded — one malformed row bricks every bump of that slug.
- D1 INSERT/UPDATE failures and `send()` failures (including `WireEventTooLargeError`) propagate as unhandled 500s; on the new path the D1 INSERT commits *before* the Wire send, so a send failure leaves an orphaned row with no Vault note and no incident.
Librarian flags trivia (empty capture, P4) but is silent on the failures that actually matter.
**Fix:** Move `claudeFor` inside `deriveRecord`'s try block; guard the tags parse (`try { tags = JSON.parse(...) } catch { tags = [] }`); wrap `handleSave`'s body in a top-level try/catch that emits `flag(env, "P3", "Librarian: save failed", detail, { sourceAgent: "Librarian", kind: "save_failed" })` and returns a 500 JSON body.

### WR-06: The 50 KB prompt gate does not guarantee the 128 KB Wire cap

**Fix status:** ✅ fixed in `91caf4f` — gate now measures `TextEncoder().encode(JSON.stringify(fullPrompt)).byteLength` (escaping + UTF-8 expansion included), bounding the final encoded event well under 128 KB; residual send() throws are flagged by the WR-05 top-level catch
**File:** `apps/librarian/src/index.ts:99-112` (comment "well under 128KB Queue cap")
**Issue:** The gate measures `fullPrompt.length` (UTF-16 code units), but `send()` measures the UTF-8-encoded JSON of the whole event. JSON escaping expands control-char-dense text up to 6× (`""` → ``, 6 bytes) and non-ASCII text up to 3× in UTF-8 — a 50,000-char pathological prompt encodes to ~300 KB, sailing past the gate and throwing `WireEventTooLargeError` *after* the D1 INSERT (→ unhandled 500, orphaned row; see WR-05). The "well under 128KB" claim only holds for plain ASCII text.
**Fix:** Gate on encoded size — `new TextEncoder().encode(JSON.stringify(fullPrompt)).byteLength > 50_000` — or catch `WireEventTooLargeError` from `send()` and convert it to the existing P3 `oversized_capture` flag + 413.

### WR-07: `tool` is unvalidated — newline injection into YAML frontmatter, unbounded length, empty string accepted

**Fix status:** ✅ fixed in `a48cc7d` — fail-closed allowlist `z.string().regex(/^[A-Za-z0-9 ._-]{1,64}$/).optional()`; non-conforming tool → 400, never silently sanitized
**File:** `apps/librarian/src/index.ts:25-28` (schema), `:44-57` (`buildNoteMarkdown` line `` `tool: ${opts.tool}` ``)
**Issue:** `body.tool` flows verbatim into the note's YAML frontmatter. It is the only request-controlled single-line slot with no sanitization (title is whitespace-normalized via `split(/\s+/).join(" ")`; tags pass through `JSON.stringify`): a `tool` containing `\n` forges arbitrary frontmatter lines (e.g. fake `uses:`/`created:` fields) or terminates the frontmatter block early, corrupting the rendered note. `tool` also has no length cap (a multi-MB `tool` bypasses the 50 KB prompt gate entirely and lands in D1, the dedupe bucket key, and the Wire payload) and `z.string()` accepts `""` (since `"" ?? default` does not apply, an empty string becomes its own dedupe bucket). The endpoint is owner-authenticated, so this is an integrity footgun rather than an attack surface — but the phase's threat register (T-5-Tamper) hardened `notePath` while leaving this hole.
**Fix:**
```typescript
tool: z.string().trim().min(1).max(64).regex(/^[^\r\n]+$/).optional(),
```

### WR-08: `uses` bump is a non-atomic read-modify-write and double-increments on a retried request

**Fix status:** ✅ fixed in `e5eb564` — `UPDATE … SET uses = uses + 1 … RETURNING uses` (atomic in SQL; noteBody renders the actual post-increment value). The optional full retry-idempotency skip was not added — the suggested atomic SQL is the applied fix
**File:** `apps/librarian/src/index.ts:130-148`
**Issue:** `SELECT uses` → compute `uses + 1` in JS → `UPDATE ... SET uses = ?` loses updates under concurrent saves, and a client retry of the same request (timeout, network blip) increments `uses` and rewrites `last_used` again. The Wire side dedupes the replay but the D1 side — the authoritative system-of-record — does not, inverting Pillar 5 ("a replay leaves counters unchanged"). The Vault note can then permanently disagree with D1 on `uses`.
**Fix:** Make the increment atomic and content-aware:
```sql
UPDATE prompts SET full_prompt = ?, last_used = ?, uses = uses + 1 WHERE slug = ?
```
then re-read the row for the noteBody (or use `RETURNING uses`). Full retry-idempotency would additionally skip the bump when `full_prompt` and `last_used` are already identical.

### WR-09: KV dedupe thresholds accepted without validation — NaN/garbage silently disables dedupe

**Fix status:** ✅ fixed in `2ed8068` — `parseDedupeKnob()` accepts only finite numbers in [0,1], falls back to 0.75/0.55, and a present-but-rejected value emits a P4 kind:`bad_config` flag
**File:** `apps/librarian/src/index.ts:114-118`
**Issue:** `Number(thresholdRaw)` on a mistyped KV value (e.g. `"0,75"`, `"abc"`) yields `NaN`; every `score >= NaN` comparison is false, so *all* saves take the "new" path — dedupe is silently disabled, duplicate notes accumulate, and no flag fires. Out-of-range values (`"7.5"`, `"-1"`) similarly break the bump/borderline bands without any signal. These are the live-tunable knobs the design explicitly advertises; a typo should not silently change system behavior.
**Fix:** Validate and clamp: `const t = Number(raw); threshold = Number.isFinite(t) && t >= 0 && t <= 1 ? t : 0.75;` and emit a P4 flag (kind `"bad_config"`) when a present value is rejected.

### WR-10: Dead slug fallback — `deriveSlug` never returns `""`, so the documented prompt-text fallback is unreachable

**Fix status:** ✅ fixed in `02653c7` — deriveSlug returns `""` for fully-stripped input; the chain is now `deriveSlug(title) || deriveSlug(promptText) || "prompt"` at the call site
**File:** `apps/librarian/src/derive.ts:97,108-116`
**Issue:** `deriveSlug` ends with `return slug || "prompt"` — it never returns a falsy value. Therefore in `deriveRecord`, `deriveSlug(title) || deriveSlug(promptText)` short-circuits on `"prompt"` and the right-hand fallback is dead code, contradicting the function's own docstring ("A returned empty slug … falls back to first 6 words of the prompt text"). Real effect: any prompt whose derived title contains no `[a-z0-9]` characters (all-CJK, all-Arabic, all-emoji prompts — the title is derived from the prompt itself when the model fails) collapses onto the `prompt`, `prompt-2`, `prompt-3`, … series instead of getting a content-derived slug.
**Fix:** Have `deriveSlug` return `""` for fully-stripped input and apply the default once at the call site: `const slug = deriveSlug(title) || deriveSlug(promptText) || "prompt";`

### WR-11: Registry `owning_agents` conflates "uses the server" with "owns writes" — corrupting the Pillar-1 hard-rule input

**Fix status:** ✅ fixed in `928fdca` — owning_agents = writers only (Calendar `["Sundial","Usher"]`, Canva `["Envoy"]`, Drive `["Steward"]` — same defect class); readers moved to a `readers` array; Gmail scopes now list the full set (`gmail.modify`, `gmail.readonly`, `gmail.compose`); doc REGISTRY table + slash-command examples updated in the same commit; registry schema test green. Herald stays an owner (drafting via gmail.compose IS a write, per CLAUDE.md roster)
**File:** `.claude/registry/mcp-registry.json:8-9,17,71`
**Issue:** The `/switchboard` command's HARD RULE reads `owning_agents` as "route writes through that agent." But the array mixes writers with readers/peripheral users:
- Google Calendar (`:17`): includes **Compass**, which is `calendar.readonly` and must *never* be routed a calendar write (CLAUDE.md: only Sundial/Usher write `calendar.events`).
- Canva (`:71`): includes **Librarian**, whose only Canva relationship is storing prompts with `tool:"Canva"` (the docs table even says "Librarian (tool field)") — a Canva design write routed to Librarian would create exactly the wrong-writer collision the rule exists to prevent. Envoy owns Canva publishing.
- Gmail (`:8-9`): `owning_agents` includes Herald, while `scopes` lists only `gmail.modify`. Herald's least-privilege grant is `gmail.readonly` + `gmail.compose` — neither appears in the machine-readable `scopes` array, so the command's Step 5 ("if the scope is already in the registry … mark all-granted") evaluates Herald drafting against the wrong scope set: either a false `missing_scope` gap, or worse, drafting silently "covered" by `gmail.modify` that Herald does not hold.
**Fix:** Split the field semantics — `owning_agents` = writers only (Calendar: `["Sundial","Usher"]`; Canva: `["Envoy"]`), add a separate `readers`/`users` array for Compass/Herald/Librarian — and list each server's full standard scope set (`gmail.modify`, `gmail.readonly`, `gmail.compose`). Update the doc table in `docs/10-switchboard.md` in the same commit (the doc mandates updating both).

### WR-12: docs/10-switchboard.md "At a glance" claims Runtime = "Cloud (Cloudflare Worker + Durable Object)", contradicting D-07 in the same document

**Fix status:** ✅ fixed in `5ec867c` — Runtime cell now reads "Design-time only — `/switchboard` Claude Code slash-command; NOT a deployed Worker (D-07)"
**File:** `docs/10-switchboard.md:12`
**Issue:** The at-a-glance table's Runtime row says Switchboard is a Cloud Worker + DO. Ten lines later the same doc states "Switchboard is **NOT a deployed Worker** (D-07)", the Deferred section reiterates it, and CLAUDE.md's roster pins it as "Design-time only … not a live Worker." A reader skimming the summary table — the most-read part of the doc — gets the opposite of the authoritative design and might scaffold a Worker (the CLAUDE.md "do NOT re-scaffold" list does not include switchboard, since none should exist).
**Fix:** Change the Runtime cell to: `Design-time only — /switchboard Claude Code slash-command; NOT a deployed Worker (D-07)`.

## Info

> **Fix-pass status (all IN-*):** deferred — the fix scope for this pass was Critical + Warning
> only (per the `/gsd:code-review --fix` objective). All six remain valid, low-risk cleanups
> for a future polish pass. Note IN-04's premise is now partially superseded: WR-06's encoded-size
> gate makes the test comment's 128 KB claim true only for the pathological-escaping case it cites.

### IN-01: auth.ts — redundant duplicate header lookup and an overclaiming docstring

**File:** `apps/librarian/src/auth.ts:26-27,41-50`
**Issue:** `request.headers.get("authorization") ?? request.headers.get("Authorization")` — the Fetch `Headers.get` is case-insensitive; the second lookup is dead code. Separately, the module docstring promises "returns false on ANY error path — … or any unexpected error," but `authorizeSave` has no try/catch: a throwing `ATLAS_LIBRARIAN_TOKEN.get()` (Secrets Store hiccup) propagates as a 500, not the documented 401. Access is still denied (fail-closed in effect), but the contract claim is inaccurate.
**Fix:** Drop the second `.get`; either wrap the body in try/catch returning `false`, or soften the docstring.

### IN-02: Dead `_skipDerive` parameter

**File:** `apps/librarian/src/index.ts:241`
**Issue:** `_skipDerive` is never read and both call sites pass `true` — vestigial API surface that implies a non-existent second mode.
**Fix:** Remove the parameter.

### IN-03: Stale `passWithNoTests: true` now masks a broken test glob

**File:** `apps/librarian/vitest.config.ts:9-10`
**Issue:** The comment says "tests land in 05-03; this keeps pnpm test green until then." They have landed (3 files, 23 tests). With the flag still set, a future test-discovery regression (renamed dir, broken glob) silently reports green — defeating the DoD gates this suite exists to enforce.
**Fix:** Remove `passWithNoTests` and the comment.

### IN-04: Test comment's false 128 KB premise leaves the 50 KB boundary untested

**File:** `apps/librarian/test/failure.test.ts:193-205`
**Issue:** The "exactly at the limit" test claims "a 50KB noteBody would exceed the 128KB Wire message cap after JSON encoding" and therefore substitutes a 1,000-char prompt. For ordinary text this is false (~50 KB encoded ≪ 128 KB; see WR-06 for the case where it *is* true), so the actual boundary behavior — a 50,000-char prompt succeeding end-to-end — is untested on a wrong premise.
**Fix:** Test the true boundary with `"a".repeat(50_000)` and assert 200 + one Wire event; keep a separate case for the encoded-size pathology once WR-06 is fixed.

### IN-05: Migration comments document formats the code does not produce

**File:** `migrations/0008_prompts.sql:24,30`
**Issue:** The comments say `created`/`last_used` are "ISO-8601 owner-local strings (e.g. 2026-06-09T14:00:00-04:00)" — Librarian writes bare `YYYY-MM-DD` from `localDate()` (and `index.ts`'s `.slice(0, 10)` calls exist only to serve this phantom datetime format). The slug example `"forge-task-extract-2026-06-09-abc"` matches neither the title-derived kebab slugs nor the collision suffixes actually produced.
**Fix:** Update both comments to match reality (`YYYY-MM-DD`; slug e.g. `"code-review-summary-helper"`), or store full ISO timestamps and drop the slices.

### IN-06: `side_effect_verbs` over-breadth gates the canonical safe action (drafting)

**File:** `.claude/registry/mcp-registry.json:113-117`
**Issue:** Including `"create"`, `"update"`, `"write"` makes every "create a draft reply" goal classify as outward-irreversible requiring `confirmation_gate: true` — yet drafting is Pillar 2's canonical *ungated* suggest-don't-destroy default (Herald drafts with no gate). The failure direction is safe (over-gating), but it will generate false P1 `ungated_outward` noise for draft/label-type goals and erode trust in real P1 gaps.
**Fix:** Either remove the suggest-tier verbs and rely on the irreversibility classification in Step 1, or document that drafts/labels are exempt from the verb-list gate.

---

_Reviewed: 2026-06-09T19:11:13Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_

_Fixes applied: 2026-06-09T19:27:35Z — 13/13 Critical+Warning fixed (one `fix(05):` commit each); 6 Info deferred._
_Fixer: Claude (gsd-code-fixer)_
_Gate: `pnpm -r typecheck` exit 0 · `pnpm test` exit 0 (all suites + registry test)_
