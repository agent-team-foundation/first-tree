import { describe, expect, it } from "vitest";
import type { HubClient } from "../../../api/activity.js";
import { compareByPillPriority, deriveComputerStatus, PILL_PRIORITY, summarizeComputers } from "../derive-status.js";

/**
 * Pure-function unit tests for the 4-state Settings → Computers status
 * pill. The pill is computed entirely from existing server fields
 * (`status`, `authState`, `capabilities`) — no new server columns, no
 * thresholds. Ordering of the if/else ladder matters: see the comments
 * on `deriveComputerStatus` itself.
 */

const T = new Date("2026-05-01T00:00:00Z").toISOString();

function client(overrides: Partial<HubClient>): HubClient {
  return {
    id: "c-1",
    userId: "u-1",
    status: "connected",
    authState: "ok",
    sdkVersion: "v1.3.2",
    hostname: "MacBook-Pro.local",
    os: "macOS",
    agentCount: 0,
    connectedAt: T,
    lastSeenAt: T,
    capabilities: {},
    ...overrides,
  };
}

function capability(state: "ok" | "missing" | "unauthenticated" | "error") {
  return {
    state,
    available: state === "ok",
    authenticated: state === "ok",
    sdkVersion: state === "ok" ? "0.8.1" : null,
    authMethod: state === "ok" ? ("oauth" as const) : ("none" as const),
    detectedAt: T,
  };
}

describe("deriveComputerStatus", () => {
  it("returns Ready when connected, auth ok, and at least one capability is ok", () => {
    const c = client({ capabilities: { "claude-code": capability("ok") } });
    expect(deriveComputerStatus(c).pill).toBe("ready");
    expect(deriveComputerStatus(c).headline).toBe("Your computer is ready");
  });

  it("returns Ready when at least one capability is ok and others are missing", () => {
    const c = client({
      capabilities: { "claude-code": capability("ok"), codex: capability("missing") },
    });
    expect(deriveComputerStatus(c).pill).toBe("ready");
  });

  it("auth_expired wins over offline (server contract: expired ⊂ disconnected)", () => {
    const c = client({ status: "disconnected", authState: "expired" });
    expect(deriveComputerStatus(c).pill).toBe("auth_expired");
    expect(deriveComputerStatus(c).headline).toBe("Your computer needs to log in again");
  });

  it("auth_expired wins even when capabilities are ok (last-reported snapshot)", () => {
    // Server snapshots capability state during 'connected'; after going offline
    // long enough for the refresh token to lapse, the row carries
    // authState=expired but the capability snapshot is still 'ok'. The pill
    // must surface the credential death, not the stale runtime detail.
    const c = client({
      status: "disconnected",
      authState: "expired",
      capabilities: { "claude-code": capability("ok") },
    });
    expect(deriveComputerStatus(c).pill).toBe("auth_expired");
  });

  it("returns Offline when disconnected with auth still ok", () => {
    const c = client({ status: "disconnected", authState: "ok" });
    expect(deriveComputerStatus(c).pill).toBe("offline");
    expect(deriveComputerStatus(c).headline).toBe("Your computer is offline");
  });

  it("returns Setup incomplete when connected + auth ok but no capability is ok", () => {
    const c = client({
      capabilities: { "claude-code": capability("missing"), codex: capability("missing") },
    });
    expect(deriveComputerStatus(c).pill).toBe("setup_incomplete");
    expect(deriveComputerStatus(c).headline).toBe("Finish setting up your computer");
  });

  it("treats an empty capabilities map as Setup incomplete (no runtime probed)", () => {
    const c = client({ capabilities: {} });
    expect(deriveComputerStatus(c).pill).toBe("setup_incomplete");
  });

  it("treats unauthenticated or error capabilities as not-ok (still Setup incomplete)", () => {
    const c = client({
      capabilities: { "claude-code": capability("unauthenticated"), codex: capability("error") },
    });
    expect(deriveComputerStatus(c).pill).toBe("setup_incomplete");
  });

  it("is tolerant of a malformed capability entry (defensive optional chain)", () => {
    // A wire-shape drift / malformed jsonb could yield an entry missing `state`.
    // The pill derivation must not throw; treat the entry as not-ok.
    const c = client({
      // biome-ignore lint/suspicious/noExplicitAny: simulating a malformed payload
      capabilities: { "claude-code": {} as any },
    });
    expect(deriveComputerStatus(c).pill).toBe("setup_incomplete");
  });
});

