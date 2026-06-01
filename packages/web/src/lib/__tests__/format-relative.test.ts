import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatDay, formatRelative } from "../utils.js";

/**
 * `formatRelative` powers the "Last seen N units ago" cell on the
 * Settings → Computers page. Fake timers are used to pin "now" so the
 * unit boundaries are deterministic.
 */
describe("formatRelative", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns '—' for null", () => {
    expect(formatRelative(null)).toBe("—");
  });

  it("returns '—' for undefined", () => {
    expect(formatRelative(undefined)).toBe("—");
  });

  it("returns '—' for an invalid timestamp string", () => {
    expect(formatRelative("not-a-date")).toBe("—");
  });

  it("formats seconds-ago for very recent timestamps", () => {
    expect(formatRelative("2026-05-01T11:59:48Z")).toMatch(/12 seconds? ago/);
  });

  it("formats minutes-ago when offset is at least a minute", () => {
    expect(formatRelative("2026-05-01T11:55:00Z")).toMatch(/5 minutes? ago/);
  });

  it("formats hours-ago when offset is at least an hour", () => {
    expect(formatRelative("2026-05-01T10:00:00Z")).toMatch(/2 hours? ago/);
  });

  it("formats days-ago when offset is at least a day", () => {
    expect(formatRelative("2026-04-23T12:00:00Z")).toMatch(/8 days? ago/);
  });

  it("uses 'yesterday' for the one-day boundary (numeric: auto)", () => {
    expect(formatRelative("2026-04-30T12:00:00Z")).toBe("yesterday");
  });

  it("clamps future-dated timestamps to 'now' to defend against server clock skew", () => {
    // 3 seconds in the future. Without the clamp, Intl.RelativeTimeFormat
    // would render "in 3 seconds" — jarring next to a "Last seen" header.
    expect(formatRelative("2026-05-01T12:00:03Z")).toBe("now");
  });

  it("renders 'now' for the exactly-zero offset", () => {
    expect(formatRelative("2026-05-01T12:00:00Z")).toBe("now");
  });

  it("formats month and year scale timestamps", () => {
    expect(formatRelative("2026-03-01T12:00:00Z")).toMatch(/2 months? ago/);
    expect(formatRelative("2024-05-01T12:00:00Z")).toMatch(/2 years? ago/);
  });

  it("formats date-only values and keeps null-safe fallback", () => {
    expect(formatDay(null)).toBe("—");
    expect(formatDay(undefined)).toBe("—");
    expect(formatDay("2026-05-01T12:00:00Z")).toMatch(/2026/);
  });
});
