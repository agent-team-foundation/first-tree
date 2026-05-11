import type { Agent } from "@agent-team-foundation/first-tree-hub-shared";
import { describe, expect, it } from "vitest";
import { buildGroups, fetchAllAgents, selectDelegateCandidates } from "../index.js";

function agent(input: {
  uuid: string;
  type: Agent["type"];
  displayName: string;
  name?: string | null;
  delegateMention?: string | null;
  managerId?: string | null;
  visibility?: Agent["visibility"];
  status?: string;
  createdAt?: string;
}): Agent {
  return {
    uuid: input.uuid,
    name: input.name ?? input.uuid,
    organizationId: "org-1",
    type: input.type,
    displayName: input.displayName,
    delegateMention: input.delegateMention ?? null,
    inboxId: `inbox-${input.uuid}`,
    status: input.status ?? "active",
    source: null,
    visibility: input.visibility ?? "organization",
    metadata: {},
    managerId: input.managerId ?? "member-1",
    clientId: input.type === "human" ? null : "client-1",
    runtimeProvider: "claude-code",
    createdAt: input.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: input.createdAt ?? "2026-01-01T00:00:00.000Z",
  };
}

describe("Team page grouping", () => {
  it("fetches every agent page before building delegate state", async () => {
    const first = agent({ uuid: "human-1", type: "human", displayName: "Ada", delegateMention: "assistant-1" });
    const second = agent({ uuid: "assistant-1", type: "personal_assistant", displayName: "Ada Assistant" });
    const result = await fetchAllAgents(async ({ cursor }) =>
      cursor ? { items: [second], nextCursor: null } : { items: [first], nextCursor: "next-page" },
    );

    expect(result.map((a) => a.uuid)).toEqual(["human-1", "assistant-1"]);
  });

  it("resolves a human delegate from the fully loaded agent map", () => {
    const human = agent({ uuid: "human-1", type: "human", displayName: "Ada", delegateMention: "assistant-1" });
    const assistant = agent({
      uuid: "assistant-1",
      type: "personal_assistant",
      displayName: "Ada Assistant",
      name: "ada-helper",
    });
    const groups = buildGroups({
      filter: "all",
      search: "",
      isAdmin: false,
      selfMemberId: "member-1",
      members: [
        {
          id: "member-1",
          agentId: "human-1",
          username: "ada",
          displayName: "Ada",
          role: "member",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      sharedAgents: [],
      yourPrivateAgents: [],
      otherPrivateAgents: [],
      resolveMember: (id) => id,
      agentByUuid: new Map([
        [human.uuid, human],
        [assistant.uuid, assistant],
      ]),
      openDelegate: () => {},
    });

    const row = groups[0]?.rows[0];
    if (row?.kind !== "human") throw new Error("expected first row to be human");
    expect(row.delegate).toEqual({ name: "ada-helper", displayName: "Ada Assistant" });
    expect(row.canEditDelegate).toBe(true);
  });

  it("keeps private active assistants selectable for admin delegate edits", () => {
    const privateAssistant = agent({
      uuid: "private-assistant",
      type: "personal_assistant",
      displayName: "Private Assistant",
      visibility: "private",
      managerId: "member-2",
    });
    const suspendedAssistant = agent({
      uuid: "suspended-assistant",
      type: "personal_assistant",
      displayName: "Suspended Assistant",
      status: "suspended",
    });

    expect(selectDelegateCandidates([privateAssistant, suspendedAssistant]).map((a) => a.uuid)).toEqual([
      "private-assistant",
    ]);
  });
});
