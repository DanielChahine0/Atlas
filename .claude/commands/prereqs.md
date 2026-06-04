---
description: Verify the Atlas Phase-0 prerequisites (Cloudflare account + wrangler login, Node LTS, pnpm, Queues reachable). Workers Free is sufficient — Paid is optional headroom. Run once before starting Phase 0.
allowed-tools: Bash(node:*), Bash(pnpm:*), Bash(corepack:*), Bash(npx wrangler whoami), Bash(npx wrangler queues list)
model: inherit
---

Check Atlas's Phase-0 gate (`docs/13-build-plan.md §1`). Current toolchain state:

- Node: !`node -v 2>/dev/null || echo MISSING`
- pnpm: !`pnpm -v 2>/dev/null || echo "MISSING — run: corepack enable && corepack prepare pnpm@latest --activate"`
- Cloudflare account: !`npx wrangler whoami 2>&1 | tail -6`
- Queues (runs on Free since 2026-02-04; confirms CLI auth): !`npx wrangler queues list 2>&1 | head -6`

Report a ✓/✗ checklist and interpret:
- **Node** should be LTS (**v22.x**).
- **pnpm** present (via corepack).
- `wrangler whoami` must show a logged-in Cloudflare account — **Workers Free is sufficient** to build & deploy the spine; **Paid ($5/mo) is optional headroom**, not a gate.
- `wrangler queues list` succeeding confirms Queues is reachable (it **runs on Free** as of 2026-02-04) and the CLI is authed — it is **not** a paid-tier signal.

For anything missing, give the exact fix command.
