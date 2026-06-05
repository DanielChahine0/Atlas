/**
 * Minimal ambient declarations for the Node surface the daemon uses.
 *
 * The repo toolchain intentionally does NOT install @types/node (prior waves), and the
 * daemon is a standalone Node package outside the workspace. Rather than pull a full
 * @types/node, we declare ONLY the handful of Node/global APIs drain.ts touches, so the
 * daemon typechecks AS A PROJECT under strict TS with no extra dependency.
 *
 * These are deliberately narrow — they are NOT a substitute for @types/node at runtime
 * (Node 22 provides the real implementations); they exist solely to satisfy `tsc`.
 */

declare const process: {
  env: Record<string, string | undefined>;
  exit(code?: number): never;
};

declare const console: {
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

declare function setTimeout(handler: () => void, ms: number): unknown;

// The global fetch + WHATWG types (Node 22 provides these as globals via undici).
interface RequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}
interface ResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}
declare function fetch(url: string, init?: RequestInit): Promise<ResponseLike>;

// The `node:https` module surface the daemon uses for the localhost (127.0.0.1:27124)
// Obsidian write, where it must trust the plugin's self-signed cert. `rejectUnauthorized`
// is scoped to THIS Agent (the localhost connection) ONLY — never the outbound cloud fetch.
declare module "node:https" {
  export interface AgentOptions {
    rejectUnauthorized?: boolean;
  }
  export class Agent {
    constructor(options?: AgentOptions);
  }
  export interface RequestOptions {
    method?: string;
    headers?: Record<string, string>;
    agent?: Agent;
  }
  export interface ClientRequest {
    on(event: "error", cb: (err: Error) => void): void;
    write(chunk: string): void;
    end(): void;
  }
  export interface IncomingMessage {
    statusCode?: number;
    on(event: "data", cb: (chunk: unknown) => void): void;
    on(event: "end", cb: () => void): void;
  }
  export function request(
    url: string,
    options: RequestOptions,
    callback: (res: IncomingMessage) => void,
  ): ClientRequest;
}
