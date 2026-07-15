import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agents, chats, messages } from "../db/schema/index.js";
import { createAgent } from "../services/agent.js";
import {
  buildLandingCampaignAgentMetadata,
  buildLandingCampaignChatMetadata,
} from "../services/landing-campaigns/metadata.js";
import { createMeChat } from "../services/me-chat.js";
import { uuidv7 } from "../uuid.js";
import { createAdminContext, useTestApp } from "./helpers.js";

const EXPORT_URL = "/api/v1/internal/analytics/scan-campaign-exports";

describe("scan campaign export routes", () => {
  const getApp = useTestApp();

  async function seedTrialHistory(opts: { agentName?: string } = {}) {
    const app = getApp();
    const admin = await createAdminContext(app);
    const agentName = opts.agentName ?? `production-scanner-${crypto.randomUUID().slice(0, 8)}`;
    const agent = await createAgent(app.db, {
      name: agentName,
      type: "agent",
      displayName: "Production Scanner",
      managerId: admin.memberId,
      clientId: admin.clientId,
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

    await app.db.insert(messages).values([
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
        content: "Report ready: https://example.test/report ghp_123456789012345678901234567890123456",
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
        clientId: admin.clientId,
        agentName,
        campaign: "production-scan",
        from: "2026-07-09T00:00:00.000Z",
        to: "2026-07-11T00:00:00.000Z",
        includeMessages: true,
      },
    });

    expect(create.statusCode).toBe(201);
    const created = create.json();
    expect(created.manifest.counts).toEqual({ trials: 1, chats: 1, messages: 2 });
    expect(created.files).toBeUndefined();

    const download = await app.inject({
      method: "GET",
      url: `${EXPORT_URL}/${created.exportId}/download`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });

    expect(download.statusCode).toBe(200);
    const body = download.json();
    const trials = body.files["trials.ndjson"].trim().split("\n").map(JSON.parse);
    const summaries = body.files["summaries.ndjson"].trim().split("\n").map(JSON.parse);
    const exportedMessages = body.files["messages.ndjson"].trim().split("\n").map(JSON.parse);

    expect(trials[0]).toMatchObject({
      trialId: agent.uuid,
      agentName,
      clientId: admin.clientId,
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

  it("can export message metadata without message bodies", async () => {
    const { app, admin, agentName } = await seedTrialHistory();

    const create = await app.inject({
      method: "POST",
      url: EXPORT_URL,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: {
        clientId: admin.clientId,
        agentName,
        campaign: "production-scan",
        includeMessages: true,
        redaction: "metadata_only",
      },
    });

    expect(create.statusCode).toBe(201);
    const created = create.json();

    const download = await app.inject({
      method: "GET",
      url: `${EXPORT_URL}/${created.exportId}/download`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });

    const body = download.json();
    const exportedMessages = body.files["messages.ndjson"].trim().split("\n").map(JSON.parse);
    expect(exportedMessages[0]).not.toHaveProperty("content");
    expect(exportedMessages[0]).toMatchObject({
      contentLength: expect.any(Number),
      metadata: { token: "[REDACTED]" },
    });
  });
});
