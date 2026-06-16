import type { ChatParticipantDetail } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import { partitionRoster, VISIBLE_LIMIT } from "../participants-section.js";

function participant(id: string, type: "human" | "agent"): ChatParticipantDetail {
  return {
    agentId: id,
    role: "member",
    mode: "default",
    joinedAt: "2026-06-16T00:00:00.000Z",
    name: id,
    displayName: id,
    type,
    avatarColorToken: null,
    avatarImageUrl: null,
  };
}

describe("partitionRoster", () => {
  it("orders agents before humans, preserving server order within each group", () => {
    const roster = [
      participant("human-1", "human"),
      participant("agent-1", "agent"),
      participant("human-2", "human"),
      participant("agent-2", "agent"),
    ];
    const { visibleAgents, visibleHumans } = partitionRoster(roster, true);
    expect(visibleAgents.map((p) => p.agentId)).toEqual(["agent-1", "agent-2"]);
    expect(visibleHumans.map((p) => p.agentId)).toEqual(["human-1", "human-2"]);
  });

  it("caps the visible roster at the limit and reports the hidden remainder", () => {
    const roster = Array.from({ length: 8 }, (_, i) => participant(`agent-${i}`, "agent"));
    const { total, visibleAgents, visibleHumans, hiddenCount } = partitionRoster(roster, false);
    expect(total).toBe(8);
    expect(visibleAgents).toHaveLength(VISIBLE_LIMIT);
    expect(visibleHumans).toHaveLength(0);
    expect(hiddenCount).toBe(3);
  });

  it("fills the visible slice with agents first, then humans, when over the cap", () => {
    const roster = [
      ...Array.from({ length: 3 }, (_, i) => participant(`agent-${i}`, "agent")),
      ...Array.from({ length: 4 }, (_, i) => participant(`human-${i}`, "human")),
    ];
    const { visibleAgents, visibleHumans, hiddenCount } = partitionRoster(roster, false);
    // 3 agents + first 2 humans = 5 visible; 2 humans hidden.
    expect(visibleAgents.map((p) => p.agentId)).toEqual(["agent-0", "agent-1", "agent-2"]);
    expect(visibleHumans.map((p) => p.agentId)).toEqual(["human-0", "human-1"]);
    expect(hiddenCount).toBe(2);
  });

  it("reveals everyone when showAll is set", () => {
    const roster = Array.from({ length: 8 }, (_, i) => participant(`agent-${i}`, "agent"));
    const { visibleAgents, hiddenCount } = partitionRoster(roster, true);
    expect(visibleAgents).toHaveLength(8);
    expect(hiddenCount).toBe(0);
  });

  it("does not hide anything at or under the cap", () => {
    const roster = Array.from({ length: 5 }, (_, i) => participant(`agent-${i}`, "agent"));
    const { hiddenCount } = partitionRoster(roster, false);
    expect(hiddenCount).toBe(0);
  });
});
