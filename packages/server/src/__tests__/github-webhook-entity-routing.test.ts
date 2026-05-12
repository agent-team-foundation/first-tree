import { createHmac, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { chats } from "../db/schema/chats.js";
import { githubEntityChatMappings } from "../db/schema/github-entity-chat-mappings.js";
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
    { updatedBy: userId, encryptionKey: TEST_ENCRYPTION_KEY },
  );
}

async function postWebhook(
  app: ReturnType<ReturnType<typeof useTestApp>>,
  orgId: string,
  secret: string,
  eventType: string,
  payload: object,
) {
  const body = JSON.stringify(payload);
  return app.inject({
    method: "POST",
    url: `/api/v1/webhooks/github/${orgId}`,
    headers: {
      "content-type": "application/json",
      "x-github-event": eventType,
      "x-github-delivery": randomUUID(),
      "x-hub-signature-256": signBody(secret, body),
    },
    payload: body,
  });
}

function issueOpenedPayload(reviewerLogin: string, number: number) {
  return {
    action: "opened",
    issue: {
      number,
      title: `Refactor inbox #${number}`,
      body: `Hey @${reviewerLogin} please review the plan`,
      html_url: `https://github.com/owner/repo/issues/${number}`,
    },
    repository: { full_name: "owner/repo" },
    sender: { login: "another-engineer", type: "User" },
  };
}

function issueCommentPayload(_reviewerLogin: string, number: number, commentBody: string) {
  return {
    action: "created",
    issue: {
      number,
      title: `Refactor inbox #${number}`,
      html_url: `https://github.com/owner/repo/issues/${number}`,
    },
    comment: {
      body: commentBody,
      html_url: `https://github.com/owner/repo/issues/${number}#issuecomment-1`,
      user: { login: "commenter" },
    },
    repository: { full_name: "owner/repo" },
    sender: { login: "commenter", type: "User" },
  };
}

function pullRequestOpenedPayload(_reviewerLogin: string, prNumber: number, body: string) {
  return {
    action: "opened",
    pull_request: {
      number: prNumber,
      title: `Implement refactor`,
      body,
      html_url: `https://github.com/owner/repo/pull/${prNumber}`,
    },
    repository: { full_name: "owner/repo" },
    sender: { login: "another-engineer", type: "User" },
  };
}

function workflowRunPayload() {
  return {
    action: "completed",
    workflow_run: { conclusion: "success" },
    repository: { full_name: "owner/repo" },
    sender: { login: "github-actions[bot]", type: "Bot" },
  };
}

async function seedReviewerWithDelegate(
  app: ReturnType<ReturnType<typeof useTestApp>>,
  admin: Awaited<ReturnType<typeof createTestAdmin>>,
): Promise<{ reviewerLogin: string; delegateUuid: string }> {
  const delegateUuid = randomUUID();
  await app.db.insert(agents).values({
    uuid: delegateUuid,
    name: `delegate-${randomUUID().slice(0, 6)}`,
    organizationId: admin.organizationId,
    type: "autonomous_agent",
    displayName: "Delegate",
    inboxId: `inbox_${delegateUuid}`,
    managerId: admin.memberId,
  });

  const reviewerLogin = `reviewer-${randomUUID().slice(0, 6)}`;
  await app.db
    .update(agents)
    .set({ name: reviewerLogin, delegateMention: delegateUuid })
    .where(eq(agents.uuid, admin.humanAgentUuid));

  return { reviewerLogin, delegateUuid };
}

