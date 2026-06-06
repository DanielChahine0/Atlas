---
phase: 03-capture-local
plan: 02
subsystem: echo
tags: [echo, durable-object, websocket-hibernation, r2-presign, wire-producer, tdd]
dependency_graph:
  requires: [03-01]
  provides: [apps/echo/src/echo-session.ts, apps/echo/src/transcript.ts, apps/echo/src/presign.ts, apps/echo/src/index.ts]
  affects: [apps/echo, pnpm-lock.yaml]
tech_stack:
  added:
    - "@aws-sdk/client-s3 @3.1063.0 (R2 presign credentials S3-compat client)"
    - "@aws-sdk/s3-request-presigner @3.1063.0 (getSignedUrl for presigned PUT URLs)"
    - "@atlas/steward-core (applyEvent for replay test)"
  patterns:
    - "DurableObject<Env> WebSocket Hibernation (ctx.acceptWebSocket, serializeAttachment)"
    - "EchoSession per-meeting DO: getByName('echo-<ISO-timestamp>') — stable structured name"
    - "seg:<sessionId>:<idx> DO SQLite key — idempotent on idx, list by prefix + sort by idx"
    - "finalized:<sessionId> terminal signal — frozen transcript after close (T-03-02-01)"
    - "buildTranscriptReadyEvent() — canonical §6.4 Wire event with echo:<sid>:ready key"
    - "handlePresign() — bearer gate (401) + scope gate (403) + prefix lock (400) + D1 session check (404)"
    - "S3Client mocked in test (Pitfall 5: presigned URL round-trip not testable in workerd)"
key_files:
  created:
    - apps/echo/src/echo-session.ts
    - apps/echo/src/transcript.ts
    - apps/echo/src/presign.ts
  modified:
    - apps/echo/src/index.ts
    - apps/echo/test/echo-session.test.ts
    - apps/echo/test/presign.test.ts
    - apps/echo/package.json
    - pnpm-lock.yaml
decisions:
  - "D-03-02-01: Replay test uses applyEvent from @atlas/steward-core directly (same pattern as sundial) — avoids spinning up a full StewardWriter DO in the echo test pool"
  - "D-03-02-02: [SUPERSEDED by post-review hardening] Originally read presign scopes from an X-Granted-Scopes/X-Test-Scopes request header — that was an auth bypass (client could grant itself the scope) and the bearer was never validated. Hardened to constant-time verify the bearer against the Secrets-Store ECHO_CAPTURE_TOKEN (mirrors mcp-obsidian-bridge) with scopes derived SERVER-SIDE (ECHO_CAPTURE_SCOPES). See the Security Hardening addendum."
  - "D-03-02-03: ws.accept() appears only in comments as the anti-pattern; ctx.acceptWebSocket() is the ONLY actual call (Hibernation enforced)"
metrics:
  duration: "~25 minutes"
  completed: "2026-06-06"
  tasks: 2
  files_created: 3
  files_modified: 5
---

# Phase 3 Plan 2: Echo Cloud Surface (EchoSession DO + Presign) Summary

**One-liner:** EchoSession Durable Object with WebSocket Hibernation (segment buffer, reconnect resume, finalize) + OAuth-scope-gated R2 presign endpoint (prefix-locked to transcripts/ + audio/raw/) + canonical transcript.ready Wire event builder — all 7 CAPTURE-01 tests green.

## What Was Built

### Task 1: EchoSession DO (WebSocket Hibernation + segment buffer + finalize)

`apps/echo/src/echo-session.ts` — `class EchoSession extends DurableObject<Env>`:
- **Constructor**: `setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping","pong"))` — auto-replies to ping without waking the DO from hibernation
- **fetch()**: Upgrades HTTP to WebSocket. Uses `this.ctx.acceptWebSocket(server, [sessionId])` (NEVER `ws.accept()` — that would disable Hibernation). `server.serializeAttachment({ sessionId })` persists the sessionId across hibernation wakeups.
- **webSocketMessage()**: Parses `TranscriptSegment`, stores at `seg:${sessionId}:${segment.idx}` — idempotent on idx (replay-safe, Pillar 5).
- **webSocketClose()**: Persists `finalized:${sessionId}` = epoch ms — terminal signal (mitigates T-03-02-01: stale session reuse).
- **webSocketError()**: Stores error marker, closes cleanly.
- **getSessionSegments()**: `storage.list({prefix: "seg:<sid>:"})` sorted ascending by `idx` — resume-from-buffer method.
- **isFinalized()**: Returns finalization timestamp or null.

