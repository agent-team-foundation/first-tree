import {
  MESSAGE_FORMATS,
  parseLandingCampaignTrialAgentMetadata,
  parseLandingCampaignTrialChatMetadata,
} from "@first-tree/shared";
import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agentResourceBindings } from "../db/schema/agent-resource-bindings.js";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chats } from "../db/schema/chats.js";
import { clients } from "../db/schema/clients.js";
import { members } from "../db/schema/members.js";
import { messages } from "../db/schema/messages.js";
import { resources } from "../db/schema/resources.js";
import { users } from "../db/schema/users.js";
import { signTokensForUser } from "../services/auth.js";
import { sendMessage } from "../services/message.js";
import { agentRequest, createTestAdmin, INVALID_BCRYPT_PLACEHOLDER, useTestApp } from "./helpers.js";

const SERVICE_USER_ID = "landing-campaign-service-user-test";
const OFFICIAL_CLIENT_ID = "landing-campaign-client-test";
const START_URL = "/api/v1/me/landing-campaigns/start";

async function seedOfficialRuntime(
  app: ReturnType<ReturnType<typeof useTestApp>>,
  organizationId: string,
): Promise<void> {
  await app.db
    .insert(users)
    .values({
      id: SERVICE_USER_ID,
      username: "first-tree-landing-service-test",
      displayName: "First Tree",
      passwordHash: INVALID_BCRYPT_PLACEHOLDER,
    })
    .onConflictDoUpdate({
      target: users.id,
      set: { displayName: "First Tree" },
    });
  await app.db
    .insert(clients)
    .values({
      id: OFFICIAL_CLIENT_ID,
      userId: SERVICE_USER_ID,
      organizationId,
      status: "connected",
      hostname: "landing-campaign-host",
    })
    .onConflictDoUpdate({
      target: clients.id,
      set: { userId: SERVICE_USER_ID, organizationId, status: "connected", hostname: "landing-campaign-host" },
    });
}

async function startProductionScan(
  app: ReturnType<ReturnType<typeof useTestApp>>,
  admin: Awaited<ReturnType<typeof createTestAdmin>>,
  repoUrl = "https://github.com/acme/backend",
) {
  return app.inject({
    method: "POST",
    url: START_URL,
    headers: { authorization: `Bearer ${admin.accessToken}` },
    payload: { organizationId: admin.organizationId, campaign: "production-scan", repoUrl },
  });
}

async function createRunnableOrgAgent(
  app: ReturnType<ReturnType<typeof useTestApp>>,
  admin: Awaited<ReturnType<typeof createTestAdmin>>,
  name: string,
): Promise<{ uuid: string }> {
  const clientId = `${name}-client`;
  await app.db.insert(clients).values({
    id: clientId,
    userId: admin.userId,
    organizationId: admin.organizationId,
    status: "connected",
  });
  const created = await app.inject({
    method: "POST",
    url: `/api/v1/orgs/${admin.organizationId}/agents`,
    headers: { authorization: `Bearer ${admin.accessToken}` },
    payload: {
      type: "agent",
      name,
      displayName: name,
      clientId,
    },
  });
  if (created.statusCode !== 201) {
    throw new Error(`failed to create runnable agent: ${created.statusCode} ${created.body}`);
  }
  return created.json<{ uuid: string }>();
}

async function createLandingCampaignServiceAccessToken(
  app: ReturnType<ReturnType<typeof useTestApp>>,
): Promise<string> {
  const tokens = await signTokensForUser(app.config.secrets.jwtSecret, SERVICE_USER_ID, app.config.auth);
  return tokens.accessToken;
}

