import { CRON_DISPATCH_GRACE_MS } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import {
  assertSchedulable,
  firstOccurrenceStrictlyAfter,
  InvalidCronScheduleError,
  matchesScheduledWallTime,
  previewOccurrences,
} from "../services/cron-schedule.js";

describe("cron-schedule", () => {
  it("lists five future occurrences with normalized schedule/timezone", () => {
    const after = new Date("2026-01-15T12:00:00.000Z");
    const preview = previewOccurrences("0 9 * * 1-5", "America/New_York", after);
    expect(preview.schedule).toBe("0 9 * * 1-5");
    expect(preview.timezone).toBe("America/New_York");
    expect(preview.occurrences).toHaveLength(5);
    for (const occ of preview.occurrences) {
      expect(new Date(occ.at).getTime()).toBeGreaterThan(after.getTime());
      expect(occ.local).toContain("America/New_York");
    }
  });

  it("uses traditional DOM/DOW OR semantics", () => {
    // 1st OR Monday — from 2026-03-01 00:00 UTC, DOM=1 matches the same day at 09:00
    // (AND semantics would wait until a Monday that is also the 1st).
    const next = firstOccurrenceStrictlyAfter("0 9 1 * 1", "UTC", new Date("2026-03-01T00:00:00.000Z"));
    expect(next?.toISOString()).toBe("2026-03-01T09:00:00.000Z");
  });

  it("skips the nonexistent America/New_York spring-forward wall time", () => {
    // 2026-03-08 local 02:00 does not exist. Must NOT shift to 03:00 EDT.
    const next = firstOccurrenceStrictlyAfter("0 2 8 3 *", "America/New_York", new Date("2026-03-07T00:00:00.000Z"));
    expect(next?.toISOString()).toBe("2027-03-08T07:00:00.000Z");
    expect(matchesScheduledWallTime("0 2 8 3 *", "America/New_York", next!)).toBe(true);
  });

  it("skips the nonexistent Europe/London spring-forward wall time", () => {
    // 2026-03-29 local 01:00 does not exist (clocks jump to 02:00 BST).
    const next = firstOccurrenceStrictlyAfter("0 1 29 3 *", "Europe/London", new Date("2026-03-28T00:00:00.000Z"));
    expect(next?.toISOString()).toBe("2027-03-29T00:00:00.000Z");
  });

  it("fires only once across Europe/London autumn overlap", () => {
    const after = new Date("2026-10-24T23:00:00.000Z");
    const first = firstOccurrenceStrictlyAfter("30 1 * * *", "Europe/London", after);
    expect(first?.toISOString()).toBe("2026-10-25T00:30:00.000Z");
    const second = firstOccurrenceStrictlyAfter("30 1 * * *", "Europe/London", first!);
    expect(second?.toISOString()).toBe("2026-10-26T01:30:00.000Z");
    expect(second!.getTime() - first!.getTime()).toBeGreaterThanOrEqual(20 * 60 * 60 * 1000);
  });

  it("rejects impossible schedules and exposes the 30s grace constant", () => {
    expect(CRON_DISPATCH_GRACE_MS).toBe(30_000);
    expect(() => assertSchedulable("0 0 31 2 *", "UTC", new Date("2026-01-01T00:00:00.000Z"))).toThrow(
      InvalidCronScheduleError,
    );
  });
});
