---
phase: 4
reviewers: [ollama]
reviewed_at: 2026-06-07T14:35:10Z
plans_reviewed: [04-01-PLAN.md, 04-02-PLAN.md, 04-03-PLAN.md, 04-04-PLAN.md, 04-05-PLAN.md, 04-06-PLAN.md, 04-07-PLAN.md]
---

# Cross-AI Plan Review — Phase 4 (Outward / Gated)

> **Reviewer-availability note (read first).** `--all` was requested, but only one *independent* reviewer was actually usable on this machine:
>
> | Reviewer | Status |
> |---|---|
> | **ollama** (`qwen2.5:7b`, local) | ✅ ran — see below |
> | claude | ⏭️ skipped — *this* CLI (self-review excluded for independence; `CLAUDE_CODE_ENTRYPOINT=cli`) |
> | cursor | ❌ available but **not logged in** (`cursor agent login` required) |
> | gemini | ❌ not installed |
> | codex | ❌ not installed |
> | coderabbit | ❌ not installed |
> | llama.cpp | ❌ server up but **no model loaded** |
> | lm_studio | ❌ server not running |
>
> **Caveat on weight of this review:** the sole reviewer is a local **7B** model. The full plan set (~46k tokens) exceeds its 32k context, so the review was run in **two focused passes** (foundation/gate, then daemon + outward agents) and the outputs merged below. A 7B model gives generic, surface-level feedback on a security-critical multi-agent architecture — treat its findings as a sanity check, **not** a substitute for a frontier-model peer review. To get a stronger independent pass, run `cursor agent login` (or install `gemini`/`codex`) and re-run `/gsd-review --phase 4`.

---

## Ollama Review (`qwen2.5:7b`, local — two passes)

### Pass A — Foundation + Gate (`04-01` gate primitive, `04-02` mcp-github PR tools, `04-03` gate Worker)

**Summary** — Foundation plans build the shared `packages/gate` confirmation-gate primitive and the `apps/gate` Worker (dedicated confirm-page handler). Core components: create-pending / decide / sweep-expired / constant-time token compare in the package; stable confirm hostname, browser polling + ack, expired-gate sweep in the Worker.

**Strengths**
- `packages/gate`: atomic dual-audit-row writes (pending + terminal) for fail-safe behavior; constant-time token comparison via `timingSafeEqual`; push-send kept inside `openGate()` (clean separation).
- `apps/gate`: single stable hostname for confirms; fail-closed on error/timeout; browser polling + ack with Bearer-token auth.

**Concerns**
- **HIGH — Fail-safe sequencing in `openGate()`:** push is sent after committing the pending state (correct), but add explicit checks so this sequence cannot fail in unexpected ways.
- **HIGH — Security of the confirm page:** confirm page must keep hardened headers and contain no 2FA/reset/login URLs; push-send is best-effort/non-fatal — document this clearly to avoid confusion.
- **MEDIUM — Idempotency reach:** `openGate()` dedups via a unique `idempotency_key`, but verify *all downstream consumers* of the gate primitive handle idempotent ops correctly.
- **MEDIUM — Missing edge/error cases:** network failure during the confirm push-send; `sweepExpired()` does not handle the race where a gate is approved just before it expires.
- **LOW — Single-writer discipline:** rule is enforced but would benefit from explicit checks/docs across components.
- **LOW — Dependency ordering:** `@atlas/gate` consumed by `apps/gate` is well-ordered; document the intended order for the future.

**Suggestions**
- Add logging + graceful error handling in `openGate()`; consider retry-with-backoff for the (non-fatal) push-send.
- Verify downstream idempotency in edge cases.
- Document the single-writer discipline explicitly.
- Test edge cases (push-send network failure) and add race-condition handling in `sweepExpired()` (approve-vs-expire).
- Document security practices; consider rate-limiting the confirm push-send.

**Risk Assessment — MEDIUM.** Primary risks: failures inside `openGate()` and race conditions (approve-vs-expire). Robust error handling + thorough testing mitigate them.

### Pass B — Daemon Browser Runner + Outward Agents (`04-04` daemon runner, `04-05` Sundial retrofit, `04-06` Usher, `04-07` Envoy)

