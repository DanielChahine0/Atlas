import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

// @cloudflare/vitest-pool-workers ^0.16 (vitest v4) uses the Vite-plugin API:
// `cloudflareTest({...})` replaces the old `defineWorkersConfig`/`poolOptions.workers`
// shape (see the package's `codemods/vitest-v3-to-v4`). Tests run inside real
// `workerd` (not Node mocks). The pool forces TZ=UTC — same as `wrangler dev` and
// production — so derive owner-local dates via Intl. Per-test storage isolation is
// the default in v4 (the old `isolatedStorage: true` flag is no longer a config key).
export default defineConfig({
  test: {
    // Wave 1 ships no tests yet (the Steward critical-section + replay/serialize
    // suites land in Plan 04). Don't hard-fail the toolchain before they exist.
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
