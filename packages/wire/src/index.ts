// `WireEvent` is declared in contract.ts as BOTH a value (the zod schema) and a type
// (z.infer). A single `export { WireEvent }` re-exports both bindings, so consumers can
// `import { WireEvent } from "@atlas/wire"` and use it as a schema (WireEvent.parse(...))
// or as a type (let e: WireEvent).
export { WireEvent } from "./contract.js";
export { send, WIRE_MAX_BYTES, WireEventTooLargeError } from "./send.js";
