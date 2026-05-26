import type { FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import { createAgent } from "../services/agent.js";
import { createChat } from "../services/chat.js";
import { createAdminContext, seedClient, useTestApp } from "./helpers.js";

/**
 * Helper: create an admin user + owned client, returning a request function
 * bound to their JWT and the seeded client id (used when createAgent needs a
 * pinned client).
 */
async function authedRequest(app: FastifyInstance, username?: string) {
  const admin = await createAdminContext(app, {
    username: username ?? `vis-admin-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  });
  return {
    req: (method: string, url: string, payload?: unknown) =>
      app.inject({
        method: method as "GET" | "POST" | "PATCH" | "DELETE",
        url,
        headers: { authorization: `Bearer ${admin.accessToken}` },
        ...(payload ? { payload } : {}),
      }),
    admin,
  };
}

/**
 * Helper: create a regular member (non-admin) and return a request function.
 */
async function createMemberAndLogin(
  app: FastifyInstance,
  adminReq: ReturnType<typeof authedRequest> extends Promise<infer T> ? T : never,
) {
  const username = `member-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const createRes = await adminReq.req("POST", `/api/v1/orgs/${adminReq.admin.organizationId}/members`, {
    username,
    displayName: "Test Member",
    role: "member",
  });
  const memberData = createRes.json<{ id: string; password: string; agentId: string }>();

  const loginRes = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username, password: memberData.password },
  });
  const { accessToken } = loginRes.json<{ accessToken: string }>();

  return {
    memberId: memberData.id,
    agentId: memberData.agentId,
    accessToken,
    req: (method: string, url: string, payload?: unknown) =>
      app.inject({
        method: method as "GET" | "POST" | "PATCH" | "DELETE",
        url,
        headers: { authorization: `Bearer ${accessToken}` },
        ...(payload ? { payload } : {}),
      }),
  };
}

// Shared default-org admin + client so tests calling createAgent without
// explicit managerId/clientId still get a valid pin after M1 Rule R-RUN.
let fallback: { memberId: string; clientId: string };

async function seedClientForMember(app: FastifyInstance, memberId: string): Promise<string> {
  const { members } = await import("../db/schema/members.js");
  const { eq } = await import("drizzle-orm");
  const [row] = await app.db
    .select({ userId: members.userId, organizationId: members.organizationId })
    .from(members)
    .where(eq(members.id, memberId))
    .limit(1);
  if (!row) throw new Error(`member "${memberId}" not found`);
  return seedClient(app, row.userId, row.organizationId);
}

async function seedAgent(app: FastifyInstance, data: Parameters<typeof createAgent>[1]) {
  const managerId = data.managerId ?? fallback.memberId;
  let clientId = data.clientId;
  if (!clientId && data.type !== "human") {
    clientId = managerId === fallback.memberId ? fallback.clientId : await seedClientForMember(app, managerId);
  }
  return createAgent(app.db, { ...data, managerId, clientId });
}

