import type { Env } from "@atlas/shared";
import type { TextBlockParam } from "@anthropic-ai/sdk/resources/messages";

// ─────────────────────────────────────────────────────────────────────────────
// The Codex reader — READ-ONLY to agents (Pillar 4; SPINE-03 / build-plan T8).
//
// The Codex (`codex.md`) is the single source of FACTS about the owner. It lives in
// Google Drive and agents read it via the LEAST-PRIVILEGE `drive.readonly` scope. There
// is NO agent write path: this module exports ONLY a read helper + types. The only
// mutation channel (the explicit "update my profile" flow) is OUT of Phase-0 scope and
// is intentionally NOT implemented here — so an agent attempting a write gets a 403 by
// the simple fact that no such code path exists.
//
// The Codex carries ZERO credentials (CLAUDE.md "never-in-Codex" invariant): it holds
// facts, never tokens. This reader never reads/stores a secret from the file body, and
// the `drive.readonly` access token is INJECTED by the caller (minted by the oauth layer
// in 00-06/00-11) so the Phase-0 unit test can stub the Drive fetch with no live network.
// ─────────────────────────────────────────────────────────────────────────────

/** The Google read-only Drive OAuth scope — least-privilege; never a broader write scope. */
export const CODEX_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly" as const;

/**
 * The CONFIG KV key holding the Codex Google-Drive file id (build-plan T8: "CONFIG entry
 * for the Drive file id"). The CONFIG KV holds the file id only — config, NEVER the token.
 */
export const CODEX_FILE_ID_KEY = "codex:drive_file_id" as const;

/**
 * The seven §11 sections SPINE-03 requires (docs/07 "Full section list"): identity,
 * education, work (work_experience), skills, projects, bios, socials. The Codex doc lists
 * ten sections (incl. addresses/EEO/voice) but SPINE-03's acceptance names these seven.
 */
export interface Codex {
  /** §1 — name, preferred name, pronouns, email, phone, links. */
  identity: Record<string, unknown>;
  /** §3 — school, degree, field, dates, GPA (a list). */
  education: unknown[];
  /** §4 — title, company, dates, location, bullets (a list; YAML key `work_experience`). */
  work: unknown[];
  /** §5 — languages, frameworks, tools (grouped). */
  skills: Record<string, unknown>;
  /** §6 — name, repo, blurb, links, tags (a list). */
  projects: unknown[];
  /** §7 — short bio, long bio, one-liner / headline. */
  bios: Record<string, unknown>;
  /** §8 — LinkedIn, X, GitHub, portfolio, handles. */
  socials: Record<string, unknown>;
  /** The raw `codex.md` text, kept so callers can cache it as one ephemeral system block. */
  raw: string;
}

/** Injected read dependencies — lets the unit test stub the Drive fetch with no live network. */
export interface CodexReadDeps {
  /** A `drive.readonly` access token (minted by the oauth layer; injected, never read from the Codex). */
  accessToken: string;
  /** Overridable for the unit test; defaults to global `fetch` (Workers runtime). */
  fetch?: typeof fetch;
}

/**
 * Read the Codex from Google Drive via `drive.readonly` and parse the seven §11 sections.
 *
 * Flow (build-plan T8 read flow):
 *   1. read the Codex Drive file id from CONFIG KV (config only — never a token),
 *   2. fetch the file body via the Drive `files.get` MEDIA path with the injected
 *      `drive.readonly` access token (Bearer),
 *   3. parse the seven sections from the `codex.md` YAML frontmatter.
 *
 * There is NO write counterpart. The Codex holds facts, never credentials.
 */
