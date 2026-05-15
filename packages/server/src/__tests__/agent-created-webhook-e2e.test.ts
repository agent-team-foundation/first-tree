import { createHmac, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chats } from "../db/schema/chats.js";
import { githubAppInstallations } from "../db/schema/github-app-installations.js";
import { githubEntityChatMappings } from "../db/schema/github-entity-chat-mappings.js";
import { messages } from "../db/schema/messages.js";
import { maybeBindGithubEntityFromToolCall } from "../services/github-entity-chat.js";
import { uuidv7 } from "../uuid.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

/**
 * End-to-end "agent main path" webhook simulation. Walks the full pipeline
 * exactly like a real GitHub delivery would: HMAC-signed POST → normalize →
 * audience → resolveTargetChat → delivery. No mocks; only the GitHub side
 * is faked (a static signed JSON body).
 *
 * Three scenarios cover the contract of the agent_created feature:
 *
 *   1. Happy path. Agent's `gh pr create` wrote an `agent_created` mapping.
 *      The subsequent `pull_request.opened` webhook arrives with sender =
 *      `<app-slug>[bot]` (because the agent used Hub's installation token).
 *      Expectation: existing chat receives the card; the App-bot echo
 *      suppression branch keeps subscribed targets.
 *
 *   2. PR comment after agent creation. Same `agent_created` mapping, but
 *      now a `issue_comment.created` event from an external commenter.
 *      Expectation: routes to the same chat (subscribed path), no new chat.
 *
 *   3. Negative: opened webhook with no mapping and no mention. Expectation:
 *      audience is empty, no chat invented, no mapping row, no message.
 */

const APP_WEBHOOK_SECRET = "test-app-webhook-secret";

