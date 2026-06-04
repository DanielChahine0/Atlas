import { describe, it, expect, vi } from "vitest";
import {
  read,
  codexSystemBlock,
  parseCodex,
  CODEX_DRIVE_SCOPE,
} from "../src/index.js";
import * as codexModule from "../src/index.js";

// A stub CONFIG KV holding the Codex Drive file id (config only — never a token). Mirrors
// the @atlas/shared test convention (stub the binding surface with vi.fn(), no wrangler
// config needed for a pure-logic reader). The reader takes the drive.readonly token as an
// injected arg, so the unit test exercises the full read path with no live network.
function envWithFileId(fileId: string | null): { CONFIG: { get: ReturnType<typeof vi.fn> } } {
  return { CONFIG: { get: vi.fn(async () => fileId) } };
}

// A realistic codex.md fixture (the docs/07 YAML schema example). FACTS only — ZERO
// credentials. Wrapped in a `---` frontmatter fence to prove the reader tolerates it.
const CODEX_FIXTURE = `---
schema_version: 1
updated: 2026-05-29T09:14:00-04:00

identity:
  first_name: Daniel
  last_name: Chahine
  preferred_name: Daniel
  pronouns: he/him
  email: chahinedaniel0@gmail.com
  links:
    portfolio: https://danielchahine.dev

addresses:
  primary:
    city: Toronto
  willing_to_relocate: true

education:
  - school: University of Toronto
    degree: BSc
    field: Computer Science
    gpa: "3.8/4.0"

work_experience:
  - title: Software Engineer Intern
    company: Shopify
    bullets:
      - "Built a Workers-based pipeline cutting webhook latency 40%."

skills:
  languages: [TypeScript, Python, Go, SQL]
  frameworks: [React, Next.js, Cloudflare Workers]

projects:
  - name: Atlas
    repo: github.com/danielchahine/atlas
    blurb: Personal multi-agent orchestrator.

bios:
  headline: Software engineer building on the edge.
  short: I build reliable systems on Cloudflare.

socials:
  github: danielchahine
  linkedin: daniel-chahine
---
`;

/** A stub Drive fetch returning the fixture body (no live network). */
function driveFetchStub(body = CODEX_FIXTURE): typeof fetch {
  return vi.fn(async () =>
    new Response(body, { status: 200, headers: { "content-type": "text/markdown" } }),
  ) as unknown as typeof fetch;
}

describe("Codex read() — drive.readonly, seven §11 sections", () => {
  it("returns all seven non-empty SPINE-03 sections from a drive.readonly read", async () => {
    const env = envWithFileId("drive-file-abc123");
    const fetch = driveFetchStub();

    const codex = await read(env as never, { accessToken: "ya29.fake-drive-readonly", fetch });

    // identity / skills / bios / socials are non-empty maps.
    expect(Object.keys(codex.identity).length).toBeGreaterThan(0);
    expect(codex.identity.email).toBe("chahinedaniel0@gmail.com");
    expect(Object.keys(codex.skills).length).toBeGreaterThan(0);
    expect(Object.keys(codex.bios).length).toBeGreaterThan(0);
    expect(Object.keys(codex.socials).length).toBeGreaterThan(0);

    // education / work / projects are non-empty lists. `work` maps the YAML key work_experience.
    expect(codex.education.length).toBeGreaterThan(0);
    expect(codex.work.length).toBeGreaterThan(0);
    expect(codex.projects.length).toBeGreaterThan(0);

    // All seven keys present and non-empty (SPINE-03 acceptance).
    for (const section of ["identity", "education", "work", "skills", "projects", "bios", "socials"] as const) {
      const v = codex[section];
      const nonEmpty = Array.isArray(v) ? v.length > 0 : Object.keys(v as object).length > 0;
      expect(nonEmpty, `section ${section} must be present and non-empty`).toBe(true);
    }
  });

  it("passes the drive.readonly token as a Bearer to the Drive files.get media path (no write verb)", async () => {
    const env = envWithFileId("drive-file-abc123");
    const fetch = driveFetchStub();

    await read(env as never, { accessToken: "ya29.fake-drive-readonly", fetch });

    const call = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    const url = call[0] as string;
    const init = call[1] as RequestInit;
    expect(url).toContain("/drive/v3/files/");
    expect(url).toContain("alt=media");
    // GET only — never a write verb against Drive.
    expect((init.method ?? "GET").toUpperCase()).toBe("GET");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer ya29.fake-drive-readonly");
    // Least-privilege scope is the read-only one.
    expect(CODEX_DRIVE_SCOPE).toContain("drive.readonly");
  });

  it("throws (no silent empty) when the Codex Drive file id is missing from CONFIG", async () => {
    const emptyEnv = envWithFileId(null) as never;
    await expect(read(emptyEnv, { accessToken: "x", fetch: driveFetchStub() })).rejects.toThrow();
  });
});

describe("Codex read-only invariant — NO agent write path (T-00-71)", () => {
  it("the public barrel exports a read helper and types ONLY — no write/update/patch/put/post/delete/mutate export", () => {
    const exportNames = Object.keys(codexModule);
    expect(exportNames).toContain("read");
    for (const name of exportNames) {
      expect(name).not.toMatch(/write|update|patch|put|post|delete|mutate/i);
    }
  });
});

describe("Codex cache-as-system-block (Anthropic prompt caching at 0.1x)", () => {
  it("codexSystemBlock() returns a system TextBlockParam with cache_control {type:'ephemeral', ttl:'1h'}", () => {
    const block = codexSystemBlock("codex text");
    expect(block.type).toBe("text");
    expect(block.text).toBe("codex text");
    expect(block.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });
});

describe("Codex carries ZERO credentials (T-00-72 — facts, never secrets)", () => {
  it("the parsed Codex has no key matching /token|secret|password|api[_-]?key/i", () => {
    const codex = parseCodex(CODEX_FIXTURE);
    const blob = JSON.stringify({
      identity: codex.identity,
      education: codex.education,
      work: codex.work,
      skills: codex.skills,
      projects: codex.projects,
      bios: codex.bios,
      socials: codex.socials,
    });
    // No credential-shaped KEY survived into the parsed sections.
    const keys = blob.match(/"([^"]+)"\s*:/g) ?? [];
    for (const k of keys) {
      expect(k).not.toMatch(/token|secret|password|api[_-]?key/i);
    }
  });
});
