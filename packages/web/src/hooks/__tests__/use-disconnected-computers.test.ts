import { describe, expect, it } from "vitest";
import type { HubClient } from "../../api/activity.js";
import { selectDisconnectedComputers } from "../use-disconnected-computers.js";

/**
 * Pure-function unit tests for the topbar disconnect-chip filter rule.
 * The hook itself wires the same helper into React Query — the visual /
 * behavioural surface is covered by manual e2e (see plan §Verification.B).
 */

const ME = "user-me";
const OTHER = "user-other";

function client(overrides: Partial<HubClient>): HubClient {
  return {
    id: overrides.id ?? "client-1",
    userId: ME,
    status: "disconnected",
    authState: "ok",
    sdkVersion: "v1.0.0",
    hostname: "host",
    os: "macOS",
    agentCount: 1,
    connectedAt: null,
    lastSeenAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("selectDisconnectedComputers", () => {
  it("returns empty for an empty list", () => {
    expect(selectDisconnectedComputers([], ME)).toEqual([]);
  });

  it("returns empty when userId is the empty string (auth not warm)", () => {
    expect(selectDisconnectedComputers([client({})], "")).toEqual([]);
  });

  it("includes a row that matches user + status=disconnected + agentCount > 0", () => {
    const c = client({ id: "match" });
    expect(selectDisconnectedComputers([c], ME)).toEqual([c]);
  });

  it("excludes rows owned by another user (admin role does not widen scope)", () => {
    const mine = client({ id: "mine" });
    const theirs = client({ id: "theirs", userId: OTHER });
    expect(selectDisconnectedComputers([mine, theirs], ME)).toEqual([mine]);
  });

  it("excludes rows whose status is connected", () => {
    const offline = client({ id: "offline" });
    const online = client({ id: "online", status: "connected" });
    expect(selectDisconnectedComputers([offline, online], ME)).toEqual([offline]);
  });

  it("excludes rows with no bound agents (no-op fleet — not a 'product unusable' case)", () => {
    const used = client({ id: "used", agentCount: 2 });
    const unused = client({ id: "unused", agentCount: 0 });
    expect(selectDisconnectedComputers([used, unused], ME)).toEqual([used]);
  });

  it("preserves input order across mixed lists", () => {
    const a = client({ id: "a", hostname: "alpha" });
    const skip = client({ id: "skip", status: "connected" });
    const b = client({ id: "b", hostname: "bravo" });
    expect(selectDisconnectedComputers([a, skip, b], ME).map((c) => c.id)).toEqual(["a", "b"]);
  });
});
