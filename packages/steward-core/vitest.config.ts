import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

// GLOBAL DECISION 3: every test-bearing package owns its own vitest.config.ts; the
// root vitest.workspace.ts GLOBS packages/*/vitest.config.ts and auto-discovers it.
//
// @cloudflare/vitest-pool-workers ^0.16 (vitest v4) uses the Vite-plugin API
// `cloudflareTest({...})`. Tests run inside real `workerd`; the pool forces TZ=UTC
// like production. Per-test storage isolation is the v4 default.
//
// The op→D1 critical section (applyEvent) is exercised END-TO-END against a real D1
// via the StewardWriter DO in apps/steward (replay/serialize/malformed suites) — the
// DO is the only legitimate caller (it wraps applyEvent in blockConcurrencyWhile).
// This package owns its own config (per GLOBAL DECISION 3) so any pure-logic unit
// test added here also runs in workerd; no wrangler config is pointed at (the D1
// integration lives with the DO that owns the lock).
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
