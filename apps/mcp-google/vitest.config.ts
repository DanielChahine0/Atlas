import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

// GLOBAL DECISION 3: every test-bearing app owns its own vitest.config.ts; the root
// vitest.workspace.ts GLOBS apps/*/vitest.config.ts and auto-discovers this file.
//
// @cloudflare/vitest-pool-workers ^0.16 (vitest v4) uses the Vite-plugin API
// `cloudflareTest({...})` (the old defineWorkersConfig / poolOptions.workers shape
// and the isolatedStorage flag were removed in pool 0.16 — see 00-01 deviation #1).
// Tests run inside real `workerd` (not Node mocks); the pool forces TZ=UTC like
// production. Per-test storage isolation (fresh KV) is the v4 default.
//
// mcp-google has no D1 dependency in its redact/scope tests, so (unlike steward)
// there is no migration setup file.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.test.jsonc" },
      miniflare: {
        // REQUIRED by the `agents` SDK / shared toolchain — omitting it is a runtime failure.
        compatibilityFlags: ["nodejs_compat"],
      },
    }),
  ],
});
