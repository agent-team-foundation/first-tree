import { CRON_DISPATCH_GRACE_MS } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import {
  assertSchedulable,
  firstOccurrenceStrictlyAfter,
  InvalidCronScheduleError,
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

  it("advances past the spring-forward gap in America/New_York", () => {
    // 2026-03-08 local 02:00 does not exist. Croner must return a real instant.
    const next = firstOccurrenceStrictlyAfter("0 2 8 3 *", "America/New_York", new Date("2026-03-07T00:00:00.000Z"));
    expect(next).not.toBeNull();
    expect(Number.isNaN(next!.getTime())).toBe(false);
    // The returned instant must be on/after the transition day in UTC terms.
    expect(next!.toISOString() >= "2026-03-08T00:00:00.000Z").toBe(true);
  });

  it("fires only once across Europe/London autumn overlap", () => {
    const after = new Date("2026-10-24T23:00:00.000Z");
    const first = firstOccurrenceStrictlyAfter("30 1 * * *", "Europe/London", after);
    expect(first).not.toBeNull();
    const second = firstOccurrenceStrictlyAfter("30 1 * * *", "Europe/London", first!);
    expect(second).not.toBeNull();
    // Next calendar day, not the second overlapping local 01:30
    expect(second!.getTime() - first!.getTime()).toBeGreaterThanOrEqual(20 * 60 * 60 * 1000);
  });

  it("rejects impossible schedules and exposes the 30s grace constant", () => {
    expect(CRON_DISPATCH_GRACE_MS).toBe(30_000);
    expect(() => assertSchedulable("0 0 31 2 *", "UTC", new Date("2026-01-01T00:00:00.000Z"))).toThrow(
      InvalidCronScheduleError,
    );
  });
});
