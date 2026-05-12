import { createHmac, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { chats } from "../db/schema/chats.js";
import { githubEntityChatMappings } from "../db/schema/github-entity-chat-mappings.js";
import { upsertInstallationFromMetadata } from "../services/github-app-installations.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

// Matches the test fixture in helpers.ts (`webhookSecret: "test-app-webhook-secret"`).
const WEBHOOK_SECRET = "test-app-webhook-secret";
const PATH = "/api/v1/webhooks/github";

function signBody(body: string): string {
  return `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex")}`;
}

function withInstallation<T extends Record<string, unknown>>(payload: T, installationId: number): T {
  return { ...payload, installation: { id: installationId } };
}

async function postWebhook(
  app: ReturnType<ReturnType<typeof useTestApp>>,
  installationId: number,
  eventType: string,
  payload: object,
) {
  const body = JSON.stringify(withInstallation(payload as Record<string, unknown>, installationId));
  return app.inject({
    method: "POST",
    url: PATH,
    headers: {
      "content-type": "application/json",
      "x-github-event": eventType,
      "x-github-delivery": randomUUID(),
      "x-hub-signature-256": signBody(body),
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

/** Bind a GitHub App installation row to the admin's org so the webhook can
 * resolve installation_id → hub_organization_id during dispatch. Each test
 * mints a fresh installation_id to avoid cross-test pollution of the
 * `github_app_installations` UNIQUE(installation_id) constraint. */
async function bindInstallation(
  app: ReturnType<ReturnType<typeof useTestApp>>,
  organizationId: string,
): Promise<{ installationId: number }> {
  // 9_900_000–9_999_999 keeps test installation IDs disjoint from the App
  // webhook test fixtures (which use the same range but never collide
  // because each test creates a fresh org).
  const installationId = 9_900_000 + Math.floor(Math.random() * 99_999);
  await upsertInstallationFromMetadata(app.db, {
    installation: {
      id: installationId,
      accountType: "Organization",
      accountLogin: "acme",
      accountGithubId: 7_700_001,
      permissions: {},
      events: [],
      suspendedAt: null,
    },
    hubOrganizationId: organizationId,
  });
  return { installationId };
}

describe("GitHub App webhook — entity-clustering routing (Phase 0)", () => {
  const getApp = useTestApp();

  it("creates a fresh entity chat on issues.opened and reuses it for follow-up issue_comment", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const { reviewerLogin, delegateUuid } = await seedReviewerWithDelegate(app, admin);
    const { installationId } = await bindInstallation(app, admin.organizationId);

    const r1 = await postWebhook(app, installationId, "issues", issueOpenedPayload(reviewerLogin, 42));
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

    const r2 = await postWebhook(
      app,
      installationId,
      "issue_comment",
      issueCommentPayload(reviewerLogin, 42, `cc @${reviewerLogin}`),
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
    const { installationId } = await bindInstallation(app, admin.organizationId);

    // Seed the issue chat first.
    await postWebhook(app, installationId, "issues", issueOpenedPayload(reviewerLogin, 100));
    const issueMappings = await app.db
      .select()
      .from(githubEntityChatMappings)
      .where(eq(githubEntityChatMappings.delegateAgentId, delegateUuid));
    expect(issueMappings).toHaveLength(1);
    const issueChatId = issueMappings[0]?.chatId;

    // PR `Fixes #100` should reuse the issue's chat.
    const prRes = await postWebhook(
      app,
      installationId,
      "pull_request",
      pullRequestOpenedPayload(reviewerLogin, 200, `Fixes #100\n\n@${reviewerLogin} ready for review`),
    );
    expect(prRes.statusCode).toBe(200);

    const allMappings = await app.db
      .select()
      .from(githubEntityChatMappings)
      .where(eq(githubEntityChatMappings.delegateAgentId, delegateUuid));
    // The PR adds a row with the same chatId (via fixes_link).
    expect(allMappings).toHaveLength(2);
    const prMapping = allMappings.find((m) => m.entityKey === "owner/repo#200");
    expect(prMapping?.chatId).toBe(issueChatId);
    expect(prMapping?.boundVia).toBe("fixes_link");
  });

  it("does NOT link via Fixes when the keyword appears in a non-PR event body", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const { reviewerLogin, delegateUuid } = await seedReviewerWithDelegate(app, admin);
    const { installationId } = await bindInstallation(app, admin.organizationId);

    // Issue body claims "Fixes #42" but it's an issue, not a PR — must not link.
    await postWebhook(app, installationId, "issues", {
      action: "opened",
      issue: {
        number: 300,
        title: `Discuss`,
        body: `Fixes #42 — but I'm an issue. cc @${reviewerLogin}`,
        html_url: `https://github.com/owner/repo/issues/300`,
      },
      repository: { full_name: "owner/repo" },
      sender: { login: "another-engineer", type: "User" },
    });

    const mappings = await app.db
      .select()
      .from(githubEntityChatMappings)
      .where(eq(githubEntityChatMappings.delegateAgentId, delegateUuid));
    expect(mappings).toHaveLength(1);
    expect(mappings[0]?.entityKey).toBe("owner/repo#300");
    expect(mappings[0]?.boundVia).toBe("direct");
  });

  it("returns silent: true and creates no chat for workflow_run", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const { delegateUuid } = await seedReviewerWithDelegate(app, admin);
    const { installationId } = await bindInstallation(app, admin.organizationId);

    const res = await postWebhook(app, installationId, "workflow_run", workflowRunPayload());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, event: "workflow_run", silent: true });

    const mappings = await app.db
      .select()
      .from(githubEntityChatMappings)
      .where(eq(githubEntityChatMappings.delegateAgentId, delegateUuid));
    expect(mappings).toHaveLength(0);
  });

  it("returns handled:false (action-level silence) for issues.labeled", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const { reviewerLogin, delegateUuid } = await seedReviewerWithDelegate(app, admin);
    const { installationId } = await bindInstallation(app, admin.organizationId);

    const res = await postWebhook(app, installationId, "issues", {
      action: "labeled",
      issue: {
        number: 42,
        title: "Refactor inbox",
        body: `Hey @${reviewerLogin}`,
        html_url: `https://github.com/owner/repo/issues/42`,
      },
      label: { name: "needs-triage" },
      repository: { full_name: "owner/repo" },
      sender: { login: "another-engineer", type: "User" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, event: "issues", handled: false });

    const mappings = await app.db
      .select()
      .from(githubEntityChatMappings)
      .where(eq(githubEntityChatMappings.delegateAgentId, delegateUuid));
    expect(mappings).toHaveLength(0);
  });

  it("fan-outs to independent chats per human when two reviewers are @-mentioned", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const { reviewerLogin: r1, delegateUuid: d1 } = await seedReviewerWithDelegate(app, admin);

    // Second human + delegate. `createTestAdmin` resolves to the same default
    // org, so both reviewers live under one installation binding.
    const admin2 = await createTestAdmin(app);
    const { reviewerLogin: r2, delegateUuid: d2 } = await seedReviewerWithDelegate(app, admin2);
    const { installationId } = await bindInstallation(app, admin.organizationId);

    const res = await postWebhook(app, installationId, "issues", {
      action: "opened",
      issue: {
        number: 555,
        title: `Big change`,
        body: `Hey @${r1} and @${r2} please review`,
        html_url: `https://github.com/owner/repo/issues/555`,
      },
      repository: { full_name: "owner/repo" },
      sender: { login: "another-engineer", type: "User" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, event: "issues", mentionsRouted: 2 });

    const m1 = await app.db
      .select()
      .from(githubEntityChatMappings)
      .where(eq(githubEntityChatMappings.delegateAgentId, d1));
    const m2 = await app.db
      .select()
      .from(githubEntityChatMappings)
      .where(eq(githubEntityChatMappings.delegateAgentId, d2));
    expect(m1).toHaveLength(1);
    expect(m2).toHaveLength(1);
    expect(m1[0]?.chatId).not.toBe(m2[0]?.chatId);
  });
});
