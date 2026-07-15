import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { agents, chatMembership, chats, clients, members, messages, organizations } from "../db/schema/index.js";
import { createAgent } from "../services/agent.js";
import {
  buildLandingCampaignAgentMetadata,
  buildLandingCampaignChatMetadata,
} from "../services/landing-campaigns/metadata.js";
import { createMeChat } from "../services/me-chat.js";
import { uuidv7 } from "../uuid.js";
import { createAdminContext, createTestApp, useTestApp } from "./helpers.js";

const EXPORT_URL = "/api/v1/internal/analytics/scan-campaign-exports";
const SERVICE_ORG_ID = "scan-export-service-org";
const SERVICE_USER_ID = "scan-export-service-user";
const OFFICIAL_CLIENT_ID = "scan-export-client";

describe("scan campaign export routes", () => {
  const getApp = useTestApp({
    landingCampaignServiceUserId: SERVICE_USER_ID,
    landingCampaignServiceOrgId: SERVICE_ORG_ID,
    landingCampaignClientId: OFFICIAL_CLIENT_ID,
  });

  async function ensureServiceOrg(app: FastifyInstance) {
    await app.db
      .insert(organizations)
      .values({ id: SERVICE_ORG_ID, name: SERVICE_ORG_ID, displayName: "Scan Export Service" })
      .onConflictDoNothing();
  }

  async function addServiceOrgMembership(
    app: FastifyInstance,
    userId: string,
    role: "admin" | "member" = "admin",
    status: "active" | "left" | "removed" = "active",
  ) {
    await ensureServiceOrg(app);
    const memberId = uuidv7();
    await app.db.transaction(async (tx) => {
      const serviceHuman = await createAgent(tx as unknown as typeof app.db, {
        name: `scan-export-service-${crypto.randomUUID().slice(0, 8)}`,
        type: "human",
        displayName: "Scan Export Service Member",
        source: "admin-api",
        managerId: memberId,
        organizationId: SERVICE_ORG_ID,
      });
      await tx.insert(members).values({
        id: memberId,
        userId,
        organizationId: SERVICE_ORG_ID,
        agentId: serviceHuman.uuid,
        role,
        status,
      });
    });
  }

  async function ensureOfficialClient(app: FastifyInstance, owner: { userId: string; organizationId: string }) {
    await app.db
      .insert(clients)
      .values({
        id: OFFICIAL_CLIENT_ID,
        userId: owner.userId,
        organizationId: owner.organizationId,
        status: "connected",
      })
      .onConflictDoNothing();
  }

  async function seedTrialHistory(
    opts: {
      agentName?: string;
      agentContent?: string;
      includeBootstrap?: boolean;
      includeUnrelatedChat?: boolean;
      includeMalformedTrialChat?: boolean;
      includeCrossOrgTrialChat?: boolean;
    } = {},
  ) {
    const app = getApp();
    const admin = await createAdminContext(app);
    await addServiceOrgMembership(app, admin.userId);
    await ensureOfficialClient(app, admin);
    const agentName = opts.agentName ?? `production-scanner-${crypto.randomUUID().slice(0, 8)}`;
    const agent = await createAgent(app.db, {
      name: agentName,
      type: "agent",
      displayName: "Production Scanner",
      managerId: admin.memberId,
    });

    const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [agent.uuid],
      topic: "Production scan trial",
    });

    const chatCreatedAt = new Date("2026-07-10T10:00:00.000Z");
    const humanMessageAt = new Date("2026-07-10T10:01:30.000Z");
    const agentMessageAt = new Date("2026-07-10T10:05:00.000Z");

    await app.db
      .update(agents)
      .set({
        clientId: OFFICIAL_CLIENT_ID,
        metadata: buildLandingCampaignAgentMetadata({
          campaign: "production-scan",
          skillSetId: "production-scan",
          skillSetVersion: "test",
        }),
      })
      .where(eq(agents.uuid, agent.uuid));

    await app.db
      .update(chats)
      .set({
        createdAt: chatCreatedAt,
        lastMessageAt: agentMessageAt,
        metadata: buildLandingCampaignChatMetadata({
          campaign: "production-scan",
          agentId: agent.uuid,
          skillSetId: "production-scan",
          skillSetVersion: "test",
          repo: { url: "https://github.com/acme/api", canonicalKey: "github.com/acme/api" },
          state: "completed",
          inputLocked: true,
          maxAgentTurns: 2,
          completedAgentTurns: 2,
          completedAgentTurnIds: ["turn-1", "turn-2"],
          maxEstimatedTokens: 1000,
          estimatedTokensUsed: 420,
        }),
      })
      .where(eq(chats.id, chatId));

    if (opts.includeUnrelatedChat) {
      const unrelatedChatId = uuidv7();
      await app.db.insert(chats).values({
        id: unrelatedChatId,
        organizationId: admin.organizationId,
        type: "direct",
        topic: "Unrelated scanner chat",
        metadata: {},
      });
      await app.db.insert(chatMembership).values([
        { chatId: unrelatedChatId, agentId: admin.humanAgentUuid, role: "owner", accessMode: "speaker" },
        { chatId: unrelatedChatId, agentId: agent.uuid, role: "member", accessMode: "speaker" },
      ]);
    }

    if (opts.includeMalformedTrialChat) {
      const malformedChatId = uuidv7();
      await app.db.insert(chats).values({
        id: malformedChatId,
        organizationId: admin.organizationId,
        type: "direct",
        topic: "Malformed scanner chat",
        metadata: { landingCampaignTrial: { campaign: "production-scan", agentId: agent.uuid } },
      });
      await app.db.insert(chatMembership).values([
        { chatId: malformedChatId, agentId: admin.humanAgentUuid, role: "owner", accessMode: "speaker" },
        { chatId: malformedChatId, agentId: agent.uuid, role: "member", accessMode: "speaker" },
      ]);
    }

    if (opts.includeCrossOrgTrialChat) {
      const otherOrgId = `scan-export-other-${crypto.randomUUID().slice(0, 8)}`;
      const crossOrgChatId = uuidv7();
      await app.db.insert(organizations).values({ id: otherOrgId, name: otherOrgId, displayName: "Other Scan Org" });
      await app.db.insert(chats).values({
        id: crossOrgChatId,
        organizationId: otherOrgId,
        type: "direct",
        topic: "Cross org scanner chat",
        metadata: buildLandingCampaignChatMetadata({
          campaign: "production-scan",
          agentId: agent.uuid,
          skillSetId: "production-scan",
          skillSetVersion: "test",
          repo: { url: "https://github.com/acme/api", canonicalKey: "github.com/acme/api" },
          state: "completed",
          inputLocked: true,
          maxAgentTurns: 2,
        }),
      });
      await app.db
        .insert(chatMembership)
        .values({ chatId: crossOrgChatId, agentId: agent.uuid, role: "member", accessMode: "speaker" });
    }

    await app.db.insert(messages).values([
      ...(opts.includeBootstrap
        ? [
            {
              id: uuidv7(),
              chatId,
              senderId: admin.humanAgentUuid,
              format: "text",
              content: "System bootstrap for https://github.com/acme/api",
              metadata: { systemSender: "first_tree_onboarding", landingCampaignTrial: true },
              source: "api",
              createdAt: chatCreatedAt,
            },
          ]
        : []),
      {
        id: uuidv7(),
        chatId,
        senderId: admin.humanAgentUuid,
        format: "text",
        content: "Please scan https://github.com/acme/api with token=secret-value",
        metadata: { token: "secret-value" },
        source: "web",
        createdAt: humanMessageAt,
      },
      {
        id: uuidv7(),
        chatId,
        senderId: agent.uuid,
        format: "markdown",
        content:
          opts.agentContent ?? "Report ready: https://example.test/report ghp_123456789012345678901234567890123456",
        metadata: {},
        source: "api",
        createdAt: agentMessageAt,
      },
    ]);

    return { app, admin, agent, agentName, chatId };
  }

  it("exports trial, summary, and redacted message NDJSON for a client campaign", async () => {
    const { app, admin, agent, agentName, chatId } = await seedTrialHistory();

    const create = await app.inject({
      method: "POST",
      url: EXPORT_URL,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: {
        clientId: OFFICIAL_CLIENT_ID,
        agentName,
        campaign: "production-scan",
        from: "2026-07-09T00:00:00.000Z",
        to: "2026-07-11T00:00:00.000Z",
        includeMessages: true,
      },
    });

    expect(create.statusCode).toBe(200);
    const body = create.json();
    expect(body.manifest.counts).toEqual({ trials: 1, chats: 1, messages: 2, exportedMessages: 2 });
    const trials = body.files["trials.ndjson"].trim().split("\n").map(JSON.parse);
    const summaries = body.files["summaries.ndjson"].trim().split("\n").map(JSON.parse);
    const exportedMessages = body.files["messages.ndjson"].trim().split("\n").map(JSON.parse);

    expect(trials[0]).toMatchObject({
      trialId: agent.uuid,
      agentName,
      clientId: OFFICIAL_CLIENT_ID,
      campaign: "production-scan",
    });
    expect(summaries[0]).toMatchObject({
      trialId: agent.uuid,
      chatId,
      outcome: "completed",
      humanMessageCount: 1,
      agentMessageCount: 1,
      firstHumanResponseSeconds: 90,
      durationSeconds: 300,
      hasLikelyReportLink: true,
    });
    expect(exportedMessages[0]).toMatchObject({
      chatId,
      senderRole: "human_or_other",
      metadata: { token: "[REDACTED]" },
    });
    expect(exportedMessages[0].content).toContain("token=[REDACTED]");
    expect(exportedMessages[1]).toMatchObject({ senderRole: "agent" });
    expect(exportedMessages[1].content).toContain("[REDACTED_GITHUB_TOKEN]");
  });

  it("computes summaries when message export is disabled", async () => {
    const { app, admin, agentName } = await seedTrialHistory();

    const create = await app.inject({
      method: "POST",
      url: EXPORT_URL,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: {
        clientId: OFFICIAL_CLIENT_ID,
        agentName,
        campaign: "production-scan",
        includeMessages: false,
      },
    });

    expect(create.statusCode).toBe(200);
    const body = create.json();
    expect(body.manifest.counts).toEqual({ trials: 1, chats: 1, messages: 2, exportedMessages: 0 });
    expect(body.files).not.toHaveProperty("messages.ndjson");
    const summaries = body.files["summaries.ndjson"].trim().split("\n").map(JSON.parse);
    expect(summaries[0]).toMatchObject({ humanMessageCount: 1, agentMessageCount: 1, totalMessageCount: 2 });
  });

  it("redacts message metadata without message bodies when requested", async () => {
    const { app, admin, agentName } = await seedTrialHistory();

    const create = await app.inject({
      method: "POST",
      url: EXPORT_URL,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: {
        clientId: OFFICIAL_CLIENT_ID,
        agentName,
        campaign: "production-scan",
        includeMessages: true,
        redaction: "metadata_only",
      },
    });

    expect(create.statusCode).toBe(200);
    const body = create.json();
    const exportedMessages = body.files["messages.ndjson"].trim().split("\n").map(JSON.parse);
    expect(exportedMessages[0]).not.toHaveProperty("content");
    expect(exportedMessages[0]).toMatchObject({
      contentLength: expect.any(Number),
      metadata: { token: "[REDACTED]" },
    });
  });

  it("allows active service organization regular members", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);
    await addServiceOrgMembership(app, admin.userId, "member");
    await ensureOfficialClient(app, admin);
    const { agentName } = await seedTrialHistory();

    const create = await app.inject({
      method: "POST",
      url: EXPORT_URL,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { clientId: OFFICIAL_CLIENT_ID, agentName, campaign: "production-scan", includeMessages: false },
    });

    expect(create.statusCode).toBe(200);
  });

  it("denies callers without active service organization membership", async () => {
    const { app, agentName } = await seedTrialHistory();
    const customerOnly = await createAdminContext(app);

    const customerOrgOnly = await app.inject({
      method: "POST",
      url: EXPORT_URL,
      headers: { authorization: `Bearer ${customerOnly.accessToken}` },
      payload: { clientId: OFFICIAL_CLIENT_ID, agentName, campaign: "production-scan" },
    });
    expect(customerOrgOnly.statusCode).toBe(403);

    await addServiceOrgMembership(app, customerOnly.userId, "member", "left");
    const leftServiceMember = await app.inject({
      method: "POST",
      url: EXPORT_URL,
      headers: { authorization: `Bearer ${customerOnly.accessToken}` },
      payload: { clientId: OFFICIAL_CLIENT_ID, agentName, campaign: "production-scan" },
    });
    expect(leftServiceMember.statusCode).toBe(403);
  });

  it("denies the wrong configured client and excludes invalid or unrelated customer chats", async () => {
    const { app, admin, agentName } = await seedTrialHistory({
      includeUnrelatedChat: true,
      includeMalformedTrialChat: true,
      includeCrossOrgTrialChat: true,
    });

    const wrongClient = await app.inject({
      method: "POST",
      url: EXPORT_URL,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { clientId: admin.clientId, agentName, campaign: "production-scan" },
    });
    expect(wrongClient.statusCode).toBe(403);

    const create = await app.inject({
      method: "POST",
      url: EXPORT_URL,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { clientId: OFFICIAL_CLIENT_ID, agentName, campaign: "production-scan" },
    });
    const body = create.json();
    expect(body.manifest.counts.chats).toBe(1);
  });

  it("does not treat user repository URLs as agent report links", async () => {
    const { app, admin, agentName } = await seedTrialHistory({
      agentContent: "I am scanning https://github.com/acme/api now.",
    });

    const create = await app.inject({
      method: "POST",
      url: EXPORT_URL,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { clientId: OFFICIAL_CLIENT_ID, agentName, campaign: "production-scan" },
    });

    const body = create.json();
    const summaries = body.files["summaries.ndjson"].trim().split("\n").map(JSON.parse);
    expect(summaries[0].hasLikelyReportLink).toBe(false);
  });

  it("classifies landing campaign bootstrap messages as system messages", async () => {
    const { app, admin, agentName } = await seedTrialHistory({ includeBootstrap: true });

    const create = await app.inject({
      method: "POST",
      url: EXPORT_URL,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { clientId: OFFICIAL_CLIENT_ID, agentName, campaign: "production-scan", includeMessages: false },
    });

    const body = create.json();
    expect(body.manifest.counts).toMatchObject({ messages: 3, exportedMessages: 0 });
    const summaries = body.files["summaries.ndjson"].trim().split("\n").map(JSON.parse);
    expect(summaries[0]).toMatchObject({
      humanMessageCount: 1,
      agentMessageCount: 1,
      systemMessageCount: 1,
      firstHumanResponseSeconds: 90,
    });
  });
});

