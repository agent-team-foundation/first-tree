import { describe, expect, it } from "vitest";
import { extractBuildId, isNewVersionAvailable } from "../use-version-check.js";

/**
 * Pure-function unit tests for the topbar new-version chip. The hook wires
 * these helpers into React Query (mount + 10min interval + focus refetch);
 * the visual/behavioural surface is covered by manual e2e.
 */

describe("extractBuildId", () => {
  it("returns the buildId from a well-formed manifest", () => {
    expect(extractBuildId({ buildId: "abc123" })).toBe("abc123");
  });

  it("returns null for null / non-object input", () => {
    expect(extractBuildId(null)).toBeNull();
    expect(extractBuildId("abc123")).toBeNull();
    expect(extractBuildId(42)).toBeNull();
  });

  it("returns null when buildId is missing, empty, or not a string", () => {
    expect(extractBuildId({})).toBeNull();
    expect(extractBuildId({ buildId: "" })).toBeNull();
    expect(extractBuildId({ buildId: 123 })).toBeNull();
  });
});

describe("isNewVersionAvailable", () => {
  it("is false when no deployed id is known (manifest missing / dev / fetch error)", () => {
    expect(isNewVersionAvailable(null, "abc123")).toBe(false);
  });

  it("is false when the deployed id matches the running id", () => {
    expect(isNewVersionAvailable("abc123", "abc123")).toBe(false);
  });

  it("is true when the deployed id differs from the running id", () => {
    expect(isNewVersionAvailable("def456", "abc123")).toBe(true);
  });
});
