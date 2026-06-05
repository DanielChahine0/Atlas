import { describe, it, expect, vi } from "vitest";
import { RawIncidentSchema } from "../src/incident.js";
import { flag, writeRunLog } from "../src/index.js";

describe("flag() — reworked to enqueue RawIncident onto INCIDENTS (D2-05)", () => {
  it("calls env.INCIDENTS.send with the correct RawIncident shape (not env.WIRE.send)", async () => {
    const INCIDENTS = { send: vi.fn().mockResolvedValue(undefined) };
    await flag(
      { INCIDENTS } as never,
      "P2",
      "x",
      "y",
      { sourceAgent: "Forge", kind: "model_error" },
    );

    expect(INCIDENTS.send).toHaveBeenCalledTimes(1);
    const incident = INCIDENTS.send.mock.calls[0]![0] as Record<string, unknown>;
    expect(incident.source_agent).toBe("Forge");
    expect(incident.kind).toBe("model_error");
    expect(incident.severity_hint).toBe("P2");
    expect(incident.title).toBe("x");
    expect(incident.detail).toBe("y");
    // WIRE must NOT be called
    expect((incident as unknown as { WIRE?: unknown }).WIRE).toBeUndefined();
  });

  it("omitted kind defaults to 'unknown'; omitted sourceAgent defaults to 'Atlas'", async () => {
    const INCIDENTS = { send: vi.fn().mockResolvedValue(undefined) };
    await flag({ INCIDENTS } as never, "P3", "some incident");

    const incident = INCIDENTS.send.mock.calls[0]![0] as Record<string, unknown>;
    expect(incident.source_agent).toBe("Atlas");
    expect(incident.kind).toBe("unknown");
  });

  it("runId option is passed through as run_id when provided, absent when not", async () => {
    const INCIDENTS = { send: vi.fn().mockResolvedValue(undefined) };
    await flag({ INCIDENTS } as never, "P4", "heartbeat", undefined, {
      sourceAgent: "Filer",
      kind: "heartbeat",
      runId: "2026-06-05",
    });

    const incident = INCIDENTS.send.mock.calls[0]![0] as Record<string, unknown>;
    expect(incident.run_id).toBe("2026-06-05");

    // Now without runId — run_id should be absent or undefined
    const INCIDENTS2 = { send: vi.fn().mockResolvedValue(undefined) };
    await flag({ INCIDENTS: INCIDENTS2 } as never, "P4", "heartbeat", undefined, {
      sourceAgent: "Filer",
      kind: "heartbeat",
    });
    const incident2 = INCIDENTS2.send.mock.calls[0]![0] as Record<string, unknown>;
    expect(incident2.run_id).toBeUndefined();
  });

  it("RawIncident.parse rejects an object missing source_agent/kind/severity_hint/title", () => {
    expect(() =>
      RawIncidentSchema.parse({ source_agent: "Atlas", kind: "ok", severity_hint: "P3" }),
    ).toThrow(); // missing title

    expect(() =>
      RawIncidentSchema.parse({ kind: "ok", severity_hint: "P3", title: "t" }),
    ).toThrow(); // missing source_agent

    expect(() =>
      RawIncidentSchema.parse({ source_agent: "Atlas", severity_hint: "P3", title: "t" }),
    ).toThrow(); // missing kind

    expect(() =>
      RawIncidentSchema.parse({ source_agent: "Atlas", kind: "ok", title: "t" }),
    ).toThrow(); // missing severity_hint

    // Valid should pass
    expect(() =>
      RawIncidentSchema.parse({
        source_agent: "Atlas",
        kind: "ok",
        severity_hint: "P1",
        title: "title",
      }),
    ).not.toThrow();
  });
});

describe("writeRunLog() — positional-? run_log helper", () => {
  it("inserts one run_log row via a positional-? prepared statement on env.DB", async () => {
    const run = vi.fn().mockResolvedValue({ meta: { changes: 1 } });
    const bind = vi.fn().mockReturnValue({ run });
    const prepare = vi.fn().mockReturnValue({ bind });
    const DB = { prepare } as unknown as D1Database;

    await writeRunLog({ DB }, {
      agent: "Filer",
      type: "sweep",
      entity: "email",
      op: "increment",
      rows_read: 42,
      duration_ms: 1200,
      result: "ok",
    });

    expect(prepare).toHaveBeenCalledTimes(1);
    const sql = prepare.mock.calls[0]![0] as string;
    expect(sql).toContain("run_log");
    expect(sql).toContain("duration_ms");
    // positional ? only — no named/numbered params
    expect(sql).not.toMatch(/\?[0-9]|:[a-zA-Z]/);
    expect(run).toHaveBeenCalledTimes(1);
    // ts is appended (9 bind args: 8 columns + ts)
    expect((bind.mock.calls[0] as unknown[]).length).toBe(9);
  });
});
