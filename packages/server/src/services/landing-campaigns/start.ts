import {
  agentPinnedMessageSchema,
  canonicalGitRepoUrl,
  type LandingCampaignRepoMetadata,
  type LandingCampaignStartRequest,
  type LandingCampaignStartResponse,
  type RuntimeProvider,
  type SendMessage,
} from "@first-tree/shared";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Database } from "../../db/connection.js";
import { agents } from "../../db/schema/agents.js";
import { chats } from "../../db/schema/chats.js";
import { clients } from "../../db/schema/clients.js";
import { members } from "../../db/schema/members.js";
import { messages } from "../../db/schema/messages.js";
import { users } from "../../db/schema/users.js";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
} from "../../errors.js";
import { uuidv7 } from "../../uuid.js";
import { agentMetadataUpdateExpressionPreservingRuntimeState, createAgent, legacyWireAgentType } from "../agent.js";
import { pickDefaultMembership } from "../auth.js";
import { createChat } from "../chat.js";
import { sendToClient } from "../connection-manager.js";
import { MEMBER_STATUSES, reactivateMembership } from "../membership.js";
import { sendMessage } from "../message.js";
import { notifyRecipients } from "../notifier.js";
import { isLandingCampaignServiceOrg } from "./guards.js";
import { buildLandingCampaignAgentMetadata, buildLandingCampaignChatMetadata } from "./metadata.js";
import { buildLandingCampaignBootstrap, getLandingCampaignSkillSet } from "./skills/catalog.js";

const SERVICE_MEMBER_AGENT_BASE_NAME = "first-tree-campaigns";

type ActiveMembership = {
  id: string;
  organizationId: string;
  agentId: string;
  role: string;
  createdAt: Date;
};

function requireLandingCampaignConfig(app: FastifyInstance): {
  serviceUserId: string;
  serviceOrgId: string;
  clientId: string;
  runtimeProvider: Extract<RuntimeProvider, "codex" | "claude-code">;
} {
  const serviceUserId = app.config.growth.landingCampaigns?.serviceUserId;
  const serviceOrgId = app.config.growth.landingCampaigns?.serviceOrgId;
  const clientId = app.config.growth.landingCampaigns?.clientId;
  if (!serviceUserId || !serviceOrgId || !clientId) {
    throw new ServiceUnavailableError("Landing campaign official runtime is not configured");
  }
  return {
    serviceUserId,
    serviceOrgId,
    clientId,
    runtimeProvider: app.config.growth.landingCampaigns?.runtimeProvider ?? "codex",
  };
}

function assertLandingCampaignRuntimeProviderSupported(provider: RuntimeProvider): void {
  if (provider === "claude-code") {
    throw new ServiceUnavailableError(
      "Landing campaign Claude Code runtime is not available until Claude Code workspace-only is implemented.",
    );
  }
  if (provider !== "codex") {
    throw new ServiceUnavailableError(`Landing campaign runtime provider "${provider}" is not supported.`);
  }
}

function parseRepo(repoUrl: string): LandingCampaignRepoMetadata {
  const canonical = canonicalGitRepoUrl(repoUrl);
  if (!canonical) throw new BadRequestError("Repository URL is not a valid GitHub repository.");
  const [host, owner, repo] = canonical.split("/");
  if (host !== "github.com" || !owner || !repo || canonical.split("/").length !== 3) {
    throw new BadRequestError("Landing campaign trials currently require a GitHub owner/repo URL.");
  }
  return {
    url: `https://github.com/${owner}/${repo}`,
    canonicalKey: canonical,
    owner,
    name: repo,
  };
}

async function resolveCallerMembership(
  db: Database,
  userId: string,
  organizationId?: string,
): Promise<ActiveMembership> {
  const rows = await db
    .select({
      id: members.id,
      organizationId: members.organizationId,
      agentId: members.agentId,
      role: members.role,
      createdAt: members.createdAt,
    })
    .from(members)
    .where(and(eq(members.userId, userId), eq(members.status, MEMBER_STATUSES.ACTIVE)))
    .orderBy(asc(members.createdAt));

  const selected = organizationId
    ? rows.find((row) => row.organizationId === organizationId)
    : (() => {
        const picked = pickDefaultMembership(rows.map((row) => ({ id: row.id, createdAt: row.createdAt })));
        return picked ? rows.find((row) => row.id === picked.id) : undefined;
      })();

  if (!selected) {
    throw new NotFoundError("Active membership not found");
  }
  return selected;
}

