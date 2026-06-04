// The PUBLIC surface of @atlas/codex — a READ helper and the Codex types ONLY.
//
// READ-ONLY INVARIANT (Pillar 4; SPINE-03; T-00-71): this barrel re-exports the read
// path and types and nothing mutating. Agents inherit no Codex change path; the mutating
// forms enumerated in the acceptance grep gate are deliberately absent. The owner's
// "refresh my profile" flow is out of Phase-0 scope and is not implemented here.
export { read, codexSystemBlock, parseCodex, CODEX_DRIVE_SCOPE, CODEX_FILE_ID_KEY } from "./codex.js";
export type { Codex, CodexReadDeps } from "./codex.js";
