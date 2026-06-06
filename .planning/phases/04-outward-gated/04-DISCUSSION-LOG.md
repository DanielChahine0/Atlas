# Phase 4: Outward (Gated) - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-06
**Phase:** 04-outward-gated
**Areas discussed:** Confirmation-gate mechanism, Browser-automation runtime, Automation depth past the gate, Envoy v1 target scope

---

## Confirmation-gate mechanism

### Q1 — Primary approval surface
| Option | Description | Selected |
|--------|-------------|----------|
| Push + token-gated confirm link | Reuse Phase-2 ntfy push: Approve/Reject buttons + a constant-time-token-gated confirm page rendering the literal artifact with an edit box | ✓ |
| Vault dashboard approval queue | Steward writes a Pending Approvals note; owner approves in Obsidian (outbound-only bridge can't carry approval back) | |
| Push inline only | Approve/Reject in the notification, no review/edit surface | |

**User's choice:** Push + token-gated confirm link

### Q2 — Where the gate waits / pending state
| Option | Description | Selected |
|--------|-------------|----------|
| D1 pending row + re-invoke | Durable any duration; cron-sweep expiry (fail-safe); agent re-establishes context on approve; no live session held | ✓ |
| Workflow step.waitForEvent | Durable pause + timeout, but >3-day wait exceeds Free's retention; holding a browser across the pause is fraught | |
| DO holds live browser + state | Submit the exact filled session, but a headless browser can't be held for a long human pause | |

**User's choice:** D1 pending row + re-invoke

### Q3 — Default gate timeout
| Option | Description | Selected |
|--------|-------------|----------|
| Per-action default | Usher short (~24h, events sell out); Envoy longer (~7d, posts not time-critical) | ✓ |
| 72h global | One 3-day default for all gates | |
| 24h global | Tighter fail-safe; risks expiring before owner notices | |

**User's choice:** Per-action default

### Q4 — Reusable primitive vs per-agent
| Option | Description | Selected |
|--------|-------------|----------|
| Shared packages/gate primitive | One primitive: pending schema + push/confirm route + expiry sweep + dual audit rows; Usher/Envoy/Sundial-removal/future-deletes all call it | ✓ |
| Per-agent gate logic | Inline per agent; duplicates fail-safe + audit logic | |

**User's choice:** Shared packages/gate primitive

---

## Browser-automation runtime

### Q1 — Browser runtime + session handling
| Option | Description | Selected |
|--------|-------------|----------|
| Local daemon, owner's sessions | Phase-3 daemon drives a local browser in the owner's logged-in accounts; no credential storage (§12); no Workers Paid; cloud-brain + local-hands | ✓ |
| Cloud Browser Rendering | Managed headless Chrome; per-run login; can't hold sessions without storing creds; bot-detection; likely Paid | |
| No headless browser at all | APIs/MCPs only; browser targets degrade to "open pre-filled for owner" | |

**User's choice:** Local daemon, owner's sessions

### Q2 — Workers Free vs Paid for Phase 4
| Option | Description | Selected |
|--------|-------------|----------|
| Stay on Free | Gate uses D1 pending row (not >3-day Workflow wait); local/MCP browser needs no Paid | ✓ |
| Take Paid if it unlocks Browser Rendering | Accept $5/mo upgrade for a cleaner cloud path | |
| Only if genuinely unavoidable | Default Free; let research surface any forced Paid as a go-live gate | |

**User's choice:** Stay on Free

### Q3 — Cloud-MCP vs browser split
| Option | Description | Selected |
|--------|-------------|----------|
| Yes — MCP for Calendar + GitHub | Calendar add via Calendar MCP; README + PR via mcp-github; browser only for LinkedIn/X/registration | ✓ |
| Reconsider the split | Route some MCP-able actions through the browser too | |

**User's choice:** Yes — MCP for Calendar + GitHub

---

## Automation depth past the gate

### Q1 — Envoy LinkedIn/X final click
| Option | Description | Selected |
|--------|-------------|----------|
| Owner clicks Post locally | Envoy opens pre-filled composer in the owner's browser; owner clicks Post; max safety + sidesteps ToS-automation | ✓ |
| Envoy auto-posts after confirm | Gate = authorization; bot clicks Post | |

**User's choice:** Owner clicks Post locally

### Q2 — Usher registration submit
| Option | Description | Selected |
|--------|-------------|----------|
| Usher auto-submits | Lower-stakes/reversible; gate confirmed event+price; auto-submit + scrape confirmation #; hard stops remain | ✓ |
| Owner clicks Submit locally | Usher fills, owner does final click | |

**User's choice:** Usher auto-submits

### Q3 — Envoy GitHub targets
| Option | Description | Selected |
|--------|-------------|----------|
| Agent completes after confirm | Commit README + open portfolio PR via GitHub App; PR is draft-by-nature, commit git-reversible | ✓ |
| Also require an owner step | Even README/PR waits for a manual owner action | |

**User's choice:** Agent completes after confirm

### Q4 — Payment policy
| Option | Description | Selected |
|--------|-------------|----------|
| Always manual — never auto-pay | Never enter card details; paid events stop with checkout link + P2; no override | ✓ |
| Allow a per-run "pay up to $N" | Owner pre-authorizes a capped amount at the gate | |

**User's choice:** Always manual — never auto-pay

---

## Envoy v1 target scope

### Q1 — v1 targets
| Option | Description | Selected |
|--------|-------------|----------|
| All four | LinkedIn + X (browser, owner clicks) + GitHub README + portfolio PR (MCP, agent completes) | ✓ |
| GitHub targets first; LinkedIn + X fast-follow | Ship clean MCP targets first; defer brittle browser targets | |
| All but X | Defer X; ship LinkedIn + README + portfolio PR | |

**User's choice:** All four

### Q2 — LinkedIn depth
| Option | Description | Selected |
|--------|-------------|----------|
| Auto-fill fields, owner saves | Open the LinkedIn form in the owner's browser, fill from Codex, owner clicks Save | ✓ |
| Copy-ready draft, owner pastes | Show the draft + open the form; owner pastes manually (most robust vs DOM churn) | |

**User's choice:** Auto-fill fields, owner saves

### Q3 — Portfolio repo + convention
| Option | Description | Selected |
|--------|-------------|----------|
| Configure at go-live | Repo + file convention in a config knob seeded at go-live; planning reads it | ✓ |
| Specify now in CONTEXT.md | Owner states repo + convention now for planning to hard-target | |

**User's choice:** Configure at go-live

### Q4 — Idempotency / re-announce
| Option | Description | Selected |
|--------|-------------|----------|
| No-op per project (key on slug) | envoy:<project-slug>; re-run = no-op; milestone mode deferred | ✓ |
| Allow re-announce (key on project + date) | envoy:<project>:<date>; re-announce on a new date | |

**User's choice:** No-op per project (key on slug)

---

## Claude's Discretion

- `packages/gate` internals (pending-row D1 schema, confirm-page rendering + edit round-trip, expiry-sweep
  cadence, dual audit_log rows).
- Daemon ↔ cloud browser-action transport (work-item schema, drain/ack; the daemon-side browser driver).
- mcp-github create-branch/open-PR tool for the portfolio PR.
- Usher idempotency (`usher:<event-id>:registered`) + already-registered short-circuit.
- Per-platform selectors / field maps (LinkedIn/X/event sites; reuse Quill's Codex field mapping).
- Confirm-page hosting (per-agent vs. a shared gate Worker).

## Deferred Ideas

- Envoy milestone / re-announce mode (separate from first-launch).
- Usher cancellation / un-register flow (a separate gated delete flow).
- Usher "attended" flip (who/when flips registered → attended).
- Usher waitlist-as-tracked-state.
- Cloud Browser Rendering fallback (documented only; would need Paid + ephemeral per-run login).
