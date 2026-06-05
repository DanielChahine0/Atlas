/**
 * seed.ts — D2-15 starter seed.
 *
 * Loads a small set of well-known intern/new-grad programs + the `fall-2026` cycle
 * into D1 `windows` when CONFIG `headhunter/tracked_companies` is unset.
 *
 * The real owner-curated list lives in KV (headhunter/tracked_companies,
 * headhunter/boards, headhunter/cycle, headhunter/rolling_companies).
 * This seed means the Worker runs out of the box for local dev / testing.
 */

import { upsertWindow, type WindowRow } from "./windows.js";

const NOW = Date.now();
const CYCLE = "fall-2026";

/**
 * A small set of well-known tech companies with stable new-grad + intern cycles.
 * Confidence is low (0.55–0.65) since these are "expected" windows, not live observations.
 * Source "seed" is NOT "historical" so they do NOT trigger the low-confidence P3 flag path.
 */
export const STARTER_SEED: WindowRow[] = [
  {
    id: "google:fall-2026:new-grad",
    company: "Google",
    cycle: CYCLE,
    role_class: "new-grad",
    opens_est: "2026-08-01",
    closes_est: "2026-10-31",
    confidence: 0.65,
    source: "seed",
    status: "upcoming",
    last_seen_open: null,
    created_at: NOW,
    updated_at: NOW,
  },
  {
    id: "meta:fall-2026:new-grad",
    company: "Meta",
    cycle: CYCLE,
    role_class: "new-grad",
    opens_est: "2026-08-01",
    closes_est: "2026-11-15",
    confidence: 0.60,
    source: "seed",
    status: "upcoming",
    last_seen_open: null,
    created_at: NOW,
    updated_at: NOW,
  },
  {
    id: "amazon:fall-2026:new-grad",
    company: "Amazon",
    cycle: CYCLE,
    role_class: "new-grad",
    opens_est: "2026-07-15",
    closes_est: "2026-10-15",
    confidence: 0.62,
    source: "seed",
    status: "upcoming",
    last_seen_open: null,
    created_at: NOW,
    updated_at: NOW,
  },
  {
    id: "microsoft:fall-2026:new-grad",
    company: "Microsoft",
    cycle: CYCLE,
    role_class: "new-grad",
    opens_est: "2026-08-15",
    closes_est: "2026-11-30",
    confidence: 0.60,
    source: "seed",
    status: "upcoming",
    last_seen_open: null,
    created_at: NOW,
    updated_at: NOW,
  },
  {
    id: "apple:fall-2026:new-grad",
    company: "Apple",
    cycle: CYCLE,
    role_class: "new-grad",
    opens_est: "2026-09-01",
    closes_est: "2026-12-15",
    confidence: 0.55,
    source: "seed",
    status: "upcoming",
    last_seen_open: null,
    created_at: NOW,
    updated_at: NOW,
  },
  // Internship cycle (same companies, different role_class)
  {
    id: "google:fall-2026:intern",
    company: "Google",
    cycle: CYCLE,
    role_class: "intern",
    opens_est: "2026-08-01",
    closes_est: "2026-10-31",
    confidence: 0.65,
    source: "seed",
    status: "upcoming",
    last_seen_open: null,
    created_at: NOW,
    updated_at: NOW,
  },
  {
    id: "meta:fall-2026:intern",
    company: "Meta",
    cycle: CYCLE,
    role_class: "intern",
    opens_est: "2026-09-01",
    closes_est: "2026-11-30",
    confidence: 0.58,
    source: "seed",
    status: "upcoming",
    last_seen_open: null,
    created_at: NOW,
    updated_at: NOW,
  },
];

/**
 * Load the starter seed into D1 if CONFIG headhunter/tracked_companies is unset.
 * Safe to call on every full() run — upsertWindow is idempotent (INSERT OR REPLACE).
 */
export async function loadSeedIfEmpty(env: { CONFIG: KVNamespace; DB: D1Database }): Promise<void> {
  const tracked = await env.CONFIG.get("headhunter/tracked_companies");
  if (tracked != null) {
    // Owner has seeded their own list — skip the starter seed
    return;
  }

  // Load seed (idempotent — INSERT OR REPLACE)
  for (const window of STARTER_SEED) {
    await upsertWindow(env.DB, window);
  }
}
