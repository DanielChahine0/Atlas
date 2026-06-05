# Phase 2: Weekly Value - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-05
**Phase:** 2-Weekly Value
**Areas discussed:** Push & alert delivery, Flagger internals & flag() rework, Scout + Friday weekly cadence, Headhunter watchlist & pipeline truth

---

## Push & alert delivery

### Q1 — Push channel
| Option | Description | Selected |
|--------|-------------|----------|
| ntfy.sh | Free, open, Cloudflare-native: one HTTPS POST to a topic; iOS/Android app; one secret | ✓ |
| Pushover | $5 one-time; polished; built-in priority/retry; 2 secrets | |
| Telegram bot | Free, already on phone; but chat app, no native priority/escalation | |

**User's choice:** ntfy.sh
**Notes:** Best fit for a single-owner Workers system; one secret to seed.

### Q2 — Ack path (bridge is outbound-only; board can't ack back)
| Option | Description | Selected |
|--------|-------------|----------|
| ntfy action button → ack endpoint | Push 'Ack' action POSTs to a token-gated Flagger endpoint, flips flag to ack, stops re-push | ✓ |
| Tap-to-open Vault note, no programmatic ack | Deep-link only; ack status cosmetic; re-push until clear/mute | |
| Time-boxed re-push, then stop | Fixed N re-pushes then silent regardless of ack | |

**User's choice:** ntfy action button → token-gated Flagger ack endpoint
**Notes:** The only inbound surface; un-ack'd P1 re-pushes every escalation_window; deterministic recovery still auto-resolves.

### Q3 — Push rollout + fallback
| Option | Description | Selected |
|--------|-------------|----------|
| Flag-gated, board is the fallback | flagger.push_enabled default off until ntfy seeded (go-live gate); board fallback on POST fail; no 2nd channel | ✓ |
| Always-on once the secret exists | No gate flag | |
| Flag-gated + backup channel | Second fallback (extra scope/secret) | |

**User's choice:** Flag-gated, board is the fallback
**Notes:** Mirrors the filer.push_enabled / AI-Gateway-ceiling gate pattern.

---

## Flagger internals & flag() rework

### Q1 — Incident topology (Steward stays sole atlas-wire consumer)
| Option | Description | Selected |
|--------|-------------|----------|
| Separate incidents queue, Flagger → Steward | New atlas-incidents queue; fire-and-forget; Flagger scores/dedupes/lifecycle then emits flag upsert to atlas-wire → Steward | ✓ |
| Steward-invoked enrichment (RPC from Steward) | Couples sole writer + puts push I/O in Steward's serial loop | |
| RPC from emitters | Every agent hard-depends on Flagger being up; morning chain would block on its monitor | |

**User's choice:** Separate incidents queue, Flagger → Steward
**Notes:** Preserves Pillar 1 + decoupling; rework flag() to enqueue an incident instead of a finished flag.

### Q2 — Scoring ownership
| Option | Description | Selected |
|--------|-------------|----------|
| Emitter hints severity; Flagger owns final severity + all trust | Min churn; KV severity_overrides; trust = evidence bands + recurrence + adjustments | ✓ |
| Emitter asserts severity AND trust | Status quo + push; trust never improves; no central policy | |
| Flagger derives severity purely from a kind taxonomy | Most faithful but full kind→severity map + migrate every call site | |

**User's choice:** Emitter hints severity; Flagger owns final severity + all trust
**Notes:** Severity stays deterministic (never the LLM); trust re-scored on recurrence.

### Q3 — Heartbeat emit + stale detection + grace
| Option | Description | Selected |
|--------|-------------|----------|
| Heartbeats on atlas-incidents + FlaggerState DO alarm, grace 10m | kind:'heartbeat' on the queue; DO alarm per slot+grace; miss → P1 trust 100; watchdog for self-death | ✓ |
| Watchdog Worker sweeps everything, grace 5m | Watchdog reads D1 run-log; one place owns 'did it run?'; latency bounded by cron cadence | |
| Per-agent grace, DO-alarm model | Tight grace for critical slots, loose for weekly; most config | |

**User's choice:** Heartbeats on atlas-incidents + FlaggerState DO alarm, grace 10m
**Notes:** Resolves the open 5-vs-10-min owner-judgment call → 10m (KV-overridable). Separate watchdog Worker (selfwatch_threshold 15m) catches Flagger's own death.

---

## Scout + Friday weekly cadence

