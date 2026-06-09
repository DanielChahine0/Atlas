---
phase: 5
slug: meta-polish
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-06-09
---

# Phase 5 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Derived from `05-RESEARCH.md` → Validation Architecture + Security Domain.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest + `@cloudflare/vitest-pool-workers` v4 (runs in real `workerd`) |
| **Config file** | `apps/librarian/vitest.config.ts` (created in Wave 0 — copy `apps/flagger` / `apps/echo` pattern) |
| **Quick run command** | `pnpm --filter librarian test` |
| **Full suite command** | `pnpm test` (all workspaces) |
| **Estimated runtime** | ~30–60 seconds (full suite); quick filter <10s |

---

## Sampling Rate

- **After every task commit:** Run `pnpm --filter librarian test` (or `pnpm --filter @atlas/steward-core test` for the op-mapping task)
- **After every plan wave:** Run `pnpm test` (full suite — must stay green; baseline is the existing Phase 0–4 suite)
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** ~60 seconds

---

## Per-Task Verification Map

> Task IDs are bound during planning (planner assigns `05-NN-MM`). Rows below are the
> requirement-level behaviors every plan MUST satisfy; the planner maps each to a concrete task.

| Behavior | Req | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|----------|-----|------------|-----------------|-----------|-------------------|-------------|--------|
| Wire event is §6.4-valid with `op:"upsert"` + structured `idempotencyKey` (`librarian:<slug>:save`) | META-01 | — | N/A | unit | `pnpm --filter librarian test wire-contract` | ❌ W0 | ⬜ pending |
| Replay of same Wire event → `meta.changes === 0`, no second D1 row, no second `vault_outbox` row | META-01 | — | idempotent replay | unit (workerd) | `pnpm --filter librarian test replay` | ❌ W0 | ⬜ pending |
| Empty/oversized prompt → P4 flag, NO Wire event | META-01 | T-5-DoS | reject, no emit | unit | `pnpm --filter librarian test failure` | ❌ W0 | ⬜ pending |
| Borderline dedupe → keep-separate + low-sev/low-trust Flagger pair flag (never silent merge) | META-01 | — | suggest-don't-destroy | unit | `pnpm --filter librarian test failure` | ❌ W0 | ⬜ pending |
| Bearer gate rejects wrong/missing token (401), fail-closed on missing binding | META-01 | T-5-Auth | constant-time, fail-closed | unit | `pnpm --filter librarian test failure` | ❌ W0 | ⬜ pending |
| `toOutboxIntent` w/ `fullNote:true` → `PUT /vault/Prompts/<slug>.md` | META-01 | — | N/A | unit (steward-core) | `pnpm --filter @atlas/steward-core test` | ❌ W0 | ⬜ pending |
| `toOutboxIntent` w/ `fullNote:true` + `notePath` NOT under `Prompts/` → `NonRetryableError` | META-01 | T-5-Tamper | path-constrained write | unit (steward-core) | `pnpm --filter @atlas/steward-core test` | ❌ W0 | ⬜ pending |
| Dedupe bump (`uses++`/`last_used`) is an upsert on the SAME `slug` — replay-safe, no clone | META-01 | — | idempotent | unit (workerd) | `pnpm --filter librarian test replay` | ❌ W0 | ⬜ pending |
| `/switchboard` command file exists w/ valid YAML front-matter + 6-step algorithm body | META-02 | — | N/A | manual | inspect `.claude/commands/switchboard.md` | ❌ W0 | ⬜ pending |
| `.claude/registry/mcp-registry.json` validates against the expected registry schema | META-02 | — | N/A | unit (Node) | registry validation test | ❌ W0 | ⬜ pending |
| Switchboard gap-emit is producer-only — NO second `atlas-wire`/`atlas-incidents` consumer | META-02 | — | Pillar 1 | unit / CI guard | `.claude/hooks/guard-wire-consumer.js` + suite | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `apps/librarian/vitest.config.ts` — Vitest workerd config (copy `apps/flagger` / `apps/echo` pattern)
- [ ] `apps/librarian/test/apply-migrations.ts` — shared D1 migration runner (copy `packages/gate/test/apply-migrations.ts`)
- [ ] `apps/librarian/test/wire-contract.test.ts` — META-01 Wire shape + structured key (stub)
- [ ] `apps/librarian/test/replay.test.ts` — META-01 replay invariant (`meta.changes === 0`, bump-not-clone) (stub)
- [ ] `apps/librarian/test/failure.test.ts` — META-01 failure paths + Bearer 401 + empty/oversized + borderline-dedupe flag (stub)
- [ ] `packages/steward-core` op-mapping test — PUT full-note branch + `Prompts/` path constraint (stub or extend existing)
- [ ] `migrations/0008_prompts.sql` — D1 `prompts` table (no existing migration has it)

*The three Atlas Definition-of-Done tests (Wire-contract, replay-through-Steward, failure-path→Flagger-severity) are mandatory for Librarian.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Vault renders the Prompt library table (Dataview) sorted `last_used` desc then `uses` desc, title deep-links to `prompts/<slug>.md` | META-01 | Requires a live Obsidian vault + bridge round-trip (owner go-live) | Save 2 prompts via mock POST → bridge drains → confirm note + table row + deep-link in Obsidian |
| Real "save this prompt" hotkey from the menubar app | META-01 | Hotkey binding is deferred owner go-live setup (Echo/Quill class) | Bind hotkey, trigger capture, confirm outbound POST authenticates |
| `/switchboard <goal>` produces a sensible ranked toolset for a real goal | META-02 | Design-time judgment; quality is owner-evaluated | Run `/switchboard "register me for an event"` → inspect ranked JSON (server→tools→scopes→agent→gate flag) |

---

## Security Domain (ASVS L1)

| ASVS Category | Applies | Standard Control |
|---------------|---------|------------------|
| V2 Authentication | yes | Bearer via `timingSafeEqual` (HMAC-SHA-256, fail-closed); token via Secrets Store async binding |
| V4 Access Control | yes | Token gate on `POST /prompt/save`; fail-closed on missing binding; 404-everything-else |
| V5 Input Validation | yes | `zod` on inbound body; ~50KB soft limit on `full_prompt` (under 128KB Queue cap) |
| V6 Cryptography | yes | HMAC-SHA-256 via Web Crypto (not hand-rolled) |

**Threats → mitigations** (block on: **high**):
- Timing side-channel on Bearer → `timingSafeEqual` (`packages/gate/src/auth.ts`).
- Oversized prompt (DoS / 128KB Queue cap) → 50KB soft limit; `send()` throws before Queue.
- `notePath` injection (arbitrary Vault write) → `toOutboxIntent` constrains `notePath` to `Prompts/`; `NonRetryableError` otherwise. **[T-5-Tamper]**
- Token in logs/`audit_log` → never logged; `scope_used=''` for Librarian; Bearer never written to D1.

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 60s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
