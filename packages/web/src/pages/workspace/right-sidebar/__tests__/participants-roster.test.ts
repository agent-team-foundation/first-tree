import { type AgentChatStatusInput, buildAgentChatStatus, type ChatParticipantDetail } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import { orderParticipantsByActivity, partitionRoster, VISIBLE_LIMIT } from "../../participant-order.js";

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
  it("preserves the supplied order", () => {
    const roster = [
      participant("human-1", "human"),
      participant("agent-1", "agent"),
      participant("human-2", "human"),
      participant("agent-2", "agent"),
    ];
    const { visibleParticipants } = partitionRoster(roster, true);
    expect(visibleParticipants.map((p) => p.agentId)).toEqual(["human-1", "agent-1", "human-2", "agent-2"]);
  });

  it("caps the visible roster at the limit and reports the hidden remainder", () => {
    const roster = Array.from({ length: 8 }, (_, i) => participant(`agent-${i}`, "agent"));
    const { total, visibleParticipants, hiddenCount } = partitionRoster(roster, false);
    expect(total).toBe(8);
    expect(visibleParticipants).toHaveLength(VISIBLE_LIMIT);
    expect(hiddenCount).toBe(3);
  });

  it("uses the supplied order when taking the visible slice", () => {
    const roster = [
      ...Array.from({ length: 3 }, (_, i) => participant(`human-${i}`, "human")),
      ...Array.from({ length: 4 }, (_, i) => participant(`agent-${i}`, "agent")),
    ];
    const { visibleParticipants, hiddenCount } = partitionRoster(roster, false);
    expect(visibleParticipants.map((p) => p.agentId)).toEqual(["human-0", "human-1", "human-2", "agent-0", "agent-1"]);
    expect(hiddenCount).toBe(2);
  });

  it("reveals everyone when showAll is set", () => {
    const roster = Array.from({ length: 8 }, (_, i) => participant(`agent-${i}`, "agent"));
    const { visibleParticipants, hiddenCount } = partitionRoster(roster, true);
    expect(visibleParticipants).toHaveLength(8);
    expect(hiddenCount).toBe(0);
  });

  it("does not hide anything at or under the cap", () => {
    const roster = Array.from({ length: 5 }, (_, i) => participant(`agent-${i}`, "agent"));
    const { hiddenCount } = partitionRoster(roster, false);
    expect(hiddenCount).toBe(0);
  });
});

const statusBase: Omit<AgentChatStatusInput, "agentId"> = {
  reachable: true,
  errored: false,
  working: false,
  engagement: "active",
};

describe("orderParticipantsByActivity", () => {
  it("keeps failed agents ahead of working and recent speakers", () => {
    const roster = [participant("working", "agent"), participant("human-1", "human"), participant("failed", "agent")];

    const ordered = orderParticipantsByActivity(
      roster,
      [{ senderId: "human-1", createdAt: "2026-07-09T04:00:00.000Z" }],
      [
        buildAgentChatStatus({ ...statusBase, agentId: "working", working: true }),
        buildAgentChatStatus({ ...statusBase, agentId: "failed", errored: true }),
      ],
    );

    expect(ordered.map((p) => p.agentId)).toEqual(["failed", "working", "human-1"]);
  });

  it("keeps fatal terminal recovery reasons ahead of recent speakers", () => {
    const roster = [participant("human-1", "human"), participant("fatal", "agent")];

    const ordered = orderParticipantsByActivity(
      roster,
      [{ senderId: "human-1", createdAt: "2026-07-09T04:00:00.000Z" }],
      [
        buildAgentChatStatus({
          ...statusBase,
          agentId: "fatal",
          statusReason: {
            kind: "terminal",
            severity: "error",
            provider: "codex",
            scope: "provider_turn",
            category: "unknown",
            reasonCode: "unknown_exhausted",
            label: "Provider retry exhausted",
          },
        }),
      ],
    );

    expect(ordered.map((p) => p.agentId)).toEqual(["fatal", "human-1"]);
  });

  it("puts currently working agents before more recent speakers", () => {
    const roster = [participant("human-1", "human"), participant("agent-1", "agent"), participant("agent-2", "agent")];

    const ordered = orderParticipantsByActivity(
      roster,
      [
        { senderId: "human-1", createdAt: "2026-07-09T03:00:00.000Z" },
        { senderId: "agent-2", createdAt: "2026-07-09T02:00:00.000Z" },
      ],
      [
        buildAgentChatStatus({ ...statusBase, agentId: "agent-1", working: true }),
        buildAgentChatStatus({ ...statusBase, agentId: "agent-2" }),
      ],
    );

    expect(ordered.map((p) => p.agentId)).toEqual(["agent-1", "human-1", "agent-2"]);
  });

  it("uses latest message time when no participant is currently working", () => {
    const roster = [participant("agent-1", "agent"), participant("human-1", "human"), participant("agent-2", "agent")];

    const ordered = orderParticipantsByActivity(roster, [
      { senderId: "agent-1", createdAt: "2026-07-09T01:00:00.000Z" },
      { senderId: "human-1", createdAt: "2026-07-09T03:00:00.000Z" },
      { senderId: "agent-1", createdAt: "2026-07-09T04:00:00.000Z" },
    ]);

    expect(ordered.map((p) => p.agentId)).toEqual(["agent-1", "human-1", "agent-2"]);
  });

  it("keeps membership order for participants with no activity", () => {
    const roster = [participant("human-1", "human"), participant("agent-1", "agent"), participant("agent-2", "agent")];

    expect(orderParticipantsByActivity(roster, []).map((p) => p.agentId)).toEqual(["human-1", "agent-1", "agent-2"]);
  });

  it("treats live timeline turns as active even before the status query catches up", () => {
    const roster = [participant("human-1", "human"), participant("agent-1", "agent")];

    const ordered = orderParticipantsByActivity(
      roster,
      [{ senderId: "human-1", createdAt: "2026-07-09T04:00:00.000Z" }],
      [],
      new Set(["agent-1"]),
    );

    expect(ordered.map((p) => p.agentId)).toEqual(["agent-1", "human-1"]);
  });
});
