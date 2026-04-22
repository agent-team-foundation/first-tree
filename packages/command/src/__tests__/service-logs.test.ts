import { describe, expect, it } from "vitest";
import { parseDuration, validateLevel } from "../core/service-logs.js";

describe("parseDuration", () => {
  it("parses seconds", () => {
    expect(parseDuration("10s")).toBe(10_000);
  });
  it("parses minutes", () => {
    expect(parseDuration("5m")).toBe(300_000);
  });
  it("parses hours", () => {
    expect(parseDuration("2h")).toBe(7_200_000);
  });
  it("parses days", () => {
    expect(parseDuration("1d")).toBe(86_400_000);
  });
  it("tolerates inner whitespace", () => {
    expect(parseDuration("  30  s  ")).toBe(30_000);
  });
  it("rejects malformed input", () => {
    expect(() => parseDuration("10")).toThrow(/invalid duration/);
    expect(() => parseDuration("1w")).toThrow(/invalid duration/);
    expect(() => parseDuration("")).toThrow(/invalid duration/);
  });
});

describe("validateLevel", () => {
  it("returns the level when valid", () => {
    expect(validateLevel("warn")).toBe("warn");
    expect(validateLevel("trace")).toBe("trace");
  });
  it("returns undefined for unset", () => {
    expect(validateLevel(undefined)).toBeUndefined();
  });
  it("throws on invalid level", () => {
    expect(() => validateLevel("loud")).toThrow(/invalid --level/);
  });
});
