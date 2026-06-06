---
phase: 03
slug: capture-local
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-06-06
---

# Phase 03 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Derived from `03-RESEARCH.md` → Validation Architecture. Phase 3 spans a **native
> Swift capture app** (XCTest / manual-only, outside the workerd suite) and **cloud
> Workers/DOs/Workflow** (fully testable in `@cloudflare/vitest-pool-workers`). The
> automated coverage lives on the cloud side; the Swift capture, consent gate, and
> no-inbound-port proof are manual owner UAT.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework (cloud)** | Vitest 2.x + `@cloudflare/vitest-pool-workers` v4 (real `workerd`) |
| **Framework (Swift)** | XCTest (Xcode) — Swift unit tests only; integration is manual UAT |
| **Config file** | `apps/echo/vitest.config.ts`, `apps/archivist/vitest.config.ts` (Wave 0 creates) |
| **Quick run command** | `pnpm test --filter @atlas/echo --filter @atlas/archivist` |
| **Full suite command** | `pnpm test` (315 existing + new) |
| **Estimated runtime** | ~quick: seconds (new specs only) · full: existing suite + new |

---

## Sampling Rate

- **After every task commit:** `pnpm test --filter @atlas/echo --filter @atlas/archivist` (new tests only)
- **After every plan wave:** `pnpm test` (full suite — must stay green at 315+ tests)
- **Before `/gsd:verify-work`:** Full suite green **and** the Manual-Only UAT checklist signed off (consent gate, no-inbound-port `lsof` proof, TCC persistence, presigned-upload staging integration)
- **Max feedback latency:** cloud tests run locally in workerd; no watch-mode flags

---

## Per-Task Verification Map

> Task IDs are assigned by the planner. Each cloud task MUST carry an `<automated>`
> verify command (or a Wave 0 dependency). The requirement→behavior→command rows below
> are the canonical coverage targets the planner maps tasks onto.

| Req sub-ID | Behavior | Test Type | Automated Command | File Exists | Status |
|---|---|---|---|---|---|
| CAPTURE-01-a | EchoSession DO accepts WS, accumulates segments, finalizes with correct `session_id` | unit (workerd) | `pnpm test --filter @atlas/echo -- echo-session` | ❌ W0 | ⬜ pending |
| CAPTURE-01-b | EchoSession reconnect-to-same-DO (`getByName`) resumes from stored segments | unit (workerd) | `pnpm test --filter @atlas/echo -- reconnect` | ❌ W0 | ⬜ pending |
| CAPTURE-01-c | `transcript.ready` Wire event is canonical §6.4 (type/agent/structured idempotencyKey) | unit (workerd) | `pnpm test --filter @atlas/echo -- wire-contract` | ❌ W0 | ⬜ pending |
| CAPTURE-01-d | Replay of `transcript.ready` → Steward → `meta.changes === 0` | integration (workerd) | `pnpm test --filter @atlas/echo -- replay` | ❌ W0 | ⬜ pending |
| CAPTURE-01-e | Archivist Opus step sets `effort` explicitly (never omits / never hardcodes high) | unit (workerd) | `pnpm test --filter @atlas/archivist -- effort-set` | ❌ W0 | ⬜ pending |
| CAPTURE-01-f | Archivist emits Steward `upsert` + per-owner-action-item Forge events; key `archivist:<series>:<date>:ai-NN` | unit (workerd) | `pnpm test --filter @atlas/archivist -- wire-contract` | ❌ W0 | ⬜ pending |
| CAPTURE-01-g | Archivist re-run on same `session_id` → no duplicate note/task (idempotent) | unit (workerd) | `pnpm test --filter @atlas/archivist -- idempotent` | ❌ W0 | ⬜ pending |
| CAPTURE-01-h | `consent:"discarded"` transcript → `NonRetryableError`, no note produced | unit (workerd) | `pnpm test --filter @atlas/archivist -- consent-discarded` | ❌ W0 | ⬜ pending |
| CAPTURE-01-i | Presign Worker: valid OAuth scope → 200 + presigned URL; invalid scope → 403 | unit (workerd) | `pnpm test --filter @atlas/echo -- presign` | ❌ W0 | ⬜ pending |
| CAPTURE-01-j | Failure path: transcript not in R2 → Flagger P2 incident via `atlas-incidents` | unit (workerd) | `pnpm test --filter @atlas/archivist -- failure-path` | ❌ W0 | ⬜ pending |
| CAPTURE-02 | Quill never submits / never writes Wire/Vault/Codex; refuses secrets | manual-only | — (Swift app; see Manual-Only) | n/a | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `apps/echo/vitest.config.ts` — new Worker test config
- [ ] `apps/archivist/vitest.config.ts` — new Worker test config
- [ ] `apps/echo/src/__tests__/echo-session.test.ts` — CAPTURE-01-a, -b, -c, -d
- [ ] `apps/echo/src/__tests__/presign.test.ts` — CAPTURE-01-i
- [ ] `apps/archivist/src/__tests__/archivist.test.ts` — CAPTURE-01-e, -f, -g, -h, -j
- [ ] `migrations/0005_meetings.sql` — D1 `meetings` table for the transcript index (apply via per-test `applyD1Migrations` provide/inject — pool does not auto-apply)

