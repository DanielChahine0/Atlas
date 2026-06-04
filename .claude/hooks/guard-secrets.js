#!/usr/bin/env node
/**
 * Atlas PreToolUse hook (matcher: Write|Edit|MultiEdit).
 * Enforces two project invariants before a file is written:
 *   1. Secrets never live in tracked repo files (SPEC §12 / Pillar 5). Blocks an Edit/Write that
 *      would put a plaintext credential into any file — they belong in Secrets Store / wrangler
 *      secret / a git-ignored .dev.vars, referenced via a binding.
 *   2. docs/SPEC-CANON.md is the authoritative design ("if two docs disagree, this file wins"):
 *      edits to it require explicit confirmation.
 *
 * Output contract: prints {hookSpecificOutput:{permissionDecision: deny|ask}} to stdout, else exits 0.
 * Pure Node, no deps — Node LTS is a project prerequisite.
 */
let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  let input = {};
  try { input = JSON.parse(raw || "{}"); } catch { process.exit(0); }

  const ti = input.tool_input || {};
  const file = ti.file_path || ti.filePath || "";

  // Collect candidate new content across Write / Edit / MultiEdit shapes.
  const parts = [];
  if (typeof ti.content === "string") parts.push(ti.content);
  if (typeof ti.new_string === "string") parts.push(ti.new_string);
  if (Array.isArray(ti.edits)) {
    for (const e of ti.edits) if (e && typeof e.new_string === "string") parts.push(e.new_string);
  }
  const text = parts.join("\n");

  const decide = (decision, reason) => {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
    }));
    process.exit(0);
  };

  // Obvious placeholders / templated values are fine.
  const isPlaceholder = (s) =>
    /\$\{|<[^>]*>|EXAMPLE|REDACTED|CHANGE_?ME|x{6,}|placeholder|your[-_]|\.\.\.|TODO/i.test(s);

  const patterns = [
    [/sk-ant-[A-Za-z0-9_-]{12,}/, "an Anthropic API key (sk-ant-…)"],
    [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, "a private key block"],
    [/\bghs_[A-Za-z0-9]{20,}/, "a GitHub App installation token (ghs_…)"],
    [/\bgithub_pat_[A-Za-z0-9_]{20,}/, "a GitHub fine-grained PAT"],
    [/\bghp_[A-Za-z0-9]{20,}/, "a GitHub classic PAT"],
    [/\b1\/\/[A-Za-z0-9_-]{20,}/, "a Google OAuth refresh token (1//…)"],
    [/\bAIza[A-Za-z0-9_-]{20,}/, "a Google API key (AIza…)"],
  ];

  for (const [re, label] of patterns) {
    const m = text.match(re);
    if (m && !isPlaceholder(m[0])) {
      return decide(
        "deny",
        `Atlas invariant (SPEC §12): secrets never go in repo files. This looks like ${label} being ` +
          `written into ${file || "a file"}. Put it in Cloudflare Secrets Store / 'wrangler secret put' / ` +
          `a git-ignored .dev.vars and reference it via a binding. If this is a false positive, add it manually.`
      );
    }
  }

  if (/(^|\/)docs\/SPEC-CANON\.md$/.test(file)) {
    return decide(
      "ask",
      "docs/SPEC-CANON.md is the authoritative design source (it wins any doc conflict). " +
        "Confirm you intend to change canon."
    );
  }

  process.exit(0);
});