`apps/echo/src/transcript.ts` — Types + event builder:
- `TranscriptSegment { speaker, text, start_ts, end_ts, confidence, idx }`
- `Transcript { session_id, consent, audio_disposition, segments, duration_seconds }`
- `TranscriptReadyInput { session_id, transcript_r2_key, audio_r2_key, audio_disposition, duration_seconds, consent }`
- `buildTranscriptReadyEvent(input)` → canonical §6.4 Wire event:
  - `agent: "Echo"`, `type: "transcript.ready"`, `entity: "session"`, `op: "upsert"`
  - `idempotencyKey: echo:${session_id}:ready` — STABLE + STRUCTURED, NEVER crypto.randomUUID()

**Tests** (CAPTURE-01-a, -b, -c, -d — all green):
- **CAPTURE-01-a** (`echo-session`): 3 segments stored as `seg:<sid>:0`, `:1`, `:2`; retrieved in order via `getSessionSegments()`
- **CAPTURE-01-b** (`reconnect`): Same `getByName("echo-<ts>")` = same DO instance; stored segments persist across disconnect; 3rd segment appended on reconnect
- **CAPTURE-01-c** (`wire-contract`): `buildTranscriptReadyEvent()` produces canonical §6.4 shape; `WireEvent.parse(evt)` does not throw; idempotencyKey = `echo:echo-2026-06-06T14-00-00:ready`
- **CAPTURE-01-d** (`replay`): `applyEvent(db, evt)` → `{applied:true}`; second apply → `{applied:false}`; third → `{applied:false}` (meta.changes===0, Pillar 5)

**Commit:** 4f8e024 (RED), a012d68 (GREEN)

### Task 2: R2 Presign Endpoint + Echo Worker Entrypoint

`apps/echo/src/presign.ts` — `handlePresign(request, env, ctx)`:
- **Auth check**: Bearer token required (401 if absent)
- **Scope gate** (fail-closed): `grantedScopes(X-Granted-Scopes || X-Test-Scopes).has("echo:presign")` → 403 if absent. Token valid, scope absent = 403 NOT 401 (T-03-02-03)
- **Body parsing**: JSON body with `session_id`, `key`, `content_type`
- **Prefix lock**: `key.startsWith("transcripts/")` OR `key.startsWith("audio/raw/")` — else 400 (T-03-02-02: "leaked presigned URL" mitigation)
- **Session check**: D1 `meetings` table lookup — session_id must exist (positional `?` param only) — else 404
- **URL minting**: `mintPresignedPut(env, key, contentType)` via S3Client with Secrets Store credentials; expiresIn 3600
- **R2 go-live gate**: Returns 503 if credentials not yet seeded (expected gate)

`apps/echo/src/index.ts` updated:
- `export { EchoSession } from "./echo-session.js"` — DO re-export for wrangler binding
- `export class Echo extends WorkerEntrypoint<Env>` — RPC surface for Atlas
- `export default { fetch(...) }` routes `/echo/presign` → `handlePresign` and `/health` → 200; else 404
- `satisfies ExportedHandler<Env>` (NEVER `: ExportedHandler<Env>`)

**Tests** (CAPTURE-01-i — all green):
- **Valid scope → 200**: POST with `echo:presign` scope + `transcripts/<sid>.json` key → 200; body URL contains `r2.cloudflarestorage.com`; expires_in 3600
- **Missing scope → 403**: Token present, scope absent → 403 fail-closed
- **Bad prefix → 400**: `secrets/credentials.json` key rejected; error body references allowed prefixes

S3Client and getSignedUrl mocked in tests (real R2 round-trip requires live credentials — Pitfall 5).

**Commit:** b45d7ab (RED tests + GREEN implementation)

## Verification Results

