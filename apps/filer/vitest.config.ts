import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

// Filer tests run in real workerd (TZ=UTC). The replay-through-Steward test applies a
// Wire event via @atlas/steward-core against a real D1, so we apply the shared repo-root
// migrations (0001+0002+0003) in beforeAll (the pool does not auto-apply).
const migrations = await readD1Migrations("../../migrations");

export default defineConfig({
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
    provide: { migrations },
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.test.jsonc" },
      miniflare: {
        compatibilityFlags: ["nodejs_compat"],
      },
    }),
  ],
});