describe("GitHub webhook — entity-clustering routing (Phase 0)", () => {
  const getApp = useTestApp();

  it("creates a fresh entity chat on issues.opened and reuses it for follow-up issue_comment", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const { reviewerLogin, delegateUuid } = await seedReviewerWithDelegate(app, admin);

    const secret = "test-webhook-secret";
    await configureWebhookSecret(app, admin.organizationId, admin.userId, secret);

    const r1 = await postWebhook(app, admin.organizationId, secret, "issues", issueOpenedPayload(reviewerLogin, 42));
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toMatchObject({ ok: true, event: "issues", mentionsRouted: 1 });

    const mappingsAfter1 = await app.db
      .select()
      .from(githubEntityChatMappings)
      .where(eq(githubEntityChatMappings.delegateAgentId, delegateUuid));
    expect(mappingsAfter1).toHaveLength(1);
    expect(mappingsAfter1[0]?.entityKey).toBe("owner/repo#42");
    expect(mappingsAfter1[0]?.boundVia).toBe("direct");

    // The chat's topic and metadata follow `createEntityChat`'s contract.
    const [chat1] = await app.db
      .select()
      .from(chats)
      .where(eq(chats.id, mappingsAfter1[0]?.chatId ?? ""))
      .limit(1);
    expect(chat1?.topic).toBe(`Issue owner/repo#42: Refactor inbox #42`);
    expect(chat1?.metadata).toMatchObject({ source: "github", entityType: "issue", entityKey: "owner/repo#42" });

    // Follow-up comment on the same issue → reuses the same chat.
    const r2 = await postWebhook(
      app,
      admin.organizationId,
      secret,
      "issue_comment",
      issueCommentPayload(reviewerLogin, 42, `any update @${reviewerLogin}?`),
    );
    expect(r2.statusCode).toBe(200);
    expect(r2.json()).toMatchObject({ ok: true, event: "issue_comment", mentionsRouted: 1 });

    const mappingsAfter2 = await app.db
      .select()
      .from(githubEntityChatMappings)
      .where(eq(githubEntityChatMappings.delegateAgentId, delegateUuid));
    expect(mappingsAfter2).toHaveLength(1);
    expect(mappingsAfter2[0]?.chatId).toBe(mappingsAfter1[0]?.chatId);
  });

  it("links a PR to the issue's chat via Fixes #N", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const { reviewerLogin, delegateUuid } = await seedReviewerWithDelegate(app, admin);
    const secret = "test-webhook-secret";
    await configureWebhookSecret(app, admin.organizationId, admin.userId, secret);

    // Seed issue#42 first.
    await postWebhook(app, admin.organizationId, secret, "issues", issueOpenedPayload(reviewerLogin, 42));
    const beforeMappings = await app.db
      .select()
      .from(githubEntityChatMappings)
      .where(eq(githubEntityChatMappings.delegateAgentId, delegateUuid));
    const issueChatId = beforeMappings[0]?.chatId;

    // Open a PR referencing issue#42.
    const prBody = `Fixes #42\nThis implements the refactor. @${reviewerLogin} ready for review`;
    const prRes = await postWebhook(
      app,
      admin.organizationId,
      secret,
      "pull_request",
      pullRequestOpenedPayload(reviewerLogin, 50, prBody),
    );
    expect(prRes.statusCode).toBe(200);
    expect(prRes.json()).toMatchObject({ ok: true, event: "pull_request", mentionsRouted: 1 });

    const afterMappings = await app.db
      .select()
      .from(githubEntityChatMappings)
      .where(eq(githubEntityChatMappings.delegateAgentId, delegateUuid));
    expect(afterMappings).toHaveLength(2);
    const prMapping = afterMappings.find((m) => m.entityKey === "owner/repo#50");
    expect(prMapping).toBeDefined();
    expect(prMapping?.chatId).toBe(issueChatId);
    expect(prMapping?.boundVia).toBe("fixes_link");
  });

  it("does NOT link via Fixes when the keyword appears in a non-PR event body", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const { reviewerLogin, delegateUuid } = await seedReviewerWithDelegate(app, admin);
    const secret = "test-webhook-secret";
    await configureWebhookSecret(app, admin.organizationId, admin.userId, secret);

    // Seed issue#42 first.
    await postWebhook(app, admin.organizationId, secret, "issues", issueOpenedPayload(reviewerLogin, 42));

    // Now issue#100 with a body that includes "fixes #42" — but it's a comment,
    // not a PR, so the link MUST NOT apply (design §4.5).
    const r = await postWebhook(
      app,
      admin.organizationId,
      secret,
      "issue_comment",
      issueCommentPayload(reviewerLogin, 100, `Maybe fixes #42 too @${reviewerLogin}`),
    );
    expect(r.statusCode).toBe(200);

    const mappings = await app.db
      .select()
      .from(githubEntityChatMappings)
      .where(eq(githubEntityChatMappings.delegateAgentId, delegateUuid));
    expect(mappings).toHaveLength(2);
    const m100 = mappings.find((m) => m.entityKey === "owner/repo#100");
    expect(m100?.boundVia).toBe("direct"); // independent, not linked
    const m42 = mappings.find((m) => m.entityKey === "owner/repo#42");
    expect(m100?.chatId).not.toBe(m42?.chatId);
  });

  it("returns silent: true and creates no chat for workflow_run", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const { delegateUuid } = await seedReviewerWithDelegate(app, admin);
    const secret = "test-webhook-secret";
    await configureWebhookSecret(app, admin.organizationId, admin.userId, secret);

    const r = await postWebhook(app, admin.organizationId, secret, "workflow_run", workflowRunPayload());
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, event: "workflow_run", silent: true });

    const mappings = await app.db
      .select()
      .from(githubEntityChatMappings)
      .where(eq(githubEntityChatMappings.delegateAgentId, delegateUuid));
    expect(mappings).toHaveLength(0);
  });

  it("returns silent: true for issues.labeled (action-level silence)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const secret = "test-webhook-secret";
    await configureWebhookSecret(app, admin.organizationId, admin.userId, secret);

    const r = await postWebhook(app, admin.organizationId, secret, "issues", {
      action: "labeled",
      issue: { number: 1, title: "x", html_url: "https://x" },
      repository: { full_name: "owner/repo" },
      sender: { login: "u", type: "User" },
    });
    expect(r.json()).toMatchObject({ ok: true, silent: true });
  });

  it("fan-outs to independent chats per human when two reviewers are @-mentioned", async () => {
    const app = getApp();
    const adminA = await createTestAdmin(app);
    // `createTestAdmin` resolves the same default org each call (it calls
    // `resolveDefaultOrgId`), so we don't need a second admin to put two
    // humans in one org. We just add an extra human + delegate pair below.
    const delegateA = randomUUID();
    const delegateB = randomUUID();
    await app.db.insert(agents).values({
      uuid: delegateA,
      name: `dlgA-${randomUUID().slice(0, 6)}`,
      organizationId: adminA.organizationId,
      type: "autonomous_agent",
      displayName: "Delegate A",
      inboxId: `inbox_${delegateA}`,
      managerId: adminA.memberId,
    });
    await app.db.insert(agents).values({
      uuid: delegateB,
      name: `dlgB-${randomUUID().slice(0, 6)}`,
      organizationId: adminA.organizationId,
      type: "autonomous_agent",
      displayName: "Delegate B",
      inboxId: `inbox_${delegateB}`,
      managerId: adminA.memberId,
    });

    const loginA = `user-a-${randomUUID().slice(0, 6)}`;
    const loginB = `user-b-${randomUUID().slice(0, 6)}`;
    await app.db
      .update(agents)
      .set({ name: loginA, delegateMention: delegateA })
      .where(eq(agents.uuid, adminA.humanAgentUuid));
    // adminB belongs to a different org but we still need a same-org human
    // agent with name=loginB to test the multi-mention fan-out. Insert a
    // fresh human agent in adminA's org.
    const humanB = randomUUID();
    await app.db.insert(agents).values({
      uuid: humanB,
      name: loginB,
      organizationId: adminA.organizationId,
      type: "human",
      displayName: "Human B",
      inboxId: `inbox_${humanB}`,
      managerId: adminA.memberId,
      delegateMention: delegateB,
    });

    const secret = "test-webhook-secret";
    await configureWebhookSecret(app, adminA.organizationId, adminA.userId, secret);

    const r = await postWebhook(
      app,
      adminA.organizationId,
      secret,
      "issues",
      issueOpenedPayload(`${loginA} @${loginB}`, 42),
    );
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, mentionsRouted: 2 });

    const aMappings = await app.db
      .select()
      .from(githubEntityChatMappings)
      .where(eq(githubEntityChatMappings.delegateAgentId, delegateA));
    const bMappings = await app.db
      .select()
      .from(githubEntityChatMappings)
      .where(eq(githubEntityChatMappings.delegateAgentId, delegateB));
    expect(aMappings).toHaveLength(1);
    expect(bMappings).toHaveLength(1);
    expect(aMappings[0]?.chatId).not.toBe(bMappings[0]?.chatId);
  });
});
