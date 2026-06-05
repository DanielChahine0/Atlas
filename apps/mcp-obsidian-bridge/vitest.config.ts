import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

// GLOBAL DECISION 3: every test-bearing app owns its own vitest.config.ts; the root
// vitest.workspace.ts GLOBS apps/*/vitest.config.ts and auto-discovers this file.
// @cloudflare/vitest-pool-workers ^0.16 (vitest v4) uses `cloudflareTest({...})`.
// Tests run inside real `workerd` (TZ=UTC). Per-test storage isolation is the v4 default.
//
// The pool does NOT auto-apply D1 migrations. We read the shared repo-root migrations
// here (Node side) and `provide` them; the test setup file applies them to the fresh
// per-test D1 via applyD1Migrations(env.DB, migrations) in beforeAll (the 00-04 pattern).
const migrations = await readD1Migrations("../../migrations");

export default defineConfig({
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
    provide: {
      migrations,
    },
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.test.jsonc" },
      miniflare: {
        compatibilityFlags: ["nodejs_compat"],
      },
    }),
  ],
});
