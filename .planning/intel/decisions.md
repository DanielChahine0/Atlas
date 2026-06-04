# Decisions (synthesized intel)

> Source corpus contains **no ADRs** and **nothing locked**. There are therefore no
> Decision/Consequences records of the ADR type. The settled cross-doc positions below
> come from the build plan's decision log (D1–D7) in `docs/13-build-plan.md`, which the
> project context designates as the resolved positions for the open questions raised across
> the SPEC/DOC set. These are recorded here as decisions for downstream traceability, but
> they are NOT locked ADRs — a future roadmapper may revisit them.

Precedence in effect: `ADR > SPEC > PRD > DOC`. SPEC-CANON.md is the self-declared
authoritative source ("If two docs disagree, this file wins") and is treated as the top
SPEC. The decision log lives in a DOC (`13-build-plan.md`); it does not override any SPEC
contract — it resolves the *open questions* the SPECs explicitly left open.

---

## DEC-cron-timezone (D1)
- source: /Users/danielchahine/Desktop/Programs/Atlas/docs/13-build-plan.md (decision log D1)
- status: decided, not locked
- scope: cron timezone vs DST (open question in docs/03 §6, docs/06 §12)
- decision: UTC crons plus a documented EST/EDT translation table, hand-edited at the two DST
  boundaries. `wrangler.jsonc` carries a comment block mapping each owner-local line to its UTC
  cron (07:45 ET = `45 12 * * *` EST; subtract 1h for EDT). Internal budget gates use
  `step.sleepUntil` with a tz-correct `Intl` zone, so only the trigger crons need the twice-a-year edit.
- rationale: Cloudflare Cron Triggers are UTC-only with no DST handling; explicit translation is
  the only correct option.

## DEC-d1-authoritative (D2)
- source: /Users/danielchahine/Desktop/Programs/Atlas/docs/13-build-plan.md (decision log D2)
- status: decided, not locked
- scope: D1 <-> Vault reconciliation on manual edits (open question in docs/06 §12)
- decision: D1 is authoritative; the Vault is a rendered view. Manual Vault edits are NOT treated as
  truth for counters. The Fri 16:30 weekly build re-derives `Counters/metrics.md` from D1 and
  overwrites drift, emitting a P3 Medium `counter_drift` flag. Per-entity content notes the owner
  edits by hand are left alone; only Steward-owned counter/status frontmatter is reconciled.
- rationale: Pillar 4 (single source of truth) plus pillar 1 (one writer): a hand-edit redefining a
  counter would make replays/double-counts unresolvable.

## DEC-r2-audio-retention (D3)
- source: /Users/danielchahine/Desktop/Programs/Atlas/docs/13-build-plan.md (decision log D3)
- status: decided, not locked
- scope: R2 audio retention window (open question in docs/06 §12)
- decision: Raw Echo audio expires at 7 days via an R2 lifecycle rule on the `audio/raw/` prefix only;
  derived `transcripts/` and `exports/` have no expiry. Raw upload goes direct from the local daemon
  via presigned URL so bytes never proxy through a Worker.
- rationale: Satisfies the SPEC §12 privacy boundary mechanically; the prefix split guarantees the
  expire rule can never touch a transcript.

## DEC-local-daemon-transport (D4)
- source: /Users/danielchahine/Desktop/Programs/Atlas/docs/13-build-plan.md (decision log D4)
- status: decided, not locked
- scope: local-daemon transport (mTLS vs OAuth-bearer) + heartbeat -> Flagger severity (docs/06 §12)
- decision: OAuth-bearer over an outbound-only pull/long-poll (daemon registered as a confidential
  client via the Workers OAuth Provider, presents `ATLAS_BRIDGE_TOKEN`; no inbound port, no published
  tunnel). Heartbeat: daemon beats on each poll; stale > grace -> P1 Critical, trust 100; a single
  failed write that retries successfully -> P4.
