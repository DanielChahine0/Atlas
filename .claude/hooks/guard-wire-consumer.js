#!/usr/bin/env node
/**
 * Atlas PreToolUse hook (matcher: Write|Edit|MultiEdit).
 * Enforces Pillar 1 — ONE writer per resource — at the moment a Worker config is written:
 *
 *   - only **Steward** may consume `atlas-wire`.
 *   - only **Flagger** may consume `atlas-incidents`.
 *
 * A `queues.consumers` block on `atlas-wire` in any other Worker creates a second Vault
 * writer (hard CI fail). A `queues.consumers` block on `atlas-incidents` in any other
 * Worker violates the single-consumer contract (also hard CI fail).
 *
 * DLQ consumers are explicitly excluded:
 *   - `atlas-wire-dlq`     → dlq-sink is the legitimate consumer (different queue).
 *   - `atlas-incidents-dlq` → dlq-sink is the legitimate consumer (different queue).
 *
 * Producer bindings (`{ "binding": "INCIDENTS", "queue": "atlas-incidents" }`) are
 * allowed on any Worker — they live in the `producers` block, not `consumers`.
 *
 * Only fires for `apps/<name>/wrangler.{jsonc,json,toml}`. Pure Node, no deps.
 */
let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  let input = {};
  try { input = JSON.parse(raw || "{}"); } catch { process.exit(0); }

  const ti = input.tool_input || {};
  const file = ti.file_path || ti.filePath || "";
  if (!/wrangler\.(jsonc?|toml)$/.test(file)) process.exit(0);

  const m = file.match(/(?:^|\/)apps\/([^/]+)\/wrangler\.(?:jsonc?|toml)$/);
  const app = m ? m[1] : "";
  if (!app) process.exit(0);

  const parts = [];
  if (typeof ti.content === "string") parts.push(ti.content);
  if (typeof ti.new_string === "string") parts.push(ti.new_string);
  if (Array.isArray(ti.edits)) {
    for (const e of ti.edits) if (e && typeof e.new_string === "string") parts.push(e.new_string);
  }
  const text = parts.join("\n");

  const declaresConsumer = /"consumers"|\[\[\s*queues\.consumers\s*\]\]|queues\.consumers/.test(text);

  // Isolate the consumer region only (producers live in a sibling array/block and
  // must NOT be matched — a bare `atlas-wire` or `atlas-incidents` in a producer
  // binding is allowed on every Worker).
  //
  // JSONC: isolate the `"consumers": [ ... ]` array region.
  // TOML:  isolate each `[[queues.consumers]]` table.
  let consumerRegion = "";
  const jsoncCons = text.match(/"consumers"\s*:\s*\[([\s\S]*?)\]/);
  if (jsoncCons) consumerRegion += jsoncCons[1];
  const tomlCons = text.match(/\[\[\s*queues\.consumers\s*\]\][\s\S]*?(?=\n\s*\[\[|\n\s*\[(?!\[)|$)/g);
  if (tomlCons) consumerRegion += "\n" + tomlCons.join("\n");

  // ── atlas-wire consumer guard ─────────────────────────────────────────────
  // Steward is the ONLY allowed consumer. DLQ (`atlas-wire-dlq`) is a different
  // queue and is allowed on dlq-sink.
  if (!(/steward/i.test(app))) {
    const consumesAtlasWire =
      /"queue"\s*:\s*"atlas-wire(?!-dlq)\b/.test(consumerRegion) ||
      /\bqueue\s*=\s*"atlas-wire(?!-dlq)\b/.test(consumerRegion);

    if (declaresConsumer && consumesAtlasWire) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            `Atlas Pillar 1 (one writer per resource): only Steward may consume the Wire. '${app}' must ` +
            `not declare a queues.consumers block on 'atlas-wire' — that creates a second Vault writer ` +
            `(a hard CI fail). Producers use the WIRE binding (queues.producers); the consumer lives ONLY ` +
            `in apps/steward. If '${app}' needs its own queue, give it a different queue name, not atlas-wire.`,
        },
      }));
      process.exit(0);
    }
  }

  // ── atlas-incidents consumer guard ───────────────────────────────────────
  // Flagger is the ONLY allowed consumer. DLQ (`atlas-incidents-dlq`) is a different
  // queue and is allowed on dlq-sink. Producer bindings (the INCIDENTS binding used
  // by all other agents to enqueue incidents) are NOT consumers and must not be flagged.
  if (!(/flagger/i.test(app))) {
    // Match `atlas-incidents` but NOT `atlas-incidents-dlq` (the DLQ is a different queue).
    const consumesAtlasIncidents =
      /"queue"\s*:\s*"atlas-incidents(?!-dlq)\b/.test(consumerRegion) ||
      /\bqueue\s*=\s*"atlas-incidents(?!-dlq)\b/.test(consumerRegion);

    if (declaresConsumer && consumesAtlasIncidents) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            `Atlas Pillar 1 (one writer per resource): only Flagger may consume atlas-incidents. '${app}' ` +
            `must not declare a queues.consumers block on 'atlas-incidents' — that creates a second consumer ` +
            `(a hard CI fail). Other Workers enqueue incidents via the INCIDENTS producer binding ` +
            `(queues.producers); the consumer lives ONLY in apps/flagger. The DLQ (atlas-incidents-dlq) ` +
            `is consumed by dlq-sink and is a distinct queue — that is allowed.`,
        },
      }));
      process.exit(0);
    }
  }

  process.exit(0);
});
