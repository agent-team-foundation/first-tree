import crypto from "node:crypto";
import { parseLandingCampaignTrialChatMetadata } from "@first-tree/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { chats } from "../db/schema/chats.js";
import { clients } from "../db/schema/clients.js";
import { messages } from "../db/schema/messages.js";
import { createAgent } from "../services/agent.js";
import { buildLandingCampaignChatMetadata } from "../services/landing-campaigns/metadata.js";
import { createMeChat } from "../services/me-chat.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

/**
 * The production-scan "fix blockers" conversion creates its launcher through
 * two different endpoints — the not-yet-onboarded onboarding path
 * (`POST /me/onboarding/kickoff`) and the already-onboarded direct path
 * (`POST /orgs/:orgId/chats` task mode). Both now compose the SAME idempotency
 * key `<humanAgent>:scan-fix:<repoSlug>` and write it to
 * `chats.onboarding_kickoff_key`, so re-entering the fix link — via either path
 * — reuses the one launcher instead of creating a duplicate `Fix production
 * scan blockers` chat.
 */

async function createOrgAgent(
  app: ReturnType<ReturnType<typeof useTestApp>>,
  admin: Awaited<ReturnType<typeof createTestAdmin>>,
) {
  const clientId = `cli-${crypto.randomUUID().slice(0, 8)}`;
  await app.db.insert(clients).values({
    id: clientId,
    userId: admin.userId,
    organizationId: admin.organizationId,
    status: "connected",
  });
  return createAgent(app.db, {
    name: `bootstrap-${crypto.randomUUID().slice(0, 8)}`,
    type: "agent",
    displayName: "Bootstrap Agent",
    managerId: admin.memberId,
    clientId,
  });
}

const KICKOFF_URL = "/api/v1/me/onboarding/kickoff";
const FIX_TOPIC = "Fix production scan blockers";
const REPO_SLUG = "acme/orders";

function kickoffFixPayload(admin: Awaited<ReturnType<typeof createTestAdmin>>, agentUuid: string) {
  return {
    organizationId: admin.organizationId,
    agentUuid,
    bootstrap: "Fix the launch blockers (onboarding path).",
    topic: FIX_TOPIC,
    campaignAction: { campaign: "production-scan", repoSlug: REPO_SLUG },
    complete: true,
  };
}

function directFixPayload(agentUuid: string) {
  return {
    mode: "task" as const,
    topic: FIX_TOPIC,
    campaignAction: { campaign: "production-scan", repoSlug: REPO_SLUG },
    initialRecipientAgentIds: [agentUuid],
    initialRecipientNames: [],
    contextParticipantAgentIds: [],
    contextParticipantNames: [],
    initialMessage: { source: "web" as const, format: "text" as const, content: "Fix the launch blockers (direct)." },
  };
}

async function seedAttributableTrial(
  app: ReturnType<ReturnType<typeof useTestApp>>,
  admin: Awaited<ReturnType<typeof createTestAdmin>>,
  agentUuid: string,
): Promise<{ chatId: string; attemptId: string }> {
  const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
    participantIds: [agentUuid],
    topic: "Production scan trial",
  });
  const attemptId = crypto.randomUUID();
  await app.db
    .update(chats)
    .set({
      metadata: buildLandingCampaignChatMetadata({
        campaign: "production-scan",
        agentId: agentUuid,
        skillSetId: "production-scan",
        skillSetVersion: "test",
        repo: { url: `https://github.com/${REPO_SLUG}`, canonicalKey: `github.com/${REPO_SLUG}` },
        attribution: { attemptId, variant: "control" },
        state: "completed",
        inputLocked: true,
        maxAgentTurns: 1,
      }),
    })
    .where(eq(chats.id, chatId));
  return { chatId, attemptId };
}

