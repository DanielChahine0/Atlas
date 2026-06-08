---
status: partial
phase: 04-outward-gated
source: [04-VERIFICATION.md]
started: 2026-06-08
updated: 2026-06-08
---

## Current Test

[awaiting human testing — all 5 items are deferred owner go-live round-trips that cannot run in code/CI; same category as the Phase-0/1/3 go-live gates tracked in STATE.md → Blockers]

## Tests

### 1. Live gate confirm page renders in the owner's browser
expected: GET /confirm?t=<token> returns a styled HTML page with the artifact in a `<pre>`, Approve and Reject buttons at the correct colors (#1D4ED8 / #B91C1C), security headers set (CSP default-src 'none', x-frame-options DENY, no-store).
result: [pending]

### 2. Owner receives ntfy confirm push after openGate() fires on a live Workers deploy
expected: A push arrives on the owner's ntfy topic with a "Review & edit" action button whose URL matches /confirm?t=<token>.
blocked_by: Secrets Store seed (NTFY_TOPIC + NTFY_TOKEN) + live Workers deploy.
result: [pending]

### 3. Full Usher end-to-end: Atlas → register → gate approval → browser daemon drains → Calendar add + events-registered counter
expected: Event appears on Google Calendar; Steward events-registered counter increments; confirmation number stored.
blocked_by: Live Google OAuth round-trip; Playwright Chromium install + owner browser-profile login.
result: [pending]

### 4. Full Envoy end-to-end: publish → gate approval → GitHub README commit + LinkedIn/X prefill
expected: GitHub README section committed via the mcp-github App; browser opens LinkedIn/X composer pre-filled; owner clicks Post; NO auto-submit fires.
blocked_by: GitHub App pull_requests:write grant (04-02 Task 2); live Playwright install; Codex drive.readonly wiring.
result: [pending]

### 5. Sundial propose-removal gate: removal candidate → confirm push → owner approves → applyRemoval deletes exactly once
expected: Gate opened with the expiry-safe lifecycle; owner sees the confirm push; on approval applyRemoval calls calendar.events.delete exactly once; replay is a no-op.
blocked_by: Live calendar.events OAuth delete tool wiring (WR-01 deferred review debt).
result: [pending]

## Summary

total: 5
passed: 0
issues: 0
pending: 5
skipped: 0
blocked: 0

## Gaps
