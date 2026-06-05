import { defineConfig } from "vitest/config";

// The daemon is a plain Node process (NOT a Worker), so its tests run in the default
// Node environment — NOT the @cloudflare/vitest-pool-workers workerd pool. The drain
// logic is exercised with MOCKED fetch + a mocked Obsidian writer (no real cloud bridge,
// no real Obsidian). This config is intentionally NOT discovered by the root
// vitest.workspace.ts (which globs apps/* + packages/* only) — run it directly with
// `npx vitest run` from daemon/ or `pnpm --dir daemon test`.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
