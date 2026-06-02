import { type AgentChatStatusInput, buildAgentChatStatus, MAIN_STATUS_PRIORITY } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import { pickLead, selectAttention } from "../compose-status-bar.js";

const mk = (agentId: string, over: Partial<AgentChatStatusInput>) =>
  buildAgentChatStatus({
    agentId,
    reachable: true,
    errored: false,
    working: false,
    engagement: "none",
    ...over,
  });

describe("selectAttention — the bar surfaces only actionable/active states, most urgent first", () => {
  it("keeps working / failed and drops ready / paused / offline", () => {
    const statuses = [
      mk("ready", {}),
      mk("working", { working: true }),
      mk("offline", { reachable: false }),
      mk("failed", { errored: true }),
      mk("paused", { engagement: "suspended" }),
    ];
    expect(selectAttention(statuses).map((s) => s.main)).toEqual(["failed", "working"]);
  });

  it("returns empty when every agent is quiet (ready / offline)", () => {
    expect(selectAttention([mk("r", {}), mk("o", { reachable: false })])).toEqual([]);
  });

  it("sorts by MAIN_STATUS_PRIORITY (most urgent first)", () => {
    const out = selectAttention([mk("w", { working: true }), mk("f", { errored: true })]);
    const idx = out.map((s) => MAIN_STATUS_PRIORITY.indexOf(s.main));
    expect(idx).toEqual([...idx].sort((x, y) => x - y));
  });
});

const workingAt = (id: string, startedAt: string) =>
  mk(id, { working: true, activity: { agentId: id, kind: "tool_call", label: "Bash", startedAt } });

describe("pickLead — rail lead with anti-flicker", () => {
  const NOW = 1_000_000;
  const HOLD = 4000;
  const atlas = workingAt("atlas", "2026-05-22T00:00:00.000Z");
  const beacon = workingAt("beacon", "2026-05-22T00:00:05.000Z"); // more recent than atlas

  it("an alert (failure) preempts immediately, regardless of the held working lead", () => {
    const failed = mk("cypher", { errored: true });
    expect(pickLead({ agentId: "atlas", since: NOW }, NOW + 100, [failed], [atlas], HOLD)?.agentId).toBe("cypher");
  });

  it("with no current lead, picks the most-recently-active working agent", () => {
    expect(pickLead(null, NOW, [], [atlas, beacon], HOLD)?.agentId).toBe("beacon");
  });

  it("holds the current working lead until the hold elapses", () => {
    expect(pickLead({ agentId: "atlas", since: NOW }, NOW + 1000, [], [atlas, beacon], HOLD)?.agentId).toBe("atlas");
  });

  it("switches to the most-recent working agent once the hold elapses", () => {
    expect(pickLead({ agentId: "atlas", since: NOW }, NOW + HOLD + 1, [], [atlas, beacon], HOLD)?.agentId).toBe(
      "beacon",
    );
  });

  it("if the held lead is no longer working, picks the most-recent immediately", () => {
    expect(pickLead({ agentId: "gone", since: NOW }, NOW + 100, [], [atlas, beacon], HOLD)?.agentId).toBe("beacon");
  });

  it("returns null when nothing is active", () => {
    expect(pickLead(null, NOW, [], [], HOLD)).toBeNull();
  });
});
