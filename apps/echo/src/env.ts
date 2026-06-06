// apps/echo/src/env.ts
//
// Env type for the Echo Worker. Declares all Cloudflare bindings used by this Worker.
// Secrets (R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY) come from the Cloudflare Secrets Store
// — never from [vars], KV, or any tracked file (CLAUDE.md invariant).

// SecretsStoreBinding: the shape that cloudflare:workers exposes for secrets_store_secrets.
// The .get() method is async — always await it.
interface SecretsStoreBinding {
  get(): Promise<string>;
}

export interface Env {
  // EchoSession DO — per-meeting WebSocket Hibernation DO.
  // Addressed as env.ECHO_SESSION.getByName("echo-<ISO-timestamp>") per meeting.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ECHO_SESSION: DurableObjectNamespace<any>;

  // Wire PRODUCER binding (atlas-wire). Echo produces transcript.ready + wire events.
  // Echo is a PRODUCER ONLY — NO consumer binding (Pillar 1; a second atlas-wire
  // consumer is a hard CI failure).
  WIRE: Queue;

  // Incidents producer (atlas-incidents). Echo routes incidents via flag() which
  // enqueues to atlas-incidents (D2-05). Flagger is the sole consumer.
  INCIDENTS: Queue;

  // D1 — system-of-record for the meetings transcript index (0006_meetings.sql).
  // Positional ? params only (CLAUDE.md D1 gotcha).
  DB: D1Database;

  // CONFIG KV — model-tier overrides, flags, Echo knobs. Never secrets, never counters.
  CONFIG: KVNamespace;

  // BLOBS R2 — audio/raw/ (7d lifecycle) + transcripts/ (persist).
  // NOTE: R2 not yet enabled on the account (err 10042) — see Phase-0 go-live gate.
  BLOBS: R2Bucket;

  // Workers AI binding — all Claude routes through claudeFor(agent,env) -> AI Gateway.
  AI: Ai;

  // R2 presign credentials from the Cloudflare Secrets Store. Used by the presign
  // endpoint to mint S3-compatible presigned PUT URLs for approved audio uploads.
  // NEVER a literal value in [vars] — Secrets Store bindings only.
  R2_ACCESS_KEY_ID: SecretsStoreBinding;
  R2_SECRET_ACCESS_KEY: SecretsStoreBinding;

  // Non-secret plaintext var: Cloudflare account id for R2 S3-compat endpoint.
  // Format: `https://${CF_ACCOUNT_ID}.r2.cloudflarestorage.com`
  CF_ACCOUNT_ID: string;

  // AI Gateway vars (non-secret identifiers, set in [vars]).
  AIG_ACCOUNT_ID: string;
  AIG_GATEWAY_ID: string;
}
