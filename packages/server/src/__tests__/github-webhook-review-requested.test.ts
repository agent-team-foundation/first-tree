import { createHmac, randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { chatParticipants, chats } from "../db/schema/chats.js";
import { organizations } from "../db/schema/organizations.js";
import { putOrgSetting } from "../services/org-settings.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

const TEST_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function signBody(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

async function configureWebhookSecret(
  app: ReturnType<ReturnType<typeof useTestApp>>,
  orgId: string,
  userId: string,
  secret: string,
): Promise<void> {
  await putOrgSetting(
    app.db,
    orgId,
    "github_integration",
    { webhookSecret: secret },
    {
      updatedBy: userId,
      encryptionKey: TEST_ENCRYPTION_KEY,
    },
  );
}

async function makeForeignOrgAgent(
  app: ReturnType<ReturnType<typeof useTestApp>>,
  label: string,
  fallbackManagerId: string,
): Promise<{ orgId: string; agentUuid: string }> {
  const orgId = `org-${label}-${randomUUID().slice(0, 6)}`;
  await app.db.insert(organizations).values({
    id: orgId,
    name: orgId.slice(0, 30),
    displayName: `Org ${label}`,
  });
  const agentUuid = randomUUID();
  await app.db.insert(agents).values({
    uuid: agentUuid,
    name: `bot-${label}-${randomUUID().slice(0, 6)}`,
    organizationId: orgId,
    type: "autonomous_agent",
    displayName: `Bot ${label}`,
    inboxId: `inbox_${agentUuid}`,
    managerId: fallbackManagerId,
  });
  return { orgId, agentUuid };
}

function reviewRequestedPayload(reviewerLogin: string) {
  return {
    action: "review_requested",
    pull_request: {
      number: 293,
      title: "Test PR",
      body: "PR description without any at-mention",
      html_url: "https://github.com/agent-team-foundation/first-tree-hub/pull/293",
    },
    requested_reviewer: { login: reviewerLogin },
    repository: { full_name: "agent-team-foundation/first-tree-hub" },
    sender: { login: "another-engineer" },
  };
}

async function postWebhook(
  app: ReturnType<ReturnType<typeof useTestApp>>,
  orgId: string,
  secret: string,
  payload: object,
) {
  const body = JSON.stringify(payload);
  return app.inject({
    method: "POST",
    url: `/api/v1/webhooks/github/${orgId}`,
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-github-delivery": randomUUID(),
      "x-hub-signature-256": signBody(secret, body),
    },
    payload: body,
  });
}

/**
 * Count direct chats that contain BOTH given agents as participants. A 0/1
 * delta around the webhook call is the end-to-end witness that fan-out
 * actually created the source↔delegate chat.
 */
async function countDirectChatsBetween(
  app: ReturnType<ReturnType<typeof useTestApp>>,
  agentA: string,
  agentB: string,
): Promise<number> {
  const aRows = await app.db
    .select({ chatId: chatParticipants.chatId })
    .from(chatParticipants)
    .where(eq(chatParticipants.agentId, agentA));
  const bRows = await app.db
    .select({ chatId: chatParticipants.chatId })
    .from(chatParticipants)
    .where(eq(chatParticipants.agentId, agentB));
  const bSet = new Set(bRows.map((r) => r.chatId));
  const sharedIds = aRows.map((r) => r.chatId).filter((id) => bSet.has(id));
  if (sharedIds.length === 0) return 0;
  const directChats = await app.db
    .select({ id: chats.id })
    .from(chats)
    .where(and(inArray(chats.id, sharedIds), eq(chats.type, "direct")));
  return directChats.length;
}

describe("GitHub webhook — pull_request.review_requested", () => {
  const getApp = useTestApp();

  it("routes review_requested to the reviewer's delegate_mention agent (same org)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    const delegateUuid = randomUUID();
    await app.db.insert(agents).values({
      uuid: delegateUuid,
      name: `delegate-${randomUUID().slice(0, 6)}`,
      organizationId: admin.organizationId,
      type: "autonomous_agent",
      displayName: "Delegate Target",
      inboxId: `inbox_${delegateUuid}`,
      managerId: admin.memberId,
    });

    // Source agent — its `name` must equal the GitHub login that the webhook
    // payload will carry as `requested_reviewer.login`. Real users hit this
    // because GitHub login → human agent name is the org's identity binding.
    const reviewerLogin = `reviewer-${randomUUID().slice(0, 6)}`;
    await app.db
      .update(agents)
      .set({ name: reviewerLogin, delegateMention: delegateUuid })
      .where(eq(agents.uuid, admin.humanAgentUuid));

    const secret = "test-webhook-secret";
    await configureWebhookSecret(app, admin.organizationId, admin.userId, secret);

    const before = await countDirectChatsBetween(app, admin.humanAgentUuid, delegateUuid);
    const res = await postWebhook(app, admin.organizationId, secret, reviewRequestedPayload(reviewerLogin));
    const after = await countDirectChatsBetween(app, admin.humanAgentUuid, delegateUuid);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, event: "pull_request", mentionsRouted: 1 });
    // End-to-end witness: the routing layer reached fan-out and created the
    // (source, delegate) direct chat. Without this assertion `mentionsRouted: 1`
    // alone would not prove a chat row was actually persisted.
    expect(after - before).toBe(1);
  });

  it("does nothing when reviewer has no agent in this org", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    const secret = "test-webhook-secret";
    await configureWebhookSecret(app, admin.organizationId, admin.userId, secret);

    const res = await postWebhook(
      app,
      admin.organizationId,
      secret,
      reviewRequestedPayload(`stranger-${randomUUID().slice(0, 6)}`),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, event: "pull_request", mentionsRouted: 0 });
  });

  // Note: the cross-org delegate-target rejection path is unit-tested in
  // `evaluate-delegate-target.test.ts` (verdict ordering, defensive equality
  // semantics). Re-asserting it here would either need log capture or an
  // unstable `vi.mock` of `findOrCreateDirectChat` to distinguish the new
  // routing-layer rejection from the legacy `findOrCreateDirectChat`-throws
  // path — the unit test gives stronger evidence with no infrastructure cost.
  // The belt-and-suspenders end-to-end safety is provided by plan A in
  // `agent-delegate-mention-cross-org.test.ts`, which forbids the dirty data
  // shape from being written in the first place.
  it("with admin-API-written data the cross-org case cannot arise (plan A guard)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const foreign = await makeForeignOrgAgent(app, "x", admin.memberId);

    // Verify plan A's promise: the same dirty write that the cross-org
    // routing guard defends against is rejected at the source.
    const { updateAgent } = await import("../services/agent.js");
    await expect(updateAgent(app.db, admin.humanAgentUuid, { delegateMention: foreign.agentUuid })).rejects.toThrow(
      /same organization/,
    );
  });
});