describe("scan campaign export configuration guard", () => {
  it("fails closed when landing campaign service org is not configured", async () => {
    const app = await createTestApp();
    try {
      const admin = await createAdminContext(app);
      const denied = await app.inject({
        method: "POST",
        url: EXPORT_URL,
        headers: { authorization: `Bearer ${admin.accessToken}` },
        payload: { clientId: OFFICIAL_CLIENT_ID, agentName: "production-scanner", campaign: "production-scan" },
      });
      expect(denied.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("fails closed when the caller belongs to a different service organization than the configured one", async () => {
    const app = await createTestApp({
      landingCampaignServiceUserId: SERVICE_USER_ID,
      landingCampaignServiceOrgId: "scan-export-wrong-service-org",
      landingCampaignClientId: OFFICIAL_CLIENT_ID,
    });
    try {
      const admin = await createAdminContext(app);
      await app.db
        .insert(organizations)
        .values({ id: SERVICE_ORG_ID, name: SERVICE_ORG_ID, displayName: "Scan Export Service" })
        .onConflictDoNothing();
      const memberId = uuidv7();
      await app.db.transaction(async (tx) => {
        const serviceHuman = await createAgent(tx as unknown as typeof app.db, {
          name: `scan-export-wrong-config-${crypto.randomUUID().slice(0, 8)}`,
          type: "human",
          displayName: "Wrong Config Service Member",
          source: "admin-api",
          managerId: memberId,
          organizationId: SERVICE_ORG_ID,
        });
        await tx.insert(members).values({
          id: memberId,
          userId: admin.userId,
          organizationId: SERVICE_ORG_ID,
          agentId: serviceHuman.uuid,
          role: "admin",
          status: "active",
        });
      });

      const denied = await app.inject({
        method: "POST",
        url: EXPORT_URL,
        headers: { authorization: `Bearer ${admin.accessToken}` },
        payload: { clientId: OFFICIAL_CLIENT_ID, agentName: "production-scanner", campaign: "production-scan" },
      });
      expect(denied.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});
