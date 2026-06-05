import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

// GLOBAL DECISION 3: every test-bearing app owns its own vitest.config.ts; the root
// vitest.workspace.ts GLOBS apps/*/vitest.config.ts and auto-discovers this file.
// @cloudflare/vitest-pool-workers ^0.16 (vitest v4) uses the Vite-plugin API
// `cloudflareTest({...})`. Tests run inside real `workerd` (TZ=UTC). Per-test storage
// isolation (fresh DO/KV) is the v4 default.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.test.jsonc" },
      miniflare: {
        // REQUIRED by the `agents` SDK — omitting it is a runtime failure.
        compatibilityFlags: ["nodejs_compat"],
      },
    }),
  ],
});