function signBody(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

type App = ReturnType<ReturnType<typeof useTestApp>>;

async function postWebhook(app: App, eventType: string, payload: object) {
  const body = JSON.stringify(payload);
  return app.inject({
    method: "POST",
    url: "/api/v1/webhooks/github-app",
    headers: {
      "content-type": "application/json",
      "x-github-event": eventType,
      "x-github-delivery": randomUUID(),
      "x-hub-signature-256": signBody(APP_WEBHOOK_SECRET, body),
    },
    payload: body,
  });
}

async function seedDelegateAgent(app: App, opts: { orgId: string; memberId: string; name: string }): Promise<string> {
  const uuid = randomUUID();
  await app.db.insert(agents).values({
    uuid,
    name: opts.name,
    organizationId: opts.orgId,
    type: "autonomous_agent",
    displayName: opts.name,
    inboxId: `inbox_${uuid}`,
    managerId: opts.memberId,
  });
  return uuid;
}

async function seedInstallation(app: App, opts: { installationId: number; orgId: string }): Promise<void> {
  await app.db.insert(githubAppInstallations).values({
    id: uuidv7(),
    installationId: opts.installationId,
    accountType: "Organization",
    accountLogin: "owner",
    accountGithubId: 1000 + opts.installationId,
    hubOrganizationId: opts.orgId,
    permissions: { contents: "read" },
    events: ["pull_request", "issues", "issue_comment"],
  });
}

async function seedDirectChat(app: App, orgId: string, humanId: string, delegateId: string): Promise<string> {
  const chatId = `chat_${randomUUID()}`;
  await app.db.insert(chats).values({ id: chatId, organizationId: orgId, type: "direct", metadata: {} });
  await app.db.insert(chatMembership).values([
    { chatId, agentId: humanId, role: "owner", accessMode: "speaker" },
    { chatId, agentId: delegateId, role: "member", accessMode: "speaker" },
  ]);
  return chatId;
}

describe("Agent-created → real webhook end-to-end", () => {
  const getApp = useTestApp();

  it("opened webhook from <slug>[bot] routes to the agent_created chat (no new chat invented)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 200001;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });

    const delegate = await seedDelegateAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
    });
    const chatId = await seedDirectChat(app, admin.organizationId, admin.humanAgentUuid, delegate);

    // Stage 1: the agent's gh pr create tool_call lands → mapping written.
    // Driven through the service directly to avoid the fire-and-forget timing
    // of the appendEvent path (covered separately in
    // agent-created-binding.test.ts).
    await maybeBindGithubEntityFromToolCall(app.db, delegate, chatId, {
      toolUseId: "tu-e2e-1",
      name: "Bash",
      args: { command: 'gh pr create --title "wire X" --body "fixes Y"' },
      status: "ok",
      resultPreview: "https://github.com/owner/repo/pull/901",
    });
    const beforeMapping = await app.db
      .select()
      .from(githubEntityChatMappings)
      .where(eq(githubEntityChatMappings.entityKey, "owner/repo#901"));
    expect(beforeMapping).toHaveLength(1);
    expect(beforeMapping[0]?.boundVia).toBe("agent_created");
    expect(beforeMapping[0]?.chatId).toBe(chatId);

    // Stage 2: real `pull_request.opened` webhook fires. Sender = our App
    // bot (because the agent used Hub's installation token to open the PR).
    const beforeChatCount = (await app.db.select().from(chats)).length;
    const res = await postWebhook(app, "pull_request", {
      action: "opened",
      pull_request: {
        number: 901,
        title: "wire X",
        html_url: "https://github.com/owner/repo/pull/901",
        body: "fixes Y",
      },
      repository: { full_name: "owner/repo" },
      sender: { login: "test-app-slug[bot]", type: "Bot" },
      installation: { id: installationId },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.delivered).toBe(1);
    expect(body.newChats).toBe(0);

    // Same chat, exactly one card delivered, no extra chats minted.
    const sent = await app.db.select().from(messages).where(eq(messages.chatId, chatId));
    expect(sent).toHaveLength(1);
    const afterChatCount = (await app.db.select().from(chats)).length;
    expect(afterChatCount).toBe(beforeChatCount);
    const allMappings = await app.db
      .select()
      .from(githubEntityChatMappings)
      .where(eq(githubEntityChatMappings.entityKey, "owner/repo#901"));
    expect(allMappings).toHaveLength(1);
  });

  it("issue_comment.created after agent_created routes to the original chat (PR follow-up flow)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 200002;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });

    const delegate = await seedDelegateAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
    });
    const chatId = await seedDirectChat(app, admin.organizationId, admin.humanAgentUuid, delegate);

    await maybeBindGithubEntityFromToolCall(app.db, delegate, chatId, {
      toolUseId: "tu-e2e-2",
      name: "Bash",
      args: { command: "gh pr create --title x --body y" },
      status: "ok",
      resultPreview: "https://github.com/owner/repo/pull/902",
    });

    // PR comment from an external reviewer — sender is NOT a bot, NOT mentioning us.
    const res = await postWebhook(app, "issue_comment", {
      action: "created",
      issue: {
        number: 902,
        title: "wire X",
        html_url: "https://github.com/owner/repo/issues/902",
        pull_request: { html_url: "https://github.com/owner/repo/pull/902" },
      },
      comment: {
        body: "Looks good.",
        html_url: "https://github.com/owner/repo/pull/902#issuecomment-1",
      },
      repository: { full_name: "owner/repo" },
      sender: { login: "reviewer-bob", type: "User" },
      installation: { id: installationId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().delivered).toBe(1);

    const sent = await app.db.select().from(messages).where(eq(messages.chatId, chatId));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.metadata).toMatchObject({
      source: "github",
      event: "issue_comment",
      action: "created",
      entityType: "pull_request",
      entityKey: "owner/repo#902",
    });
  });

  it("opened webhook with no mapping and no mention does NOT mint a chat", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 200003;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });

    const beforeChats = (await app.db.select().from(chats)).length;
    const beforeMappings = (await app.db.select().from(githubEntityChatMappings)).length;

    const res = await postWebhook(app, "pull_request", {
      action: "opened",
      pull_request: {
        number: 903,
        title: "external work",
        html_url: "https://github.com/owner/repo/pull/903",
        body: "no @mentions here",
      },
      repository: { full_name: "owner/repo" },
      sender: { login: "external-author", type: "User" },
      installation: { id: installationId },
    });
    expect(res.statusCode).toBe(200);
    // Empty audience short-circuits before the delivery stage — the webhook
    // route returns `{audience: 0}` in that branch, not `{delivered, newChats}`.
    expect(res.json().audience).toBe(0);

    const afterChats = (await app.db.select().from(chats)).length;
    const afterMappings = (await app.db.select().from(githubEntityChatMappings)).length;
    expect(afterChats).toBe(beforeChats);
    expect(afterMappings).toBe(beforeMappings);
    const sentToOrg = await app.db
      .select()
      .from(messages)
      .innerJoin(chats, eq(messages.chatId, chats.id))
      .where(eq(chats.organizationId, admin.organizationId));
    expect(sentToOrg).toHaveLength(0);
  });

  it("opened webhook with body @mention still creates a chat (mention exemption preserved)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 200004;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });

    const delegate = await seedDelegateAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
    });
    const humanName = `human-${randomUUID().slice(0, 6)}`;
    const humanAgent = await app.db
      .insert(agents)
      .values({
        uuid: randomUUID(),
        name: humanName,
        organizationId: admin.organizationId,
        type: "human",
        displayName: humanName,
        inboxId: `inbox_${randomUUID()}`,
        managerId: admin.memberId,
        delegateMention: delegate,
      })
      .returning({ uuid: agents.uuid });
    expect(humanAgent[0]?.uuid).toBeTruthy();

    const beforeChats = (await app.db.select().from(chats)).length;

    const res = await postWebhook(app, "pull_request", {
      action: "opened",
      pull_request: {
        number: 904,
        title: "ping the agent",
        html_url: "https://github.com/owner/repo/pull/904",
        body: `cc @${humanName}`,
      },
      repository: { full_name: "owner/repo" },
      sender: { login: "external-author", type: "User" },
      installation: { id: installationId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().delivered).toBe(1);
    expect(res.json().newChats).toBe(1);

    const afterChats = (await app.db.select().from(chats)).length;
    expect(afterChats).toBe(beforeChats + 1);

    const mapping = await app.db
      .select()
      .from(githubEntityChatMappings)
      .where(
        and(
          eq(githubEntityChatMappings.entityType, "pull_request"),
          eq(githubEntityChatMappings.entityKey, "owner/repo#904"),
        ),
      );
    expect(mapping).toHaveLength(1);
    expect(mapping[0]?.boundVia).toBe("direct");
  });
});
