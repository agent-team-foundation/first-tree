import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HubClient, RuntimeAgent } from "../../../../api/activity.js";
import {
  authExpiredDiagnostic,
  cardHostnameLabel,
  computerCardViewModel,
  formatOfflineDuration,
  offlineDiagnostic,
  SETUP_INCOMPLETE_DIAGNOSTIC,
  summarizeBoundAgents,
} from "../view-models.js";

/**
 * Pure view-model tests for the card layer. Mirrors PR-A's testing
 * convention (`presence-chip.test.ts`, `derive-status.test.ts`) — assert
 * against pure functions rather than render output. The actual body
 * components are thin renderers consuming these plans, so visual
 * regressions are caught by manual QA + the dev stack walkthrough.
 */

const T0 = new Date("2026-05-01T12:00:00Z");

function client(overrides: Partial<HubClient>): HubClient {
  return {
    id: "client_abc12345",
    userId: "u-1",
    status: "connected",
    authState: "ok",
    sdkVersion: "0.5.2",
    hostname: "MacBook-Pro.local",
    os: "darwin",
    agentCount: 0,
    connectedAt: T0.toISOString(),
    lastSeenAt: T0.toISOString(),
    capabilities: {},
    ...overrides,
  };
}

function agent(overrides: Partial<RuntimeAgent>): RuntimeAgent {
  return {
    agentId: "agent-1",
    clientId: "client_abc12345",
    runtimeType: "claude-code",
    runtimeState: null,
    activeSessions: null,
    totalSessions: null,
    runtimeUpdatedAt: null,
    type: "autonomous_agent",
    managedByMe: true,
    ...overrides,
  };
}

describe("formatOfflineDuration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns null for null / undefined / invalid input", () => {
    expect(formatOfflineDuration(null)).toBeNull();
    expect(formatOfflineDuration(undefined)).toBeNull();
    expect(formatOfflineDuration("not-a-date")).toBeNull();
  });

  it("returns null for timestamps in the future (clock skew)", () => {
    expect(formatOfflineDuration("2026-05-01T12:00:05Z")).toBeNull();
  });

  it("formats seconds for offsets under a minute", () => {
    expect(formatOfflineDuration("2026-05-01T11:59:45Z")).toBe("15 seconds");
    // Singular form for 1 second.
    expect(formatOfflineDuration("2026-05-01T11:59:59Z")).toBe("1 second");
  });

  it("formats minutes for offsets under an hour", () => {
    expect(formatOfflineDuration("2026-05-01T11:55:00Z")).toBe("5 minutes");
    expect(formatOfflineDuration("2026-05-01T11:59:00Z")).toBe("1 minute");
  });

  it("formats hours for offsets under a day", () => {
    expect(formatOfflineDuration("2026-05-01T10:00:00Z")).toBe("2 hours");
  });

  it("formats days for offsets of a day or more", () => {
    expect(formatOfflineDuration("2026-04-23T12:00:00Z")).toBe("8 days");
    expect(formatOfflineDuration("2026-04-30T12:00:00Z")).toBe("1 day");
  });
});

describe("summarizeBoundAgents", () => {
  it("returns zero counts for an empty list", () => {
    expect(summarizeBoundAgents([])).toEqual({ total: 0, online: 0, offline: 0, agents: [] });
  });

  it("classifies agents by runtimeState null vs non-null", () => {
    const result = summarizeBoundAgents([
      agent({ agentId: "a", runtimeState: "idle" }),
      agent({ agentId: "b", runtimeState: "working" }),
      agent({ agentId: "c", runtimeState: null }),
    ]);
    expect(result.total).toBe(3);
    expect(result.online).toBe(2);
    expect(result.offline).toBe(1);
    expect(result.agents.map((a) => a.agentId)).toEqual(["a", "b", "c"]);
  });

  it("preserves activeSessions and totalSessions on each line", () => {
    const result = summarizeBoundAgents([
      agent({ agentId: "busy", runtimeState: "working", activeSessions: 2, totalSessions: 5 }),
    ]);
    expect(result.agents[0]).toMatchObject({ activeSessions: 2, totalSessions: 5 });
  });
});

describe("diagnostic copy", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("authExpiredDiagnostic includes the offline duration when available", () => {
    expect(authExpiredDiagnostic({ lastSeenAt: "2026-04-23T12:00:00Z" })).toBe(
      "This computer hasn't checked in for 8 days. Your access token has expired.",
    );
  });

  it("authExpiredDiagnostic falls back to a generic line when duration is unknown", () => {
    // Server invariant: lastSeenAt is non-null, but if it ever weren't, the
    // fallback must still read sensibly.
    expect(authExpiredDiagnostic({ lastSeenAt: "" })).toBe(
      "Your access token has expired. Run the command below on this computer to re-authenticate.",
    );
  });

  it("offlineDiagnostic mentions last-seen duration + wake guidance", () => {
    expect(offlineDiagnostic({ lastSeenAt: "2026-05-01T10:00:00Z" })).toBe(
      "Last seen 2 hours ago. Make sure the machine is awake and connected.",
    );
  });

  it("SETUP_INCOMPLETE_DIAGNOSTIC is a stable copy string", () => {
    expect(SETUP_INCOMPLETE_DIAGNOSTIC).toContain("no runtime is ready");
  });
});

describe("cardHostnameLabel", () => {
  it("returns hostname when set", () => {
    expect(cardHostnameLabel(client({ hostname: "MacBook-Pro.local" }))).toBe("MacBook-Pro.local");
  });

  it("falls back to short id (first 8 chars) when hostname is null", () => {
    expect(cardHostnameLabel(client({ id: "client_deadbeef", hostname: null }))).toBe("client_d");
  });
});

describe("computerCardViewModel", () => {
  it("returns ready pill + aria label for a healthy client", () => {
    const ready = client({
      hostname: "MacBook-Pro.local",
      capabilities: {
        "claude-code": {
          state: "ok",
          available: true,
          authenticated: true,
          sdkVersion: "0.8.1",
          authMethod: "oauth",
          detectedAt: T0.toISOString(),
        },
      },
    });
    const vm = computerCardViewModel(ready);
    expect(vm).toEqual({
      pill: "ready",
      label: "MacBook-Pro.local",
      ariaLabel: "Computer: MacBook-Pro.local — Ready",
    });
  });

  it("returns auth_expired pill + aria label when authState is expired", () => {
    const c = client({ hostname: "old.local", status: "disconnected", authState: "expired" });
    const vm = computerCardViewModel(c);
    expect(vm.pill).toBe("auth_expired");
    expect(vm.ariaLabel).toBe("Computer: old.local — Auth expired");
  });

  it("returns setup_incomplete pill when connected but no runtime is ok", () => {
    const c = client({
      hostname: "fresh.local",
      capabilities: {
        "claude-code": {
          state: "missing",
          available: false,
          authenticated: false,
          sdkVersion: null,
          authMethod: "none",
          detectedAt: T0.toISOString(),
        },
      },
    });
    const vm = computerCardViewModel(c);
    expect(vm.pill).toBe("setup_incomplete");
    expect(vm.ariaLabel).toBe("Computer: fresh.local — Setup incomplete");
  });

  it("returns offline pill when disconnected but auth ok", () => {
    const c = client({ hostname: "away.local", status: "disconnected", authState: "ok" });
    const vm = computerCardViewModel(c);
    expect(vm.pill).toBe("offline");
    expect(vm.ariaLabel).toBe("Computer: away.local — Offline");
  });
});
