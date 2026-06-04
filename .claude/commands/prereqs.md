---
description: Verify the Atlas Phase-0 hard prerequisites (Workers PAID plan, wrangler login, Node LTS, pnpm, Queues entitlement). Run once before starting Phase 0.
allowed-tools: Bash(node:*), Bash(pnpm:*), Bash(corepack:*), Bash(npx wrangler whoami), Bash(npx wrangler queues list)
model: inherit
---

Check Atlas's Phase-0 gate (`docs/13-build-plan.md §1`). Current toolchain state:

- Node: !`node -v 2>/dev/null || echo MISSING`
- pnpm: !`pnpm -v 2>/dev/null || echo "MISSING — run: corepack enable && corepack prepare pnpm@latest --activate"`
- Cloudflare account: !`npx wrangler whoami 2>&1 | tail -6`
- Queues (proves Paid entitlement): !`npx wrangler queues list 2>&1 | head -6`

Report a ✓/✗ checklist and interpret:
- **Node** should be LTS (**v22.x**).
- **pnpm** present (via corepack).
- `wrangler whoami` must show an account on the **Workers PAID** plan.
- `wrangler queues list` succeeding **proves the Queues entitlement** — the Wire requires Paid (hard gate).

For anything missing, give the exact fix command.
