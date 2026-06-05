// The PUBLIC surface of @atlas/model — the AI-Gateway model factory.
//
// claudeFor(agent, env) / modelFor(agent, env) are the ONE canonical Claude entrypoint the
// 16 agents inherit: every call routes through the AI Gateway (never the direct Anthropic
// host), tiering is config-driven (KV→[vars]→map, re-tunable without redeploy), and a
// non-2xx Gateway response raises a Flagger P3 flag (canonical op:"upsert"/entity:"flag").
export { claudeFor, modelFor, gatewayBaseURL } from "./claude.js";
export type { AgentClaude } from "./claude.js";
