import { describe, expect, it } from "vitest";
import { getAgentTestActionState, isBindableClient } from "../action-state.js";

describe("agent detail action state", () => {
  it("blocks connection tests until the agent has an online bound computer", () => {
    expect(
      getAgentTestActionState({
        agentStatus: "active",
        clientStatus: undefined,
        clientStatusLoading: true,
        presenceStatus: "offline",
        testPending: false,
      }),
    ).toMatchObject({ disabled: true, title: "Checking the bound computer before testing." });

    expect(
      getAgentTestActionState({
        agentStatus: "active",
        clientStatus: { online: true, clientId: null, offlineSince: null },
        clientStatusLoading: false,
        presenceStatus: "online",
        testPending: false,
      }),
    ).toMatchObject({ disabled: true, title: "Bind a computer before testing this agent." });

    expect(
      getAgentTestActionState({
        agentStatus: "active",
        clientStatus: { online: false, clientId: "client-1", offlineSince: "2026-05-13T10:00:00.000Z" },
        clientStatusLoading: false,
        presenceStatus: "offline",
        testPending: false,
      }),
    ).toMatchObject({ disabled: true, title: "The bound computer is offline." });

    expect(
      getAgentTestActionState({
        agentStatus: "active",
        clientStatus: { online: true, clientId: "client-1", offlineSince: null },
        clientStatusLoading: false,
        presenceStatus: "online",
        testPending: false,
      }),
    ).toMatchObject({ disabled: false });
  });

  // Reachability source-of-truth: even if the bound computer reports
  // `clientStatus.online: true`, a stale `agent_presence.status` would
  // (correctly) say the agent itself can't be reached, and the Test action
  // must respect that — the runtime might have crashed without dragging the
  // computer offline.
  it("blocks Test when presenceStatus says offline despite clientStatus.online", () => {
    expect(
      getAgentTestActionState({
        agentStatus: "active",
        clientStatus: { online: true, clientId: "client-1", offlineSince: null },
        clientStatusLoading: false,
        presenceStatus: "offline",
        testPending: false,
      }),
    ).toMatchObject({ disabled: true, title: "The bound computer is offline." });
  });

  it("uses the same connected-client rule for bindability and row state", () => {
    expect(isBindableClient({ status: "connected" })).toBe(true);
    expect(isBindableClient({ status: "online" })).toBe(false);
    expect(isBindableClient({ status: "active" })).toBe(false);
    expect(isBindableClient({ status: "disconnected" })).toBe(false);
  });
});