---

## Manual-Only Verifications

> All require a physical macOS runtime / live UI and cannot run in workerd. These are
> the Phase-3 owner-UAT checklist and the **gating criteria** for trusting Phase 4.

| Behavior | Requirement | Why Manual | Test Instructions |
|---|---|---|---|
| Core Audio process-tap capture produces segments | CAPTURE-01 | Needs physical audio devices + macOS runtime | Start Echo in a meeting; confirm segments appear in EchoSession DO storage |
| WhisperKit STT accuracy | CAPTURE-01 | Needs real audio + Neural Engine | Compare transcript text to actual speech |
| FluidAudio diarization (Owner vs Speaker 2…) | CAPTURE-01 | Needs real multi-speaker audio | Verify labeling on a real call; low-confidence splits flagged P4, not dropped |
| **Consent gate = 100%** | CAPTURE-01 | Needs live UI interaction | Decline consent → verify **nothing** persisted (no D1 `meetings` row, no transcript); P3 logged |
| **Non-dismissable recording indicator** | CAPTURE-01 | Needs live UI | Indicator stays visible + non-dismissable for the whole live session on a real meeting |
| **No inbound listening port** | CAPTURE-01, CAPTURE-02 | Needs running daemon | `lsof -i -nP \| grep LISTEN` shows no port for the capture app (only Obsidian `127.0.0.1:27124` if bridge co-located) |
| Long-session silent-zeros watchdog | CAPTURE-01 | Needs 60+ min capture | Run Echo 60+ min; verify tap+aggregate-device teardown/recreate fires and capture resumes; P3 on detection |
| R2 direct upload via presigned URL | CAPTURE-01 | S3 presign unsupported in `wrangler dev`; needs deployed R2 | Staging integration: upload a transcript blob via presigned URL, confirm it lands in R2 under the scoped prefix |
| TCC permission persistence across rebuilds | CAPTURE-01, CAPTURE-02 | Needs Developer ID signing | Rebuild + relaunch; Microphone/audio-capture/Accessibility not re-prompted |
| Quill AX read + value injection on a real form | CAPTURE-02 | Needs live focused form | Hotkey on a real form; fields populate from Codex; review panel shows per-field confidence; STOP before submit |
| Quill OCR fallback on a non-AX form | CAPTURE-02 | Needs non-AX form on screen | Open a PDF form; invoke Quill; verify OCR-detected labels |
| Quill refuses secrets + EEO blank | CAPTURE-02 | Needs live form with sensitive fields | Password/SSN/payment fields not filled (P2 flag); EEO/demographics left blank |
| Raw audio/screen never leave device except approved artifact | CAPTURE-01, CAPTURE-02 | Privacy boundary proof | No upload without per-session approval; Quill emits no Wire/R2; incident flags carry form+field-labels only, never values |

---

## Validation Sign-Off

- [ ] All cloud tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive cloud tasks without automated verify
- [ ] Wave 0 covers all MISSING references (configs, DO/Workflow specs, migration)
- [ ] No watch-mode flags
- [ ] Manual-Only UAT checklist enumerated and owner-signed before phase gate
- [ ] `nyquist_compliant: true` set in frontmatter (after planner maps tasks)

**Approval:** pending