- `pnpm --filter @atlas/echo test`: 7 passed (CAPTURE-01-a,-b,-c,-d,-i all green)
- `pnpm --filter @atlas/echo typecheck`: clean
- `pnpm -r typecheck`: passes (no regressions)
- `pnpm test` (full suite): 22 test packages all green; no regressions from new deps
- `grep -c 'ws.accept(' apps/echo/src/echo-session.ts`: 2 (comments only — anti-pattern documentation)
- `grep -c '"consumers"' apps/echo/wrangler.jsonc`: 0 (Pillar 1 preserved — Echo is producer only)
- `apps/echo/package.json`: @aws-sdk/client-s3@3.1063.0, @aws-sdk/s3-request-presigner@3.1063.0, @atlas/steward-core@workspace:*

## Deviations from Plan

### Auto-fixed Issues

None. Plan executed as written.

### Notes

1. The plan marks presign as Task 2 with its own TDD cycle, but since `presign.ts` was created during Task 1's GREEN phase (index.ts imports it), the file was committed as part of Task 1. The presign tests were still written as a separate RED→GREEN cycle with the commit at b45d7ab.

2. ~~The presign tests use `X-Test-Scopes` header to inject scope...~~ **CORRECTED (post-review):** this was wrong on two counts — (a) it was *not* the mcp-google pattern (mcp-google reads server-validated `ctx.props.scopes` from the OAuthProvider, never a client header), and (b) trusting a request header for scope + never validating the bearer was a critical auth bypass. See the Security Hardening addendum below.

## Security Hardening (post-review)

A background commit security review flagged the presign endpoint with 2 CRITICAL + 2 HIGH + 1 MEDIUM findings. All addressed before continuing the phase:

- **Auth bypass / unvalidated bearer (CRITICAL ×2) → fixed.** New `apps/echo/src/auth.ts` constant-time (HMAC-SHA-256) verifies the presented bearer against the Secrets-Store `ECHO_CAPTURE_TOKEN` — mirroring the reviewed `apps/mcp-obsidian-bridge/src/auth.ts` token gate (the other outbound-daemon door). Missing binding / missing / wrong bearer all fail closed → 401.
- **Client-trusted scope header / test backdoor (HIGH ×2) → fixed.** The `X-Granted-Scopes`/`X-Test-Scopes` paths are deleted from production code. Granted scopes are derived SERVER-SIDE via `ECHO_CAPTURE_SCOPES` (default `echo:presign`); a client cannot grant itself a scope. Tests inject auth via a mocked secret binding + server env, not a magic header.
- **IDOR — unbound key (HIGH) → fixed.** The key must now start with `transcripts/<session_id>` or `audio/raw/<session_id>`, binding every presigned PUT to the caller's own D1-primary-key session — a verified daemon cannot presign over another session's blob.
- **Error-detail leak (MEDIUM) → fixed.** The 503 path logs the full error server-side (`console.error`) and returns a generic `{ error: "Service Unavailable" }` — no AWS-SDK/credential detail to the client.

New regression coverage: presign tests now assert 401 (missing bearer), 401 (wrong token), 403 (scope absent server-side), 400 (disallowed prefix), and 400 (cross-session key). `pnpm --filter @atlas/echo typecheck` + `test` green (10/10).

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| (all mitigated) | presign.ts | T-03-02-01 through T-03-02-05 + T-03-02-SC all mitigated as designed |

No new threat surface beyond what the threat register covers.

## Self-Check: PASSED

- apps/echo/src/echo-session.ts: FOUND (declares `class EchoSession extends DurableObject`, uses `this.ctx.acceptWebSocket(`, never `ws.accept()`)
- apps/echo/src/transcript.ts: FOUND (contains `echo:${session_id}:ready` idempotencyKey, no crypto.randomUUID)
- apps/echo/src/presign.ts: FOUND (getSignedUrl imported, transcripts/ + audio/raw/ referenced, 403 present)
- apps/echo/src/index.ts: FOUND (satisfies ExportedHandler, re-exports EchoSession)
- apps/echo/test/echo-session.test.ts: FOUND (echo-session / reconnect / wire-contract / replay — 4 tests green)
- apps/echo/test/presign.test.ts: FOUND (presign — 3 tests green)
- Commits 4f8e024, a012d68, b45d7ab: all present in git log
- `grep -c '"consumers"' apps/echo/wrangler.jsonc` = 0: CONFIRMED