async function resolveAvailableServiceAgentName(db: Database, orgId: string): Promise<string> {
  const suffixes = ["", "service", uuidv7().slice(0, 8)];
  for (const suffix of suffixes) {
    const candidate = suffix ? `${SERVICE_MEMBER_AGENT_BASE_NAME}-${suffix}` : SERVICE_MEMBER_AGENT_BASE_NAME;
    const [existing] = await db
      .select({ uuid: agents.uuid })
      .from(agents)
      .where(and(eq(agents.organizationId, orgId), eq(agents.name, candidate), ne(agents.status, "deleted")))
      .limit(1);
    if (!existing) return candidate;
  }
  return `${SERVICE_MEMBER_AGENT_BASE_NAME}-${uuidv7().slice(0, 8)}`;
}

async function ensureServiceMember(
  db: Database,
  organizationId: string,
  serviceUserId: string,
): Promise<typeof members.$inferSelect> {
  const [serviceUser] = await db
    .select({ id: users.id, username: users.username, displayName: users.displayName })
    .from(users)
    .where(eq(users.id, serviceUserId))
    .limit(1);
  if (!serviceUser) {
    throw new ServiceUnavailableError("Landing campaign service user is not configured");
  }

  const [existing] = await db
    .select()
    .from(members)
    .where(and(eq(members.userId, serviceUserId), eq(members.organizationId, organizationId)))
    .limit(1);
  if (existing) {
    if (existing.status !== MEMBER_STATUSES.ACTIVE) {
      await reactivateMembership(db, existing, {
        displayName: serviceUser.displayName,
        username: serviceUser.username,
        role: "member",
        resetOnboarding: false,
      });
      return { ...existing, status: MEMBER_STATUSES.ACTIVE, role: "member" };
    }
    if (existing.role !== "member") {
      const [updated] = await db.update(members).set({ role: "member" }).where(eq(members.id, existing.id)).returning();
      if (!updated) throw new Error("Unexpected: service member role update returned no row");
      return updated;
    }
    return existing;
  }

  const memberId = uuidv7();
  const agentId = uuidv7();
  const agentName = await resolveAvailableServiceAgentName(db, organizationId);
  await db.insert(agents).values({
    uuid: agentId,
    name: agentName,
    organizationId,
    type: "human",
    displayName: serviceUser.displayName || "First Tree",
    inboxId: `inbox_${agentId}`,
    source: "admin-api",
    visibility: "private",
    managerId: memberId,
    metadata: { landingCampaignServiceUser: true },
  });
  const [created] = await db
    .insert(members)
    .values({
      id: memberId,
      userId: serviceUserId,
      organizationId,
      agentId,
      role: "member",
    })
    .returning();
  if (!created) throw new Error("Unexpected: INSERT RETURNING produced no service member row");
  return created;
}

async function assertOfficialClient(
  db: Database,
  clientId: string,
  serviceUserId: string,
  serviceOrgId: string,
): Promise<void> {
  const [client] = await db
    .select({ id: clients.id, userId: clients.userId, organizationId: clients.organizationId })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);
  if (!client || client.userId !== serviceUserId || client.organizationId !== serviceOrgId) {
    throw new ServiceUnavailableError("Landing campaign official client is not configured in the service organization");
  }
}

async function createCampaignAgentWithFallbackName(
  db: Database,
  input: Parameters<typeof createAgent>[1],
): ReturnType<typeof createAgent> {
  const baseName = input.name ?? "landing-campaign-agent";
  const candidates = [baseName, `${baseName}-${uuidv7().slice(0, 8)}`];
  let lastConflict: ConflictError | null = null;
  for (const name of candidates) {
    try {
      return await createAgent(db, { ...input, name });
    } catch (err) {
      if (err instanceof ConflictError) {
        lastConflict = err;
        continue;
      }
      throw err;
    }
  }
  throw lastConflict ?? new ConflictError(`Agent name "${baseName}" already exists`);
}

