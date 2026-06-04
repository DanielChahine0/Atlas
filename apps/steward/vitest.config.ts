import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

// Tests run inside real `workerd` via the vitest-pool-workers Vite plugin (the
// vitest v4 API). The pool forces TZ=UTC — same as `wrangler dev` / production.
// The Steward replay (meta.changes===0), serialize, malformed, and DLQ suites
// land in Plan 04 with the StewardWriter critical section.
export default defineConfig({
  test: {
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
