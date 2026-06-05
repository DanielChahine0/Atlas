import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

// Headhunter tests run in real workerd (TZ=UTC). Apply all migrations (0001+0002+0003+0004).
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
