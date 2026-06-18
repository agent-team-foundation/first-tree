import { describe, expect, it } from "vitest";
import { extractChannel } from "../use-server-channel.js";

/**
 * Pure-function unit tests for the bootstrap-config channel probe. The hook
 * wires this into React Query (fetched once, cached for the session); the
 * staging-only toggle it gates is covered by manual e2e.
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
