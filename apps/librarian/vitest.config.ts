import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

// Librarian tests run in real workerd (TZ=UTC). Apply all migrations including 0008.
const migrations = await readD1Migrations("../../migrations");

export default defineConfig({
  test: {
    // passWithNoTests: tests land in 05-03; this keeps pnpm test green until then.
    passWithNoTests: true,
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
