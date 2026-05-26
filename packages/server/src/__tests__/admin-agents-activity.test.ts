import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { members } from "../db/schema/members.js";
import { organizations } from "../db/schema/organizations.js";
import { users } from "../db/schema/users.js";
import { createAgent } from "../services/agent.js";
import { bindAgent } from "../services/presence.js";
import { uuidv7 } from "../uuid.js";
import { createAdminContext, INVALID_BCRYPT_PLACEHOLDER, seedClient, useTestApp } from "./helpers.js";

/**
 * Follow-up to #220. The `GET /admin/agents/activity` route used to read
 * `memberScope(request)` directly and ignore `?organizationId=`, which meant
 * every consumer of the React Query `["activity"]` cache (Workspace roster
 * + middle area, Agents tab RUNTIME column, Computers BOUND AGENTS, Cmd-K
 * palette) silently rendered JWT-default-org runtime data even when the
 * dropdown showed a different org. These tests pin the post-fix behaviour
 * so the same regression cannot land again unnoticed.
 */
describe("GET /admin/agents/activity org scoping", () => {
  const getApp = useTestApp();

  /** Attach `userId` to a fresh org with the requested role + a self
   * human agent, mirroring the helper in admin-realtime-role.test.ts. */
  async function attachOrg(
    app: FastifyInstance,
    userId: string,
    role: "admin" | "member",
  ): Promise<{ orgId: string; memberId: string }> {
    const orgId = `org-act-${crypto.randomUUID().slice(0, 8)}`;
    const memberId = uuidv7();
    await app.db.transaction(async (tx) => {
      await tx
        .insert(organizations)
        .values({ id: orgId, name: `act-${crypto.randomUUID().slice(0, 6)}`, displayName: "Activity Side" });
      const human = await createAgent(tx as unknown as typeof app.db, {
        name: `act-h-${crypto.randomUUID().slice(0, 6)}`,
        type: "human",
        displayName: "Activity Human",
        managerId: memberId,
        organizationId: orgId,
      });
      await tx.insert(members).values({ id: memberId, userId, organizationId: orgId, agentId: human.uuid, role });
    });
    return { orgId, memberId };
  }

  async function setup() {
    const app = getApp();
    // Alice has org A (default, admin) plus a seeded client owned by her.
    const alice = await createAdminContext(app);
    // Alice is also admin in org B.
    const orgB = await attachOrg(app, alice.userId, "admin");

    // One non-human agent per org, pinned to Alice's client (a single
    // user-owned client can host agents from multiple orgs, post-#214).
    const agentA = await createAgent(app.db, {
      name: `act-a-${crypto.randomUUID().slice(0, 6)}`,
      type: "autonomous_agent",
      displayName: "Org A bot",
      managerId: alice.memberId,
      clientId: alice.clientId,
    });
    const agentB = await createAgent(app.db, {
      name: `act-b-${crypto.randomUUID().slice(0, 6)}`,
      type: "autonomous_agent",
      displayName: "Org B bot",
      managerId: orgB.memberId,
      clientId: alice.clientId,
      organizationId: orgB.orgId,
    });

    // bindAgent inserts an agent_presence row with runtime_state='idle' so
    // listAgentsWithRuntime's `IS NOT NULL` filter sees both agents.
    const instance = `inst-${crypto.randomUUID().slice(0, 6)}`;
    await bindAgent(app.db, agentA.uuid, {
      clientId: alice.clientId,
      instanceId: instance,
      runtimeType: "claude-code",
    });
    await bindAgent(app.db, agentB.uuid, {
      clientId: alice.clientId,
      instanceId: instance,
      runtimeType: "claude-code",
    });

    return { app, alice, orgB, agentA, agentB };
  }

  it("returns only the URL org's agents", async () => {
    const { app, alice, agentA, agentB } = await setup();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${encodeURIComponent(alice.organizationId)}/activity`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const ids = res.json<{ agents: Array<{ agentId: string }> }>().agents.map((a) => a.agentId);
    expect(ids).toContain(agentA.uuid);
    expect(ids).not.toContain(agentB.uuid);
  });

  it("returns the target org's agents when the URL targets it directly", async () => {
    const { app, alice, orgB, agentA, agentB } = await setup();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${encodeURIComponent(orgB.orgId)}/activity`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const ids = res.json<{ agents: Array<{ agentId: string }> }>().agents.map((a) => a.agentId);
    expect(ids).toContain(agentB.uuid);
    expect(ids).not.toContain(agentA.uuid);
  });

  it("rejects when the caller has no membership in the URL's org (403 via requireOrgMembership)", async () => {
    const { app, alice } = await setup();
    const outsider = `org-act-out-${crypto.randomUUID().slice(0, 8)}`;
    await app.db.insert(organizations).values({ id: outsider, name: outsider.slice(0, 30), displayName: "Outside" });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${encodeURIComponent(outsider)}/activity`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  // Every row carries `presenceStatus`, the two-state reachability column
  // pulled from `agent_presence.status`. Management-page consumers
  // (Computers bound-agent lists, Team / Settings via the same RuntimeAgent
  // DTO going forward) need this to render Online/Offline without
  // cross-referencing the agents endpoint.
  it("includes presenceStatus on every agent row", async () => {
    const { app, alice, agentA } = await setup();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${encodeURIComponent(alice.organizationId)}/activity`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const agents = res.json<{ agents: Array<{ agentId: string; presenceStatus: string }> }>().agents;
    expect(agents.length).toBeGreaterThan(0);
    for (const row of agents) {
      expect(["online", "offline"]).toContain(row.presenceStatus);
    }
    const aRow = agents.find((a) => a.agentId === agentA.uuid);
    expect(aRow?.presenceStatus).toBeDefined();
  });
});