describe("Agent Visibility", () => {
  const getApp = useTestApp();

  beforeEach(async () => {
    fallback = await createAdminContext(getApp(), {
      username: `vis-fb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });
  });

  describe("default visibility by type", () => {
    it("human agents default to organization visibility", async () => {
      const app = getApp();
      const agent = await seedAgent(app, { name: "vis-human", type: "human" });
      expect(agent.visibility).toBe("organization");
    });

    // Post-type-merge: pre-merge `personal_assistant` + `autonomous_agent`
    // collapsed into a single `agent` type. The server defaults to
    // "organization" (the autonomous-bot framing that was the most common
    // pre-merge case); callers that want the private framing (new-agent
    // dialog, CLI assistant onboarding) pass `visibility: "private"`
    // explicitly.
    it("agent rows default to organization visibility", async () => {
      const app = getApp();
      const agent = await seedAgent(app, { name: "vis-agent", type: "agent" });
      expect(agent.visibility).toBe("organization");
    });

    it("explicit private visibility overrides default", async () => {
      const app = getApp();
      const agent = await seedAgent(app, {
        name: "vis-override",
        type: "agent",
        visibility: "private",
      });
      expect(agent.visibility).toBe("private");
    });
  });

  describe("visibility filtering in agent listing", () => {
    it("admin sees organization-visible agents and their own private agents (same as member)", async () => {
      const app = getApp();
      const { req: adminReq, admin } = await authedRequest(app);

      // Get admin's memberId from /me
      const meRes = await adminReq("GET", "/api/v1/me");
      const adminMemberId = meRes.json<{ memberships: Array<{ id: string }> }>().memberships[0]?.id ?? admin.memberId;

      // Create agents: org-visible, admin's private, unowned private. Post-
      // type-merge `agent` defaults to organization visibility — pass
      // `visibility: "private"` explicitly when a test wants the assistant
      // framing.
      await seedAgent(app, { name: "admin-see-org", type: "agent" });
      await seedAgent(app, {
        name: "admin-see-own-priv",
        type: "agent",
        visibility: "private",
        managerId: adminMemberId,
      });
      await seedAgent(app, { name: "admin-hidden-priv", type: "agent", visibility: "private" });

      const res = await adminReq("GET", `/api/v1/orgs/${admin.organizationId}/agents?limit=100`);
      expect(res.statusCode).toBe(200);
      const body = res.json<{ items: Array<{ name: string; visibility: string }> }>();
      const names = body.items.map((a) => a.name);
      expect(names).toContain("admin-see-org");
      expect(names).toContain("admin-see-own-priv");
      expect(names).not.toContain("admin-hidden-priv");
    });

    it("member sees organization-visible agents and their own private agents", async () => {
      const app = getApp();
      const adminBundle = await authedRequest(app);
      const member = await createMemberAndLogin(app, adminBundle);

      // Create agents: one org-visible, one private managed by this member, one private managed by admin
      await seedAgent(app, { name: "member-see-org", type: "agent" });
      await seedAgent(app, {
        name: "member-see-my",
        type: "agent",
        visibility: "private",
        managerId: member.memberId,
      });
      await seedAgent(app, {
        name: "member-hidden",
        type: "agent",
        visibility: "private",
      });

      const res = await member.req("GET", `/api/v1/orgs/${adminBundle.admin.organizationId}/agents?limit=100`);
      expect(res.statusCode).toBe(200);
      const body = res.json<{ items: Array<{ name: string; visibility: string }> }>();
      const names = body.items.map((a) => a.name);

      expect(names).toContain("member-see-org");
      expect(names).toContain("member-see-my");
      expect(names).not.toContain("member-hidden");
    });
  });

  /**
   * Server-side ?query= search powers the web participant picker so orgs
   * with more than `limit` (100) visible agents can still reach agents
   * past the first page (issue 494). The contracts under test:
   *   1. Match is case-insensitive substring against name + displayName.
   *   2. Search is wrapped by the visibility predicate — private agents
   *      owned by other members must not leak through `?query=`.
   *   3. Humans surface under search the same way they do unfiltered
   *      (lockstep with issue 343 / #492).
   *   4. ILIKE wildcards in user input are neutralised so a literal
   *      "%" or "_" doesn't act as a pattern.
   */
  describe("?query= server-side picker search", () => {
    it("matches by case-insensitive substring on both name and displayName", async () => {
      const app = getApp();
      const { req: adminReq, admin } = await authedRequest(app);

      await seedAgent(app, { name: "query-aardvark", type: "agent", displayName: "Aardvark" });
      await seedAgent(app, { name: "query-buffalo", type: "agent", displayName: "Buffalo Bot" });
      // Match by displayName only — the slug does not contain "buff".
      await seedAgent(app, { name: "query-misc", type: "agent", displayName: "Wild Buffer" });
      await seedAgent(app, { name: "query-cheetah", type: "agent", displayName: "Cheetah" });

      const orgId = admin.organizationId;
      const res = await adminReq("GET", `/api/v1/orgs/${orgId}/agents?query=BUFF`);
      expect(res.statusCode).toBe(200);
      const names = res.json<{ items: Array<{ name: string }> }>().items.map((a) => a.name);

      expect(names).toContain("query-buffalo");
      expect(names).toContain("query-misc");
      expect(names).not.toContain("query-aardvark");
      expect(names).not.toContain("query-cheetah");
    });

    it("whitespace-splits the query into AND-of-keyword matches against name + displayName", async () => {
      // The user-perceived failure this protects: a search for "Picker
      // 110" should reach an agent named `picker-agent-110` even though
      // the literal substring "Picker 110" (with a space) appears in
      // neither `name` nor `displayName`. Each token alone does, so the
      // AND-of-OR semantics light it up.
      const app = getApp();
      const { req: adminReq, admin } = await authedRequest(app);

      await seedAgent(app, { name: "picker-agent-110", type: "agent", displayName: "Picker Agent 110" });
      await seedAgent(app, { name: "picker-agent-220", type: "agent", displayName: "Picker Agent 220" });
      // Match by displayName cross-field: token "blue" only appears here,
      // token "110" only in the `name` of an unrelated row above. AND-of-
      // tokens means "blue 110" should match nothing.
      await seedAgent(app, { name: "blue-team-bot", type: "agent", displayName: "Blue Team Bot" });

      const orgId = admin.organizationId;

      // Multi-token, ordering-agnostic — both arrangements should match.
      for (const q of ["Picker 110", "110 picker"]) {
        const res = await adminReq("GET", `/api/v1/orgs/${orgId}/agents?query=${encodeURIComponent(q)}`);
        expect(res.statusCode, `query="${q}" should succeed`).toBe(200);
        const names = res.json<{ items: Array<{ name: string }> }>().items.map((a) => a.name);
        expect(names, `query="${q}" must hit picker-agent-110`).toContain("picker-agent-110");
        expect(names, `query="${q}" must not hit picker-agent-220`).not.toContain("picker-agent-220");
      }

      // Cross-token AND must fail when no single row contains both tokens
      // across either column.
      const noMatch = await adminReq("GET", `/api/v1/orgs/${orgId}/agents?query=${encodeURIComponent("blue 110")}`);
      expect(noMatch.statusCode).toBe(200);
      const noMatchNames = noMatch.json<{ items: Array<{ name: string }> }>().items.map((a) => a.name);
      expect(noMatchNames).not.toContain("picker-agent-110");
      expect(noMatchNames).not.toContain("blue-team-bot");

      // Cross-column AND still works: "Bot" in displayName, "blue" in name.
      const crossCol = await adminReq("GET", `/api/v1/orgs/${orgId}/agents?query=${encodeURIComponent("blue bot")}`);
      expect(crossCol.statusCode).toBe(200);
      const crossColNames = crossCol.json<{ items: Array<{ name: string }> }>().items.map((a) => a.name);
      expect(crossColNames).toContain("blue-team-bot");
    });

    it("respects visibility — does not surface other members' private agents", async () => {
      const app = getApp();
      const adminBundle = await authedRequest(app);
      const member = await createMemberAndLogin(app, adminBundle);

      await seedAgent(app, {
        name: "qpriv-mine",
        type: "agent",
        visibility: "private",
        managerId: member.memberId,
      });
      await seedAgent(app, { name: "qpriv-other", type: "agent", visibility: "private" });

      const orgId = adminBundle.admin.organizationId;
      const res = await member.req("GET", `/api/v1/orgs/${orgId}/agents?query=qpriv`);
      expect(res.statusCode).toBe(200);
      const names = res.json<{ items: Array<{ name: string }> }>().items.map((a) => a.name);

      expect(names).toContain("qpriv-mine");
      expect(names).not.toContain("qpriv-other");
    });

    it("surfaces humans the same way the unfiltered list does", async () => {
      const app = getApp();
      const { req: adminReq, admin } = await authedRequest(app);

      await seedAgent(app, { name: "qhuman-needle", type: "human", displayName: "Needle Human" });

      const orgId = admin.organizationId;
      const res = await adminReq("GET", `/api/v1/orgs/${orgId}/agents?query=needle`);
      expect(res.statusCode).toBe(200);
      const names = res.json<{ items: Array<{ name: string; type: string }> }>().items.map((a) => a.name);

      expect(names).toContain("qhuman-needle");
    });

    it("treats ILIKE wildcards in user input as literals", async () => {
      const app = getApp();
      const { req: adminReq, admin } = await authedRequest(app);

      // Slugs are restricted by AGENT_NAME_REGEX (lowercase + - / _), so a `%`
      // can only land in `displayName` — which is exactly where the literal
      // match guarantee matters. A naive ILIKE would treat `%` as wildcard
      // and "%off" would match every display name.
      await seedAgent(app, { name: "qwild-target", type: "agent", displayName: "50%off promo" });
      await seedAgent(app, { name: "qwild-decoy", type: "agent", displayName: "regular off-sale" });

      const orgId = admin.organizationId;
      const res = await adminReq("GET", `/api/v1/orgs/${orgId}/agents?query=${encodeURIComponent("%off")}`);
      expect(res.statusCode).toBe(200);
      const names = res.json<{ items: Array<{ name: string }> }>().items.map((a) => a.name);

      expect(names).toContain("qwild-target");
      expect(names).not.toContain("qwild-decoy");
    });

    it("escapes ILIKE wildcards per-token — one bare `%` doesn't leak into a sibling token's pattern", async () => {
      // The multi-token split happens BEFORE per-token escaping. The
      // worry this case locks down: if a future refactor flattened the
      // escape step (e.g. escape once, then split) a `%` in token 0
      // could end up acting as a wildcard inside token 1's pattern,
      // matching rows the user didn't ask for.
      //
      // Setup: a slug containing "picker-agent-110" (no `%`), and an
      // unrelated row that contains "110" but no `%` anywhere.
      // Searching for `% 110` should match NEITHER (the `%` token must
      // be a literal `%`, which neither row has).
      const app = getApp();
      const { req: adminReq, admin } = await authedRequest(app);

      await seedAgent(app, { name: "qpct-110", type: "agent", displayName: "Picker Agent 110" });
      await seedAgent(app, { name: "qpct-110-sibling", type: "agent", displayName: "Sibling 110" });

      const orgId = admin.organizationId;
      const res = await adminReq("GET", `/api/v1/orgs/${orgId}/agents?query=${encodeURIComponent("% 110")}`);
      expect(res.statusCode).toBe(200);
      const names = res.json<{ items: Array<{ name: string }> }>().items.map((a) => a.name);

      // Per-token escape means token 0 (`%`) ILIKE compiles to
      // `%\%%` — match anything containing a literal `%`. Neither
      // seeded row has one, so AND of (`%` token) and (`110` token)
      // selects nothing among the seeded rows even though both contain
      // "110".
      expect(names).not.toContain("qpct-110");
      expect(names).not.toContain("qpct-110-sibling");
    });

    it("ignores `?query=` when value is whitespace-only (parsed as omitted)", async () => {
      const app = getApp();
      const { req: adminReq, admin } = await authedRequest(app);

      await seedAgent(app, { name: "qblank-a", type: "agent" });
      await seedAgent(app, { name: "qblank-b", type: "agent" });

      const orgId = admin.organizationId;
      const res = await adminReq("GET", `/api/v1/orgs/${orgId}/agents?query=${encodeURIComponent("   ")}`);
      expect(res.statusCode).toBe(200);
      const names = res.json<{ items: Array<{ name: string }> }>().items.map((a) => a.name);

      // Both seeded names survive — `query` after schema-level trim
      // collapses to "" and the service falls back to the unfiltered
      // listing (the route accepts the empty string instead of returning
      // 400, so the picker never has to pre-validate whitespace).
      expect(names).toEqual(expect.arrayContaining(["qblank-a", "qblank-b"]));
    });
  });

  describe("visibility in single agent GET", () => {
    it("member cannot access private agent managed by another member", async () => {
      const app = getApp();
      const adminBundle = await authedRequest(app);
      const member = await createMemberAndLogin(app, adminBundle);

      const privateAgent = await seedAgent(app, {
        name: "no-access-priv",
        type: "agent",
        visibility: "private",
      });

      const res = await member.req("GET", `/api/v1/agents/${privateAgent.uuid}`);
      expect(res.statusCode).toBe(404);
    });

    it("member can access organization-visible agent", async () => {
      const app = getApp();
      const adminBundle = await authedRequest(app);
      const member = await createMemberAndLogin(app, adminBundle);

      const orgAgent = await seedAgent(app, { name: "access-org", type: "agent" });

      const res = await member.req("GET", `/api/v1/agents/${orgAgent.uuid}`);
      expect(res.statusCode).toBe(200);
    });

    it("member can access their own private agent", async () => {
      const app = getApp();
      const adminBundle = await authedRequest(app);
      const member = await createMemberAndLogin(app, adminBundle);

      const myAgent = await seedAgent(app, {
        name: "access-my-priv",
        type: "agent",
        visibility: "private",
        managerId: member.memberId,
      });

      const res = await member.req("GET", `/api/v1/agents/${myAgent.uuid}`);
      expect(res.statusCode).toBe(200);
    });

    it("admin can access a private agent managed by another member", async () => {
      const app = getApp();
      const { req: adminReq } = await authedRequest(app);
      const otherMemberBundle = await authedRequest(app);
      const otherMember = await createMemberAndLogin(app, otherMemberBundle);

      const privateAgent = await seedAgent(app, {
        name: "admin-cross-priv",
        type: "agent",
        visibility: "private",
        managerId: otherMember.memberId,
      });

      const res = await adminReq("GET", `/api/v1/agents/${privateAgent.uuid}`);
      expect(res.statusCode).toBe(200);
      expect(res.json<{ uuid: string }>().uuid).toBe(privateAgent.uuid);
    });

    it("admin can list sessions of a private agent managed by another member", async () => {
      const app = getApp();
      const { req: adminReq } = await authedRequest(app);
      const otherMemberBundle = await authedRequest(app);
      const otherMember = await createMemberAndLogin(app, otherMemberBundle);

      const privateAgent = await seedAgent(app, {
        name: "admin-cross-priv-sessions",
        type: "agent",
        visibility: "private",
        managerId: otherMember.memberId,
      });

      const res = await adminReq("GET", `/api/v1/agents/${privateAgent.uuid}/sessions`);
      expect(res.statusCode).toBe(200);
    });

    it("admin can read client-status of a private agent managed by another member", async () => {
      const app = getApp();
      const { req: adminReq } = await authedRequest(app);
      const otherMemberBundle = await authedRequest(app);
      const otherMember = await createMemberAndLogin(app, otherMemberBundle);

      const privateAgent = await seedAgent(app, {
        name: "admin-cross-priv-status",
        type: "agent",
        visibility: "private",
        managerId: otherMember.memberId,
      });

      const res = await adminReq("GET", `/api/v1/agents/${privateAgent.uuid}/client-status`);
      expect(res.statusCode).toBe(200);
    });
  });

  describe("managerId authorization for PATCH", () => {
    it("member can update their own agent", async () => {
      const app = getApp();
      const adminBundle = await authedRequest(app);
      const member = await createMemberAndLogin(app, adminBundle);

      const myAgent = await seedAgent(app, {
        name: "patch-my",
        type: "agent",
        visibility: "private",
        managerId: member.memberId,
      });

      const res = await member.req("PATCH", `/api/v1/agents/${myAgent.uuid}`, {
        displayName: "Updated",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().displayName).toBe("Updated");
    });

    it("member cannot update another member's agent", async () => {
      const app = getApp();
      const adminBundle = await authedRequest(app);
      const member = await createMemberAndLogin(app, adminBundle);

      const otherAgent = await seedAgent(app, {
        name: "patch-other",
        type: "agent",
      });

      const res = await member.req("PATCH", `/api/v1/agents/${otherAgent.uuid}`, {
        displayName: "Hacked",
      });
      expect(res.statusCode).toBe(404);
    });

    it("admin can update any agent", async () => {
      const app = getApp();
      const { req: adminReq } = await authedRequest(app);

      const agent = await seedAgent(app, {
        name: "patch-admin",
        type: "agent",
      });

      const res = await adminReq("PATCH", `/api/v1/agents/${agent.uuid}`, {
        displayName: "Admin Updated",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().displayName).toBe("Admin Updated");
    });
  });

  describe("assertAllAgentsVisibleInOrg admin short-circuit (chat-create)", () => {
    // Visibility (can see) and ownership (can use) are intentionally two
    // layers. The admin short-circuit only opens the visibility gate so the
    // chat-create error is the precise owner-exclusive 403 from
    // me-chat.ts:645 (RFC §4.4.2/§4.5) instead of a misleading 404 — admins
    // can already list the row via `/agents/all`, so 404 here would be
    // false enumeration defense, not real defense.
    it("admin sees the precise owner-exclusive 403 (not visibility 404) when including another member's private agent", async () => {
      const app = getApp();
      const adminBundle = await authedRequest(app);
      const otherMember = await createMemberAndLogin(app, adminBundle);

      const privateAgent = await seedAgent(app, {
        name: "admin-cross-priv-chat",
        type: "agent",
        visibility: "private",
        managerId: otherMember.memberId,
      });

      const res = await adminBundle.req("POST", `/api/v1/orgs/${adminBundle.admin.organizationId}/chats`, {
        participantIds: [privateAgent.uuid],
      });
      expect(res.statusCode).toBe(403);
    });

    it("non-admin member still gets the visibility 404 — the agent is invisible to them", async () => {
      const app = getApp();
      const adminBundle = await authedRequest(app);
      const memberA = await createMemberAndLogin(app, adminBundle);
      const memberB = await createMemberAndLogin(app, adminBundle);

      const privateAgent = await seedAgent(app, {
        name: "non-admin-cross-priv-chat",
        type: "agent",
        visibility: "private",
        managerId: memberA.memberId,
      });

      const res = await memberB.req("POST", `/api/v1/orgs/${adminBundle.admin.organizationId}/chats`, {
        participantIds: [privateAgent.uuid],
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("visibility update via PATCH", () => {
    it("can change visibility from private to organization", async () => {
      const app = getApp();
      const { req: adminReq } = await authedRequest(app);

      const agent = await seedAgent(app, { name: "vis-change", type: "agent", visibility: "private" });
      expect(agent.visibility).toBe("private");

      const res = await adminReq("PATCH", `/api/v1/agents/${agent.uuid}`, {
        visibility: "organization",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().visibility).toBe("organization");
    });
  });
});

describe("Chat Access Control", () => {
  const getApp = useTestApp();

  beforeEach(async () => {
    fallback = await createAdminContext(getApp(), {
      username: `chat-fb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });
  });

  describe("GET /admin/chats/mine — member-scoped grouped listing", () => {
    it("returns chats grouped by agent for the member", async () => {
      const app = getApp();
      const adminBundle = await authedRequest(app);
      const member = await createMemberAndLogin(app, adminBundle);

      // Create a personal assistant managed by member
      const assistant = await seedAgent(app, {
        name: "chat-pa",
        type: "agent",
        visibility: "private",
        managerId: member.memberId,
      });

      // Create a chat between member's human agent and assistant
      await createChat(app.db, member.agentId, {
        type: "group",
        participantIds: [assistant.uuid],
      });

      const res = await member.req("GET", `/api/v1/orgs/${adminBundle.admin.organizationId}/chats?scope=grouped`);
      expect(res.statusCode).toBe(200);
      const body = res.json<Array<{ agent: { uuid: string }; chats: Array<{ id: string }> }>>();

      // Should have at least one agent group with chats
      expect(body.length).toBeGreaterThanOrEqual(1);
      const agentUuids = body.map((g) => g.agent.uuid);
      // Should include the member's human agent or the assistant
      expect(agentUuids.some((id) => id === member.agentId || id === assistant.uuid)).toBe(true);
    });

    it("does not return chats from other members' agents", async () => {
      const app = getApp();
      const adminBundle = await authedRequest(app);
      const memberA = await createMemberAndLogin(app, adminBundle);
      const memberB = await createMemberAndLogin(app, adminBundle);

      // Create agents for A and B
      const assistantA = await seedAgent(app, {
        name: "chat-a-pa",
        type: "agent",
        visibility: "private",
        managerId: memberA.memberId,
      });
      const assistantB = await seedAgent(app, {
        name: "chat-b-pa",
        type: "agent",
        visibility: "private",
        managerId: memberB.memberId,
      });

      // Create a chat for A
      const chatA = await createChat(app.db, memberA.agentId, {
        type: "group",
        participantIds: [assistantA.uuid],
      });

      // Create a chat for B
      await createChat(app.db, memberB.agentId, {
        type: "group",
        participantIds: [assistantB.uuid],
      });

      // B should NOT see A's chat
      const res = await memberB.req("GET", `/api/v1/orgs/${adminBundle.admin.organizationId}/chats?scope=grouped`);
      expect(res.statusCode).toBe(200);
      const body = res.json<Array<{ agent: { uuid: string }; chats: Array<{ id: string }> }>>();
      const allChatIds = body.flatMap((g) => g.chats.map((c) => c.id));
      expect(allChatIds).not.toContain(chatA.id);
    });
  });

  describe("POST /chats/:chatId/workspace-join — manager joins chat", () => {
    // The v1 supervision-check route `POST /chats/:chatId/join` was removed
    // along with its `joinChat` service. In v2 the manager's relationship to
    // the chat is materialised as a watcher row by `recomputeChatWatchers`
    // (run on every speaker write via `addChatParticipants`), and the
    // `/workspace-join` route gates on "you're already a watcher".
    it("manager can join a chat of their managed agent (watcher → speaker)", async () => {
      const app = getApp();
      const adminBundle = await authedRequest(app);
      const member = await createMemberAndLogin(app, adminBundle);

      // Create two agents managed by member
      const agentA = await seedAgent(app, {
        name: "join-a",
        type: "agent",
        visibility: "private",
        managerId: member.memberId,
      });
      const agentB = await seedAgent(app, {
        name: "join-b",
        type: "agent",
        visibility: "private",
        managerId: member.memberId,
      });

      // Create a chat between the two agents (not including human agent).
      // `createChat` → `addChatParticipants` already recomputes watchers, so
      // the member's human agent lands as a watcher row immediately and
      // `/workspace-join` will accept the promotion.
      const chat = await createChat(app.db, agentA.uuid, {
        type: "group",
        participantIds: [agentB.uuid],
      });

      // Member joins the chat.
      const res = await member.req("POST", `/api/v1/chats/${chat.id}/workspace-join`);
      expect(res.statusCode).toBe(204);

      // Verify the human agent is now a speaker in the chat.
      const { chatMembership } = await import("../db/schema/chat-membership.js");
      const { and: andOp, eq: eqOp } = await import("drizzle-orm");
      const [row] = await app.db
        .select({ accessMode: chatMembership.accessMode })
        .from(chatMembership)
        .where(andOp(eqOp(chatMembership.chatId, chat.id), eqOp(chatMembership.agentId, member.agentId)))
        .limit(1);
      expect(row?.accessMode).toBe("speaker");
    });

    it("member cannot join a chat they don't supervise", async () => {
      const app = getApp();
      const adminBundle = await authedRequest(app);
      const memberA = await createMemberAndLogin(app, adminBundle);
      const memberB = await createMemberAndLogin(app, adminBundle);

      // Create agents managed by member A
      const agentA = await seedAgent(app, {
        name: "nojoin-a",
        type: "agent",
        visibility: "private",
        managerId: memberA.memberId,
      });
      const agentA2 = await seedAgent(app, {
        name: "nojoin-a2",
        type: "agent",
        visibility: "private",
        managerId: memberA.memberId,
      });

      // Create a chat between A's agents
      const chat = await createChat(app.db, agentA.uuid, {
        type: "group",
        participantIds: [agentA2.uuid],
      });

      // Member B tries to join — refused. memberB has no watcher row for
      // this chat (they manage none of its speakers), so requireChatAccess
      // returns 404 (probing-protection) before `joinMeChat` is even called.
      const res = await memberB.req("POST", `/api/v1/chats/${chat.id}/workspace-join`);
      expect(res.statusCode).toBe(404);
    });
  });

  describe("POST /admin/chats/:chatId/leave — manager leaves chat", () => {
    it("manager can leave a chat they joined", async () => {
      const app = getApp();
      const adminBundle = await authedRequest(app);
      const member = await createMemberAndLogin(app, adminBundle);

      const assistant = await seedAgent(app, {
        name: "leave-pa",
        type: "agent",
        visibility: "private",
        managerId: member.memberId,
      });

      // Create chat with human agent as participant
      const chat = await createChat(app.db, member.agentId, {
        type: "group",
        participantIds: [assistant.uuid],
      });

      // Member leaves
      const res = await member.req("POST", `/api/v1/chats/${chat.id}/leave`);
      expect(res.statusCode).toBe(200);
      const body = res.json<{ participants: Array<{ agentId: string }> }>();
      const participantIds = body.participants.map((p) => p.agentId);
      expect(participantIds).not.toContain(member.agentId);
    });

    it("returns 404 if not a participant", async () => {
      const app = getApp();
      const adminBundle = await authedRequest(app);
      const memberA = await createMemberAndLogin(app, adminBundle);
      const memberB = await createMemberAndLogin(app, adminBundle);

      const assistant = await seedAgent(app, {
        name: "leave-other-pa",
        type: "agent",
        visibility: "private",
        managerId: memberA.memberId,
      });

      const chat = await createChat(app.db, memberA.agentId, {
        type: "group",
        participantIds: [assistant.uuid],
      });

      // B is not a participant — leave should fail
      const res = await memberB.req("POST", `/api/v1/chats/${chat.id}/leave`);
      expect(res.statusCode).toBe(404);
    });
  });

  describe("GET /:chatId — access control", () => {
    it("non-participant member cannot read chat detail", async () => {
      const app = getApp();
      const adminBundle = await authedRequest(app);
      const memberA = await createMemberAndLogin(app, adminBundle);
      const memberB = await createMemberAndLogin(app, adminBundle);

      const assistant = await seedAgent(app, {
        name: "detail-pa",
        type: "agent",
        visibility: "private",
        managerId: memberA.memberId,
      });

      const chat = await createChat(app.db, memberA.agentId, {
        type: "group",
        participantIds: [assistant.uuid],
      });

      const res = await memberB.req("GET", `/api/v1/chats/${chat.id}`);
      expect(res.statusCode).toBe(404);
    });
  });

  describe("GET /:chatId/messages — access control", () => {
    it("non-participant member cannot read messages", async () => {
      const app = getApp();
      const adminBundle = await authedRequest(app);
      const memberA = await createMemberAndLogin(app, adminBundle);
      const memberB = await createMemberAndLogin(app, adminBundle);

      const assistant = await seedAgent(app, {
        name: "msg-pa",
        type: "agent",
        visibility: "private",
        managerId: memberA.memberId,
      });

      const chat = await createChat(app.db, memberA.agentId, {
        type: "group",
        participantIds: [assistant.uuid],
      });

      const res = await memberB.req("GET", `/api/v1/chats/${chat.id}/messages`);
      expect(res.statusCode).toBe(404);
    });
  });

  describe("POST /:chatId/messages — access control", () => {
    it("non-participant member cannot send messages", async () => {
      const app = getApp();
      const adminBundle = await authedRequest(app);
      const memberA = await createMemberAndLogin(app, adminBundle);
      const memberB = await createMemberAndLogin(app, adminBundle);

      const assistant = await seedAgent(app, {
        name: "send-pa",
        type: "agent",
        visibility: "private",
        managerId: memberA.memberId,
      });

      const chat = await createChat(app.db, memberA.agentId, {
        type: "group",
        participantIds: [assistant.uuid],
      });

      const res = await memberB.req("POST", `/api/v1/chats/${chat.id}/messages`, {
        format: "text",
        content: "should fail",
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("DELETE /:uuid — managerId authorization", () => {
    it("non-manager member cannot delete agent", async () => {
      const app = getApp();
      const adminBundle = await authedRequest(app);
      const member = await createMemberAndLogin(app, adminBundle);

      const agent = await seedAgent(app, {
        name: "del-other",
        type: "agent",
      });

      // Suspend first (required before delete)
      await adminBundle.req("POST", `/api/v1/agents/${agent.uuid}/suspend`);

      const res = await member.req("DELETE", `/api/v1/agents/${agent.uuid}`);
      expect(res.statusCode).toBe(404);
    });
  });

  describe("GET /orgs/:orgId/chats?scope=all — admin-only", () => {
    it("non-admin member cannot list all chats", async () => {
      const app = getApp();
      const bundle = await authedRequest(app);
      const member = await createMemberAndLogin(app, bundle);

      const res = await member.req("GET", `/api/v1/orgs/${bundle.admin.organizationId}/chats?scope=all`);
      expect(res.statusCode).toBe(403);
    });

    it("admin can list all chats", async () => {
      const app = getApp();
      const { req: adminReq, admin } = await authedRequest(app);

      const res = await adminReq("GET", `/api/v1/orgs/${admin.organizationId}/chats?scope=all`);
      expect(res.statusCode).toBe(200);
    });
  });
});
