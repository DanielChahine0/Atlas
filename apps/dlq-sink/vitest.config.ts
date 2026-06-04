import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

// GLOBAL DECISION 3: every test-bearing app owns its own vitest.config.ts; the root
// vitest.workspace.ts GLOBS apps/*/vitest.config.ts and auto-discovers this file.
//
// @cloudflare/vitest-pool-workers ^0.16 (vitest v4) uses the Vite-plugin API
// `cloudflareTest({...})` (the old defineWorkersConfig / poolOptions.workers shape and
// the isolatedStorage flag were removed in pool 0.16 — see 00-01/00-04 deviation #1).
// Tests run inside real `workerd` (not Node mocks); the pool forces TZ=UTC like
// production. Per-test storage isolation (fresh D1/KV) is the v4 default.
//
// The pool does NOT auto-apply D1 migrations. We read the shared repo-root migrations
// here (Node side) and `provide` them; the test setup file applies them to the fresh
// per-test D1 via applyD1Migrations(env.DB, migrations) in beforeAll. Vitest evaluates
// this config with the project dir (apps/dlq-sink) as cwd, so the shared repo-root
// migrations/ resolves at "../../migrations" — the same path the wrangler.test.jsonc
// migrations_dir uses. (Relative string avoids depending on @types/node.)
const migrations = await readD1Migrations("../../migrations");

export default defineConfig({
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
    provide: {
      // Surfaced to the setup file via inject("migrations").
      migrations,
    },
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.test.jsonc" },
      miniflare: {
        // REQUIRED by the shared toolchain — omitting it is a runtime failure.
        compatibilityFlags: ["nodejs_compat"],
      },
    }),
  ],
});
