import { type AgentChatStatusInput, buildAgentChatStatus, MAIN_STATUS_PRIORITY } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import { selectAttention } from "../compose-status-bar.js";

const mk = (agentId: string, over: Partial<AgentChatStatusInput>) =>
  buildAgentChatStatus({
    agentId,
    reachable: true,
    errored: false,
    needsYou: false,
    working: false,
    engagement: "none",
    ...over,
  });

describe("selectAttention — the bar surfaces only actionable/active states, most urgent first", () => {
  it("keeps working / needs-you / failed and drops ready / paused / offline", () => {
    const statuses = [
      mk("ready", {}),
      mk("working", { working: true }),
      mk("offline", { reachable: false }),
      mk("needs", { needsYou: true }),
      mk("failed", { errored: true }),
      mk("paused", { engagement: "suspended" }),
    ];
    expect(selectAttention(statuses).map((s) => s.main)).toEqual(["failed", "needs_you", "working"]);
  });

  it("returns empty when every agent is quiet (ready / offline)", () => {
    expect(selectAttention([mk("r", {}), mk("o", { reachable: false })])).toEqual([]);
  });

  it("sorts by MAIN_STATUS_PRIORITY (most urgent first)", () => {
    const out = selectAttention([mk("w", { working: true }), mk("f", { errored: true }), mk("n", { needsYou: true })]);
    const idx = out.map((s) => MAIN_STATUS_PRIORITY.indexOf(s.main));
    expect(idx).toEqual([...idx].sort((x, y) => x - y));
  });
});
