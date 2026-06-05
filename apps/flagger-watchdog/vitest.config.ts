import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

// flagger-watchdog tests run in real workerd (TZ=UTC). The watchdog reads CONFIG KV
// and emits to WIRE — no D1 needed (no migrations to apply).
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.test.jsonc" },
      miniflare: { compatibilityFlags: ["nodejs_compat"] },
    }),
  ],
});