### Q1 — Scrape method
| Option | Description | Selected |
|--------|-------------|----------|
| RSS/fetch + Gmail newsletters first; defer browser | Reuses Filer's Type/Newsletter labels; no Browser Rendering infra; lowest ToS/flake risk | ✓ |
| Browser Rendering (Playwright) from day one | Full coverage incl. JS-rendered; new infra + captcha + flake | |
| Hybrid: fetch/RSS for most, browser for 1-2 key sources | Middle ground | |

**User's choice:** RSS/fetch + Gmail newsletters first; defer browser
**Notes:** JS-rendered sources (Luma/Eventbrite/Meetup) deferred to a follow-up.

### Q2 — weekly-Herald content (deferred from Phase 1 by D1-02)
| Option | Description | Selected |
|--------|-------------|----------|
| Week-in-review retrospective | Action-required open, waiting-on, VIP, items that slipped; draft-only + 16:30 build event | ✓ |
| Daily digest, week-windowed | Reuse daily bucketing over 7 days; less distinct | |
| Events-only Friday (skip weekly-Herald) | Would fail WEEKLY-01 criterion 1 | |

**User's choice:** Week-in-review retrospective
**Notes:** Required by WEEKLY-01 criterion 1; Fri 16:00 parallel with Scout via Promise.all (build-plan-locked).

### Q3 — Interest/fit signal source (Codex has no interests section)
| Option | Description | Selected |
|--------|-------------|----------|
| Codex skills/projects + KV keyword list | No Codex schema change; tunable; profile stays in Codex | ✓ |
| Add an 'interests' section to the Codex | Touches frozen Phase-0 Codex schema + write flow | |
| KV-only interest config | Duplicates profile data outside the single source of truth | |

**User's choice:** Codex skills/projects + KV keyword list
**Notes:** Cross-cutting — also feeds Headhunter fit ranking.

---

## Headhunter watchlist & pipeline truth

### Q1 — Funnel evidence + emitter (no double-count)
| Option | Description | Selected |
|--------|-------------|----------|
| Headhunter emits from Filer's Type/Job threads | Reads labeled threads, classifies stage, single emitter, deduped by (thread, stage) | ✓ |
| Headhunter emits from task completion | Diverges from reality; no OA/interview/offer signal | |
| Manual owner-maintained kanban | Most accurate, least automation; criterion becomes manual | |

**User's choice:** Headhunter emits from Filer's Type/Job threads
**Notes:** Resolves the spec's applied-state open question; inbound email = ground truth.

### Q2 — Urgency vs fit floor (0.4)
| Option | Description | Selected |
|--------|-------------|----------|
| Closing windows + real deadlines bypass the fit floor | Nothing time-critical hidden; only non-urgent shortlist fit-gated; shaky dates → P3 | ✓ |
| Strict fit floor always applies | Low-fit-but-real deadline silently drops | |
| Watchlist companies bypass; generic boards don't | Untracked urgent deadline can still slip | |

**User's choice:** Closing windows + real deadlines bypass the fit floor
**Notes:** Matches the 'zero missed deadlines' core value; low-confidence DATES still route to Flagger P3.

### Q3 — Watchlist / boards / cycle handling
| Option | Description | Selected |
|--------|-------------|----------|
| KV config gate + small starter seed | Window model + starter seed; real list owner-curated KV set before go-live | ✓ |
| Capture the exact watchlist now | Brittle; bloats CONTEXT; needs editing each cycle | |
| Infer the watchlist from Type/Job email over time | Cold-starts empty; slow to become useful | |

**User's choice:** KV config gate + small starter seed
**Notes:** A Phase-2 config gate, like the ntfy creds and AI-Gateway ceilings.

---

## Claude's Discretion

- atlas-incidents queue config + incident schema + FlaggerState DO shape; cascade grouping; auto-resolve scope; mute-rule/severity-override KV shapes; ≥70%-actionable instrumentation.
- Scout KV knobs (min_relevance, dedupe window, max_per_digest, sparse-week relaxation, optional Calendar conflict pre-check), digest format, Event D1 record.
- Headhunter window state-machine, seen-store fingerprint, lead/push thresholds, model tiering (full→Sonnet, board-scan→Haiku).
- Whether the added crons need the optional Workers Paid upgrade; GitHub MCP read-only Type/Dev signals.

## Deferred Ideas

- JS-rendered event scraping (Browser Rendering/Playwright) — deferred from Scout v1.
- Scout → Usher registration hand-off — Phase 4 (gated).
- Second push fallback channel for Flagger — board is the only fallback in Phase 2.
- A Codex 'interests' section — using a KV keyword list this phase.
- GitHub MCP read-only Type/Dev repo signals for Headhunter/Forge ranking — optional, gated on the Phase-0 GitHub-App owner-gate.
- Optional Workers Paid upgrade — only if the new crons exceed the Free per-Worker cron cap.
