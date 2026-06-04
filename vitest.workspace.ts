import { defineWorkspace } from "vitest/config";

// Every test-bearing app/package owns its own vitest.config.ts; this glob picks
// them up automatically (do NOT maintain an explicit per-app list).
export default defineWorkspace([
  "apps/*/vitest.config.ts",
  "packages/*/vitest.config.ts",
]);