**Summary** — Covers the irreversible-action agents: Usher (on-demand gated registration via local browser) and Envoy (gated brand publishing), both requiring explicit owner confirmation before any outward action.

**Strengths**
- Fail-safe gates: every outward action parks at the confirm gate first.
- No autonomous actions: neither agent auto-submits/auto-posts; all require explicit owner confirm.
- Captcha + payment treated as **hard stops** handed to the human.
- Credentials never leave the owner machine (browser runs locally in the already-logged-in session).
- Structured idempotency keys for replay safety / no double-counting.

**Concerns**
- **HIGH — Captcha hard stop:** detected before any irreversible step, but must be thoroughly tested to guarantee it never auto-solves.
- **HIGH — Payment hard stop:** must be rigorously enforced + tested so no payment wall is ever auto-submitted.
- **MEDIUM — Confirmation # before counter bump:** ensure the confirmation number is scraped *before* any counter bump (`events-registered++`) in **all** edge cases.
- **LOW — Dependency ordering / edge cases:** manage ordering between components so no missing edge/error case is overlooked.

**Suggestions**
- Comprehensive test scenarios for Usher + Envoy: network failures, unexpected external responses (e.g., GitHub), varied user interactions.
- Well-documented code/comments around hard stops and confirm gates.
- CI checks running Usher + Envoy tests to catch issues early.

**Specific critiques**
- `04-06` (Usher) Task 2: verify the `openGate` call is configured with the right `idempotencyKey` and `expiresInMs`; verify the `already-registered` short-circuit has no race conditions.
- `04-07` (Envoy) Task 2: verify `Envoy.publish` enqueues browser actions only for approved targets and handles partial fan-out; verify the Wire event is emitted only after approved targets publish (no silent failures).

**Risk Assessment — MEDIUM.** Primary risks: enforcement of captcha/payment hard stops and never acting without explicit confirm — mitigated by thorough testing and robust fail-safe implementation.

---

## Consensus Summary

Only one independent reviewer ran, so "consensus" here is the synthesis across its two passes plus the orchestrator's framing. The 7B reviewer **validated the plans' security posture at a high level** (it correctly identified and endorsed the gate-first, hard-stop, local-browser, idempotency design) and **raised no blocking objection** — it rated both halves **MEDIUM risk**, driven by *implementation/testing rigor* rather than *design gaps*.

### Agreed Strengths (across both passes)
- Fail-safe, gate-first design: outward actions park at a confirm gate; fail-closed on error/timeout.
- Hard stops for captcha + payment, handed to the human (never auto-solved/auto-paid).
- Credentials stay on the owner's machine (local already-logged-in browser session).
- Structured idempotency keys + atomic dual-audit-row writes for replay safety.

### Agreed Concerns (highest priority — both passes converge on "test the fail-safes")
1. **The hard-stops and fail-safe sequencing are only as good as their tests.** Both passes flag (HIGH) that captcha-never-solved, payment-never-auto-submitted, and `openGate()` sequencing need explicit, adversarial test coverage — not just correct-looking code.
2. **Counter bump must follow the scraped confirmation #** in every edge case (Usher `events-registered++`) — verify, don't assume.
3. **Idempotency must hold across all downstream gate consumers**, not just at `openGate()`.
4. **Untested edge cases:** confirm push-send network failure; `sweepExpired()` approve-vs-expire race; Envoy partial fan-out / emit-after-approve ordering.

### Divergent Views
None — a single model, two passes, no contradictions. (No second independent model was available to surface disagreement, which is itself the main gap in this review.)

### Orchestrator note on the reviewer's findings
Several "concerns" the 7B model raised are likely **already satisfied** by the plans (e.g., the plans already specify dual-audit rows, confirmation-# before counter bump, and the three-test Definition-of-Done). Because the model only saw the plans (not the existing codebase or the project's mandatory Wire-contract / replay / failure-path tests), it defaults to "add tests / verify" for things that may already be planned. Triage each concern against the actual PLAN.md acceptance criteria before treating it as an action item — the genuinely useful signal is the **emphasis on adversarial tests for the captcha/payment hard stops and the `sweepExpired` race**, which are worth confirming are explicitly enumerated in the plans' test sections.
