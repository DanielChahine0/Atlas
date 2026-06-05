import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

// @atlas/tasks store tests run against a REAL D1 in workerd (mirrors apps/steward).
// @cloudflare/vitest-pool-workers ^0.16 (vitest v4) uses the Vite-plugin API
// cloudflareTest({...}); tests run in real `workerd` with TZ=UTC; per-test storage
// isolation (fresh D1) is the v4 default.
//
// The pool does NOT auto-apply D1 migrations. We read the shared repo-root migrations
// here (Node side) and `provide` them; the setup file applies 0001+0002+0003 to the
// fresh per-test D1 in beforeAll. The project dir (packages/tasks) is cwd, so the
// shared migrations/ resolves at "../../migrations" — same path wrangler.test.jsonc uses.
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
        // REQUIRED by the shared toolchain — omitting it is a runtime failure.
        compatibilityFlags: ["nodejs_compat"],
      },
    }),
  ],
});
