## Conflict Detection Report

Mode: new (net-new bootstrap, no existing .planning/ context to check against)
Precedence in effect: ADR > SPEC > PRD > DOC
Corpus: 32 classified docs (23 SPEC, 9 DOC, 0 ADR, 0 PRD, 0 UNKNOWN). Nothing is locked.
Authoritative source: docs/SPEC-CANON.md ("If two docs disagree, this file wins").
Cycle detection: the cross-ref graph is a documentation hub-and-spoke — SPEC-CANON links to its
derived docs and they link back to it. These are reference back-links, not derivation edges; no
derivation cycle exists (all content flows from SPEC-CANON downward, nothing is derived from a doc
that derives from it). Traversal depth well under the 50 cap. No cycle blocker raised.

### BLOCKERS (0)

None. There are no ADRs and nothing is locked, so no LOCKED-vs-LOCKED contradictions are possible.
No UNKNOWN-confidence-low docs (the two medium-confidence docs, 06-hosting and agents/atlas, were
both confidently typed SPEC — medium reflects mixed DOC/SPEC signal, not type ambiguity that blocks).
No derivation cycle. No competing requirement that cannot be synthesized.

### WARNINGS (0)

None. The corpus contains no PRDs, so there are no competing acceptance-criteria variants to
preserve. All "open questions" surfaced by the SPECs (cron/DST, D1<->Vault reconciliation, R2
retention, daemon transport, model routing, Quill phase, Switchboard build-or-not) are already
RESOLVED by the build plan's decision log D1-D7 (docs/13-build-plan.md §6.3) and by the project's
designation of those as settled positions — they are recorded as decisions, not left as open
warnings. The owner-judgment calls in build-plan §7 are deliberate human decisions, not cross-doc
contradictions, and are logged in intel/context.md as decision points rather than raised here.

### INFO (3)

[INFO] Auto-resolved: agent-count phrasing differs across two DOCs — reconciled, no contradiction
  Found: docs/00-overview.md describes "a fleet of 16 specialized sub-agents" (counts sub-agents only)
  Found: docs/01-agent-roster.md states "Total agents: 17 (Atlas + 16 sub-agents, #0–#16)" (counts the
    orchestrator too)
  Authority: docs/SPEC-CANON.md §2 — canonical roster numbered #0 (Atlas) through #16 (Librarian),
    i.e. one orchestrator + 16 sub-agents
  Note: Same scope, no real disagreement — both phrasings map to the identical canonical roster. The
    synthesized intel uses the canon framing ("16 sub-agents + Atlas"); recorded in
    intel/context.md (Topic: Agent roster). No action needed.

[INFO] Auto-resolved: SPEC open questions settled by the build-plan decision log (D1–D7)
  Found: docs/03-scheduling.md §6 and docs/06-hosting-cloudflare-mcp.md §12 leave open: cron timezone
    vs DST, D1<->Vault reconciliation on manual edits, R2 audio retention window, local-daemon
    transport, and Workers-AI-vs-Anthropic model routing + cost ceilings
  Found: docs/12-roadmap.md (Open questions) leaves open: Quill's phase placement and whether
    Switchboard is worth coding at all
  Resolution: docs/13-build-plan.md §6.3 decision log resolves each as Decided (D1 cron/DST = UTC
    crons + EST/EDT translation table; D2 D1-authoritative, Vault is a rendered view; D3 raw audio
    7-day expiry on audio/raw/ only; D4 OAuth-bearer outbound-only daemon transport, stale heartbeat
    -> P1; D5 Claude via AI Gateway with per-codename KV tiering + two cost-domain gateways; D6 Quill
    stays Phase 3/M5 with no Echo dependency; D7 Switchboard = design-time habit, not a deployed
    Worker). The project designates these as the settled positions.
  Precedence note: the decision log lives in a DOC (lower precedence than the SPECs that raised the
    questions), but it does not OVERRIDE any SPEC contract — it only fills gaps the SPECs explicitly
    left open. No contract was contradicted, so this is recorded as auto-resolved, not a conflict.
    Captured in intel/decisions.md as DEC-* entries (status: decided, not locked).

[INFO] Auto-resolved: librarian.md (DOC) schema details deferred to 09-prompt-library.md (SPEC)
  Found: docs/agents/librarian.md (DOC) carries a record-shape table, a Wire event JSON schema, and a
    four-column table layout for the prompt library
  Authority: docs/09-prompt-library.md (SPEC) — line 5 of librarian.md explicitly frames it as the
    "agent-doc companion" to the canonical feature spec at ../09-prompt-library.md and ../SPEC-CANON.md
  Resolution: SPEC > DOC by default precedence; librarian.md self-defers. The canonical prompt-library
    record shape `{ title (<=6 words), slug, tags[], tool, full_prompt, created, last_used, uses }`
    from the SPEC is used in intel/constraints.md (CON-prompt-library-record). No content was dropped;
    the DOC's prose is retained as context. No action needed.