export async function read(
  env: Pick<Env, "CONFIG">,
  deps: CodexReadDeps,
): Promise<Codex> {
  const fileId = await env.CONFIG.get(CODEX_FILE_ID_KEY);
  if (!fileId) {
    throw new Error(`Codex Drive file id missing from CONFIG (key "${CODEX_FILE_ID_KEY}")`);
  }

  const doFetch = deps.fetch ?? fetch;
  // Drive v3 files.get MEDIA download (alt=media returns the raw file body). The read-only
  // scope suffices — we never request a broader write scope (least-privilege; T-00-72).
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`;
  const res = await doFetch(url, {
    method: "GET",
    headers: { authorization: `Bearer ${deps.accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Codex read failed: Drive responded ${res.status}`);
  }
  const text = await res.text();
  return parseCodex(text);
}

/**
 * Build the Codex prompt-context block. The Codex is stable across calls, so agents pass
 * it as a `system` `TextBlockParam` with `cache_control: { type: "ephemeral", ttl: "1h" }`
 * — Anthropic prompt caching reads at 0.1x cost (build-plan T8 caching rule). Returning the
 * SDK's `TextBlockParam` type means a Worker can spread it straight into `system: [...]`.
 */
export function codexSystemBlock(text: string): TextBlockParam {
  return {
    type: "text",
    text,
    cache_control: { type: "ephemeral", ttl: "1h" },
  };
}

// ── Minimal Codex-shaped YAML reader (no external dep) ───────────────────────────────────
//
// The Codex is a fixed, owner-authored shape (docs/07 schema example). We parse only the
// frontmatter top-level sections we need; this is a focused reader, NOT a general YAML
// engine. It tolerates an optional leading `---` frontmatter fence and `#` comment lines.

/** Parse the seven §11 sections out of the `codex.md` body. */
export function parseCodex(text: string): Codex {
  const body = stripFrontmatterFence(text);
  const root = parseTopLevelBlocks(body);

  return {
    identity: asMap(root["identity"]),
    education: asList(root["education"]),
    // §4's YAML key is `work_experience`; SPINE-03 exposes it as `work`.
    work: asList(root["work_experience"]),
    skills: asMap(root["skills"]),
    projects: asList(root["projects"]),
    bios: asMap(root["bios"]),
    socials: asMap(root["socials"]),
    raw: text,
  };
}

/** Drop a leading/trailing `---` YAML frontmatter fence if present; keep the inner block. */
function stripFrontmatterFence(text: string): string {
  const trimmed = text.replace(/^﻿/, "");
  const fence = trimmed.match(/^---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n[\s\S]*)?$/);
  return fence ? fence[1]! : trimmed;
}

type Block = Record<string, unknown>;

/**
 * Split a Codex body into its TOP-LEVEL keyed blocks (column-0 `key:` lines), parsing each
 * block's indented sub-tree into a nested value (a map, a list of maps, or a scalar map).
 */
function parseTopLevelBlocks(body: string): Block {
  const lines = body.split(/\r?\n/);
  const root: Block = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (isSkippable(line) || indentOf(line) !== 0) {
      i++;
      continue;
    }
    const m = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!m) {
      i++;
      continue;
    }
    const key = m[1]!;
    const inline = m[2]!.trim();
    // Gather the indented child lines belonging to this top-level key.
    const child: string[] = [];
    i++;
    while (i < lines.length && (isSkippable(lines[i]!) || indentOf(lines[i]!) > 0)) {
      if (!isSkippable(lines[i]!)) child.push(lines[i]!);
      i++;
    }
    root[key] = inline !== "" ? parseScalar(inline) : parseChildren(child);
  }
  return root;
}

/** Parse an indented child block into either a list (`- …`) or a map (`k: v`). */
function parseChildren(lines: string[]): unknown {
  if (lines.length === 0) return {};
  const base = minIndent(lines);
  const isList = lines.some((l) => l.slice(base).startsWith("- "));
  return isList ? parseList(lines, base) : parseMap(lines, base);
}

/** Parse a YAML list of (possibly multi-key) items at the given indent. */
function parseList(lines: string[], base: number): unknown[] {
  const items: unknown[] = [];
  let cur: string[] | null = null;
  const push = () => {
    if (cur) items.push(parseListItem(cur));
    cur = null;
  };
  for (const l of lines) {
    const body = l.slice(base);
    if (body.startsWith("- ")) {
      push();
      cur = [body.slice(2)];
    } else if (cur) {
      cur.push(body.replace(/^\s\s/, ""));
    }
  }
  push();
  return items;
}

/** A list item is either a scalar (`- value`) or an inline/continued map. */
function parseListItem(lines: string[]): unknown {
  const first = lines[0]!;
  const m = first.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
  if (!m) return parseScalar(first.trim());
  return parseMap(lines, 0);
}

/** Parse `key: value` map lines at the given base indent into an object. */
function parseMap(lines: string[], base: number): Block {
  const out: Block = {};
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    const body = l.slice(base);
    const m = body.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!m || indentOf(body) !== 0) {
      i++;
      continue;
    }
    const key = m[1]!;
    const inline = m[2]!.trim();
    const child: string[] = [];
    i++;
    while (i < lines.length && indentOf(lines[i]!.slice(base)) > 0) {
      child.push(lines[i]!.slice(base));
      i++;
    }
    out[key] = inline !== "" ? parseScalar(inline) : parseChildren(child);
  }
  return out;
}

/** Parse a scalar: an inline `[a, b]` flow list, a quoted string, a bool/number, or a string. */
function parseScalar(raw: string): unknown {
  const v = raw.trim();
  if (v.startsWith("[") && v.endsWith("]")) {
    const inner = v.slice(1, -1).trim();
    if (inner === "") return [];
    return inner.split(",").map((s) => parseScalar(s.trim()));
  }
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  if (v === "true") return true;
  if (v === "false") return false;
  if (v !== "" && !Number.isNaN(Number(v)) && /^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function minIndent(lines: string[]): number {
  return Math.min(...lines.filter((l) => l.trim() !== "").map(indentOf));
}

function isSkippable(line: string): boolean {
  const t = line.trim();
  return t === "" || t.startsWith("#");
}

function asMap(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function asList(v: unknown): unknown[] {
  return Array.isArray(v) ? v : v && typeof v === "object" ? [v] : [];
}
