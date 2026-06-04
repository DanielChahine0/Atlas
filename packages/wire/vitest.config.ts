import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

// GLOBAL DECISION 3: every test-bearing package owns its own vitest.config.ts; the
// root vitest.workspace.ts GLOBS packages/*/vitest.config.ts and auto-discovers this
// file (do NOT hand-edit the root workspace list).
//
// @cloudflare/vitest-pool-workers ^0.16 (vitest v4) uses the Vite-plugin API:
// `cloudflareTest({...})` (the old `defineWorkersConfig`/`poolOptions.workers` shape
// and the `isolatedStorage` flag were removed in pool 0.16 — see Wave-1 deviation #1).
// Tests run inside real `workerd` (not Node mocks); the pool forces TZ=UTC like
// production. Per-test storage isolation is the v4 default.
//
// packages/wire has no Cloudflare-binding needs of its own (the WireEvent contract is
// pure zod + a producer helper that takes a stubbed Queue), so no wrangler config is
// pointed at here — only nodejs_compat is required to satisfy the toolchain.
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
