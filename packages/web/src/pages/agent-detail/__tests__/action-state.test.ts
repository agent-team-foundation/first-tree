import { describe, expect, it } from "vitest";
import { getAgentTestActionState, isBindableClient } from "../action-state.js";

describe("agent detail action state", () => {
  it("blocks connection tests until the agent has an online bound computer", () => {
    expect(
      getAgentTestActionState({
        agentStatus: "active",
        clientStatus: undefined,
        clientStatusLoading: true,
        runtimeState: null,
        testPending: false,
      }),
    ).toMatchObject({ disabled: true, title: "Checking the bound computer before testing." });

    expect(
      getAgentTestActionState({
        agentStatus: "active",
        clientStatus: { online: true, clientId: null, offlineSince: null },
        clientStatusLoading: false,
        runtimeState: "idle",
        testPending: false,
      }),
    ).toMatchObject({ disabled: true, title: "Bind a computer before testing this agent." });

    expect(
      getAgentTestActionState({
        agentStatus: "active",
        clientStatus: { online: false, clientId: "client-1", offlineSince: "2026-05-13T10:00:00.000Z" },
        clientStatusLoading: false,
        runtimeState: null,
        testPending: false,
      }),
    ).toMatchObject({ disabled: true, title: "The bound computer is offline." });

    expect(
      getAgentTestActionState({
        agentStatus: "active",
        clientStatus: { online: true, clientId: "client-1", offlineSince: null },
        clientStatusLoading: false,
        runtimeState: "idle",
        testPending: false,
      }),
    ).toMatchObject({ disabled: false });
  });

  // Reachability source-of-truth: even if `clientStatus.online === true`,
  // a runtime that crashed (presence row's `runtime_state` cleared to NULL)
  // means the agent itself can't be reached. The Test action must respect
  // that — the runtime can die without dragging the computer offline.
  it("blocks Test when runtimeState is null despite clientStatus.online", () => {
    expect(
      getAgentTestActionState({
        agentStatus: "active",
        clientStatus: { online: true, clientId: "client-1", offlineSince: null },
        clientStatusLoading: false,
        runtimeState: null,
        testPending: false,
      }),
    ).toMatchObject({ disabled: true, title: "The bound computer is offline." });
  });

  // A runtime in `"error"` is still bound and reporting (just badly) —
  // we keep it reachable for the Test gate so an operator can use Test
  // to retry. Distinct from `<StateChip>` which renders the business
  // state itself.
  it("allows Test when runtimeState is 'error'", () => {
    expect(
      getAgentTestActionState({
        agentStatus: "active",
        clientStatus: { online: true, clientId: "client-1", offlineSince: null },
        clientStatusLoading: false,
        runtimeState: "error",
        testPending: false,
      }),
    ).toMatchObject({ disabled: false });
  });

  it("uses the same connected-client rule for bindability and row state", () => {
    expect(isBindableClient({ status: "connected" })).toBe(true);
    expect(isBindableClient({ status: "online" })).toBe(false);
    expect(isBindableClient({ status: "active" })).toBe(false);
    expect(isBindableClient({ status: "disconnected" })).toBe(false);
  });
});
