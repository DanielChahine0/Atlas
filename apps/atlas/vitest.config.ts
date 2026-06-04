import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

// @cloudflare/vitest-pool-workers ^0.16 (vitest v4) uses the Vite-plugin API:
// `cloudflareTest({...})` replaces the old `defineWorkersConfig`/`poolOptions.workers`
// shape (see the package's `codemods/vitest-v3-to-v4`). Tests run inside real
// `workerd` (not Node mocks). The pool forces TZ=UTC — same as `wrangler dev` and
// production — so derive owner-local dates via Intl. Per-test storage isolation is
// the default in v4 (the old `isolatedStorage: true` flag is no longer a config key).
export default defineConfig({
  plugins: [
    cloudflareTest({
      // Point the pool at this Worker's wrangler.jsonc so bindings (DB, WIRE, DO
      // namespaces, …) resolve exactly as they do in production.
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // REQUIRED by the `agents` SDK — omitting it is a runtime failure.
        compatibilityFlags: ["nodejs_compat"],
      },
    }),
  ],
});
