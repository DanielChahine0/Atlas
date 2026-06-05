import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

// Flagger tests run in real workerd (TZ=UTC). Apply all migrations including 0004.
const migrations = await readD1Migrations("../../migrations");

export default defineConfig({
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
    provide: { migrations },
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.test.jsonc" },
      miniflare: { compatibilityFlags: ["nodejs_compat"] },
    }),
  ],
});
