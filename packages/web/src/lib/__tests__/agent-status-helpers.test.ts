import type { AgentChatStatus } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import { upsertAgentStatus } from "../agent-status-view.js";

function status(over: Partial<AgentChatStatus> & { agentId: string }): AgentChatStatus {
  return {
    main: "ready",
    reachable: true,
    engagement: "active",
    working: false,
    needsYou: false,
    errored: false,
    activity: null,
    ...over,
  };
}

describe("upsertAgentStatus", () => {
  it("appends when the agent is not present", () => {
    const prev = [status({ agentId: "a1" })];
    const next = upsertAgentStatus(prev, status({ agentId: "a2", main: "working", working: true }));
    expect(next).toHaveLength(2);
    expect(next.map((s) => s.agentId)).toEqual(["a1", "a2"]);
  });

  it("replaces in place (same length, same index) when present", () => {
    const prev = [status({ agentId: "a1" }), status({ agentId: "a2" })];
    const next = upsertAgentStatus(prev, status({ agentId: "a2", main: "failed", errored: true }));
    expect(next).toHaveLength(2);
    expect(next[1]?.main).toBe("failed");
    expect(next[0]).toBe(prev[0]); // untouched entries keep their reference
  });
});