/**
 * `managedByMe` powers the workspace new-chat view's default-seed logic
 * (`pickDefault` in `new-chat-draft.tsx`): a fresh draft should only seed
 * a chip from agents the caller personally manages, never another
 * member's org-visible agent. The server is the only place that knows
 * the join (agent.managerId === caller's memberId for the URL org), so
 * the boolean is computed here and shipped on each row of `/activity`.
 */
describe("GET /orgs/:orgId/activity — managedByMe field", () => {
  const getApp = useTestApp();

  async function setup() {
    const app = getApp();
    // Alice (the caller) and Bob (another member of the same org), each
    // owning one autonomous agent. Both agents are org-visible, so the
    // visibility filter returns both rows to Alice — `managedByMe` is
    // what differentiates them.
    const alice = await createAdminContext(app);
    const bobMemberId = uuidv7();
    const bobUserId = uuidv7();
    // Insert bob as a second member of alice's org. Same FK-cycle dance
    // as createTestAdmin (helpers.ts): user → agent (with FK to member,
    // deferred via migration 0019) → member (FK back to the agent), all
    // in one transaction.
    await app.db.transaction(async (tx) => {
      await tx.insert(users).values({
        id: bobUserId,
        username: `bob-${crypto.randomUUID().slice(0, 8)}`,
        passwordHash: INVALID_BCRYPT_PLACEHOLDER,
        displayName: "Bob",
      });
      const bobHuman = await createAgent(tx as unknown as typeof app.db, {
        name: `bob-h-${crypto.randomUUID().slice(0, 6)}`,
        type: "human",
        displayName: "Bob",
        managerId: bobMemberId,
        organizationId: alice.organizationId,
      });
      await tx.insert(members).values({
        id: bobMemberId,
        userId: bobUserId,
        organizationId: alice.organizationId,
        agentId: bobHuman.uuid,
        role: "member",
      });
    });

    // Each manager's agent must pin to a client owned by that manager's
    // user (services/agent.ts::resolveAgentClient enforces this), so bob
    // needs his own seeded client.
    const bobClientId = await seedClient(app, bobUserId, alice.organizationId);

    const aliceAgent = await createAgent(app.db, {
      name: `mbm-a-${crypto.randomUUID().slice(0, 6)}`,
      type: "autonomous_agent",
      displayName: "Alice bot",
      managerId: alice.memberId,
      clientId: alice.clientId,
    });
    const bobAgent = await createAgent(app.db, {
      name: `mbm-b-${crypto.randomUUID().slice(0, 6)}`,
      type: "autonomous_agent",
      displayName: "Bob bot",
      managerId: bobMemberId,
      clientId: bobClientId,
    });

    const instance = `inst-${crypto.randomUUID().slice(0, 6)}`;
    await bindAgent(app.db, aliceAgent.uuid, {
      clientId: alice.clientId,
      instanceId: instance,
      runtimeType: "claude-code",
    });
    await bindAgent(app.db, bobAgent.uuid, {
      clientId: bobClientId,
      instanceId: instance,
      runtimeType: "claude-code",
    });

    return { app, alice, aliceAgent, bobAgent };
  }

  it("marks the caller's own agents as managedByMe=true and others' as false", async () => {
    const { app, alice, aliceAgent, bobAgent } = await setup();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${encodeURIComponent(alice.organizationId)}/activity`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const agents = res.json<{ agents: Array<{ agentId: string; managedByMe: boolean }> }>().agents;
    const byId = new Map(agents.map((a) => [a.agentId, a.managedByMe]));
    // Both agents are org-visible, so both reach the caller.
    expect(byId.get(aliceAgent.uuid)).toBe(true);
    expect(byId.get(bobAgent.uuid)).toBe(false);
  });
});
