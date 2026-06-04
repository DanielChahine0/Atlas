#!/usr/bin/env node
/**
 * Atlas PreToolUse hook (matcher: Write|Edit|MultiEdit).
 * Enforces Pillar 1 — ONE writer per resource — at the moment a Worker config is written:
 * only **Steward** may consume the Wire (`atlas-wire`). A `queues.consumers` block on `atlas-wire`
 * in any other Worker creates a second Vault writer and is a hard CI fail (CLAUDE.md / DoD).
 *
 * Only fires for a `apps/<name>/wrangler.{jsonc,json,toml}` whose <name> is not Steward. The DLQ
 * consumer (`atlas-wire-dlq`) is excluded. Pure Node, no deps.
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
  if (/steward/i.test(app)) process.exit(0); // Steward is the one allowed consumer

  const parts = [];
  if (typeof ti.content === "string") parts.push(ti.content);
  if (typeof ti.new_string === "string") parts.push(ti.new_string);
  if (Array.isArray(ti.edits)) {
    for (const e of ti.edits) if (e && typeof e.new_string === "string") parts.push(e.new_string);
  }
  const text = parts.join("\n");

  const declaresConsumer = /"consumers"|\[\[\s*queues\.consumers\s*\]\]|queues\.consumers/.test(text);

  // Pillar 1 only cares whether a CONSUMER binds the live `atlas-wire` bus. A
  // `producers` reference to `atlas-wire` (every agent except Steward is a WIRE
  // producer — e.g. dlq-sink emitting Flagger incidents back onto the bus) is allowed
  // and must NOT trip this guard. So we look at the CONSUMER queue declarations only,
  // not a bare `atlas-wire` anywhere in the file, for a queue that is not the `-dlq`
  // dead-letter queue.
  //
  // JSONC: isolate the `"consumers": [ ... ]` array region (producers live in a
  // sibling array, so the bare producer queue is outside this slice). TOML: isolate
  // the `[[queues.consumers]]` table(s). Then look for an `atlas-wire` queue (sans
  // `-dlq`) inside that region only.
  let consumerRegion = "";
  const jsoncCons = text.match(/"consumers"\s*:\s*\[([\s\S]*?)\]/);
  if (jsoncCons) consumerRegion += jsoncCons[1];
  const tomlCons = text.match(/\[\[\s*queues\.consumers\s*\]\][\s\S]*?(?=\n\s*\[\[|\n\s*\[(?!\[)|$)/g);
  if (tomlCons) consumerRegion += "\n" + tomlCons.join("\n");

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

  process.exit(0);
});