- rationale: Reuses the outbound auth Echo/Quill already need, avoids cert lifecycle on the laptop,
  keeps the "no inbound port to the laptop" invariant; a dead daemon means a stale dashboard, which
  is fleet-critical.

## DEC-model-routing-cost (D5)
- source: /Users/danielchahine/Desktop/Programs/Atlas/docs/13-build-plan.md (decision log D5)
- status: decided, not locked
- scope: Workers AI vs Anthropic-direct per agent + per-agent cost ceiling (docs/06 §12)
- decision: All reasoning/synthesis agents call Claude via AI Gateway — Opus (`claude-opus-4-8`):
  Atlas, Compass, Archivist; Sonnet (`claude-sonnet-4-6`): Forge, Herald, Scout, Headhunter-full;
  Haiku (`claude-haiku-4-5`): Filer, Headhunter-light. Tier is read from KV (`model:<codename>`),
  re-tunable without redeploy. Workers AI is used only as Filer's fallback backstop (Universal
  Endpoint -> Llama) during an Anthropic outage; reasoning agents do NOT fall back to a weaker model.
  Cost ceiling: two gateways per cost domain — `atlas-reasoning` (Opus) and `atlas-highvolume`
  (Filer/Headhunter Haiku) — each with its own dashboard rate-limit/budget; per-call
  `cf-aig-metadata:{agent}` gives per-agent cost attribution.
- rationale: Per-gateway is the only place CF enforces a hard budget; isolating the continuous Filer
  path into `atlas-highvolume` keeps the always-on labeler affordable, and a degraded plan is worse
  than a failed-and-resumed Workflow step.

## DEC-quill-phase-placement (D6)
- source: /Users/danielchahine/Desktop/Programs/Atlas/docs/13-build-plan.md (decision log D6)
- status: decided, not locked
- scope: Quill phase placement (open question in docs/12-roadmap.md)
- decision: Keep Quill in Phase 3 (milestone M5), immediately after the Echo daemon (M4) exists, with
  NO Echo data dependency — it ships once the local outbound-auth runtime is proven, before the
  outward phase.
- rationale: Quill needs the same local macOS daemon + outbound-auth plumbing as Echo, so co-locating
  amortizes the one-time runtime cost; it stays out of M6 because it is convenience, not outward-risk.

## DEC-switchboard-design-time (D7)
- source: /Users/danielchahine/Desktop/Programs/Atlas/docs/13-build-plan.md (decision log D7)
- status: decided, not locked
- scope: Switchboard — coded agent or design-time habit? (open question in docs/12-roadmap.md)
- decision: Design-time habit, not a runtime-coded agent (milestone M7 is a doc/process milestone,
  not a deployed Worker). Switchboard is consulted ad hoc when a new capability/MCP tool is needed; it
  does not run in the loop. Revisit coding it only if the fleet grows enough to feel routing pain.
- rationale: The roster already marks Switchboard "design-time only" and "doesn't run in the loop";
  building a Worker for a thing that never fires in production is pure overhead.

---

## Design pillars (canonical decisions baked into SPEC-CANON §0)
- source: /Users/danielchahine/Desktop/Programs/Atlas/docs/SPEC-CANON.md §0
- status: authoritative (SPEC), not locked
- scope: cross-cutting system invariants
- decisions:
  1. One writer per resource. Exactly one agent may mutate any given external system; the Vault
     has a single writer (Steward). Prevents races and double-counting.
  2. Suggest, don't destroy. Agents label, draft, recommend. Anything destructive or outward-facing
     (delete, post, register, pay) is gated behind explicit human confirmation.
  3. Cloud by default, local when it must be. Most agents run on Cloudflare; Echo (audio) and Quill
     (screen) run as a local macOS daemon.
  4. Single source of truth. Personal facts live in The Codex; dashboard state lives in The Vault;
     agents read the Codex, only Steward writes the Vault.
  5. Idempotent + observable. Every run is safe to repeat; every notable event/failure is reported
     to Flagger.
