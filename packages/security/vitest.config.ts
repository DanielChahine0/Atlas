import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

// GLOBAL DECISION 3: every test-bearing package owns its own vitest.config.ts; the root
// vitest.workspace.ts GLOBS packages/*/vitest.config.ts and auto-discovers this file (do
// NOT hand-edit the root workspace list).
//
// @cloudflare/vitest-pool-workers ^0.16 (vitest v4) uses the `cloudflareTest({...})` plugin
// API (the old defineWorkersConfig/isolatedStorage shape was removed in pool 0.16 — see
// Wave-1 deviation #1). The CI-backstop redaction test runs inside real `workerd`.
export default defineConfig({
  test: {
    passWithNoTests: true,
  },
  plugins: [
    cloudflareTest({
      miniflare: {
        // REQUIRED by the `agents` SDK / shared toolchain — omitting it is a runtime failure.
        compatibilityFlags: ["nodejs_compat"],
      },
    }),
  ],
});
