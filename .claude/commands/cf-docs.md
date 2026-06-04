---
description: Pull CURRENT Cloudflare / Workers / Agents-SDK / MCP-SDK / Wrangler docs for a topic via context7 + the Cloudflare Docs MCP. Use before writing any Workers/Wrangler/Agents/MCP code so syntax & versions are current, not from training data.
argument-hint: [topic — e.g. "Durable Objects alarms" or "Queues consumer config"]
allowed-tools: mcp__context7__resolve-library-id, mcp__context7__query-docs, mcp__cloudflare-docs__*, WebSearch, WebFetch, Read
model: inherit
---

Research the current, authoritative docs for: **$ARGUMENTS**

These SDKs move weekly — prefer the **cloudflare-docs** MCP and **context7** (resolve the library id,
then query docs) over your training data.

Cross-check what you find against Atlas's pins (see @CLAUDE.md) and flag any drift explicitly:
- `agents` SDK **0.14.x** (requires `compatibility_flags: ["nodejs_compat"]`; transitively pins MCP SDK 1.29.0)
- `@modelcontextprotocol/sdk` **1.29.0** — use `registerTool()`, NOT the v2 alpha
- `@cloudflare/workers-oauth-provider` **0.7.x**
- `wrangler` latest v4 (`kv namespace`, not `kv:namespace`)

Return: the current syntax/config, the **minimal working snippet**, the version it applies to, and any
compat/migration caveat. If it contradicts a pin in CLAUDE.md or `docs/13-build-plan.md`, say so.
