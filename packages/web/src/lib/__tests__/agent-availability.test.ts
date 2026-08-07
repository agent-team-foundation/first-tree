import type { Agent } from "@first-tree/shared";
import { describe, expect, it, vi } from "vitest";
import { deriveAgentAvailability, deriveAgentDirectoryAvailability } from "../agent-availability.js";

describe("deriveAgentAvailability", () => {
  it("lets lifecycle suspension override connection facts", () => {
    expect(
      deriveAgentAvailability({
        status: "suspended",
        clientId: "client-1",
        connection: "online",
      }),
    ).toEqual({ kind: "suspended", label: "Suspended", detail: "Can’t receive new work." });
  });

  it("separates missing setup from an offline computer", () => {
    expect(deriveAgentAvailability({ status: "active", clientId: null, connection: "offline" })).toEqual({
      kind: "needs-setup",
      label: "Needs setup",
      detail: "No computer assigned.",
    });
    expect(deriveAgentAvailability({ status: "active", clientId: "client-1", connection: "offline" })).toEqual({
      kind: "offline",
      label: "Offline",
      detail: "Computer connection unavailable.",
    });
  });

  it("adds human-readable connection context without creating a health claim", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-05T05:00:00.000Z"));
    expect(
      deriveAgentAvailability({
        status: "active",
        clientId: "client-1",
        connection: "online",
        clientLabel: "Gandy’s MacBook Pro",
      }),
    ).toEqual({ kind: "online", label: "Online", detail: "Connected to Gandy’s MacBook Pro" });
    expect(
      deriveAgentAvailability({
        status: "active",
        clientId: "client-1",
        connection: "offline",
        offlineSince: "2026-08-05T03:00:00.000Z",
      }).detail,
    ).toMatch(/^Computer connection unavailable · Last seen 2 hours? ago$/);
    vi.useRealTimers();
  });
});

describe("deriveAgentDirectoryAvailability", () => {
  const base = {
    uuid: "agent-1",
    name: "nova",
    organizationId: "org-1",
    type: "agent",
    displayName: "Nova",
    delegateMention: null,
    inboxId: "inbox-1",
    status: "active",
    visibility: "organization",
    metadata: {},
    managerId: "member-1",
    clientId: "client-1",
    runtimeProvider: "claude-code",
    avatarColorToken: null,
    avatarImageUrl: null,
    runtimeState: "idle",
    lastSeenAt: null,
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:00.000Z",
  } satisfies Agent;

  it("uses the same four-state user vocabulary in Team", () => {
    expect(deriveAgentDirectoryAvailability(base).label).toBe("Online");
    expect(deriveAgentDirectoryAvailability({ ...base, runtimeState: null }).label).toBe("Offline");
    expect(deriveAgentDirectoryAvailability({ ...base, clientId: null, runtimeState: null }).label).toBe("Needs setup");
    expect(deriveAgentDirectoryAvailability({ ...base, status: "suspended" }).label).toBe("Suspended");
  });
});
