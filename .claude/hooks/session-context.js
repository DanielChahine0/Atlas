#!/usr/bin/env node
/**
 * Atlas SessionStart hook. Injects the current GSD phase / focus / next-action from
 * .planning/STATE.md as additionalContext so every session opens already oriented to where
 * the project actually is — no need to re-read planning files each time. Read-only.
 */
const fs = require("fs");
const path = require("path");

let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  let input = {};
  try { input = JSON.parse(raw || "{}"); } catch {}
  const cwd = input.cwd || process.cwd();
  const statePath = path.join(cwd, ".planning", "STATE.md");

  let ctx = "";
  try {
    const s = fs.readFileSync(statePath, "utf8");
    const grabBold = (label) => {
      const m = s.match(new RegExp("\\*\\*" + label + ":\\*\\*\\s*(.+)"));
      return m ? m[1].trim() : "";
    };
    const phase = s.match(/^Phase:\s*(.+)$/m);
    const next = s.match(/Next action:\s*(.+)/);
    const focus = grabBold("Current focus");

    const bits = [];
    if (phase) bits.push("Phase " + phase[1].trim());
    if (focus) bits.push("Focus: " + focus);
    if (next) bits.push("Next: " + next[1].trim());
    if (bits.length) {
      ctx =
        "Atlas (GSD design phase) — " +
        bits.join(" · ") +
        ". Authoritative design: docs/SPEC-CANON.md; how-to-build: docs/13-build-plan.md. " +
        "Honor the 5 pillars + security in CLAUDE.md.";
    }
  } catch {
    /* no STATE.md yet — stay silent */
  }

  if (ctx) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: ctx },
    }));
  }
  process.exit(0);
});
