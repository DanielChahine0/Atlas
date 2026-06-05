// RED PHASE placeholder
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index.js";

export type WindowStatus = "upcoming" | "open" | "closing" | "closed";

export class HeadhunterState extends DurableObject<Env> {
  async advanceWindow(_windowId: string, _newStatus: WindowStatus): Promise<void> {
    throw new Error("not implemented");
  }
}
