// RED PHASE placeholder
import type { WindowRow } from "./windows.js";

/** D2-15: starter seed — loads only when CONFIG headhunter/tracked_companies is unset. */
export const STARTER_SEED: WindowRow[] = [];

export async function loadSeedIfEmpty(_env: { CONFIG: KVNamespace; DB: D1Database }): Promise<void> {
  throw new Error("not implemented");
}