async function ensureTrialAgent(
  db: Database,
  input: {
    organizationId: string;
    serviceMemberId: string;
    officialClientId: string;
    runtimeProvider: RuntimeProvider;
    campaign: string;
    skillSet: NonNullable<ReturnType<typeof getLandingCampaignSkillSet>>;
    repo: LandingCampaignRepoMetadata;
  },
) {
  const metadata = buildLandingCampaignAgentMetadata({
    campaign: input.campaign,
    skillSetId: input.skillSet.id,
    skillSetVersion: input.skillSet.version,
    repo: input.repo,
  });

  const [existing] = await db
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.organizationId, input.organizationId),
        ne(agents.status, "deleted"),
        sql`${agents.metadata} ->> 'landingCampaignTrial' = 'true'`,
        sql`${agents.metadata} ->> 'campaign' = ${input.campaign}`,
      ),
    )
    .orderBy(asc(agents.createdAt))
    .limit(1);

  if (existing) {
    if (
      existing.managerId !== input.serviceMemberId ||
      existing.clientId !== input.officialClientId ||
      existing.runtimeProvider !== input.runtimeProvider
    ) {
      throw new ConflictError(
        "Existing landing campaign trial agent is pinned to a different manager, client, or runtime provider.",
      );
    }
    const [updated] = await db
      .update(agents)
      .set({
        visibility: "organization",
        displayName: input.skillSet.agentDisplayName,
        metadata: agentMetadataUpdateExpressionPreservingRuntimeState(metadata),
        updatedAt: new Date(),
      })
      .where(eq(agents.uuid, existing.uuid))
      .returning();
    if (!updated) throw new Error("Unexpected: trial agent update returned no row");
    return updated;
  }

  return createCampaignAgentWithFallbackName(db, {
    name: input.skillSet.agentName,
    displayName: input.skillSet.agentDisplayName,
    type: "agent",
    source: "admin-api",
    visibility: "organization",
    managerId: input.serviceMemberId,
    organizationId: input.organizationId,
    clientId: input.officialClientId,
    runtimeProvider: input.runtimeProvider,
    metadata,
  });
}

