import { describe, it, expect, vi } from "vitest";
import {
  inferDeadline,
  fridayOf,
  ownerOffset,
  ownerLocalDateTime,
  type DeadlineSignals,
} from "../src/deadline.js";

// Deadline-inference unit tests (pure, no D1). Runs in workerd (TZ=UTC), so all owner-local
// math must be derived explicitly via the America/Toronto offset — never a bare Date local.

describe("inferDeadline — explicit path (NEW-F1)", () => {
  it("a stated 'by EOD Monday June 2' parses to 2026-06-02T23:59:00-04:00 (explicit, verbatim date)", () => {
    // The extractor parsed the date the email stated verbatim + flagged EOD; the explicit
    // branch (previously DEAD because ExtractedTask carried no explicit fields) must fire.
    const signals: DeadlineSignals = { explicitDue: "2026-06-02", eod: true };
    const { due, due_kind } = inferDeadline("2026-05-30", signals);
    expect(due_kind).toBe("explicit");
    expect(due).toBe("2026-06-02T23:59:00-04:00");
  });

  it("a stated explicit date (no EOD) is used verbatim with due_kind 'explicit'", () => {
    const signals: DeadlineSignals = { explicitDue: "2026-06-02" };
    const { due, due_kind } = inferDeadline("2026-05-30", signals);
    expect(due_kind).toBe("explicit");
    expect(due).toBe("2026-06-02"); // date-only, used exactly as parsed
  });

  it("a full explicit datetime is used exactly as parsed (EOD ignored when a time is present)", () => {
    const signals: DeadlineSignals = { explicitDue: "2026-06-02T15:30:00-04:00", eod: true };
    const { due, due_kind } = inferDeadline("2026-05-30", signals);
    expect(due_kind).toBe("explicit");
    expect(due).toBe("2026-06-02T15:30:00-04:00");
  });

  it("explicit WINS over an inferred Due/* label", () => {
    const signals: DeadlineSignals = { explicitDue: "2026-06-02", dueLabel: "Due/ThisWeek" };
    expect(inferDeadline("2026-05-30", signals).due_kind).toBe("explicit");
  });

  it("no explicit date and no inferable signal → {due:null, due_kind:'none'} (does NOT invent a date)", () => {
    const { due, due_kind } = inferDeadline("2026-05-30", {});
    expect(due).toBeNull();
    expect(due_kind).toBe("none");
  });

  it("EOD stated with NO explicit date anchors at the run date (inferred, not explicit)", () => {
    const { due, due_kind } = inferDeadline("2026-06-02", { eod: true });
    expect(due_kind).toBe("inferred");
    expect(due).toBe("2026-06-02T23:59:00-04:00");
  });
});

describe("fridayOf (IN-05)", () => {
  it("Mon-Thu roll forward to the same week's Friday", () => {
    expect(fridayOf("2026-06-01")).toBe("2026-06-05"); // Mon → Fri (same week)
    expect(fridayOf("2026-06-04")).toBe("2026-06-05"); // Thu → Fri (same week)
  });

  it("Friday returns the same day (delta 0)", () => {
    expect(fridayOf("2026-06-05")).toBe("2026-06-05"); // Fri → Fri
  });

  it("Saturday rolls to the UPCOMING Friday, never the past one (the IN-05 bug)", () => {
    // 2026-06-06 is a Saturday (dow=6). A bare `5 - dow` gives delta -1 → 2026-06-05, a PAST
    // Friday (yesterday). The `(5 - dow + 7) % 7` form must give +6 → the next Friday.
    expect(fridayOf("2026-06-06")).toBe("2026-06-12");
  });

  it("Sunday rolls to the upcoming Friday (+5)", () => {
    expect(fridayOf("2026-06-07")).toBe("2026-06-12"); // Sun → next Fri
  });
});

describe("ownerOffset (IN-02)", () => {
  it("returns -04:00 for an EDT date (summer)", () => {
    expect(ownerOffset("2026-06-02")).toBe("-04:00");
  });

  it("returns -05:00 for an EST date (winter)", () => {
    expect(ownerOffset("2026-01-15")).toBe("-05:00");
  });

  it("ownerLocalDateTime composes a full owner-local ISO string", () => {
    expect(ownerLocalDateTime("2026-06-02", "23:59")).toBe("2026-06-02T23:59:00-04:00");
  });

  it("warns (observably) and still returns a value when a parse is impossible", () => {
    // The longOffset miss must be OBSERVABLE (a console.warn), not a silent "-04:00" that is
    // wrong half the year. Force the miss by stubbing Intl to emit an unparsable tz token.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const realDTF = Intl.DateTimeFormat;
    const fake = function (this: unknown) {
      return {
        formatToParts: () => [{ type: "timeZoneName", value: "UTC" }],
      };
    } as unknown as typeof Intl.DateTimeFormat;
    vi.stubGlobal("Intl", { ...Intl, DateTimeFormat: fake });
    try {
      const out = ownerOffset("2026-06-02");
      expect(out).toBe("-04:00"); // still returns a value (never crashes)
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain("UTC"); // the unparsed token is surfaced
    } finally {
      vi.stubGlobal("Intl", { ...Intl, DateTimeFormat: realDTF });
      warn.mockRestore();
    }
  });
});
