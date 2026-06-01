import type { Agent } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import { buildTeamData, fetchAllAgents, selectDelegateCandidates } from "../index.js";

function agent(input: {
  uuid: string;
  type: Agent["type"];
  displayName: string;
  name?: string | null;
  delegateMention?: string | null;
  managerId?: string | null;
  visibility?: Agent["visibility"];
  status?: string;
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
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const member = (id: string, agentId: string, displayName: string, role = "member") => ({
  id,
  agentId,
  username: displayName.toLowerCase(),
  displayName,
  role,
  createdAt: "2026-01-01T00:00:00.000Z",
  lastActiveAt: null,
});

describe("fetchAllAgents", () => {
  it("fetches every agent page before building delegate state", async () => {
    const first = agent({ uuid: "human-1", type: "human", displayName: "Ada", delegateMention: "assistant-1" });
    const second = agent({ uuid: "assistant-1", type: "agent", displayName: "Ada Assistant" });
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
});

describe("buildTeamData", () => {
  const base = {
    filter: "all" as const,
    search: "",
    isAdmin: false,
    selfMemberId: "member-1",
    resolveMember: (id: string) => id,
  };

  it("resolves a human's delegate identity from the loaded agent map", () => {
    const human = agent({ uuid: "human-1", type: "human", displayName: "Ada", delegateMention: "assistant-1" });
    const assistant = agent({ uuid: "assistant-1", type: "agent", displayName: "Ada Assistant", name: "ada-helper" });
    const { humans } = buildTeamData({
      ...base,
      members: [member("member-1", "human-1", "Ada")],
      agents: [],
      agentByUuid: new Map([
        [human.uuid, human],
        [assistant.uuid, assistant],
      ]),
    });
    const row = humans[0];
    if (!row) throw new Error("expected a human row");
    expect(row.delegate).toEqual({ uuid: "assistant-1", name: "ada-helper", displayName: "Ada Assistant" });
    // Only the user themselves can edit their own delegate (admins cannot).
    expect(row.canEditDelegate).toBe(true);
  });

  it("derives lastActiveLabel from member.lastActiveAt (null → no label)", () => {
    const { humans } = buildTeamData({
      ...base,
      members: [
        { ...member("member-1", "human-1", "Active"), lastActiveAt: "2026-05-01T00:00:00.000Z" },
        { ...member("member-2", "human-2", "Never"), lastActiveAt: null },
      ],
      agents: [],
      agentByUuid: new Map(),
    });
    const active = humans.find((h) => h.id === "member-1");
    const never = humans.find((h) => h.id === "member-2");
    expect(active?.lastActiveLabel).toBeTruthy();
    expect(never?.lastActiveLabel).toBeNull();
  });

  it("partitions agents into Public/Private with own agents pinned first", () => {
    const myShared = agent({
      uuid: "my-shared",
      type: "agent",
      displayName: "Zed Shared",
      visibility: "organization",
      managerId: "member-1",
    });
    const myPrivate = agent({
      uuid: "my-private",
      type: "agent",
      displayName: "My Private",
      visibility: "private",
      managerId: "member-1",
    });
    const theirShared = agent({
      uuid: "their-shared",
      type: "agent",
      displayName: "Acme Shared",
      visibility: "organization",
      managerId: "member-2",
    });
    const { publicAgents, privateAgents, agentCount } = buildTeamData({
      ...base,
      members: [],
      agents: [theirShared, myShared, myPrivate],
      agentByUuid: new Map(),
    });
    // Public: own agent pinned first despite alphabetical ordering of the other.
    expect(publicAgents.map((r) => r.agent.uuid)).toEqual(["my-shared", "their-shared"]);
    expect(privateAgents.map((r) => r.agent.uuid)).toEqual(["my-private"]);
    expect(agentCount).toBe(3);
  });

  it("hides other members' private agents from members but shows them to admins", () => {
    const theirPrivate = agent({
      uuid: "their-private",
      type: "agent",
      displayName: "Theirs",
      visibility: "private",
      managerId: "member-2",
    });
    const memberView = buildTeamData({ ...base, members: [], agents: [theirPrivate], agentByUuid: new Map() });
    expect(memberView.privateAgents).toHaveLength(0);

    const adminView = buildTeamData({
      ...base,
      isAdmin: true,
      members: [],
      agents: [theirPrivate],
      agentByUuid: new Map(),
    });
    expect(adminView.privateAgents.map((r) => r.agent.uuid)).toEqual(["their-private"]);
  });

  it("`mine` filter narrows agents to the viewer but leaves humans untouched", () => {
    const mine = agent({ uuid: "mine", type: "agent", displayName: "Mine", managerId: "member-1" });
    const theirs = agent({
      uuid: "theirs",
      type: "agent",
      displayName: "Theirs",
      visibility: "organization",
      managerId: "member-2",
    });
    const members = [member("member-1", "human-1", "Ada"), member("member-2", "human-2", "Bo")];

    const all = buildTeamData({ ...base, members, agents: [mine, theirs], agentByUuid: new Map() });
    expect(all.agentCount).toBe(2);
    expect(all.humans).toHaveLength(2);

    const onlyMine = buildTeamData({
      ...base,
      filter: "mine",
      members,
      agents: [mine, theirs],
      agentByUuid: new Map(),
    });
    expect(onlyMine.publicAgents.map((r) => r.agent.uuid)).toEqual(["mine"]);
    expect(onlyMine.agentCount).toBe(1);
    // Humans are not affected by the agent-scoped Mine filter.
    expect(onlyMine.humans).toHaveLength(2);
  });

  it("filters both sections by search", () => {
    const found = agent({ uuid: "found", type: "agent", displayName: "Searchable Bot", managerId: "member-1" });
    const other = agent({ uuid: "other", type: "agent", displayName: "Hidden", managerId: "member-1" });
    const { publicAgents, humans } = buildTeamData({
      ...base,
      search: "searchable",
      members: [member("member-1", "human-1", "Ada")],
      agents: [found, other],
      agentByUuid: new Map(),
    });
    expect(publicAgents.map((r) => r.agent.uuid)).toEqual(["found"]);
    expect(humans).toHaveLength(0); // "Ada"/"ada" doesn't match "searchable"
  });

  it("pins the viewer's own human row to the top", () => {
    const { humans } = buildTeamData({
      ...base,
      members: [member("member-2", "human-2", "Bo"), member("member-1", "human-1", "Ada")],
      agents: [],
      agentByUuid: new Map(),
    });
    expect(humans[0]?.id).toBe("member-1");
    expect(humans[0]?.isSelf).toBe(true);
  });
});

describe("selectDelegateCandidates", () => {
  it("returns only the given manager's active team-visible (organization) agents", () => {
    const mineOrg = agent({
      uuid: "mine-org",
      type: "agent",
      displayName: "Mine",
      visibility: "organization",
      managerId: "member-1",
    });
    const theirOrg = agent({
      uuid: "their-org",
      type: "agent",
      displayName: "Theirs",
      visibility: "organization",
      managerId: "member-2",
    });
    const minePrivate = agent({
      uuid: "mine-private",
      type: "agent",
      displayName: "Private",
      visibility: "private",
      managerId: "member-1",
    });
    const suspended = agent({
      uuid: "suspended",
      type: "agent",
      displayName: "Suspended",
      visibility: "organization",
      status: "suspended",
      managerId: "member-1",
    });
    const human = agent({ uuid: "human-1", type: "human", displayName: "Ada", managerId: "member-1" });

    expect(
      selectDelegateCandidates([mineOrg, theirOrg, minePrivate, suspended, human], "member-1").map((a) => a.uuid),
    ).toEqual(["mine-org"]);
  });
});
