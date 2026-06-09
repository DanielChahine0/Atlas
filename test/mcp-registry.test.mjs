/**
 * Persistent registry-schema validation test (META-02, Plan 05-04, Task 3).
 *
 * Asserts that .claude/registry/mcp-registry.json matches the expected schema so a
 * regressed registry is caught post-merge under `pnpm test` (chained via the root
 * `test:registry` script into the root `test` script).
 *
 * Uses Node.js built-in node:test (available in LTS v22+). No additional framework
 * required — vitest is not needed here because this test reads a repo-root file and
 * must run in plain Node (the workerd pool in @atlas/shared cannot reach the repo root).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = resolve(__dirname, "../.claude/registry/mcp-registry.json");

// Load the registry once
const rawJson = readFileSync(REGISTRY_PATH, "utf8");
const registry = JSON.parse(rawJson);

describe("mcp-registry.json schema validation", () => {
  test("top-level version is a non-empty string", () => {
    assert.equal(typeof registry.version, "string");
    assert.notEqual(registry.version, "");
  });

  test("servers is a non-empty array", () => {
    assert.ok(Array.isArray(registry.servers), "servers must be an array");
    assert.ok(registry.servers.length > 0, "servers must be non-empty");
  });

  test("every server has required keys: name, best_at, tools, owning_agents, scopes, health", () => {
    const requiredKeys = ["name", "best_at", "tools", "owning_agents", "scopes", "health"];
    for (const server of registry.servers) {
      for (const key of requiredKeys) {
        assert.ok(key in server, `server ${server.name}: missing key "${key}"`);
      }
    }
  });

  test("every server.health is one of: connected, degraded, absent", () => {
    const valid = new Set(["connected", "degraded", "absent"]);
    for (const server of registry.servers) {
      assert.ok(
        valid.has(server.health),
        `server ${server.name}.health is "${server.health}" — must be connected, degraded, or absent`,
      );
    }
  });

  test("every server.best_at, tools, owning_agents, scopes are arrays", () => {
    for (const server of registry.servers) {
      assert.ok(Array.isArray(server.best_at), `${server.name}.best_at must be an array`);
      assert.ok(Array.isArray(server.tools), `${server.name}.tools must be an array`);
      assert.ok(Array.isArray(server.owning_agents), `${server.name}.owning_agents must be an array`);
      assert.ok(Array.isArray(server.scopes), `${server.name}.scopes must be an array`);
    }
  });

  test("side_effect_verbs array contains all required verbs", () => {
    assert.ok(Array.isArray(registry.side_effect_verbs), "side_effect_verbs must be an array");
    const required = ["post", "register", "pay", "delete", "submit", "send"];
    for (const verb of required) {
      assert.ok(
        registry.side_effect_verbs.includes(verb),
        `side_effect_verbs must include "${verb}"`,
      );
    }
  });

  test("ranking_weights is a non-null object", () => {
    assert.equal(typeof registry.ranking_weights, "object");
    assert.notEqual(registry.ranking_weights, null);
  });

  test("minimum required servers present: Gmail, GitHub, Obsidian", () => {
    const names = registry.servers.map((s) => s.name);
    for (const required of ["Gmail", "GitHub", "Obsidian"]) {
      assert.ok(names.includes(required), `servers must include "${required}"`);
    }
  });
});
