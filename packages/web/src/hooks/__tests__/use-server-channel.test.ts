import { describe, expect, it } from "vitest";
import { extractChannel, extractGrowthLandingPagesEnabled } from "../use-server-channel.js";

/**
 * Pure-function unit tests for public bootstrap-config probes. The hook wires
 * these into React Query (fetched once, cached for the session); callers cover
 * their own render gates.
 */
describe("extractChannel", () => {
  it("returns each known channel from a well-formed bootstrap config", () => {
    expect(extractChannel({ channel: "dev" })).toBe("dev");
    expect(extractChannel({ channel: "staging" })).toBe("staging");
    expect(extractChannel({ channel: "prod" })).toBe("prod");
  });

  it("returns null for null / non-object input", () => {
    expect(extractChannel(null)).toBeNull();
    expect(extractChannel("staging")).toBeNull();
    expect(extractChannel(42)).toBeNull();
  });

  it("returns null when channel is missing or unrecognised (older server / malformed)", () => {
    expect(extractChannel({})).toBeNull();
    expect(extractChannel({ serverCommandVersion: "1.2.3" })).toBeNull();
    expect(extractChannel({ channel: "qa" })).toBeNull();
    expect(extractChannel({ channel: 1 })).toBeNull();
  });
});

describe("extractGrowthLandingPagesEnabled", () => {
  it("returns true only for an explicit true bootstrap flag", () => {
    expect(extractGrowthLandingPagesEnabled({ growthLandingPagesEnabled: true })).toBe(true);
    expect(extractGrowthLandingPagesEnabled({ growthLandingPagesEnabled: false })).toBe(false);
  });

  it("fails closed for older or malformed bootstrap configs", () => {
    expect(extractGrowthLandingPagesEnabled(null)).toBe(false);
    expect(extractGrowthLandingPagesEnabled({})).toBe(false);
    expect(extractGrowthLandingPagesEnabled({ growthLandingPagesEnabled: "true" })).toBe(false);
    expect(extractGrowthLandingPagesEnabled({ growthLandingPagesEnabled: 1 })).toBe(false);
  });
});
