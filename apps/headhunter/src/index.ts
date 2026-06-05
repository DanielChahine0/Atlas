// RED PHASE placeholder
import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env as SharedEnv, RawIncident } from "@atlas/shared";

export { HeadhunterState } from "./state.js";

export interface Env extends Omit<SharedEnv, "INCIDENTS"> {
  INCIDENTS: Queue<RawIncident>;
  HEADHUNTER_STATE?: DurableObjectNamespace;
  FORGE?: {
    createTask(
      task: {
        title: string;
        due: string | null;
        due_kind: "explicit" | "inferred";
        source_agent: string;
        thread: null;
        priority: string;
      },
      opts: { idempotencyKey: string; runId: string },
    ): Promise<{ id: string } | null>;
  };
}

export class Headhunter extends WorkerEntrypoint<Env> {
  async full(_params?: { date?: string }): Promise<{ scanned: number; tasks: number }> {
    throw new Error("not implemented");
  }

  async deadlines(_params?: { date?: string }): Promise<{ promoted: number; tasks: number }> {
    throw new Error("not implemented");
  }
}

export default {
  fetch(): Response {
    return new Response("Headhunter runs via Atlas service binding.", { status: 200 });
  },
} satisfies ExportedHandler<Env>;
