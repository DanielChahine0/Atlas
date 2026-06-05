import { beforeAll, inject } from "vitest";
import { env, applyD1Migrations } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";

declare module "vitest" {
  interface ProvidedContext {
    migrations: D1Migration[];
  }
}

// The pool gives each test an ISOLATED, empty D1 (per-test storage isolation is the
// v4 default). It does NOT auto-apply migrations, so we apply the shared repo-root
// migrations/0001_init_core.sql here BEFORE any test runs (the OAuth no-secret-leak
// test queries audit_log). The migrations array is read on the Node side in
// vitest.config.ts and surfaced via `provide`/`inject` (the 00-04 steward pattern).
//
// applyD1Migrations records state in a `d1_migrations` table, so re-application
// across isolated stores is itself idempotent.
const migrations = inject("migrations");

beforeAll(async () => {
  const db = (env as unknown as { DB: D1Database }).DB;
  await applyD1Migrations(db, migrations);
});