describe("production-scan fix conversion — cross-path idempotency", () => {
  const getApp = useTestApp({ growthLandingPagesEnabled: true });

  it("dedups the fix launcher across the onboarding path and the direct path", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const agent = await createOrgAgent(app, admin);
    const trial = await seedAttributableTrial(app, admin, agent.uuid);

    // PATH 1 — not-yet-onboarded: onboarding kickoff creates the fix launcher,
    // keyed `<human>:scan-fix:<repoSlug>`.
    const onboarding = await app.inject({
      method: "POST",
      url: KICKOFF_URL,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: kickoffFixPayload(admin, agent.uuid),
    });
    expect(onboarding.statusCode).toBe(200);
    const chat1 = onboarding.json<{ chatId: string }>().chatId;

    // Its kickoff key is the scan-fix key, not the default onboarding key.
    const [row1] = await app.db.select().from(chats).where(eq(chats.id, chat1)).limit(1);
    expect(row1?.onboardingKickoffKey).toBe(`${admin.humanAgentUuid}:scan-fix:${REPO_SLUG}`);

    // PATH 2 — user re-enters the fix link once onboarded → direct path. Same
    // key ⇒ reuse chat1, not a second launcher.
    const direct = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${encodeURIComponent(admin.organizationId)}/chats`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: directFixPayload(agent.uuid),
    });
    expect(direct.statusCode).toBe(201);
    const chat2 = direct.json<{ chatId: string }>().chatId;

    expect(chat2).toBe(chat1);
    const fixChats = await app.db.select().from(chats).where(eq(chats.topic, FIX_TOPIC));
    expect(fixChats).toHaveLength(1);
    // Reuse must be clean: the second path reopened the launcher without
    // appending a duplicate bootstrap message.
    const msgs = await app.db.select().from(messages).where(eq(messages.chatId, chat1));
    expect(msgs).toHaveLength(1);
    const [trialRow] = await app.db.select({ metadata: chats.metadata }).from(chats).where(eq(chats.id, trial.chatId));
    expect(parseLandingCampaignTrialChatMetadata(trialRow?.metadata)).toMatchObject({
      attribution: { attemptId: trial.attemptId, variant: "control" },
      actionConversion: { chatId: chat1, recordedAt: expect.any(String) },
    });
  });

  it("the direct path alone is idempotent on re-entry", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const agent = await createOrgAgent(app, admin);
    const trial = await seedAttributableTrial(app, admin, agent.uuid);
    const url = `/api/v1/orgs/${encodeURIComponent(admin.organizationId)}/chats`;
    const headers = { authorization: `Bearer ${admin.accessToken}` };

    const a = await app.inject({ method: "POST", url, headers, payload: directFixPayload(agent.uuid) });
    const b = await app.inject({ method: "POST", url, headers, payload: directFixPayload(agent.uuid) });
    expect(a.json<{ chatId: string }>().chatId).toBe(b.json<{ chatId: string }>().chatId);
    const fixChats = await app.db.select().from(chats).where(eq(chats.topic, FIX_TOPIC));
    expect(fixChats).toHaveLength(1);
    const actionChatId = a.json<{ chatId: string }>().chatId;
    const [trialRow] = await app.db.select({ metadata: chats.metadata }).from(chats).where(eq(chats.id, trial.chatId));
    expect(parseLandingCampaignTrialChatMetadata(trialRow?.metadata)?.actionConversion).toMatchObject({
      chatId: actionChatId,
      recordedAt: expect.any(String),
    });
  });

  it("the onboarding path alone is idempotent on re-entry", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const agent = await createOrgAgent(app, admin);
    const first = await app.inject({
      method: "POST",
      url: KICKOFF_URL,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: kickoffFixPayload(admin, agent.uuid),
    });
    const second = await app.inject({
      method: "POST",
      url: KICKOFF_URL,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: kickoffFixPayload(admin, agent.uuid),
    });
    expect(first.json<{ chatId: string }>().chatId).toBe(second.json<{ chatId: string }>().chatId);
    const fixChats = await app.db.select().from(chats).where(eq(chats.topic, FIX_TOPIC));
    expect(fixChats).toHaveLength(1);
  });

  it("dedups across differently-cased slugs (GitHub repos are case-insensitive)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const agent = await createOrgAgent(app, admin);

    const onboarding = await app.inject({
      method: "POST",
      url: KICKOFF_URL,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: {
        ...kickoffFixPayload(admin, agent.uuid),
        campaignAction: { campaign: "production-scan", repoSlug: "Acme/Orders" },
      },
    });
    const direct = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${encodeURIComponent(admin.organizationId)}/chats`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: {
        ...directFixPayload(agent.uuid),
        campaignAction: { campaign: "production-scan", repoSlug: "acme/orders" },
      },
    });
    expect(direct.json<{ chatId: string }>().chatId).toBe(onboarding.json<{ chatId: string }>().chatId);
    const fixChats = await app.db.select().from(chats).where(eq(chats.topic, FIX_TOPIC));
    expect(fixChats).toHaveLength(1);
  });

  it("keeps stale scanFixRepoSlug clients on the same production-scan key", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const agent = await createOrgAgent(app, admin);
    const generic = kickoffFixPayload(admin, agent.uuid);
    const { campaignAction: _campaignAction, ...legacy } = generic;

    const onboarding = await app.inject({
      method: "POST",
      url: KICKOFF_URL,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { ...legacy, scanFixRepoSlug: REPO_SLUG },
    });
    const direct = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${encodeURIComponent(admin.organizationId)}/chats`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: directFixPayload(agent.uuid),
    });

    expect(direct.json<{ chatId: string }>().chatId).toBe(onboarding.json<{ chatId: string }>().chatId);
  });

  it("a non-scan-fix onboarding kickoff keeps the default onboarding key", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const agent = await createOrgAgent(app, admin);
    const res = await app.inject({
      method: "POST",
      url: KICKOFF_URL,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: {
        organizationId: admin.organizationId,
        agentUuid: agent.uuid,
        bootstrap: "Get started.",
        topic: "Get started with First Tree",
      },
    });
    const [row] = await app.db.select().from(chats).where(eq(chats.id, res.json<{ chatId: string }>().chatId)).limit(1);
    expect(row?.onboardingKickoffKey).toBe(`${admin.humanAgentUuid}:${agent.uuid}:onboarding`);
  });
});
