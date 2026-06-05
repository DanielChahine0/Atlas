import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

// @cloudflare/vitest-pool-workers ^0.16 (vitest v4) uses the Vite-plugin API:
// `cloudflareTest({...})` replaces the old `defineWorkersConfig`/`poolOptions.workers`
// shape (see the package's `codemods/vitest-v3-to-v4`). Tests run inside real
// `workerd` (not Node mocks). The pool forces TZ=UTC — same as `wrangler dev` and
// production — so derive owner-local dates via Intl. Per-test storage isolation is
// the default in v4 (the old `isolatedStorage: true` flag is no longer a config key).
//
// The pool does NOT auto-apply D1 migrations. We read the shared repo-root migrations
// here (Node side) and `provide` them; the setup file applies them to the fresh per-test
// D1 in beforeAll (the 00-04 steward pattern). The OAuth no-secret-leak test queries
// audit_log, so the schema must be present. Vitest evaluates this config with the project
// dir (apps/atlas) as cwd, so "../../migrations" resolves the same path wrangler uses.
const migrations = await readD1Migrations("../../migrations");

export default defineConfig({
  test: {
    // No-secret-leak test queries audit_log — apply the schema before any test runs.
    setupFiles: ["./test/apply-migrations.ts"],
    provide: {
      // Surfaced to the setup file via inject("migrations").
      migrations,
    },
    // Earlier waves shipped suites that need no D1 schema; keep the toolchain non-failing
    // if a future config is run with no test files.
    passWithNoTests: true,
  },
  plugins: [
    cloudflareTest({
      // Point the pool at the TEST wrangler config — it mirrors production
      // bindings miniflare can emulate locally (DO, WIRE, DB, KV) but omits the
      // remote-only `AI` binding so the pool runs fully local (no workers.dev
      // subdomain / remote-proxy session required).
      wrangler: { configPath: "./wrangler.test.jsonc" },
      miniflare: {
        // REQUIRED by the `agents` SDK — omitting it is a runtime failure.
        compatibilityFlags: ["nodejs_compat"],
      },
    }),
  ],
});
