import type { Agent } from "@first-tree/shared";
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
    avatarColorToken: null,
    avatarImageUrl: null,
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

  it("fails fast if agent pagination does not terminate", async () => {
    await expect(fetchAllAgents(async () => ({ items: [], nextCursor: "same-cursor" }))).rejects.toThrow(
      "fetchAllAgents exceeded 100 pages",
    );
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
      yourAgents: [],
      teamAgents: [],
      otherPrivateAgents: [],
      resolveMember: (id) => id,
      agentByUuid: new Map([
        [human.uuid, human],
        [assistant.uuid, assistant],
      ]),
      openDelegate: () => {},
    });

    // "Your agents" renders first (even when empty); humans is the second
    // group. Locate it by key rather than positional indexing so the test
    // doesn't rot if section order changes again.
    const humansGroup = groups.find((g) => g.key === "humans");
    if (!humansGroup) throw new Error("expected a humans group");
    const row = humansGroup.rows[0];
    if (row?.kind !== "human") throw new Error("expected first humans row to be human");
    expect(row.delegate).toEqual({ name: "ada-helper", displayName: "Ada Assistant" });
    expect(row.canEditDelegate).toBe(true);
  });

  it("places Your agents section first and partitions agents by manager", () => {
    const myShared = agent({
      uuid: "my-shared",
      type: "personal_assistant",
      displayName: "My Shared Bot",
      visibility: "organization",
      managerId: "member-1",
    });
    const myPrivate = agent({
      uuid: "my-private",
      type: "personal_assistant",
      displayName: "My Private Bot",
      visibility: "private",
      managerId: "member-1",
    });
    const theirShared = agent({
      uuid: "their-shared",
      type: "personal_assistant",
      displayName: "Their Shared Bot",
      visibility: "organization",
      managerId: "member-2",
    });
    const groups = buildGroups({
      filter: "all",
      search: "",
      isAdmin: false,
      selfMemberId: "member-1",
      members: [],
      yourAgents: [myShared, myPrivate],
      teamAgents: [theirShared],
      otherPrivateAgents: [],
      resolveMember: (id) => id,
      agentByUuid: new Map(),
      openDelegate: () => {},
    });

    expect(groups.map((g) => g.key)).toEqual(["yours", "humans", "team"]);
    const yoursGroup = groups[0];
    if (!yoursGroup) throw new Error("expected yours group");
    expect(yoursGroup.title).toBe("Your agents");
    expect(yoursGroup.count).toBe(2);
    // Private agents sort to the top of Your agents — governance attention
    // belongs on the sensitive rows.
    const yoursFirst = yoursGroup.rows[0];
    if (yoursFirst?.kind !== "agent") throw new Error("expected agent row");
    expect(yoursFirst.agent.uuid).toBe("my-private");
    expect(yoursFirst.showVisibilityChip).toBe(true);

    const teamGroup = groups.find((g) => g.key === "team");
    if (!teamGroup) throw new Error("expected team group");
    expect(teamGroup.count).toBe(1);
    const teamFirst = teamGroup.rows[0];
    if (teamFirst?.kind !== "agent") throw new Error("expected agent row");
    // Homogeneous section — no per-row visibility chip needed.
    expect(teamFirst.showVisibilityChip).toBe(false);
  });

  it("sorts Your agents deterministically: private first, then displayName tiebreaker", () => {
    // Deliberately scrambled input order — without a stable secondary
    // sort key the rendered order would follow this scramble and reshuffle
    // visibly across refetches. The sort should pin private to the top
    // and break ties alphabetically (case-insensitive).
    const sharedZeta = agent({
      uuid: "shared-z",
      type: "personal_assistant",
      displayName: "Zeta",
      visibility: "organization",
      managerId: "member-1",
    });
    const sharedAlpha = agent({
      uuid: "shared-a",
      type: "personal_assistant",
      displayName: "alpha",
      visibility: "organization",
      managerId: "member-1",
    });
    const privateBeta = agent({
      uuid: "private-b",
      type: "personal_assistant",
      displayName: "Beta",
      visibility: "private",
      managerId: "member-1",
    });
    const privateGamma = agent({
      uuid: "private-g",
      type: "personal_assistant",
      displayName: "gamma",
      visibility: "private",
      managerId: "member-1",
    });

    const groups = buildGroups({
      filter: "all",
      search: "",
      isAdmin: false,
      selfMemberId: "member-1",
      members: [],
      // Order: shared, private, shared, private — guarantees the test
      // exercises both the visibility partition and the alpha tiebreaker.
      yourAgents: [sharedZeta, privateBeta, sharedAlpha, privateGamma],
      teamAgents: [],
      otherPrivateAgents: [],
      resolveMember: (id) => id,
      agentByUuid: new Map(),
      openDelegate: () => {},
    });

    const yoursGroup = groups.find((g) => g.key === "yours");
    if (!yoursGroup) throw new Error("expected yours group");
    const uuids = yoursGroup.rows.map((r) => (r.kind === "agent" ? r.agent.uuid : "?"));
    expect(uuids).toEqual(["private-b", "private-g", "shared-a", "shared-z"]);
  });

  it("shows Other members' private agents collapsibly for admins only", () => {
    const theirPrivate = agent({
      uuid: "their-private",
      type: "personal_assistant",
      displayName: "Their Private Bot",
      visibility: "private",
      managerId: "member-2",
    });

    const memberView = buildGroups({
      filter: "all",
      search: "",
      isAdmin: false,
      selfMemberId: "member-1",
      members: [],
      yourAgents: [],
      teamAgents: [],
      otherPrivateAgents: [theirPrivate],
      resolveMember: (id) => id,
      agentByUuid: new Map(),
      openDelegate: () => {},
    });
    expect(memberView.find((g) => g.key === "other-private")).toBeUndefined();

    const adminView = buildGroups({
      filter: "all",
      search: "",
      isAdmin: true,
      selfMemberId: "member-1",
      members: [],
      yourAgents: [],
      teamAgents: [],
      otherPrivateAgents: [theirPrivate],
      resolveMember: (id) => id,
      agentByUuid: new Map(),
      openDelegate: () => {},
    });
    const adminOtherPrivate = adminView.find((g) => g.key === "other-private");
    expect(adminOtherPrivate).toBeDefined();
    expect(adminOtherPrivate?.collapsible).toBe(true);
    expect(adminOtherPrivate?.count).toBe(1);
  });

  it("respects the yours / team / humans filter pills", () => {
    const myAgent = agent({
      uuid: "my-agent",
      type: "personal_assistant",
      displayName: "Mine",
      managerId: "member-1",
    });
    const theirAgent = agent({
      uuid: "their-agent",
      type: "personal_assistant",
      displayName: "Theirs",
      visibility: "organization",
      managerId: "member-2",
    });
    const baseArgs = {
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
      yourAgents: [myAgent],
      teamAgents: [theirAgent],
      otherPrivateAgents: [],
      resolveMember: (id: string) => id,
      agentByUuid: new Map(),
      openDelegate: () => {},
    };

    expect(buildGroups({ ...baseArgs, filter: "yours" }).map((g) => g.key)).toEqual(["yours"]);
    expect(buildGroups({ ...baseArgs, filter: "humans" }).map((g) => g.key)).toEqual(["humans"]);
    expect(buildGroups({ ...baseArgs, filter: "team" }).map((g) => g.key)).toEqual(["team"]);
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
    const humanAgent = agent({ uuid: "human-1", type: "human", displayName: "Ada" });
    const autonomousAgent = agent({
      uuid: "auto-1",
      type: "autonomous_agent",
      displayName: "Cron Bot",
    });

    expect(
      selectDelegateCandidates([humanAgent, autonomousAgent, privateAssistant, suspendedAssistant]).map((a) => a.uuid),
    ).toEqual(["private-assistant"]);
  });
});
