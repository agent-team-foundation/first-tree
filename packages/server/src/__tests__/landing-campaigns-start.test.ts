import {
  MESSAGE_FORMATS,
  parseLandingCampaignTrialAgentMetadata,
  parseLandingCampaignTrialChatMetadata,
} from "@first-tree/shared";
import { and, asc, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agentChatSessions } from "../db/schema/agent-chat-sessions.js";
import { agentConfigs } from "../db/schema/agent-configs.js";
import { agentResourceBindings } from "../db/schema/agent-resource-bindings.js";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chats } from "../db/schema/chats.js";
import { clients } from "../db/schema/clients.js";
import { members } from "../db/schema/members.js";
import { messages } from "../db/schema/messages.js";
import { organizations } from "../db/schema/organizations.js";
import { resources } from "../db/schema/resources.js";
import { users } from "../db/schema/users.js";
import { createAgent } from "../services/agent.js";
import { bindAgentRuntimeSession, validateAgentRuntimeSession } from "../services/agent-runtime-session.js";
import { signTokensForUser } from "../services/auth.js";
import { completeLandingCampaignTrialAgentTurn } from "../services/landing-campaigns/chat-state.js";
import {
  LANDING_CAMPAIGN_TRIAL_PROMPT,
  LANDING_CAMPAIGN_TRIAL_PROMPT_RESOURCE_NAME,
} from "../services/landing-campaigns/trial-prompt.js";
import { createMember } from "../services/member.js";
import { sendMessage } from "../services/message.js";
import * as sessionEventService from "../services/session-event.js";
import { uuidv7 } from "../uuid.js";
import { agentRequest, createTestAdmin, INVALID_BCRYPT_PLACEHOLDER, useTestApp } from "./helpers.js";

const SERVICE_USER_ID = "landing-campaign-service-user-test";
const SERVICE_ORG_ID = "landing-campaign-service-org-test";
const OFFICIAL_CLIENT_ID = "landing-campaign-client-test";
const START_URL = "/api/v1/me/landing-campaigns/start";

async function seedOfficialRuntime(
  app: ReturnType<ReturnType<typeof useTestApp>>,
  _organizationId: string,
): Promise<void> {
  const serviceOrgId = app.config.growth.landingCampaigns?.serviceOrgId ?? SERVICE_ORG_ID;
  await app.db
    .insert(organizations)
    .values({
      id: serviceOrgId,
      name: `landing-campaign-service-${serviceOrgId.slice(-8)}`,
      displayName: "Landing Campaign Service",
    })
    .onConflictDoNothing();
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
      organizationId: serviceOrgId,
      status: "connected",
      hostname: "landing-campaign-host",
    })
    .onConflictDoUpdate({
      target: clients.id,
      set: {
        userId: SERVICE_USER_ID,
        organizationId: serviceOrgId,
        status: "connected",
        hostname: "landing-campaign-host",
      },
    });
}

async function attachOrg(
  app: ReturnType<ReturnType<typeof useTestApp>>,
  userId: string,
  role: "admin" | "member",
): Promise<{ orgId: string; memberId: string; humanAgentId: string }> {
  const orgId = `org-lc-${crypto.randomUUID().slice(0, 8)}`;
  const memberId = uuidv7();
  let humanAgentId = "";
  await app.db.transaction(async (tx) => {
    await tx
      .insert(organizations)
      .values({ id: orgId, name: `lc-${crypto.randomUUID().slice(0, 6)}`, displayName: "Landing Side" });
    const human = await createAgent(tx as unknown as typeof app.db, {
      name: `lc-h-${crypto.randomUUID().slice(0, 6)}`,
      type: "human",
      displayName: "Landing Side Human",
      managerId: memberId,
      organizationId: orgId,
    });
    humanAgentId = human.uuid;
    await tx.insert(members).values({ id: memberId, userId, organizationId: orgId, agentId: human.uuid, role });
  });
  return { orgId, memberId, humanAgentId };
}

async function startProductionScan(
  app: ReturnType<ReturnType<typeof useTestApp>>,
  admin: Awaited<ReturnType<typeof createTestAdmin>>,
  repoUrl = "https://github.com/acme/backend",
) {
  return startCampaign(app, admin, "production-scan", repoUrl);
}

async function startProductionScanInOrg(
  app: ReturnType<ReturnType<typeof useTestApp>>,
  admin: Awaited<ReturnType<typeof createTestAdmin>>,
  organizationId: string,
  repoUrl = "https://github.com/acme/backend",
) {
  return startCampaignInOrg(app, admin, organizationId, "production-scan", repoUrl);
}

async function startCampaign(
  app: ReturnType<ReturnType<typeof useTestApp>>,
  admin: Awaited<ReturnType<typeof createTestAdmin>>,
  campaign: string,
  repoUrl = "https://github.com/acme/backend",
) {
  return startCampaignInOrg(app, admin, admin.organizationId, campaign, repoUrl);
}

async function startCampaignInOrg(
  app: ReturnType<ReturnType<typeof useTestApp>>,
  admin: Awaited<ReturnType<typeof createTestAdmin>>,
  organizationId: string,
  campaign: string,
  repoUrl = "https://github.com/acme/backend",
) {
  return app.inject({
    method: "POST",
    url: START_URL,
    headers: { authorization: `Bearer ${admin.accessToken}` },
    payload: { organizationId, campaign, repoUrl },
  });
}

