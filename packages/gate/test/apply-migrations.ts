import { beforeAll, inject } from "vitest";
import { env, applyD1Migrations } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";

declare module "vitest" {
  interface ProvidedContext {
    migrations: D1Migration[];
  }
}

// Apply the shared repo-root migrations (0001..0007) to the fresh per-test D1
// before any test runs (the pool does not auto-apply). The migrations array is read on the
// Node side in vitest.config.ts and surfaced via provide/inject.
const migrations = inject("migrations");

beforeAll(async () => {
  const db = (env as unknown as { DB: D1Database }).DB;
  await applyD1Migrations(db, migrations);
});