async function provisionTrialAgent(
  app: FastifyInstance,
  input: {
    organizationId: string;
    serviceUserId: string;
    officialClientId: string;
    runtimeProvider: RuntimeProvider;
    campaign: string;
    skillSet: NonNullable<ReturnType<typeof getLandingCampaignSkillSet>>;
    repo: LandingCampaignRepoMetadata;
  },
): Promise<{
  serviceMember: typeof members.$inferSelect;
  trialAgent: Awaited<ReturnType<typeof ensureTrialAgent>>;
}> {
  const lockKey = `${input.organizationId}:${input.campaign}`;
  return app.db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('landing_campaign_trial'), hashtext(${lockKey}))`);
    const db = tx as unknown as Database;
    const serviceMember = await ensureServiceMember(db, input.organizationId, input.serviceUserId);
    const trialAgent = await ensureTrialAgent(db, {
      organizationId: input.organizationId,
      serviceMemberId: serviceMember.id,
      officialClientId: input.officialClientId,
      runtimeProvider: input.runtimeProvider,
      campaign: input.campaign,
      skillSet: input.skillSet,
      repo: input.repo,
    });
    return { serviceMember, trialAgent };
  });
}

function notifyClientAgentPinned(app: FastifyInstance, agent: Awaited<ReturnType<typeof ensureTrialAgent>>): void {
  if (!agent.clientId) return;
  const parsed = agentPinnedMessageSchema.safeParse({
    type: "agent:pinned",
    agentId: agent.uuid,
    name: agent.name,
    displayName: agent.displayName,
    agentType: legacyWireAgentType(agent.type),
    runtimeProvider: agent.runtimeProvider,
  });
  if (!parsed.success) {
    app.log.warn(
      { err: parsed.error.flatten(), agentId: agent.uuid, clientId: agent.clientId },
      "landing campaign agent:pinned frame failed schema validation",
    );
    return;
  }
  sendToClient(agent.clientId, parsed.data);
}

async function ensureTrialChatAndBootstrap(
  app: FastifyInstance,
  input: {
    humanAgentId: string;
    agentId: string;
    campaign: string;
    repo: LandingCampaignRepoMetadata;
    skillSet: NonNullable<ReturnType<typeof getLandingCampaignSkillSet>>;
  },
): Promise<{ chatId: string; sent?: { recipients: string[]; messageId: string } }> {
  const kickoffKey = [
    "landing-campaign",
    input.humanAgentId,
    input.agentId,
    input.campaign,
    input.repo.canonicalKey,
  ].join(":");

  const metadata = buildLandingCampaignChatMetadata({
    campaign: input.campaign,
    agentId: input.agentId,
    skillSetId: input.skillSet.id,
    skillSetVersion: input.skillSet.version,
    repo: input.repo,
    state: "running",
    inputLocked: true,
    maxAgentTurns: app.config.growth.landingCampaignMaxAgentTurns,
    completedAgentTurns: 0,
  });

  let chatId: string;
  const [existing] = await app.db
    .select({ id: chats.id })
    .from(chats)
    .where(eq(chats.onboardingKickoffKey, kickoffKey))
    .limit(1);
  if (existing) {
    chatId = existing.id;
  } else {
    const created = await createChat(app.db, {
      mode: "legacy-empty-agent",
      creatorAgentId: input.humanAgentId,
      participantAgentIds: [input.agentId],
      topic: input.skillSet.chatTopic,
      metadata,
      onboardingKickoffKey: kickoffKey,
      allowLandingCampaignTrial: true,
    });
    chatId = created.id;
  }

  let sent: { recipients: string[]; messageId: string } | undefined;
  await app.db.transaction(async (tx) => {
    await tx.select({ id: chats.id }).from(chats).where(eq(chats.id, chatId)).for("update");
    const [firstMessage] = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.chatId, chatId))
      .limit(1);
    if (firstMessage) return;
    const message: SendMessage = {
      format: "text",
      content: buildLandingCampaignBootstrap(input.skillSet, input.repo.url),
      source: "api",
      metadata: {
        systemSender: "first_tree_onboarding",
        campaign: input.campaign,
        landingCampaignTrial: true,
        repo: input.repo,
      },
    };
    const result = await sendMessage(tx as unknown as Database, chatId, input.humanAgentId, message, {
      addressedToAgentIds: [input.agentId],
      allowSystemSender: true,
    });
    sent = { recipients: result.recipients, messageId: result.message.id };
  });

  return { chatId, sent };
}

export async function startLandingCampaignTrial(
  app: FastifyInstance,
  userId: string,
  body: LandingCampaignStartRequest,
  setupUrl: string,
): Promise<LandingCampaignStartResponse> {
  const config = requireLandingCampaignConfig(app);
  assertLandingCampaignRuntimeProviderSupported(config.runtimeProvider);
  const skillSet = getLandingCampaignSkillSet(body.campaign);
  if (!skillSet) throw new NotFoundError(`Landing campaign "${body.campaign}" not found`);
  const repo = parseRepo(body.repoUrl);
  const caller = await resolveCallerMembership(app.db, userId, body.organizationId);
  if (caller.role !== "admin") {
    throw new ForbiddenError("Only organization admins can start a First Tree landing campaign trial.");
  }
  if (isLandingCampaignServiceOrg(app.config, caller.organizationId)) {
    throw new ForbiddenError("Landing campaign trials cannot be started in the First Tree service organization.");
  }

  await assertOfficialClient(app.db, config.clientId, config.serviceUserId, config.serviceOrgId);
  const { serviceMember, trialAgent } = await provisionTrialAgent(app, {
    organizationId: caller.organizationId,
    serviceUserId: config.serviceUserId,
    officialClientId: config.clientId,
    runtimeProvider: config.runtimeProvider,
    campaign: body.campaign,
    skillSet,
    repo,
  });
  await app.resourcesService.ensureAndBindCampaignScanSkill(trialAgent.uuid, body.campaign, serviceMember.id, setupUrl);
  notifyClientAgentPinned(app, trialAgent);

  const result = await ensureTrialChatAndBootstrap(app, {
    humanAgentId: caller.agentId,
    agentId: trialAgent.uuid,
    campaign: body.campaign,
    repo,
    skillSet,
  });
  if (result.sent) notifyRecipients(app.notifier, result.sent.recipients, result.sent.messageId);

  return {
    chatId: result.chatId,
    agentUuid: trialAgent.uuid,
    campaign: body.campaign,
    repoCanonicalKey: repo.canonicalKey,
  };
}