async function startCampaignWithoutOrganization(
  app: ReturnType<ReturnType<typeof useTestApp>>,
  admin: Awaited<ReturnType<typeof createTestAdmin>>,
  campaign = "production-scan",
  repoUrl = "https://github.com/acme/backend",
) {
  return app.inject({
    method: "POST",
    url: START_URL,
    headers: { authorization: `Bearer ${admin.accessToken}` },
    payload: { campaign, repoUrl },
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

async function countTrialChatsForUser(app: ReturnType<ReturnType<typeof useTestApp>>, userId: string): Promise<number> {
  const [row] = await app.db
    .select({ count: sql<number>`count(DISTINCT ${chats.id})::int` })
    .from(chats)
    .innerJoin(
      chatMembership,
      and(
        eq(chatMembership.chatId, chats.id),
        eq(chatMembership.role, "owner"),
        eq(chatMembership.accessMode, "speaker"),
      ),
    )
    .innerJoin(members, eq(members.agentId, chatMembership.agentId))
    .where(and(eq(members.userId, userId), sql`${chats.metadata} ? 'landingCampaignTrial'`));
  return row?.count ?? 0;
}

describe("POST /me/landing-campaigns/start", () => {
  const getApp = useTestApp({
    growthLandingPagesEnabled: true,
    landingCampaignServiceUserId: SERVICE_USER_ID,
    landingCampaignServiceOrgId: SERVICE_ORG_ID,
    landingCampaignClientId: OFFICIAL_CLIENT_ID,
  });
  const getDisabledApp = useTestApp({
    landingCampaignServiceUserId: SERVICE_USER_ID,
    landingCampaignServiceOrgId: SERVICE_ORG_ID,
    landingCampaignClientId: OFFICIAL_CLIENT_ID,
  });
  const getUnconfiguredApp = useTestApp({
    growthLandingPagesEnabled: true,
  });
  const getClaudeProviderApp = useTestApp({
    growthLandingPagesEnabled: true,
    landingCampaignServiceUserId: SERVICE_USER_ID,
    landingCampaignServiceOrgId: SERVICE_ORG_ID,
    landingCampaignClientId: OFFICIAL_CLIENT_ID,
    landingCampaignRuntimeProvider: "claude-code",
  });
  const getMultiTurnApp = useTestApp({
    growthLandingPagesEnabled: true,
    landingCampaignServiceUserId: SERVICE_USER_ID,
    landingCampaignServiceOrgId: SERVICE_ORG_ID,
    landingCampaignClientId: OFFICIAL_CLIENT_ID,
    landingCampaignMaxAgentTurns: 2,
  });
  // Exercises the shipped production default (6) end-to-end through turn
  // gating — the server-config unit test asserts the default value in
  // isolation; this proves a 6-turn trial actually admits turns 1–5 and locks
  // exactly at the 6th, so a regression in turn accounting at that boundary is
  // caught.
  const getSixTurnApp = useTestApp({
    growthLandingPagesEnabled: true,
    landingCampaignServiceUserId: SERVICE_USER_ID,
    landingCampaignServiceOrgId: SERVICE_ORG_ID,
    landingCampaignClientId: OFFICIAL_CLIENT_ID,
    landingCampaignMaxAgentTurns: 6,
  });
  const getBudgetApp = useTestApp({
    growthLandingPagesEnabled: true,
    landingCampaignServiceUserId: SERVICE_USER_ID,
    landingCampaignServiceOrgId: SERVICE_ORG_ID,
    landingCampaignClientId: OFFICIAL_CLIENT_ID,
    landingCampaignMaxAgentTurns: 3,
    landingCampaignMaxEstimatedTokens: 500,
  });
  const getResetBudgetApp = useTestApp({
    growthLandingPagesEnabled: true,
    landingCampaignServiceUserId: SERVICE_USER_ID,
    landingCampaignServiceOrgId: SERVICE_ORG_ID,
    landingCampaignClientId: OFFICIAL_CLIENT_ID,
    landingCampaignMaxAgentTurns: 3,
    landingCampaignMaxEstimatedTokens: 900,
  });
  const getSingleTrialQuotaApp = useTestApp({
    growthLandingPagesEnabled: true,
    landingCampaignServiceUserId: SERVICE_USER_ID,
    landingCampaignServiceOrgId: SERVICE_ORG_ID,
    landingCampaignClientId: OFFICIAL_CLIENT_ID,
    landingCampaignMaxTrialsPerUserPer24Hours: 1,
  });

  it("parses legacy trial chat metadata with estimated token defaults", () => {
    const trial = parseLandingCampaignTrialChatMetadata({
      landingCampaignTrial: {
        campaign: "production-scan",
        agentId: "agent-1",
        skillSetId: "production-scan",
        skillSetVersion: "test",
        repo: { url: "https://github.com/acme/backend", canonicalKey: "github.com/acme/backend" },
        state: "running",
        inputLocked: false,
      },
    });

    expect(trial).toMatchObject({
      maxAgentTurns: 1,
      completedAgentTurns: 0,
      completedAgentTurnIds: [],
      maxEstimatedTokens: null,
      estimatedTokensUsed: 0,
      lastObservedEstimatedTokens: 0,
      lastObservedTokenUsageEventId: null,
    });
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

  it("requires the official runtime config before provisioning anything", async () => {
    const app = getUnconfiguredApp();
    const admin = await createTestAdmin(app);

    const res = await startProductionScan(app, admin);

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      error: expect.stringContaining("official runtime is not configured"),
    });
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

  it("fails closed for Claude Code until landing campaign workspace-only is implemented", async () => {
    const app = getClaudeProviderApp();
    const admin = await createTestAdmin(app);

    const res = await startProductionScan(app, admin);

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      error: expect.stringContaining("Claude Code runtime is not available"),
    });
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

  it("rejects unknown landing campaign runtime providers before provisioning", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const landingCampaigns = app.config.growth.landingCampaigns;
    if (!landingCampaigns) throw new Error("landing campaign config missing");
    const previousRuntimeProvider = landingCampaigns.runtimeProvider;

    try {
      const mutableConfig = landingCampaigns as unknown as { runtimeProvider: "unknown-runtime" };
      mutableConfig.runtimeProvider = "unknown-runtime";

      const res = await startProductionScan(app, admin);

      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({
        error: expect.stringContaining('runtime provider "unknown-runtime" is not supported'),
      });
    } finally {
      landingCampaigns.runtimeProvider = previousRuntimeProvider;
    }
  });

  it("rejects an official client registered outside the service org", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    await seedOfficialRuntime(app, admin.organizationId);
    await app.db
      .update(clients)
      .set({ organizationId: admin.organizationId })
      .where(eq(clients.id, OFFICIAL_CLIENT_ID));

    const res = await startProductionScan(app, admin);

    expect(res.statusCode).toBe(503);
  });

  it("rejects unsupported campaigns before provisioning", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    const res = await startCampaign(app, admin, "unknown-campaign");

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({
      error: expect.stringContaining('Landing campaign "unknown-campaign" not found'),
    });
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

  it("launches agent-readiness with its external skill and isolated trial identity", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    await seedOfficialRuntime(app, admin.organizationId);

    const res = await startCampaign(app, admin, "agent-readiness");

    expect(res.statusCode).toBe(200);
    const body = res.json<{ chatId: string; agentUuid: string; campaign: string; repoCanonicalKey: string }>();
    expect(body).toMatchObject({
      campaign: "agent-readiness",
      repoCanonicalKey: "github.com/acme/backend",
    });

    const [trialAgent] = await app.db.select().from(agents).where(eq(agents.uuid, body.agentUuid)).limit(1);
    expect(trialAgent).toMatchObject({
      name: "agent-team-readiness-scanner",
      displayName: "Agent Team Readiness Scanner",
    });
    expect(parseLandingCampaignTrialAgentMetadata(trialAgent?.metadata)).toMatchObject({
      landingCampaignTrial: true,
      campaign: "agent-readiness",
      skillSetId: "agent-readiness",
      skillSetVersion: "2026.07.17.1",
    });

    const [chat] = await app.db.select().from(chats).where(eq(chats.id, body.chatId)).limit(1);
    expect(chat?.topic).toBe("Agent team readiness scan");
    expect(parseLandingCampaignTrialChatMetadata(chat?.metadata)).toMatchObject({
      campaign: "agent-readiness",
      agentId: body.agentUuid,
      repo: { canonicalKey: "github.com/acme/backend" },
      state: "running",
      inputLocked: false,
    });

    const [bootstrap] = await app.db.select().from(messages).where(eq(messages.chatId, body.chatId)).limit(1);
    expect(bootstrap?.content).toContain("clone https://github.com/agent-team-foundation/agent-team-readiness-scan");
    expect(bootstrap?.content).toContain("run its agent-team-readiness skill on the repo above");
    expect(bootstrap?.content).toContain("six-dimension score");
    expect(bootstrap?.metadata).toMatchObject({
      campaign: "agent-readiness",
      landingCampaignTrial: true,
    });
  });

  it("rejects invalid or non-GitHub repository URLs before provisioning", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    await seedOfficialRuntime(app, admin.organizationId);

    const invalid = await startProductionScan(app, admin, "https://github.com/");
    const nonGithub = await startProductionScan(app, admin, "https://gitlab.com/acme/backend");

    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({
      error: expect.stringContaining("valid GitHub repository"),
    });
    expect(nonGithub.statusCode).toBe(400);
    expect(nonGithub.json()).toMatchObject({
      error: expect.stringContaining("require a GitHub owner/repo URL"),
    });
    const serviceMembers = await app.db
      .select()
      .from(members)
      .where(and(eq(members.userId, SERVICE_USER_ID), eq(members.organizationId, admin.organizationId)));
    expect(serviceMembers).toHaveLength(0);
  });

  it("returns 404 when the requested organization is not an active caller membership", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    const res = await startProductionScanInOrg(app, admin, `org-missing-${crypto.randomUUID().slice(0, 8)}`);

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({
      error: expect.stringContaining("Active membership not found"),
    });
  });

  it("creates the service-managed trial agent, binds only the trial prompt, and starts an unlocked capped chat", async () => {
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
    });
    expect(agentMeta?.repo).toBeUndefined();

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

    // The scan skill is no longer server-materialized: the bootstrap message
    // instructs the agent to clone the campaign's skill repo instead.
    const skillResources = await app.db
      .select()
      .from(resources)
      .where(and(eq(resources.ownerAgentId, body.agentUuid), eq(resources.type, "skill")));
    expect(skillResources).toHaveLength(0);
    const skillBindings = await app.db
      .select()
      .from(agentResourceBindings)
      .where(and(eq(agentResourceBindings.agentId, body.agentUuid), eq(agentResourceBindings.type, "skill")));
    expect(skillBindings).toHaveLength(0);

    const [prompt] = await app.db
      .select()
      .from(resources)
      .where(
        and(eq(resources.ownerAgentId, body.agentUuid), eq(resources.type, "prompt"), eq(resources.scope, "agent")),
      )
      .limit(1);
    expect(prompt?.name).toBe(LANDING_CAMPAIGN_TRIAL_PROMPT_RESOURCE_NAME);
    expect(prompt?.defaultEnabled).toBeNull();
    expect(prompt?.payload).toMatchObject({
      body: LANDING_CAMPAIGN_TRIAL_PROMPT,
    });

    const promptBindings = await app.db
      .select()
      .from(agentResourceBindings)
      .where(
        and(
          eq(agentResourceBindings.agentId, body.agentUuid),
          eq(agentResourceBindings.type, "prompt"),
          eq(agentResourceBindings.resourceId, prompt?.id ?? ""),
        ),
      );
    expect(promptBindings).toHaveLength(1);
    expect(promptBindings[0]?.inlinePromptBody).toBeNull();
    expect(JSON.stringify(prompt?.payload)).toContain("Workspace access");
    expect(JSON.stringify(prompt?.payload)).toContain("Privacy and secrets");
    expect(JSON.stringify(prompt?.payload)).toContain("passwords");
    expect(JSON.stringify(prompt?.payload)).toContain("tokens");

    const resolvedConfig = await app.resourcesService.resolveRuntimeConfig(await app.configService.get(body.agentUuid));
    expect(resolvedConfig.payload.prompt.sections).toEqual([
      {
        scope: "agent",
        name: LANDING_CAMPAIGN_TRIAL_PROMPT_RESOURCE_NAME,
        body: LANDING_CAMPAIGN_TRIAL_PROMPT,
        editable: false,
      },
    ]);
    expect(resolvedConfig.payload.prompt.append).toContain(LANDING_CAMPAIGN_TRIAL_PROMPT);

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
      inputLocked: false,
      maxAgentTurns: 1,
      completedAgentTurns: 0,
      maxEstimatedTokens: 120_000,
      estimatedTokensUsed: 0,
      lastObservedEstimatedTokens: 0,
      lastObservedTokenUsageEventId: null,
    });

    const [bootstrap] = await app.db.select().from(messages).where(eq(messages.chatId, body.chatId)).limit(1);
    expect(bootstrap?.senderId).toBe(admin.humanAgentUuid);
    expect(bootstrap?.content).toContain("https://github.com/acme/backend");
    // The kickoff instructs the agent to fetch the external skill instead of
    // relying on a server-delivered body.
    expect(bootstrap?.content).toContain("clone https://github.com/agent-team-foundation/launch-readiness-scan");
    expect(bootstrap?.content).toContain("run its production-scan skill on the repo above");
    // The kickoff no longer names a "trial mode" — the external skill is
    // unconditionally trial-shaped, so the phrase would reference nothing.
    expect(bootstrap?.content).not.toContain("trial mode");
    expect(bootstrap?.content).toContain("safe, read-only check before launch");
    expect(bootstrap?.metadata).toMatchObject({
      systemSender: "first_tree_onboarding",
      campaign: "production-scan",
      landingCampaignTrial: true,
    });
  });

  it("uses the caller's default active membership when no organization is supplied", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    await seedOfficialRuntime(app, admin.organizationId);

    const res = await startCampaignWithoutOrganization(app, admin);

    expect(res.statusCode).toBe(200);
    const body = res.json<{ agentUuid: string; repoCanonicalKey: string }>();
    expect(body.repoCanonicalKey).toBe("github.com/acme/backend");
    const [trialAgent] = await app.db
      .select({ organizationId: agents.organizationId })
      .from(agents)
      .where(eq(agents.uuid, body.agentUuid))
      .limit(1);
    expect(trialAgent?.organizationId).toBe(admin.organizationId);
  });

  it("falls back from colliding service and trial agent names and repairs the service member", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    await seedOfficialRuntime(app, admin.organizationId);
    await app.db.insert(agents).values([
      {
        uuid: uuidv7(),
        name: "first-tree-campaigns",
        organizationId: admin.organizationId,
        type: "human",
        displayName: "Reserved service name",
        inboxId: `inbox_${uuidv7()}`,
        source: "admin-api",
        visibility: "private",
        managerId: admin.memberId,
      },
      {
        uuid: uuidv7(),
        name: "first-tree-campaigns-service",
        organizationId: admin.organizationId,
        type: "human",
        displayName: "Reserved service suffix",
        inboxId: `inbox_${uuidv7()}`,
        source: "admin-api",
        visibility: "private",
        managerId: admin.memberId,
      },
      {
        uuid: uuidv7(),
        name: "production-scanner",
        organizationId: admin.organizationId,
        type: "agent",
        displayName: "Existing production scanner",
        inboxId: `inbox_${uuidv7()}`,
        source: "admin-api",
        visibility: "organization",
        managerId: admin.memberId,
      },
    ]);

    const first = await startProductionScan(app, admin);
    expect(first.statusCode).toBe(200);
    const firstBody = first.json<{ agentUuid: string }>();
    const [trialAgent] = await app.db.select().from(agents).where(eq(agents.uuid, firstBody.agentUuid)).limit(1);
    expect(trialAgent?.name).toMatch(/^production-scanner-[0-9a-f]+$/);
    const [serviceMember] = await app.db
      .select()
      .from(members)
      .where(and(eq(members.userId, SERVICE_USER_ID), eq(members.organizationId, admin.organizationId)))
      .limit(1);
    expect(serviceMember?.status).toBe("active");
    const [serviceAgent] = await app.db
      .select()
      .from(agents)
      .where(eq(agents.uuid, serviceMember?.agentId ?? ""))
      .limit(1);
    expect(serviceAgent?.name).toMatch(/^first-tree-campaigns-[0-9a-f]+$/);

    await app.db
      .update(members)
      .set({ status: "left", role: "admin" })
      .where(eq(members.id, serviceMember?.id ?? ""));
    const reactivated = await startProductionScan(app, admin, "https://github.com/acme/api");
    expect(reactivated.statusCode).toBe(200);
    const [afterReactivation] = await app.db
      .select({ status: members.status, role: members.role })
      .from(members)
      .where(eq(members.id, serviceMember?.id ?? ""));
    expect(afterReactivation).toEqual({ status: "active", role: "member" });

    await app.db
      .update(members)
      .set({ role: "admin" })
      .where(eq(members.id, serviceMember?.id ?? ""));
    const roleRepaired = await startProductionScan(app, admin, "https://github.com/acme/frontend");
    expect(roleRepaired.statusCode).toBe(200);
    const [afterRoleRepair] = await app.db
      .select({ role: members.role })
      .from(members)
      .where(eq(members.id, serviceMember?.id ?? ""));
    expect(afterRoleRepair?.role).toBe("member");
  });

  it("purges the legacy server-materialized campaign skill from a reused trial agent", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    await seedOfficialRuntime(app, admin.organizationId);
    const first = await startProductionScan(app, admin);
    expect(first.statusCode).toBe(200);
    const body = first.json<{ agentUuid: string }>();
    const [trialAgent] = await app.db.select().from(agents).where(eq(agents.uuid, body.agentUuid)).limit(1);
    if (!trialAgent?.managerId) throw new Error("expected trial agent with manager");

    // Simulate a pre-migration trial agent: old kickoffs provisioned an
    // agent-scoped skill resource named after the campaign and bound it.
    const legacyResourceId = uuidv7();
    await app.db.insert(resources).values({
      id: legacyResourceId,
      organizationId: admin.organizationId,
      type: "skill",
      scope: "agent",
      ownerAgentId: body.agentUuid,
      name: "production-scan",
      repoCanonicalKey: null,
      defaultEnabled: null,
      status: "active",
      payload: { name: "production-scan", description: "stale", body: "STALE INLINE BODY", metadata: {} },
      createdBy: trialAgent.managerId,
      updatedBy: trialAgent.managerId,
    });
    await app.db.insert(agentResourceBindings).values({
      id: uuidv7(),
      organizationId: admin.organizationId,
      agentId: body.agentUuid,
      type: "skill",
      mode: "include",
      resourceId: legacyResourceId,
      replacesResourceId: null,
      inlinePromptBody: null,
      repoRef: null,
      repoLocalPath: null,
      order: 0,
      createdBy: trialAgent.managerId,
      updatedBy: trialAgent.managerId,
    });
    const [configBefore] = await app.db
      .select({ version: agentConfigs.version })
      .from(agentConfigs)
      .where(eq(agentConfigs.agentId, body.agentUuid));

    const again = await startProductionScan(app, admin);
    expect(again.statusCode).toBe(200);

    const skillRows = await app.db
      .select()
      .from(resources)
      .where(and(eq(resources.ownerAgentId, body.agentUuid), eq(resources.type, "skill")));
    expect(skillRows).toHaveLength(0);
    const skillBindings = await app.db
      .select()
      .from(agentResourceBindings)
      .where(and(eq(agentResourceBindings.agentId, body.agentUuid), eq(agentResourceBindings.type, "skill")));
    expect(skillBindings).toHaveLength(0);
    // Version bumped so the client re-fetches and prunes the materialized copy.
    const [configAfter] = await app.db
      .select({ version: agentConfigs.version })
      .from(agentConfigs)
      .where(eq(agentConfigs.agentId, body.agentUuid));
    expect(configAfter?.version).toBe((configBefore?.version ?? 0) + 1);
  });

  it("presents stale running trial chats as unlocked while turns remain", async () => {
    const app = getMultiTurnApp();
    const admin = await createTestAdmin(app);
    await seedOfficialRuntime(app, admin.organizationId);
    const started = await startProductionScan(app, admin);
    const body = started.json<{ chatId: string }>();

    const [chat] = await app.db.select({ metadata: chats.metadata }).from(chats).where(eq(chats.id, body.chatId));
    const trial = parseLandingCampaignTrialChatMetadata(chat?.metadata);
    if (!chat || !trial) throw new Error("expected landing trial chat metadata");
    await app.db
      .update(chats)
      .set({
        metadata: {
          ...chat.metadata,
          landingCampaignTrial: { ...trial, state: "running", inputLocked: true, completedAgentTurns: 1 },
        },
      })
      .where(eq(chats.id, body.chatId));

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/chats/${body.chatId}`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(detail.statusCode).toBe(200);
    const detailTrial = parseLandingCampaignTrialChatMetadata(
      detail.json<{ metadata: Record<string, unknown> }>().metadata,
    );
    expect(detailTrial).toMatchObject({
      state: "running",
      inputLocked: false,
      maxAgentTurns: 2,
      completedAgentTurns: 1,
    });

    const [storedChat] = await app.db.select({ metadata: chats.metadata }).from(chats).where(eq(chats.id, body.chatId));
    expect(parseLandingCampaignTrialChatMetadata(storedChat?.metadata)).toMatchObject({
      state: "running",
      inputLocked: true,
      maxAgentTurns: 2,
      completedAgentTurns: 1,
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

    const prompts = await app.db
      .select()
      .from(resources)
      .where(
        and(
          eq(resources.ownerAgentId, firstBody.agentUuid),
          eq(resources.type, "prompt"),
          eq(resources.scope, "agent"),
        ),
      );
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.payload).toMatchObject({
      body: LANDING_CAMPAIGN_TRIAL_PROMPT,
    });

    const promptBindings = await app.db
      .select()
      .from(agentResourceBindings)
      .where(
        and(
          eq(agentResourceBindings.agentId, firstBody.agentUuid),
          eq(agentResourceBindings.type, "prompt"),
          eq(agentResourceBindings.resourceId, prompts[0]?.id ?? ""),
        ),
      );
    expect(promptBindings).toHaveLength(1);
    expect(promptBindings[0]?.inlinePromptBody).toBeNull();
  });

  it("does not charge quota for the same repo replay but rejects a second new repo in the rolling window", async () => {
    const app = getSingleTrialQuotaApp();
    const admin = await createTestAdmin(app);
    await seedOfficialRuntime(app, admin.organizationId);

    const first = await startProductionScan(app, admin);
    const replay = await startProductionScan(app, admin);
    const secondRepo = await startProductionScan(app, admin, "https://github.com/acme/api");

    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(replay.json<{ chatId: string }>().chatId).toBe(first.json<{ chatId: string }>().chatId);
    expect(secondRepo.statusCode).toBe(403);
    expect(secondRepo.json<{ error: string }>().error).toContain("free trial limit");
    expect(await countTrialChatsForUser(app, admin.userId)).toBe(1);
  });

  it("counts landing trial quota across organizations for the same user", async () => {
    const app = getSingleTrialQuotaApp();
    const admin = await createTestAdmin(app);
    await seedOfficialRuntime(app, admin.organizationId);
    const otherOrg = await attachOrg(app, admin.userId, "admin");

    const first = await startProductionScan(app, admin);
    const secondOrg = await startProductionScanInOrg(app, admin, otherOrg.orgId, "https://github.com/acme/api");

    expect(first.statusCode).toBe(200);
    expect(secondOrg.statusCode).toBe(403);
    expect(secondOrg.json<{ error: string }>().error).toContain("last 24 hours");
    expect(await countTrialChatsForUser(app, admin.userId)).toBe(1);
  });

  it("allows another new repo after the rolling 24-hour quota window expires", async () => {
    const app = getSingleTrialQuotaApp();
    const admin = await createTestAdmin(app);
    await seedOfficialRuntime(app, admin.organizationId);

    const first = await startProductionScan(app, admin);
    expect(first.statusCode).toBe(200);
    const firstBody = first.json<{ chatId: string }>();
    await app.db
      .update(chats)
      .set({ createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })
      .where(eq(chats.id, firstBody.chatId));

    const second = await startProductionScan(app, admin, "https://github.com/acme/api");

    expect(second.statusCode).toBe(200);
    expect(second.json<{ chatId: string }>().chatId).not.toBe(firstBody.chatId);
    expect(await countTrialChatsForUser(app, admin.userId)).toBe(2);
  });

  it("serializes concurrent new repo starts against the per-user quota", async () => {
    const app = getSingleTrialQuotaApp();
    const admin = await createTestAdmin(app);
    await seedOfficialRuntime(app, admin.organizationId);

    const results = await Promise.all([
      startProductionScan(app, admin, "https://github.com/acme/backend"),
      startProductionScan(app, admin, "https://github.com/acme/api"),
    ]);

    expect(results.map((res) => res.statusCode).sort()).toEqual([200, 403]);
    expect(await countTrialChatsForUser(app, admin.userId)).toBe(1);
  });

  it("resends the bootstrap when a running trial has been silent past the retry window", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    await seedOfficialRuntime(app, admin.organizationId);
    const first = await startProductionScan(app, admin);
    expect(first.statusCode).toBe(200);
    const firstBody = first.json<{ chatId: string }>();
    await app.db
      .update(messages)
      .set({ createdAt: new Date(Date.now() - 11 * 60 * 1000) })
      .where(eq(messages.chatId, firstBody.chatId));

    const second = await startProductionScan(app, admin);

    expect(second.statusCode).toBe(200);
    expect(second.json<{ chatId: string }>().chatId).toBe(firstBody.chatId);
    const chatMessages = await app.db
      .select()
      .from(messages)
      .where(eq(messages.chatId, firstBody.chatId))
      .orderBy(asc(messages.createdAt));
    expect(chatMessages).toHaveLength(2);
    const retry = chatMessages[1];
    expect(retry?.metadata).toMatchObject({
      systemSender: "first_tree_onboarding",
      landingCampaignTrial: true,
      bootstrapRetry: true,
    });
    expect(retry?.content).toContain("restarted");
    expect(retry?.content).toContain("run its production-scan skill on https://github.com/acme/backend");
  });

  it("does not resend the bootstrap while the agent shows recent session activity", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    await seedOfficialRuntime(app, admin.organizationId);
    const first = await startProductionScan(app, admin);
    expect(first.statusCode).toBe(200);
    const firstBody = first.json<{ chatId: string; agentUuid: string }>();
    await app.db
      .update(messages)
      .set({ createdAt: new Date(Date.now() - 11 * 60 * 1000) })
      .where(eq(messages.chatId, firstBody.chatId));
    await sessionEventService.appendEvent(app.db, firstBody.agentUuid, firstBody.chatId, {
      kind: "thinking",
      payload: {},
    });

    const second = await startProductionScan(app, admin);

    expect(second.statusCode).toBe(200);
    expect(second.json<{ chatId: string }>().chatId).toBe(firstBody.chatId);
    const chatMessages = await app.db.select().from(messages).where(eq(messages.chatId, firstBody.chatId));
    expect(chatMessages).toHaveLength(1);
  });

  it("does not resend the bootstrap while the runtime reports fresh working state without session events", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    await seedOfficialRuntime(app, admin.organizationId);
    const first = await startProductionScan(app, admin);
    expect(first.statusCode).toBe(200);
    const firstBody = first.json<{ chatId: string; agentUuid: string }>();
    await app.db
      .update(messages)
      .set({ createdAt: new Date(Date.now() - 11 * 60 * 1000) })
      .where(eq(messages.chatId, firstBody.chatId));
    // Codex no-events case: a long turn is in flight (fresh per-chat
    // runtime_state='working') but has emitted zero session events.
    await app.db
      .insert(agentChatSessions)
      .values({
        agentId: firstBody.agentUuid,
        chatId: firstBody.chatId,
        state: "active",
        runtimeState: "working",
        runtimeStateAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [agentChatSessions.agentId, agentChatSessions.chatId],
        set: { state: "active", runtimeState: "working", runtimeStateAt: new Date() },
      });

    const second = await startProductionScan(app, admin);

    expect(second.statusCode).toBe(200);
    expect(second.json<{ chatId: string }>().chatId).toBe(firstBody.chatId);
    const chatMessages = await app.db.select().from(messages).where(eq(messages.chatId, firstBody.chatId));
    expect(chatMessages).toHaveLength(1);
  });

  it("does not resend the bootstrap when the trial agent has already replied", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    await seedOfficialRuntime(app, admin.organizationId);
    const first = await startProductionScan(app, admin);
    expect(first.statusCode).toBe(200);
    const firstBody = first.json<{ chatId: string; agentUuid: string }>();
    await sendMessage(app.db, firstBody.chatId, firstBody.agentUuid, {
      format: "text",
      content: "Cloning the scan skill now.",
      source: "api",
      metadata: { mentions: [admin.humanAgentUuid] },
    });
    await app.db
      .update(messages)
      .set({ createdAt: new Date(Date.now() - 11 * 60 * 1000) })
      .where(eq(messages.chatId, firstBody.chatId));

    const second = await startProductionScan(app, admin);

    expect(second.statusCode).toBe(200);
    expect(second.json<{ chatId: string }>().chatId).toBe(firstBody.chatId);
    const chatMessages = await app.db.select().from(messages).where(eq(messages.chatId, firstBody.chatId));
    expect(chatMessages).toHaveLength(2);
  });

  it("preserves runtime session metadata when reusing the trial agent for a new repo", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    await seedOfficialRuntime(app, admin.organizationId);

    const first = await startProductionScan(app, admin);
    expect(first.statusCode).toBe(200);
    const firstBody = first.json<{ agentUuid: string }>();
    const runtimeSessionToken = await bindAgentRuntimeSession(app.db, firstBody.agentUuid, OFFICIAL_CLIENT_ID);
    expect(
      await validateAgentRuntimeSession(app.db, firstBody.agentUuid, OFFICIAL_CLIENT_ID, runtimeSessionToken),
    ).toBe(true);

    const second = await startProductionScan(app, admin, "https://github.com/acme/api");

    expect(second.statusCode).toBe(200);
    const secondBody = second.json<{ agentUuid: string; repoCanonicalKey: string }>();
    expect(secondBody.agentUuid).toBe(firstBody.agentUuid);
    expect(secondBody.repoCanonicalKey).toBe("github.com/acme/api");
    expect(
      await validateAgentRuntimeSession(app.db, firstBody.agentUuid, OFFICIAL_CLIENT_ID, runtimeSessionToken),
    ).toBe(true);
    const [trialAgent] = await app.db.select().from(agents).where(eq(agents.uuid, firstBody.agentUuid)).limit(1);
    expect(parseLandingCampaignTrialAgentMetadata(trialAgent?.metadata)).toMatchObject({
      landingCampaignTrial: true,
      campaign: "production-scan",
    });
    expect(parseLandingCampaignTrialAgentMetadata(trialAgent?.metadata)?.repo).toBeUndefined();
    const runtimeSession = (trialAgent?.metadata as Record<string, unknown> | undefined)?.runtimeSession;
    expect(runtimeSession).toMatchObject({
      clientId: OFFICIAL_CLIENT_ID,
      boundAt: expect.any(String),
      tokenHash: expect.any(String),
    });
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

  it("keeps the official client ordinary outside trial metadata while preserving ownership and spoofing guards", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    await seedOfficialRuntime(app, admin.organizationId);

    const ordinaryUserOfficialClient = await app.inject({
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
    expect(ordinaryUserOfficialClient.statusCode).toBe(403);

    const started = await startProductionScan(app, admin);
    expect(started.statusCode).toBe(200);
    const serviceAccessToken = await createLandingCampaignServiceAccessToken(app);
    const serviceOwnedOrdinaryAgent = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${admin.organizationId}/agents`,
      headers: { authorization: `Bearer ${serviceAccessToken}` },
      payload: {
        type: "agent",
        name: "service-owned-ordinary",
        displayName: "Service Owned Ordinary",
        clientId: OFFICIAL_CLIENT_ID,
      },
    });
    expect(serviceOwnedOrdinaryAgent.statusCode).toBe(201);
    expect(
      parseLandingCampaignTrialAgentMetadata(
        serviceOwnedOrdinaryAgent.json<{ metadata: Record<string, unknown> }>().metadata,
      ),
    ).toBeNull();

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

  it("blocks ordinary chats while allowing trial-chat messages until the turn cap", async () => {
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
    expect(message.statusCode).toBe(201);

    await completeLandingCampaignTrialAgentTurn(app.db, body.chatId, body.agentUuid, "turn-default-cap");
    const afterLimit = await app.inject({
      method: "POST",
      url: `/api/v1/chats/${body.chatId}/messages`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { format: "text", content: "Can you keep going?", metadata: { mentions: [body.agentUuid] } },
    });
    expect(afterLimit.statusCode).toBe(403);
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

  it("issues an outbox token scoped to the current trial agent and chat message route", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    await seedOfficialRuntime(app, admin.organizationId);
    const started = await startProductionScan(app, admin);
    const body = started.json<{ chatId: string; agentUuid: string }>();
    const ordinary = await createRunnableOrgAgent(app, admin, "ordinary-agent-outbox-scope");
    const serviceAccessToken = await createLandingCampaignServiceAccessToken(app);
    const trialAgentRequest = agentRequest(app, serviceAccessToken, body.agentUuid);

    const tokenRes = await trialAgentRequest("POST", `/api/v1/agent/chats/${body.chatId}/outbox-token`);

    expect(tokenRes.statusCode).toBe(200);
    const outbox = tokenRes.json<{ accessToken: string; expiresIn: number }>();
    expect(outbox.accessToken).toBeTruthy();
    expect(outbox.expiresIn).toBeGreaterThan(0);

    const send = await app.inject({
      method: "POST",
      url: `/api/v1/agent/chats/${body.chatId}/messages`,
      headers: { authorization: `Bearer ${outbox.accessToken}`, "x-agent-id": body.agentUuid },
      payload: {
        format: "text",
        content: "Final trial report.",
        metadata: { mentions: [admin.humanAgentUuid] },
        source: "cli",
      },
    });
    expect(send.statusCode).toBe(201);
    const [runningChat] = await app.db
      .select({ metadata: chats.metadata })
      .from(chats)
      .where(eq(chats.id, body.chatId));
    expect(parseLandingCampaignTrialChatMetadata(runningChat?.metadata)).toMatchObject({
      state: "running",
      inputLocked: false,
      completedAgentTurns: 0,
    });

    const completedTurn = await completeLandingCampaignTrialAgentTurn(
      app.db,
      body.chatId,
      body.agentUuid,
      "turn-outbox",
    );
    expect(completedTurn).toEqual({
      advanced: true,
      reachedTurnLimit: true,
      reachedLimit: true,
      limitReason: "turns",
      duplicate: false,
    });
    const [completedChat] = await app.db
      .select({ metadata: chats.metadata })
      .from(chats)
      .where(eq(chats.id, body.chatId));
    expect(parseLandingCampaignTrialChatMetadata(completedChat?.metadata)).toMatchObject({
      state: "completed",
      inputLocked: true,
      completedAgentTurns: 1,
    });

    const sendAfterCompleted = await app.inject({
      method: "POST",
      url: `/api/v1/agent/chats/${body.chatId}/messages`,
      headers: { authorization: `Bearer ${outbox.accessToken}`, "x-agent-id": body.agentUuid },
      payload: {
        format: "text",
        content: "Follow-up after completion.",
        metadata: { mentions: [admin.humanAgentUuid] },
        source: "cli",
      },
    });
    expect(sendAfterCompleted.statusCode).toBe(403);

    const requestAfterCompleted = await app.inject({
      method: "POST",
      url: `/api/v1/agent/chats/${body.chatId}/messages`,
      headers: { authorization: `Bearer ${outbox.accessToken}`, "x-agent-id": body.agentUuid },
      payload: {
        format: MESSAGE_FORMATS.REQUEST,
        content: "Can you answer after completion?",
        metadata: { mentions: [admin.humanAgentUuid] },
        source: "cli",
      },
    });
    expect(requestAfterCompleted.statusCode).toBe(403);
    const [stillCompletedChat] = await app.db
      .select({ metadata: chats.metadata })
      .from(chats)
      .where(eq(chats.id, body.chatId));
    expect(parseLandingCampaignTrialChatMetadata(stillCompletedChat?.metadata)).toMatchObject({
      state: "completed",
      inputLocked: true,
    });

    const me = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${outbox.accessToken}` },
    });
    expect(me.statusCode).toBe(401);

    const wrongAgent = await app.inject({
      method: "POST",
      url: `/api/v1/agent/chats/${body.chatId}/messages`,
      headers: { authorization: `Bearer ${outbox.accessToken}`, "x-agent-id": ordinary.uuid },
      payload: {
        format: "text",
        content: "Wrong agent.",
        metadata: { mentions: [admin.humanAgentUuid] },
        source: "cli",
      },
    });
    expect(wrongAgent.statusCode).toBe(401);
  });

  it("allows ordinary human messages while running until completed agent turns reach the limit", async () => {
    const app = getMultiTurnApp();
    const admin = await createTestAdmin(app);
    await seedOfficialRuntime(app, admin.organizationId);
    const started = await startProductionScan(app, admin);
    const body = started.json<{ chatId: string; agentUuid: string }>();

    const [initialChat] = await app.db.select().from(chats).where(eq(chats.id, body.chatId)).limit(1);
    expect(parseLandingCampaignTrialChatMetadata(initialChat?.metadata)).toMatchObject({
      state: "running",
      inputLocked: false,
      maxAgentTurns: 2,
      completedAgentTurns: 0,
    });

    const whileRunning = await app.inject({
      method: "POST",
      url: `/api/v1/chats/${body.chatId}/messages`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: {
        format: "text",
        content: "Can you include deploy risk while you are running?",
        metadata: { mentions: [body.agentUuid] },
      },
    });
    expect(whileRunning.statusCode).toBe(201);

    const firstTurn = await completeLandingCampaignTrialAgentTurn(app.db, body.chatId, body.agentUuid, "turn-1");
    expect(firstTurn).toEqual({
      advanced: true,
      reachedTurnLimit: false,
      reachedLimit: false,
      limitReason: null,
      duplicate: false,
    });
    const [runningChat] = await app.db.select().from(chats).where(eq(chats.id, body.chatId)).limit(1);
    const runningTrial = parseLandingCampaignTrialChatMetadata(runningChat?.metadata);
    expect(runningTrial).toMatchObject({
      state: "running",
      inputLocked: false,
      maxAgentTurns: 2,
      completedAgentTurns: 1,
    });
    expect(runningTrial?.awaitingUserKind).toBeUndefined();

    const followUp = await app.inject({
      method: "POST",
      url: `/api/v1/chats/${body.chatId}/messages`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: {
        format: "text",
        content: "Can you expand on the deployment risk?",
        metadata: { mentions: [body.agentUuid] },
      },
    });
    expect(followUp.statusCode).toBe(201);

    const finalTurn = await completeLandingCampaignTrialAgentTurn(app.db, body.chatId, body.agentUuid, "turn-2");
    expect(finalTurn).toEqual({
      advanced: true,
      reachedTurnLimit: true,
      reachedLimit: true,
      limitReason: "turns",
      duplicate: false,
    });
    const [completedChat] = await app.db.select().from(chats).where(eq(chats.id, body.chatId)).limit(1);
    const completedTrial = parseLandingCampaignTrialChatMetadata(completedChat?.metadata);
    expect(completedTrial).toMatchObject({
      state: "completed",
      inputLocked: true,
      maxAgentTurns: 2,
      completedAgentTurns: 2,
    });
    expect(completedTrial?.awaitingUserKind).toBeUndefined();

    const afterLimit = await app.inject({
      method: "POST",
      url: `/api/v1/chats/${body.chatId}/messages`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: {
        format: "text",
        content: "Can we keep going?",
        metadata: { mentions: [body.agentUuid] },
      },
    });
    expect(afterLimit.statusCode).toBe(403);
  });

  it("admits six agent turns then locks at the sixth under the shipped default cap", async () => {
    const app = getSixTurnApp();
    const admin = await createTestAdmin(app);
    await seedOfficialRuntime(app, admin.organizationId);
    const started = await startProductionScan(app, admin);
    const body = started.json<{ chatId: string; agentUuid: string }>();

    const [initialChat] = await app.db.select().from(chats).where(eq(chats.id, body.chatId)).limit(1);
    expect(parseLandingCampaignTrialChatMetadata(initialChat?.metadata)).toMatchObject({
      state: "running",
      inputLocked: false,
      maxAgentTurns: 6,
      completedAgentTurns: 0,
    });

    // Turns 1–5 advance without hitting the cap.
    for (let turn = 1; turn <= 5; turn++) {
      const result = await completeLandingCampaignTrialAgentTurn(app.db, body.chatId, body.agentUuid, `turn-${turn}`);
      expect(result).toMatchObject({ advanced: true, reachedTurnLimit: false, limitReason: null });
      const [chat] = await app.db.select().from(chats).where(eq(chats.id, body.chatId)).limit(1);
      expect(parseLandingCampaignTrialChatMetadata(chat?.metadata)).toMatchObject({
        state: "running",
        inputLocked: false,
        completedAgentTurns: turn,
      });
    }

    // The sixth turn reaches the cap and locks the chat.
    const sixth = await completeLandingCampaignTrialAgentTurn(app.db, body.chatId, body.agentUuid, "turn-6");
    expect(sixth).toMatchObject({ advanced: true, reachedTurnLimit: true, limitReason: "turns" });
    const [completedChat] = await app.db.select().from(chats).where(eq(chats.id, body.chatId)).limit(1);
    expect(parseLandingCampaignTrialChatMetadata(completedChat?.metadata)).toMatchObject({
      state: "completed",
      inputLocked: true,
      maxAgentTurns: 6,
      completedAgentTurns: 6,
    });

    const afterLimit = await app.inject({
      method: "POST",
      url: `/api/v1/chats/${body.chatId}/messages`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { format: "text", content: "One more?", metadata: { mentions: [body.agentUuid] } },
    });
    expect(afterLimit.statusCode).toBe(403);
  });

  it("keeps turn-only behavior for legacy uncapped trial metadata", async () => {
    const app = getMultiTurnApp();
    const admin = await createTestAdmin(app);
    await seedOfficialRuntime(app, admin.organizationId);
    const started = await startProductionScan(app, admin);
    const body = started.json<{ chatId: string; agentUuid: string }>();
    const [initialChat] = await app.db
      .select({ metadata: chats.metadata })
      .from(chats)
      .where(eq(chats.id, body.chatId));
    const initialTrial = parseLandingCampaignTrialChatMetadata(initialChat?.metadata);
    if (!initialChat || !initialTrial) throw new Error("expected trial chat metadata");
    await app.db
      .update(chats)
      .set({
        metadata: {
          ...initialChat.metadata,
          landingCampaignTrial: { ...initialTrial, maxEstimatedTokens: null },
        },
      })
      .where(eq(chats.id, body.chatId));

    const uncappedEvent = await sessionEventService.appendEvent(app.db, body.agentUuid, body.chatId, {
      kind: "token_usage",
      payload: {
        provider: "codex",
        model: "gpt-5",
        inputTokens: 100_000,
        cachedInputTokens: 10_000,
        outputTokens: 20_000,
      },
    });

    const firstTurn = await completeLandingCampaignTrialAgentTurn(app.db, body.chatId, body.agentUuid, "uncapped-1");
    expect(firstTurn).toEqual({
      advanced: true,
      reachedTurnLimit: false,
      reachedLimit: false,
      limitReason: null,
      duplicate: false,
    });
    const [runningChat] = await app.db
      .select({ metadata: chats.metadata })
      .from(chats)
      .where(eq(chats.id, body.chatId));
    expect(parseLandingCampaignTrialChatMetadata(runningChat?.metadata)).toMatchObject({
      state: "running",
      inputLocked: false,
      maxAgentTurns: 2,
      completedAgentTurns: 1,
      maxEstimatedTokens: null,
      estimatedTokensUsed: 130_000,
      lastObservedEstimatedTokens: 130_000,
      lastObservedTokenUsageEventId: uncappedEvent.id,
    });

    const followUp = await app.inject({
      method: "POST",
      url: `/api/v1/chats/${body.chatId}/messages`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: {
        format: "text",
        content: "Can you keep going after a large uncapped turn?",
        metadata: { mentions: [body.agentUuid] },
      },
    });
    expect(followUp.statusCode).toBe(201);
  });

  it("locks a trial chat when the estimated token cap is reached before the turn cap", async () => {
    const app = getBudgetApp();
    const admin = await createTestAdmin(app);
    await seedOfficialRuntime(app, admin.organizationId);
    const started = await startProductionScan(app, admin);
    const body = started.json<{ chatId: string; agentUuid: string }>();

    const [initialChat] = await app.db
      .select({ metadata: chats.metadata })
      .from(chats)
      .where(eq(chats.id, body.chatId));
    expect(parseLandingCampaignTrialChatMetadata(initialChat?.metadata)).toMatchObject({
      state: "running",
      inputLocked: false,
      maxAgentTurns: 3,
      completedAgentTurns: 0,
      maxEstimatedTokens: 500,
      estimatedTokensUsed: 0,
      lastObservedEstimatedTokens: 0,
      lastObservedTokenUsageEventId: null,
    });

    const firstUsage = await sessionEventService.appendEvent(app.db, body.agentUuid, body.chatId, {
      kind: "token_usage",
      payload: { provider: "codex", model: "gpt-5", inputTokens: 100, cachedInputTokens: 25, outputTokens: 50 },
    });
    await sessionEventService.appendEvent(app.db, uuidv7(), body.chatId, {
      kind: "token_usage",
      payload: {
        provider: "codex",
        model: "gpt-5",
        inputTokens: 10_000,
        cachedInputTokens: 1_000,
        outputTokens: 2_000,
      },
    });
    const firstTurn = await completeLandingCampaignTrialAgentTurn(app.db, body.chatId, body.agentUuid, "budget-1");
    expect(firstTurn).toEqual({
      advanced: true,
      reachedTurnLimit: false,
      reachedLimit: false,
      limitReason: null,
      duplicate: false,
    });
    const [afterFirstChat] = await app.db
      .select({ metadata: chats.metadata })
      .from(chats)
      .where(eq(chats.id, body.chatId));
    expect(parseLandingCampaignTrialChatMetadata(afterFirstChat?.metadata)).toMatchObject({
      state: "running",
      inputLocked: false,
      completedAgentTurns: 1,
      estimatedTokensUsed: 175,
      lastObservedEstimatedTokens: 175,
      lastObservedTokenUsageEventId: firstUsage.id,
    });

    const whileUnderBudget = await app.inject({
      method: "POST",
      url: `/api/v1/chats/${body.chatId}/messages`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: {
        format: "text",
        content: "Please continue while the token budget remains.",
        metadata: { mentions: [body.agentUuid] },
      },
    });
    expect(whileUnderBudget.statusCode).toBe(201);

    const secondUsage = await sessionEventService.appendEvent(app.db, body.agentUuid, body.chatId, {
      kind: "token_usage",
      payload: { provider: "codex", model: "gpt-5", inputTokens: 200, cachedInputTokens: 50, outputTokens: 100 },
    });
    const secondTurn = await completeLandingCampaignTrialAgentTurn(app.db, body.chatId, body.agentUuid, "budget-2");
    expect(secondTurn).toEqual({
      advanced: true,
      reachedTurnLimit: false,
      reachedLimit: true,
      limitReason: "tokens",
      duplicate: false,
    });
    const [lockedChat] = await app.db.select({ metadata: chats.metadata }).from(chats).where(eq(chats.id, body.chatId));
    expect(parseLandingCampaignTrialChatMetadata(lockedChat?.metadata)).toMatchObject({
      state: "completed",
      inputLocked: true,
      maxAgentTurns: 3,
      completedAgentTurns: 2,
      maxEstimatedTokens: 500,
      estimatedTokensUsed: 525,
      lastObservedEstimatedTokens: 525,
      lastObservedTokenUsageEventId: secondUsage.id,
      limitReason: "tokens",
    });

    const duplicate = await completeLandingCampaignTrialAgentTurn(app.db, body.chatId, body.agentUuid, "budget-2");
    expect(duplicate).toEqual({
      advanced: false,
      reachedTurnLimit: false,
      reachedLimit: true,
      limitReason: "tokens",
      duplicate: true,
    });
    const [afterDuplicateChat] = await app.db
      .select({ metadata: chats.metadata })
      .from(chats)
      .where(eq(chats.id, body.chatId));
    expect(parseLandingCampaignTrialChatMetadata(afterDuplicateChat?.metadata)).toMatchObject({
      completedAgentTurns: 2,
      estimatedTokensUsed: 525,
      completedAgentTurnIds: ["budget-1", "budget-2"],
    });

    const afterBudget = await app.inject({
      method: "POST",
      url: `/api/v1/chats/${body.chatId}/messages`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: {
        format: "text",
        content: "Can we keep going after the token budget?",
        metadata: { mentions: [body.agentUuid] },
      },
    });
    expect(afterBudget.statusCode).toBe(403);
  });

  it("continues charging estimated tokens after session event traces reset", async () => {
    const app = getResetBudgetApp();
    const admin = await createTestAdmin(app);
    await seedOfficialRuntime(app, admin.organizationId);
    const started = await startProductionScan(app, admin);
    const body = started.json<{ chatId: string; agentUuid: string }>();

    const firstUsage = await sessionEventService.appendEvent(app.db, body.agentUuid, body.chatId, {
      kind: "token_usage",
      payload: { provider: "codex", model: "gpt-5", inputTokens: 300, cachedInputTokens: 50, outputTokens: 50 },
    });
    const firstTurn = await completeLandingCampaignTrialAgentTurn(app.db, body.chatId, body.agentUuid, "reset-1");
    expect(firstTurn).toEqual({
      advanced: true,
      reachedTurnLimit: false,
      reachedLimit: false,
      limitReason: null,
      duplicate: false,
    });
    const [afterFirstChat] = await app.db
      .select({ metadata: chats.metadata })
      .from(chats)
      .where(eq(chats.id, body.chatId));
    expect(parseLandingCampaignTrialChatMetadata(afterFirstChat?.metadata)).toMatchObject({
      state: "running",
      inputLocked: false,
      completedAgentTurns: 1,
      estimatedTokensUsed: 400,
      lastObservedEstimatedTokens: 400,
      lastObservedTokenUsageEventId: firstUsage.id,
    });

    await sessionEventService.clearEvents(app.db, body.agentUuid, body.chatId);
    const secondUsage = await sessionEventService.appendEvent(app.db, body.agentUuid, body.chatId, {
      kind: "token_usage",
      payload: { provider: "codex", model: "gpt-5", inputTokens: 450, cachedInputTokens: 50, outputTokens: 100 },
    });
    const secondTurn = await completeLandingCampaignTrialAgentTurn(app.db, body.chatId, body.agentUuid, "reset-2");
    expect(secondTurn).toEqual({
      advanced: true,
      reachedTurnLimit: false,
      reachedLimit: true,
      limitReason: "tokens",
      duplicate: false,
    });
    const [lockedChat] = await app.db.select({ metadata: chats.metadata }).from(chats).where(eq(chats.id, body.chatId));
    expect(parseLandingCampaignTrialChatMetadata(lockedChat?.metadata)).toMatchObject({
      state: "completed",
      inputLocked: true,
      completedAgentTurns: 2,
      completedAgentTurnIds: ["reset-1", "reset-2"],
      maxEstimatedTokens: 900,
      estimatedTokensUsed: 1000,
      lastObservedEstimatedTokens: 600,
      lastObservedTokenUsageEventId: secondUsage.id,
      limitReason: "tokens",
    });
  });

  it("serializes concurrent trial request writes so only one state transition wins", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    await seedOfficialRuntime(app, admin.organizationId);
    const started = await startProductionScan(app, admin);
    const body = started.json<{ chatId: string; agentUuid: string }>();
    const serviceAccessToken = await createLandingCampaignServiceAccessToken(app);
    const trialAgentRequest = agentRequest(app, serviceAccessToken, body.agentUuid);
    const tokenRes = await trialAgentRequest("POST", `/api/v1/agent/chats/${body.chatId}/outbox-token`);
    const outbox = tokenRes.json<{ accessToken: string }>();

    const [firstRequestRes, secondRequestRes] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/v1/agent/chats/${body.chatId}/messages`,
        headers: { authorization: `Bearer ${outbox.accessToken}`, "x-agent-id": body.agentUuid },
        payload: {
          format: MESSAGE_FORMATS.REQUEST,
          content: "Need one more answer?",
          metadata: { mentions: [admin.humanAgentUuid] },
          source: "cli",
        },
      }),
      app.inject({
        method: "POST",
        url: `/api/v1/agent/chats/${body.chatId}/messages`,
        headers: { authorization: `Bearer ${outbox.accessToken}`, "x-agent-id": body.agentUuid },
        payload: {
          format: MESSAGE_FORMATS.REQUEST,
          content: "Need another answer?",
          metadata: { mentions: [admin.humanAgentUuid] },
          source: "cli",
        },
      }),
    ]);

    expect([firstRequestRes.statusCode, secondRequestRes.statusCode].sort()).toEqual([201, 403]);
    const trialMessages = await app.db
      .select({ id: messages.id, format: messages.format })
      .from(messages)
      .where(and(eq(messages.chatId, body.chatId), eq(messages.senderId, body.agentUuid)));
    expect(trialMessages).toHaveLength(1);
    expect(trialMessages[0]?.format).toBe(MESSAGE_FORMATS.REQUEST);

    const [chat] = await app.db.select({ metadata: chats.metadata }).from(chats).where(eq(chats.id, body.chatId));
    const trial = parseLandingCampaignTrialChatMetadata(chat?.metadata);
    expect(trial).toMatchObject({ state: "awaiting_user", inputLocked: false, awaitingUserKind: "request" });
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
      awaitingUserKind: "request",
    });

    const plainMessageDuringRequest = await app.inject({
      method: "POST",
      url: `/api/v1/chats/${body.chatId}/messages`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: {
        format: "text",
        content: "I am not answering the request yet.",
        metadata: { mentions: [body.agentUuid] },
      },
    });
    expect(plainMessageDuringRequest.statusCode).toBe(403);

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
      inputLocked: false,
      completedAgentTurns: 0,
    });

    const completedTurn = await completeLandingCampaignTrialAgentTurn(
      app.db,
      body.chatId,
      body.agentUuid,
      "turn-request-answer",
    );
    expect(completedTurn).toEqual({
      advanced: true,
      reachedTurnLimit: true,
      reachedLimit: true,
      limitReason: "turns",
      duplicate: false,
    });
    const [completedChat] = await app.db.select().from(chats).where(eq(chats.id, body.chatId)).limit(1);
    expect(parseLandingCampaignTrialChatMetadata(completedChat?.metadata)).toMatchObject({
      state: "completed",
      inputLocked: true,
      completedAgentTurns: 1,
    });
  });

  it("treats legacy awaiting_user trial chats without a kind as request waits", async () => {
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
    const awaitingTrial = parseLandingCampaignTrialChatMetadata(awaitingChat?.metadata);
    if (!awaitingChat || !awaitingTrial) throw new Error("expected landing trial metadata");
    const legacyTrial = { ...awaitingTrial };
    delete legacyTrial.awaitingUserKind;
    await app.db
      .update(chats)
      .set({
        metadata: {
          ...awaitingChat.metadata,
          landingCampaignTrial: legacyTrial,
        },
      })
      .where(eq(chats.id, body.chatId));

    const plainMessageDuringLegacyRequest = await app.inject({
      method: "POST",
      url: `/api/v1/chats/${body.chatId}/messages`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: {
        format: "text",
        content: "I am not answering the legacy request yet.",
        metadata: { mentions: [body.agentUuid] },
      },
    });
    expect(plainMessageDuringLegacyRequest.statusCode).toBe(403);

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
      inputLocked: false,
      completedAgentTurns: 0,
    });
  });

  it("hides the service member and service client outside the service org", async () => {
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

  it("treats the service user and client as ordinary inside the service org", async () => {
    const app = getApp();
    if (!app.config.growth.landingCampaigns) throw new Error("landing campaign config missing");
    const previousServiceOrgId = app.config.growth.landingCampaigns.serviceOrgId;
    try {
      const admin = await createTestAdmin(app);
      app.config.growth.landingCampaigns.serviceOrgId = admin.organizationId;
      await seedOfficialRuntime(app, admin.organizationId);
      const [existingServiceMember] = await app.db
        .select()
        .from(members)
        .where(and(eq(members.userId, SERVICE_USER_ID), eq(members.organizationId, admin.organizationId)))
        .limit(1);
      const serviceMember =
        existingServiceMember ??
        (await createMember(app.db, admin.organizationId, {
          username: "first-tree-landing-service-test",
          displayName: "First Tree",
          role: "member",
        }));

      const membersRes = await app.inject({
        method: "GET",
        url: `/api/v1/orgs/${admin.organizationId}/members`,
        headers: { authorization: `Bearer ${admin.accessToken}` },
      });
      expect(membersRes.statusCode).toBe(200);
      expect(membersRes.json<Array<{ userId: string }>>().some((row) => row.userId === SERVICE_USER_ID)).toBe(true);

      const patchMember = await app.inject({
        method: "PATCH",
        url: `/api/v1/orgs/${admin.organizationId}/members/${serviceMember.id}`,
        headers: { authorization: `Bearer ${admin.accessToken}` },
        payload: { displayName: "First Tree Service" },
      });
      expect(patchMember.statusCode).toBe(200);

      const clientsRes = await app.inject({
        method: "GET",
        url: `/api/v1/orgs/${admin.organizationId}/clients`,
        headers: { authorization: `Bearer ${admin.accessToken}` },
      });
      expect(clientsRes.statusCode).toBe(200);
      expect(clientsRes.json<Array<{ id: string }>>().some((row) => row.id === OFFICIAL_CLIENT_ID)).toBe(true);

      const startInServiceOrg = await startProductionScan(app, admin);
      expect(startInServiceOrg.statusCode).toBe(403);
    } finally {
      app.config.growth.landingCampaigns.serviceOrgId = previousServiceOrgId;
    }
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

  it("returns scoped 404 when another org admin targets the campaign service member id", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    await seedOfficialRuntime(app, admin.organizationId);
    const started = await startProductionScan(app, admin);
    const body = started.json<{ agentUuid: string }>();
    const [trialAgent] = await app.db.select().from(agents).where(eq(agents.uuid, body.agentUuid)).limit(1);
    if (!trialAgent?.managerId) throw new Error("trial agent manager missing");

    const otherAdmin = await createTestAdmin(app);
    const otherOrg = await attachOrg(app, otherAdmin.userId, "admin");
    const patchMember = await app.inject({
      method: "PATCH",
      url: `/api/v1/orgs/${otherOrg.orgId}/members/${trialAgent.managerId}`,
      headers: { authorization: `Bearer ${otherAdmin.accessToken}` },
      payload: { displayName: "Renamed" },
    });
    expect(patchMember.statusCode).toBe(404);

    const deleteMember = await app.inject({
      method: "DELETE",
      url: `/api/v1/orgs/${otherOrg.orgId}/members/${trialAgent.managerId}`,
      headers: { authorization: `Bearer ${otherAdmin.accessToken}` },
    });
    expect(deleteMember.statusCode).toBe(404);
  });
});
