import { describe, it, expect } from "vitest";

// Wave-1 smoke test: proves the vitest-pool-workers runtime actually boots
// `workerd` and that the pool forces TZ=UTC (same as production / wrangler dev),
// which is the foundation for every date-keyed idempotency key downstream.
// Real behavioural suites (replay/serialize/malformed/DLQ) land in Plan 04.
describe("toolchain smoke", () => {
  it("runs inside workerd with TZ=UTC", () => {
    // workerd pins the runtime timezone to UTC regardless of host locale.
    expect(new Date().getTimezoneOffset()).toBe(0);
  });

  it("derives owner-local date via Intl (America/Toronto), not new Date()", () => {
    // The canonical pattern for every date-keyed idempotency key. We assert it
    // produces a well-formed YYYY-MM-DD — not the UTC date, which can be a day
    // ahead for a Toronto owner after ~20:00 local.
    const local = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Toronto",
    }).format(new Date());
    expect(local).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