describe("PILL_PRIORITY", () => {
  it("orders pills auth_expired < setup_incomplete < offline < ready (problems first)", () => {
    expect(PILL_PRIORITY.auth_expired).toBeLessThan(PILL_PRIORITY.setup_incomplete);
    expect(PILL_PRIORITY.setup_incomplete).toBeLessThan(PILL_PRIORITY.offline);
    expect(PILL_PRIORITY.offline).toBeLessThan(PILL_PRIORITY.ready);
  });
});

describe("compareByPillPriority", () => {
  it("sorts auth_expired ahead of ready", () => {
    const expired = client({ id: "exp", status: "disconnected", authState: "expired" });
    const ready = client({ id: "rdy", capabilities: { "claude-code": capability("ok") } });
    const sorted = [ready, expired].sort(compareByPillPriority);
    expect(sorted[0]?.id).toBe("exp");
    expect(sorted[1]?.id).toBe("rdy");
  });

  it("ties on pill priority break by lastSeenAt descending (most recent first)", () => {
    const newer = client({ id: "new", lastSeenAt: "2026-05-01T10:00:00Z" });
    const older = client({ id: "old", lastSeenAt: "2026-05-01T05:00:00Z" });
    // Both are setup_incomplete (no caps); the more recently-seen one wins.
    const sorted = [older, newer].sort(compareByPillPriority);
    expect(sorted[0]?.id).toBe("new");
    expect(sorted[1]?.id).toBe("old");
  });

  it("is stable when both pill and lastSeenAt match (returns 0)", () => {
    const a = client({ id: "a" });
    const b = client({ id: "b" });
    expect(compareByPillPriority(a, b)).toBe(0);
  });
});

describe("summarizeComputers — page subtitle pure helper", () => {
  it("returns null for an empty list", () => {
    expect(summarizeComputers([], "u-1")).toBeNull();
  });

  it("returns null for undefined input (loading state)", () => {
    expect(summarizeComputers(undefined, "u-1")).toBeNull();
  });

  it("uses the possessive headline when the viewer owns the single row", () => {
    const c = client({ userId: "u-1", capabilities: { "claude-code": capability("ok") } });
    expect(summarizeComputers([c], "u-1")).toBe("Your computer is ready");
  });

  it("uses neutral phrasing when admin views someone else's single row", () => {
    const c = client({ userId: "u-other", capabilities: { "claude-code": capability("ok") }, agentCount: 0 });
    expect(summarizeComputers([c], "u-1")).toBe("1 computer is ready");
  });

  it("uses neutral phrasing when there is no viewer id (server-rendered fallback)", () => {
    const c = client({ userId: "u-other" });
    expect(summarizeComputers([c], null)).toBe("1 computer needs setup");
  });

  it("appends an agents-bound suffix when agents are present (single computer)", () => {
    const c = client({
      userId: "u-1",
      agentCount: 3,
      capabilities: { "claude-code": capability("ok") },
    });
    expect(summarizeComputers([c], "u-1")).toBe("Your computer is ready · 3 agents bound");
  });

  it("uses the singular 'agent' when exactly one agent is bound", () => {
    const c = client({
      userId: "u-1",
      agentCount: 1,
      capabilities: { "claude-code": capability("ok") },
    });
    expect(summarizeComputers([c], "u-1")).toBe("Your computer is ready · 1 agent bound");
  });

  it("breaks down pills in priority order and omits zero-count pills for multi-row views", () => {
    const c1 = client({ id: "c1", status: "disconnected", authState: "expired", agentCount: 1 });
    const c2 = client({ id: "c2", capabilities: { "claude-code": capability("ok") }, agentCount: 2 });
    const c3 = client({ id: "c3", capabilities: { "claude-code": capability("ok") }, agentCount: 0 });
    expect(summarizeComputers([c1, c2, c3], "u-1")).toBe("1 auth expired · 2 ready · 3 agents bound");
  });

  it("omits the agents-bound suffix entirely when no agents are bound", () => {
    const c1 = client({ id: "c1", agentCount: 0 });
    const c2 = client({ id: "c2", agentCount: 0 });
    expect(summarizeComputers([c1, c2], "u-1")).toBe("2 setup incomplete");
  });
});
