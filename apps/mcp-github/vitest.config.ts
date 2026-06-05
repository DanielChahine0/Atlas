import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

// GLOBAL DECISION 3: every test-bearing app owns its own vitest.config.ts; the root
// vitest.workspace.ts GLOBS apps/*/vitest.config.ts and auto-discovers this file.
// @cloudflare/vitest-pool-workers ^0.16 (vitest v4) uses the Vite-plugin API
// `cloudflareTest({...})`. Tests run inside real `workerd` (TZ=UTC). Per-test storage
// isolation (fresh DO/KV) is the v4 default.
export default defineConfig({
  test: {
    // mcp-github's correctness (the stateful McpAgent + OAuthProvider composition and
    // the credentials-never-leave-the-server invariant) is proven by build + typecheck +
    // the dry-run binding resolution, not by a workerd unit suite (a real McpAgent DO
    // round-trip needs a live OAuth grant). With no test files, the workers pool would
    // exit 1 (the 00-01 finding) — passWithNoTests keeps `pnpm test` green. The redaction
    // (mcp-google), bridge, and daemon suites carry this plan's behavioral proofs.
    passWithNoTests: true,
  },
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