describe("POST /me/landing-campaigns/start", () => {
  const getApp = useTestApp({
    growthLandingPagesEnabled: true,
    landingCampaignServiceUserId: SERVICE_USER_ID,
    landingCampaignClientId: OFFICIAL_CLIENT_ID,
  });
  const getDisabledApp = useTestApp({
    landingCampaignServiceUserId: SERVICE_USER_ID,
    landingCampaignClientId: OFFICIAL_CLIENT_ID,
  });

  it("feature flag off rejects before creating service member, trial agent, chat, or resource", async () => {
    const app = getDisabledApp();
    const admin = await createTestAdmin(app);

    const res = await startProductionScan(app, admin);

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "feature_disabled" });
    const serviceMembers = await app.db
      .select()
      .from(members)
      .where(and(eq(members.userId, SERVICE_USER_ID), eq(members.organizationId, admin.organizationId)));
    expect(serviceMembers).toHaveLength(0);
    const trialAgents = await app.db
      .select()
      .from(agents)
      .where(
        and(
          eq(agents.organizationId, admin.organizationId),
          sql`${agents.metadata} ->> 'landingCampaignTrial' = 'true'`,
        ),
      );
    expect(trialAgents).toHaveLength(0);
  });

  it("creates the service-managed trial agent, installs the agent-scoped campaign skill, and starts a locked chat", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    await seedOfficialRuntime(app, admin.organizationId);

    const res = await startProductionScan(app, admin);

    expect(res.statusCode).toBe(200);
    const body = res.json<{ chatId: string; agentUuid: string; campaign: string; repoCanonicalKey: string }>();
    expect(body).toMatchObject({
      campaign: "production-scan",
      repoCanonicalKey: "github.com/acme/backend",
    });

    const [trialAgent] = await app.db.select().from(agents).where(eq(agents.uuid, body.agentUuid)).limit(1);
    expect(trialAgent?.managerId).toBeTruthy();
    expect(trialAgent?.clientId).toBe(OFFICIAL_CLIENT_ID);
    expect(trialAgent?.runtimeProvider).toBe("codex");
    expect(trialAgent?.visibility).toBe("organization");
    const agentMeta = parseLandingCampaignTrialAgentMetadata(trialAgent?.metadata);
    expect(agentMeta).toMatchObject({
      landingCampaignTrial: true,
      campaign: "production-scan",
      skillSetId: "production-scan",
      repo: { canonicalKey: "github.com/acme/backend" },
    });

    const [serviceMember] = await app.db
      .select()
      .from(members)
      .where(eq(members.id, trialAgent?.managerId ?? ""));
    expect(serviceMember).toMatchObject({
      userId: SERVICE_USER_ID,
      organizationId: admin.organizationId,
      role: "member",
      status: "active",
    });

    const [skill] = await app.db
      .select()
      .from(resources)
      .where(and(eq(resources.ownerAgentId, body.agentUuid), eq(resources.type, "skill"), eq(resources.scope, "agent")))
      .limit(1);
    expect(skill?.name).toBe("production-scan");
    expect(skill?.defaultEnabled).toBeNull();
    expect(skill?.payload).toMatchObject({ name: "production-scan" });
    expect(JSON.stringify(skill?.payload)).toContain("/onboarding");
    expect(JSON.stringify(skill?.payload)).not.toContain("{{FIRST_TREE_SETUP_URL}}");
    const bindings = await app.db
      .select()
      .from(agentResourceBindings)
      .where(
        and(eq(agentResourceBindings.agentId, body.agentUuid), eq(agentResourceBindings.resourceId, skill?.id ?? "")),
      );
    expect(bindings).toHaveLength(1);

    const [chat] = await app.db.select().from(chats).where(eq(chats.id, body.chatId)).limit(1);
    expect(chat?.topic).toBe("Production readiness scan");
    expect(chat?.onboardingKickoffKey).toContain("landing-campaign:");
    expect(chat?.onboardingKickoffKey).toContain("github.com/acme/backend");
    const chatMeta = parseLandingCampaignTrialChatMetadata(chat?.metadata);
    expect(chatMeta).toMatchObject({
      campaign: "production-scan",
      agentId: body.agentUuid,
      repo: { canonicalKey: "github.com/acme/backend" },
      state: "running",
      inputLocked: true,
    });

    const [bootstrap] = await app.db.select().from(messages).where(eq(messages.chatId, body.chatId)).limit(1);
    expect(bootstrap?.senderId).toBe(admin.humanAgentUuid);
    expect(bootstrap?.content).toContain("https://github.com/acme/backend");
    expect(bootstrap?.metadata).toMatchObject({
      systemSender: "first_tree_onboarding",
      campaign: "production-scan",
      landingCampaignTrial: true,
    });
  });

  it("requires org admin before installing the service member or trial agent", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const member = await createTestAdmin(app);
    await app.db.update(members).set({ role: "member" }).where(eq(members.id, member.memberId));
    await seedOfficialRuntime(app, admin.organizationId);

    const res = await startProductionScan(app, member);

    expect(res.statusCode).toBe(403);
    const serviceMembers = await app.db
      .select()
      .from(members)
      .where(and(eq(members.userId, SERVICE_USER_ID), eq(members.organizationId, admin.organizationId)));
    expect(serviceMembers).toHaveLength(0);
    const trialAgents = await app.db
      .select()
      .from(agents)
      .where(
        and(
          eq(agents.organizationId, admin.organizationId),
          sql`${agents.metadata} ->> 'landingCampaignTrial' = 'true'`,
        ),
      );
    expect(trialAgents).toHaveLength(0);
  });

  it("is idempotent for the same campaign and repo, but creates a new chat when the repo changes", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    await seedOfficialRuntime(app, admin.organizationId);

    const first = await startProductionScan(app, admin);
    const second = await startProductionScan(app, admin);
    const third = await startProductionScan(app, admin, "https://github.com/acme/api");

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(third.statusCode).toBe(200);
    const firstBody = first.json<{ chatId: string; agentUuid: string }>();
    const secondBody = second.json<{ chatId: string; agentUuid: string }>();
    const thirdBody = third.json<{ chatId: string; agentUuid: string; repoCanonicalKey: string }>();
    expect(secondBody.chatId).toBe(firstBody.chatId);
    expect(secondBody.agentUuid).toBe(firstBody.agentUuid);
    expect(thirdBody.agentUuid).toBe(firstBody.agentUuid);
    expect(thirdBody.chatId).not.toBe(firstBody.chatId);
    expect(thirdBody.repoCanonicalKey).toBe("github.com/acme/api");

    const firstMessages = await app.db.select().from(messages).where(eq(messages.chatId, firstBody.chatId));
    const thirdMessages = await app.db.select().from(messages).where(eq(messages.chatId, thirdBody.chatId));
    expect(firstMessages).toHaveLength(1);
    expect(thirdMessages).toHaveLength(1);
  });

  it("serializes concurrent starts for the same campaign and repo into one trial agent and chat", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    await seedOfficialRuntime(app, admin.organizationId);

    const [first, second] = await Promise.all([startProductionScan(app, admin), startProductionScan(app, admin)]);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const firstBody = first.json<{ chatId: string; agentUuid: string }>();
    const secondBody = second.json<{ chatId: string; agentUuid: string }>();
    expect(secondBody).toEqual(firstBody);

    const trialAgents = await app.db
      .select()
      .from(agents)
      .where(
        and(
          eq(agents.organizationId, admin.organizationId),
          sql`${agents.metadata} ->> 'landingCampaignTrial' = 'true'`,
          sql`${agents.metadata} ->> 'campaign' = 'production-scan'`,
        ),
      );
    expect(trialAgents).toHaveLength(1);
    const kickoffChats = await app.db
      .select()
      .from(chats)
      .where(sql`${chats.onboardingKickoffKey} LIKE ${`landing-campaign:%github.com/acme/backend`}`);
    expect(kickoffChats).toHaveLength(1);
    const bootstrapMessages = await app.db.select().from(messages).where(eq(messages.chatId, firstBody.chatId));
    expect(bootstrapMessages).toHaveLength(1);
  });

  it("does not silently rebind an existing trial agent pinned to a different official client", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    await seedOfficialRuntime(app, admin.organizationId);
    const started = await startProductionScan(app, admin);
    const body = started.json<{ chatId: string; agentUuid: string }>();
    const otherClientId = "landing-campaign-client-other";
    await app.db.insert(clients).values({
      id: otherClientId,
      userId: SERVICE_USER_ID,
      organizationId: admin.organizationId,
      status: "connected",
    });
    await app.db.update(agents).set({ clientId: otherClientId }).where(eq(agents.uuid, body.agentUuid));

    const res = await startProductionScan(app, admin);

    expect(res.statusCode).toBe(409);
    const [trialAgent] = await app.db.select().from(agents).where(eq(agents.uuid, body.agentUuid)).limit(1);
    expect(trialAgent?.clientId).toBe(otherClientId);
    const trialChats = await app.db
      .select()
      .from(chats)
      .where(sql`${chats.onboardingKickoffKey} LIKE ${`landing-campaign:%github.com/acme/backend`}`);
    expect(trialChats).toHaveLength(1);
  });

  it("rejects ordinary user attempts to spoof the official client or trial metadata", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    await seedOfficialRuntime(app, admin.organizationId);

    const officialClient = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${admin.organizationId}/agents`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: {
        type: "agent",
        name: "spoof-client",
        displayName: "Spoof Client",
        clientId: OFFICIAL_CLIENT_ID,
      },
    });
    expect(officialClient.statusCode).toBe(403);

    const metadata = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${admin.organizationId}/agents`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: {
        type: "agent",
        name: "spoof-metadata",
        displayName: "Spoof Metadata",
        metadata: {
          landingCampaignTrial: true,
          campaign: "production-scan",
          skillSetId: "production-scan",
          skillSetVersion: "2026.07.02.1",
          repo: { url: "https://github.com/acme/backend", canonicalKey: "github.com/acme/backend" },
        },
      },
    });
    expect(metadata.statusCode).toBe(403);
  });

  it("blocks ordinary chats and messages from continuing the single-run trial agent", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    await seedOfficialRuntime(app, admin.organizationId);
    const started = await startProductionScan(app, admin);
    const body = started.json<{ chatId: string; agentUuid: string }>();

    const normalAgentChat = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${body.agentUuid}/chats`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(normalAgentChat.statusCode).toBe(403);

    const normalOrgChat = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${admin.organizationId}/chats`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { participantIds: [body.agentUuid] },
    });
    expect(normalOrgChat.statusCode).toBe(403);

    const message = await app.inject({
      method: "POST",
      url: `/api/v1/chats/${body.chatId}/messages`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { format: "text", content: "Can you do another thing?", metadata: { mentions: [body.agentUuid] } },
    });
    expect(message.statusCode).toBe(403);
  });

  it("blocks adding ordinary participants to a landing campaign trial chat", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    await seedOfficialRuntime(app, admin.organizationId);
    const started = await startProductionScan(app, admin);
    const body = started.json<{ chatId: string; agentUuid: string }>();

    const ordinaryAgent = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${admin.organizationId}/agents`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: {
        type: "agent",
        name: "ordinary-agent",
        displayName: "Ordinary Agent",
      },
    });
    expect(ordinaryAgent.statusCode).toBe(201);
    const ordinary = ordinaryAgent.json<{ uuid: string }>();

    const addParticipant = await app.inject({
      method: "POST",
      url: `/api/v1/chats/${body.chatId}/participants`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { participantIds: [ordinary.uuid] },
    });
    expect(addParticipant.statusCode).toBe(403);

    const rows = await app.db
      .select()
      .from(chatMembership)
      .where(and(eq(chatMembership.chatId, body.chatId), eq(chatMembership.agentId, ordinary.uuid)));
    expect(rows).toHaveLength(0);
  });

  it("blocks agent-runtime participant mutation on landing campaign trial chats", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    await seedOfficialRuntime(app, admin.organizationId);
    const started = await startProductionScan(app, admin);
    const body = started.json<{ chatId: string; agentUuid: string }>();
    const ordinary = await createRunnableOrgAgent(app, admin, "ordinary-agent-runtime-target");
    const serviceAccessToken = await createLandingCampaignServiceAccessToken(app);
    const trialAgentRequest = agentRequest(app, serviceAccessToken, body.agentUuid);

    const addParticipant = await trialAgentRequest("POST", `/api/v1/agent/chats/${body.chatId}/participants`, {
      agentId: ordinary.uuid,
    });

    expect(addParticipant.statusCode).toBe(403);
    const rows = await app.db
      .select()
      .from(chatMembership)
      .where(and(eq(chatMembership.chatId, body.chatId), eq(chatMembership.agentId, ordinary.uuid)));
    expect(rows).toHaveLength(0);
  });

  it("blocks agent-runtime participant removal on landing campaign trial chats", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    await seedOfficialRuntime(app, admin.organizationId);
    const started = await startProductionScan(app, admin);
    const body = started.json<{ chatId: string; agentUuid: string }>();
    const serviceAccessToken = await createLandingCampaignServiceAccessToken(app);
    const trialAgentRequest = agentRequest(app, serviceAccessToken, body.agentUuid);

    const removeHuman = await trialAgentRequest(
      "DELETE",
      `/api/v1/agent/chats/${body.chatId}/participants/${admin.humanAgentUuid}`,
    );

    expect(removeHuman.statusCode).toBe(403);
    const rows = await app.db
      .select()
      .from(chatMembership)
      .where(and(eq(chatMembership.chatId, body.chatId), eq(chatMembership.agentId, admin.humanAgentUuid)));
    expect(rows).toHaveLength(1);
  });

  it("blocks trial agents from creating ordinary chats through the agent-runtime API", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    await seedOfficialRuntime(app, admin.organizationId);
    const started = await startProductionScan(app, admin);
    const body = started.json<{ chatId: string; agentUuid: string }>();
    const ordinary = await createRunnableOrgAgent(app, admin, "ordinary-agent-runtime-chat");
    const serviceAccessToken = await createLandingCampaignServiceAccessToken(app);
    const trialAgentRequest = agentRequest(app, serviceAccessToken, body.agentUuid);

    const legacyCreate = await trialAgentRequest("POST", "/api/v1/agent/chats", {
      type: "group",
      participantIds: [ordinary.uuid],
    });
    expect(legacyCreate.statusCode).toBe(403);

    const taskCreate = await trialAgentRequest("POST", "/api/v1/agent/chats", {
      mode: "task",
      initialRecipientAgentIds: [ordinary.uuid],
      initialRecipientNames: [],
      contextParticipantAgentIds: [],
      contextParticipantNames: [],
      initialMessage: { source: "cli", format: "text", content: "Please continue this trial." },
    });
    expect(taskCreate.statusCode).toBe(403);
  });

  it("blocks ordinary agents from pulling trial agents into ordinary chats through the agent-runtime API", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    await seedOfficialRuntime(app, admin.organizationId);
    const started = await startProductionScan(app, admin);
    const body = started.json<{ agentUuid: string }>();
    const ordinary = await createRunnableOrgAgent(app, admin, "ordinary-agent-pulls-trial");
    const ordinaryAgentRequest = agentRequest(app, admin.accessToken, ordinary.uuid);

    const createWithTrial = await ordinaryAgentRequest("POST", "/api/v1/agent/chats", {
      type: "group",
      participantIds: [body.agentUuid],
    });
    expect(createWithTrial.statusCode).toBe(403);

    const ordinaryChat = await ordinaryAgentRequest("POST", "/api/v1/agent/chats", {
      type: "group",
      participantIds: [admin.humanAgentUuid],
    });
    expect(ordinaryChat.statusCode).toBe(201);
    const ordinaryChatBody = ordinaryChat.json<{ id: string }>();

    const addTrial = await ordinaryAgentRequest("POST", `/api/v1/agent/chats/${ordinaryChatBody.id}/participants`, {
      agentId: body.agentUuid,
    });
    expect(addTrial.statusCode).toBe(403);
  });

  it("does not expose trial agents as ordinary addressable, default, or usable agents", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    await seedOfficialRuntime(app, admin.organizationId);
    const started = await startProductionScan(app, admin);
    const body = started.json<{ agentUuid: string }>();

    const addressable = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${admin.organizationId}/agents?limit=100&addressableOnly=true`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(addressable.statusCode).toBe(200);
    expect(
      addressable.json<{ items: Array<{ uuid: string }> }>().items.some((agent) => agent.uuid === body.agentUuid),
    ).toBe(false);

    const defaults = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${admin.organizationId}/agents/new-chat-default-candidates`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: {},
    });
    expect(defaults.statusCode).toBe(200);
    expect(defaults.json<{ agent: { uuid: string } | null }>().agent?.uuid).not.toBe(body.agentUuid);

    const me = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(me.statusCode).toBe(200);
    const membership = me
      .json<{ memberships: Array<{ organizationId: string; hasUsableAgent: boolean; hasPersonalAgent: boolean }> }>()
      .memberships.find((row) => row.organizationId === admin.organizationId);
    expect(membership?.hasUsableAgent).toBe(false);
    expect(membership?.hasPersonalAgent).toBe(false);
  });

  it("moves the trial chat through awaiting_user, running, and completed as asks are answered", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    await seedOfficialRuntime(app, admin.organizationId);
    const started = await startProductionScan(app, admin);
    const body = started.json<{ chatId: string; agentUuid: string }>();

    const ask = await sendMessage(app.db, body.chatId, body.agentUuid, {
      format: MESSAGE_FORMATS.REQUEST,
      content: "Choose a scan focus.",
      source: "api",
      metadata: { mentions: [admin.humanAgentUuid] },
    });
    const [awaitingChat] = await app.db.select().from(chats).where(eq(chats.id, body.chatId)).limit(1);
    expect(parseLandingCampaignTrialChatMetadata(awaitingChat?.metadata)).toMatchObject({
      state: "awaiting_user",
      inputLocked: false,
    });

    const answer = await app.inject({
      method: "POST",
      url: `/api/v1/chats/${body.chatId}/messages`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: {
        format: "text",
        content: "Focus on deploy risk.",
        metadata: {
          mentions: [body.agentUuid],
          resolves: { request: ask.message.id, kind: "answered" },
        },
      },
    });
    expect(answer.statusCode).toBe(201);
    const [runningChat] = await app.db.select().from(chats).where(eq(chats.id, body.chatId)).limit(1);
    expect(parseLandingCampaignTrialChatMetadata(runningChat?.metadata)).toMatchObject({
      state: "running",
      inputLocked: true,
    });

    await sendMessage(app.db, body.chatId, body.agentUuid, {
      format: "text",
      content: "Here is the final report.",
      source: "api",
      metadata: { mentions: [admin.humanAgentUuid] },
    });
    const [completedChat] = await app.db.select().from(chats).where(eq(chats.id, body.chatId)).limit(1);
    expect(parseLandingCampaignTrialChatMetadata(completedChat?.metadata)).toMatchObject({
      state: "completed",
      inputLocked: true,
    });
  });

  it("hides the service member and official client from ordinary org lists", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    await seedOfficialRuntime(app, admin.organizationId);
    await startProductionScan(app, admin);

    const membersRes = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${admin.organizationId}/members`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(membersRes.statusCode).toBe(200);
    expect(membersRes.json<Array<{ userId: string }>>().some((row) => row.userId === SERVICE_USER_ID)).toBe(false);

    const clientsRes = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${admin.organizationId}/clients`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(clientsRes.statusCode).toBe(200);
    expect(clientsRes.json<Array<{ id: string }>>().some((row) => row.id === OFFICIAL_CLIENT_ID)).toBe(false);

    const meRes = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(meRes.statusCode).toBe(200);
    const currentOrg = meRes
      .json<{ memberships: Array<{ organizationId: string; orgHasOtherMembers: boolean }> }>()
      .memberships.find((row) => row.organizationId === admin.organizationId);
    expect(currentOrg?.orgHasOtherMembers).toBe(false);
  });

  it("prevents deleting the service member and editing the trial agent through ordinary management APIs", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    await seedOfficialRuntime(app, admin.organizationId);
    const started = await startProductionScan(app, admin);
    const body = started.json<{ agentUuid: string }>();
    const [trialAgent] = await app.db.select().from(agents).where(eq(agents.uuid, body.agentUuid)).limit(1);
    if (!trialAgent?.managerId) throw new Error("trial agent manager missing");

    const deleteMember = await app.inject({
      method: "DELETE",
      url: `/api/v1/orgs/${admin.organizationId}/members/${trialAgent.managerId}`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(deleteMember.statusCode).toBe(403);

    const patchAgent = await app.inject({
      method: "PATCH",
      url: `/api/v1/agents/${body.agentUuid}`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { displayName: "Renamed" },
    });
    expect(patchAgent.statusCode).toBe(403);

    const patchResources = await app.inject({
      method: "PATCH",
      url: `/api/v1/agents/${body.agentUuid}/resources`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { resources: [] },
    });
    expect(patchResources.statusCode).toBe(403);
  });
});
