---
description: Translate an owner-local (America/Toronto) schedule time into the correct UTC cron expression for wrangler.jsonc, with the EST↔EDT (DST) caveat. Use when adding any Cron Trigger.
argument-hint: [time + cadence — e.g. "07:45 daily" or "Fri 16:00"]
allowed-tools: Read
model: inherit
---

Convert **$ARGUMENTS** (America/Toronto, owner-local) to a UTC cron for `wrangler.jsonc`.

Atlas decision **D1**: Cloudflare Cron Triggers are **UTC-only with NO DST**. Produce BOTH versions:
- **EST** (UTC−5, ~Nov–Mar): `<expr>`
- **EDT** (UTC−4, ~Mar–Nov): `<expr>`

Then output the exact line for the config with an inline owner-local comment, e.g.:
```jsonc
"triggers": { "crons": [
  "45 12 * * *"   // 07:45 America/Toronto (EST). EDT = "45 11 * * *" — swap at the DST boundary.
] }
```

Remind: only the **trigger cron** needs the twice-yearly hand-edit. Durable in-Workflow waits should
use `step.sleepUntil` with a tz-correct `Intl` zone (`America/Toronto`) — that path is DST-safe.
