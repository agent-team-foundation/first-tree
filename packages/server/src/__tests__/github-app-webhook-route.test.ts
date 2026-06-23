import { createHmac, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { chatUserState } from "../db/schema/chat-user-state.js";
import { chats } from "../db/schema/chats.js";
import { githubAppInstallations } from "../db/schema/github-app-installations.js";
import { githubEntityChatMappings } from "../db/schema/github-entity-chat-mappings.js";
import { messages } from "../db/schema/messages.js";
import { putOrgSetting } from "../services/org-settings.js";
import { uuidv7 } from "../uuid.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

const APP_WEBHOOK_SECRET = "test-app-webhook-secret";

function signBody(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

type App = ReturnType<ReturnType<typeof useTestApp>>;

async function postWebhook(
  app: App,
  eventType: string,
  payload: object,
  opts: { secret?: string; deliveryId?: string; skipSignature?: boolean } = {},
) {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-github-event": eventType,
    "x-github-delivery": opts.deliveryId ?? randomUUID(),
  };
  if (!opts.skipSignature) {
    headers["x-hub-signature-256"] = signBody(opts.secret ?? APP_WEBHOOK_SECRET, body);
  }
  return app.inject({
    method: "POST",
    url: "/api/v1/webhooks/github-app",
    headers,
    payload: body,
  });
}

async function seedAgent(
  app: App,
  opts: { orgId: string; memberId: string; name: string; delegateMention?: string | null },
): Promise<string> {
  const uuid = randomUUID();
  await app.db.insert(agents).values({
    uuid,
    name: opts.name,
    organizationId: opts.orgId,
    type: "agent",
    displayName: opts.name,
    inboxId: `inbox_${uuid}`,
    managerId: opts.memberId,
    delegateMention: opts.delegateMention ?? null,
  });
  return uuid;
}

async function seedInstallation(
  app: App,
  opts: { installationId: number; orgId: string | null; suspended?: boolean },
): Promise<void> {
  await app.db.insert(githubAppInstallations).values({
    id: uuidv7(),
    installationId: opts.installationId,
    accountType: "Organization",
    accountLogin: "owner",
    accountGithubId: 1000 + opts.installationId,
    hubOrganizationId: opts.orgId,
    permissions: { contents: "read" },
    events: ["pull_request", "issues"],
    suspendedAt: opts.suspended ? new Date() : null,
  });
}

async function configureContextReviewer(app: App, admin: Awaited<ReturnType<typeof createTestAdmin>>) {
  const reviewer = await seedAgent(app, {
    orgId: admin.organizationId,
    memberId: admin.memberId,
    name: `context-reviewer-${randomUUID().slice(0, 6)}`,
  });
  await putOrgSetting(
    app.db,
    admin.organizationId,
    "context_tree",
    { repo: "https://github.com/owner/context-tree.git", branch: "main" },
    { updatedBy: admin.userId },
  );
  await putOrgSetting(
    app.db,
    admin.organizationId,
    "context_tree_features",
    { contextReviewer: { enabled: true, agentUuid: reviewer } },
    { updatedBy: admin.userId, memberId: admin.memberId },
  );
  return reviewer;
}

function contextPullRequestPayload(installationId: number, repoFullName = "owner/context-tree") {
  return {
    action: "opened",
    pull_request: {
      number: 42,
      title: "Improve context review guidance",
      html_url: `https://github.com/${repoFullName}/pull/42`,
      body: "",
      base: { ref: "main" },
      head: { ref: "context-reviewer" },
    },
    repository: { full_name: repoFullName },
    sender: { login: "context-writer", type: "User" },
    installation: { id: installationId },
  };
}

describe("POST /webhooks/github-app", () => {
  const getApp = useTestApp();

  it("returns 401 on a bad HMAC signature", async () => {
    const app = getApp();
    const res = await postWebhook(app, "ping", { zen: "x" }, { secret: "wrong-secret" });
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 when the signature header is missing", async () => {
    const app = getApp();
    const res = await postWebhook(app, "ping", { zen: "x" }, { skipSignature: true });
    expect(res.statusCode).toBe(401);
  });

  it("returns 200 fast-path on a ping event", async () => {
    const app = getApp();
    const res = await postWebhook(app, "ping", { zen: "Anything added dilutes everything else." });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, event: "ping" });
  });

  it("installation.created → UPSERTs the installation row", async () => {
    const app = getApp();
    const installationId = 100001;
    const payload = {
      action: "created",
      installation: {
        id: installationId,
        account: { id: 555, login: "octolabs", type: "Organization" },
        permissions: { contents: "write" },
        events: ["pull_request"],
        suspended_at: null,
      },
    };
    const res = await postWebhook(app, "installation", payload);
    expect(res.statusCode).toBe(200);
    expect(res.json().lifecycle).toBe("created");

    const [row] = await app.db
      .select()
      .from(githubAppInstallations)
      .where(eq(githubAppInstallations.installationId, installationId))
      .limit(1);
    expect(row).toBeTruthy();
    expect(row?.accountLogin).toBe("octolabs");
  });

  it("installation.deleted → removes the row", async () => {
    const app = getApp();
    const installationId = 100002;
    await seedInstallation(app, { installationId, orgId: null });

    const res = await postWebhook(app, "installation", {
      action: "deleted",
      installation: { id: installationId, account: { id: 999, login: "x", type: "User" } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().lifecycle).toBe("deleted");
    const rows = await app.db
      .select()
      .from(githubAppInstallations)
      .where(eq(githubAppInstallations.installationId, installationId));
    expect(rows).toHaveLength(0);
  });

  it("installation.suspend → sets suspended_at", async () => {
    const app = getApp();
    const installationId = 100003;
    await seedInstallation(app, { installationId, orgId: null });

    const res = await postWebhook(app, "installation", {
      action: "suspend",
      installation: {
        id: installationId,
        account: { id: 1, login: "x", type: "User" },
        suspended_at: "2026-05-13T00:00:00Z",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().lifecycle).toBe("suspended");

    const [row] = await app.db
      .select({ suspendedAt: githubAppInstallations.suspendedAt })
      .from(githubAppInstallations)
      .where(eq(githubAppInstallations.installationId, installationId))
      .limit(1);
    expect(row?.suspendedAt).toBeTruthy();
  });

  it("returns ignored:no installation context when payload lacks an installation block", async () => {
    const app = getApp();
    const res = await postWebhook(app, "issues", {
      action: "opened",
      issue: { number: 1, title: "x" },
      repository: { full_name: "owner/repo" },
      sender: { login: "anyone", type: "User" },
      // no installation field
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ignored).toBe("no installation context");
  });

  it("returns ignored:installation not seen when installation_id is unknown", async () => {
    const app = getApp();
    const res = await postWebhook(app, "issues", {
      action: "opened",
      issue: { number: 1, title: "x", html_url: "https://github.com/owner/repo/issues/1", body: "" },
      repository: { full_name: "owner/repo" },
      sender: { login: "anyone", type: "User" },
      installation: { id: 9_999_999 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ignored).toBe("installation not seen");
  });

  it("returns ignored:installation not bound for an unbound installation", async () => {
    const app = getApp();
    const installationId = 100010;
    await seedInstallation(app, { installationId, orgId: null });
    const res = await postWebhook(app, "issues", {
      action: "opened",
      issue: { number: 1, title: "x", html_url: "https://github.com/owner/repo/issues/1", body: "" },
      repository: { full_name: "owner/repo" },
      sender: { login: "anyone", type: "User" },
      installation: { id: installationId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ignored).toBe("installation not bound");
  });

  it("returns ignored:suspended for a suspended installation", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100011;
    await seedInstallation(app, { installationId, orgId: admin.organizationId, suspended: true });
    const res = await postWebhook(app, "issues", {
      action: "opened",
      issue: { number: 1, title: "x", html_url: "https://github.com/owner/repo/issues/1", body: "" },
      repository: { full_name: "owner/repo" },
      sender: { login: "anyone", type: "User" },
      installation: { id: installationId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ignored).toBe("suspended");
  });

  it("Bug 1 — pull_request.synchronize delivers to subscribed chat (was silenced before)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100020;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });

    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
    });
    const human = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `human-${randomUUID().slice(0, 6)}`,
      delegateMention: delegate,
    });
    const chatId = `chat_${randomUUID()}`;
    await app.db.insert(chats).values({ id: chatId, organizationId: admin.organizationId, type: "direct" });
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: admin.organizationId,
      humanAgentId: human,
      delegateAgentId: delegate,
      entityType: "pull_request",
      entityKey: "owner/repo#700",
      chatId,
      boundVia: "direct",
    });

    const res = await postWebhook(app, "pull_request", {
      action: "synchronize",
      pull_request: {
        number: 700,
        title: "Refactor inbox",
        html_url: "https://github.com/owner/repo/pull/700",
        body: "",
      },
      repository: { full_name: "owner/repo" },
      sender: { login: "external-author", type: "User" },
      installation: { id: installationId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().delivered).toBe(1);
    const sent = await app.db.select().from(messages).where(eq(messages.chatId, chatId));
    expect(sent).toHaveLength(1);
  });

  it("Bug 3 — issue_comment on a PR routes to the existing PR chat, not a new Issue chat", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100021;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });

    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
    });
    const human = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `human-${randomUUID().slice(0, 6)}`,
      delegateMention: delegate,
    });
    const prChatId = `chat_${randomUUID()}`;
    await app.db.insert(chats).values({ id: prChatId, organizationId: admin.organizationId, type: "direct" });
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: admin.organizationId,
      humanAgentId: human,
      delegateAgentId: delegate,
      entityType: "pull_request",
      entityKey: "owner/repo#316",
      chatId: prChatId,
      boundVia: "direct",
    });

    const res = await postWebhook(app, "issue_comment", {
      action: "created",
      issue: {
        number: 316,
        title: "Improve onboarding",
        html_url: "https://github.com/owner/repo/issues/316",
        pull_request: { html_url: "https://github.com/owner/repo/pull/316" },
      },
      comment: { body: "ack", html_url: "https://github.com/owner/repo/pull/316#issuecomment-1" },
      repository: { full_name: "owner/repo" },
      sender: { login: "external-commenter", type: "User" },
      installation: { id: installationId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().delivered).toBe(1);

    // No new chat with metadata.entityType="issue" should have been created.
    const sentToPRChat = await app.db.select().from(messages).where(eq(messages.chatId, prChatId));
    expect(sentToPRChat).toHaveLength(1);
    const issueMappings = await app.db
      .select()
      .from(githubEntityChatMappings)
      .where(eq(githubEntityChatMappings.entityType, "issue"));
    expect(issueMappings).toEqual([]);
  });

  it("pull_request.closed (merged=true) → syncs entity_state to 'merged' without delivering a message", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100030;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });

    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
    });
    const human = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `human-${randomUUID().slice(0, 6)}`,
      delegateMention: delegate,
    });
    const chatId = `chat_${randomUUID()}`;
    await app.db.insert(chats).values({ id: chatId, organizationId: admin.organizationId, type: "direct" });
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: admin.organizationId,
      humanAgentId: human,
      delegateAgentId: delegate,
      entityType: "pull_request",
      entityKey: "owner/repo#820",
      chatId,
      boundVia: "direct",
    });

    const res = await postWebhook(app, "pull_request", {
      action: "closed",
      pull_request: {
        number: 820,
        title: "Implement archive on merge",
        html_url: "https://github.com/owner/repo/pull/820",
        body: "",
        merged: true,
      },
      repository: { full_name: "owner/repo" },
      sender: { login: "merger", type: "User" },
      installation: { id: installationId },
    });

    expect(res.statusCode).toBe(200);
    // normalize still drops pull_request.closed → no audience/deliver run.
    expect(res.json().handled).toBe(false);

    // Merge no longer flips engagement on the spot — the chat-archive
    // sweeper does that after the idle window. The webhook's job is just
    // to persist the upstream PR state.
    const stateRows = await app.db
      .select()
      .from(chatUserState)
      .where(and(eq(chatUserState.chatId, chatId), eq(chatUserState.agentId, human)));
    expect(stateRows).toHaveLength(0);

    const [mappingRow] = await app.db
      .select({
        entityState: githubEntityChatMappings.entityState,
        entityStateUpdatedAt: githubEntityChatMappings.entityStateUpdatedAt,
      })
      .from(githubEntityChatMappings)
      .where(and(eq(githubEntityChatMappings.chatId, chatId), eq(githubEntityChatMappings.entityKey, "owner/repo#820")))
      .limit(1);
    expect(mappingRow?.entityState).toBe("merged");
    expect(mappingRow?.entityStateUpdatedAt).not.toBeNull();

    const sent = await app.db.select().from(messages).where(eq(messages.chatId, chatId));
    expect(sent).toHaveLength(0);
  });

  it("pull_request.reopened → flips entity_state back to 'open'", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100032;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });

    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
    });
    const human = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `human-${randomUUID().slice(0, 6)}`,
      delegateMention: delegate,
    });
    const chatId = `chat_${randomUUID()}`;
    await app.db.insert(chats).values({ id: chatId, organizationId: admin.organizationId, type: "direct" });
    // Mapping was previously settled (merged) — reopened must un-settle it.
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: admin.organizationId,
      humanAgentId: human,
      delegateAgentId: delegate,
      entityType: "pull_request",
      entityKey: "owner/repo#822",
      chatId,
      boundVia: "direct",
      entityState: "merged",
    });

    const res = await postWebhook(app, "pull_request", {
      action: "reopened",
      pull_request: {
        number: 822,
        title: "Reopened PR",
        html_url: "https://github.com/owner/repo/pull/822",
        body: "",
        merged: false,
      },
      repository: { full_name: "owner/repo" },
      sender: { login: "reopener", type: "User" },
      installation: { id: installationId },
    });

    expect(res.statusCode).toBe(200);

    const [mappingRow] = await app.db
      .select({ entityState: githubEntityChatMappings.entityState })
      .from(githubEntityChatMappings)
      .where(and(eq(githubEntityChatMappings.chatId, chatId), eq(githubEntityChatMappings.entityKey, "owner/repo#822")))
      .limit(1);
    expect(mappingRow?.entityState).toBe("open");
  });

  it("late opened webhooks do not overwrite newer persisted entity_state", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100036;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });

    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
    });
    const human = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `human-${randomUUID().slice(0, 6)}`,
      delegateMention: delegate,
    });
    const chatId = `chat_${randomUUID()}`;
    await app.db.insert(chats).values({ id: chatId, organizationId: admin.organizationId, type: "direct" });
    await app.db.insert(githubEntityChatMappings).values([
      {
        organizationId: admin.organizationId,
        humanAgentId: human,
        delegateAgentId: delegate,
        entityType: "pull_request",
        entityKey: "owner/repo#825",
        chatId,
        boundVia: "direct",
        entityState: "draft",
      },
      {
        organizationId: admin.organizationId,
        humanAgentId: human,
        delegateAgentId: delegate,
        entityType: "pull_request",
        entityKey: "owner/repo#826",
        chatId,
        boundVia: "direct",
        entityState: "merged",
      },
      {
        organizationId: admin.organizationId,
        humanAgentId: human,
        delegateAgentId: delegate,
        entityType: "issue",
        entityKey: "owner/repo#827",
        chatId,
        boundVia: "direct",
        entityState: "closed",
      },
    ]);

    for (const number of [825, 826]) {
      const res = await postWebhook(app, "pull_request", {
        action: "opened",
        pull_request: {
          number,
          title: "Late opened",
          html_url: `https://github.com/owner/repo/pull/${number}`,
          body: "",
          state: "open",
          draft: false,
          merged: false,
        },
        repository: { full_name: "owner/repo" },
        sender: { login: "author", type: "User" },
        installation: { id: installationId },
      });
      expect(res.statusCode).toBe(200);
    }

    const issueRes = await postWebhook(app, "issues", {
      action: "opened",
      issue: {
        number: 827,
        title: "Late issue opened",
        html_url: "https://github.com/owner/repo/issues/827",
        body: "",
        state: "open",
      },
      repository: { full_name: "owner/repo" },
      sender: { login: "author", type: "User" },
      installation: { id: installationId },
    });
    expect(issueRes.statusCode).toBe(200);

    const rows = await app.db
      .select({ entityKey: githubEntityChatMappings.entityKey, entityState: githubEntityChatMappings.entityState })
      .from(githubEntityChatMappings)
      .where(eq(githubEntityChatMappings.chatId, chatId));
    const stateByKey = new Map(rows.map((row) => [row.entityKey, row.entityState]));
    expect(stateByKey.get("owner/repo#825")).toBe("draft");
    expect(stateByKey.get("owner/repo#826")).toBe("merged");
    expect(stateByKey.get("owner/repo#827")).toBe("closed");
  });

  it("pull_request.converted_to_draft → syncs entity_state to 'draft'", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100034;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });

    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
    });
    const human = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `human-${randomUUID().slice(0, 6)}`,
      delegateMention: delegate,
    });
    const chatId = `chat_${randomUUID()}`;
    await app.db.insert(chats).values({ id: chatId, organizationId: admin.organizationId, type: "direct" });
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: admin.organizationId,
      humanAgentId: human,
      delegateAgentId: delegate,
      entityType: "pull_request",
      entityKey: "owner/repo#823",
      chatId,
      boundVia: "direct",
      entityState: "open",
    });

    const res = await postWebhook(app, "pull_request", {
      action: "converted_to_draft",
      pull_request: {
        number: 823,
        title: "Draft again",
        html_url: "https://github.com/owner/repo/pull/823",
        body: "",
        draft: true,
      },
      repository: { full_name: "owner/repo" },
      sender: { login: "author", type: "User" },
      installation: { id: installationId },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().handled).toBe(false);

    const [mappingRow] = await app.db
      .select({ entityState: githubEntityChatMappings.entityState })
      .from(githubEntityChatMappings)
      .where(and(eq(githubEntityChatMappings.chatId, chatId), eq(githubEntityChatMappings.entityKey, "owner/repo#823")))
      .limit(1);
    expect(mappingRow?.entityState).toBe("draft");
  });

  it("pull_request.ready_for_review → syncs entity_state to 'open' even when normalize drops the event", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100035;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });

    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
    });
    const human = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `human-${randomUUID().slice(0, 6)}`,
      delegateMention: delegate,
    });
    const chatId = `chat_${randomUUID()}`;
    await app.db.insert(chats).values({ id: chatId, organizationId: admin.organizationId, type: "direct" });
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: admin.organizationId,
      humanAgentId: human,
      delegateAgentId: delegate,
      entityType: "pull_request",
      entityKey: "owner/repo#824",
      chatId,
      boundVia: "direct",
      entityState: "draft",
    });

    const res = await postWebhook(app, "pull_request", {
      action: "ready_for_review",
      pull_request: {
        number: 824,
        title: "Ready",
        html_url: "https://github.com/owner/repo/pull/824",
        body: "",
        draft: false,
        requested_reviewers: [],
      },
      repository: { full_name: "owner/repo" },
      sender: { login: "author", type: "User" },
      installation: { id: installationId },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().handled).toBe(false);

    const [mappingRow] = await app.db
      .select({ entityState: githubEntityChatMappings.entityState })
      .from(githubEntityChatMappings)
      .where(and(eq(githubEntityChatMappings.chatId, chatId), eq(githubEntityChatMappings.entityKey, "owner/repo#824")))
      .limit(1);
    expect(mappingRow?.entityState).toBe("open");
  });

  it("pull_request.review_requested seeds a new draft PR mapping from the payload state", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100037;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });

    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
    });
    const humanName = `reviewer-${randomUUID().slice(0, 6)}`;
    const human = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: humanName,
      delegateMention: delegate,
    });

    const res = await postWebhook(app, "pull_request", {
      action: "review_requested",
      pull_request: {
        number: 828,
        title: "Draft review",
        html_url: "https://github.com/owner/repo/pull/828",
        body: "",
        state: "open",
        draft: true,
        merged: false,
      },
      requested_reviewer: { login: humanName, type: "User" },
      repository: { full_name: "owner/repo" },
      sender: { login: "author", type: "User" },
      installation: { id: installationId },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ delivered: 1, newChats: 1, failed: 0 });

    const [mappingRow] = await app.db
      .select({
        humanAgentId: githubEntityChatMappings.humanAgentId,
        entityState: githubEntityChatMappings.entityState,
      })
      .from(githubEntityChatMappings)
      .where(eq(githubEntityChatMappings.entityKey, "owner/repo#828"))
      .limit(1);
    expect(mappingRow).toMatchObject({ humanAgentId: human, entityState: "draft" });
  });

  it("issue_comment.created seeds a new closed issue mapping from the issue payload state", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100038;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });

    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
    });
    const humanName = `issue-${randomUUID().slice(0, 6)}`;
    const human = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: humanName,
      delegateMention: delegate,
    });

    const res = await postWebhook(app, "issue_comment", {
      action: "created",
      issue: {
        number: 829,
        title: "Closed issue",
        html_url: "https://github.com/owner/repo/issues/829",
        body: "",
        state: "closed",
      },
      comment: {
        body: `@${humanName} please verify`,
        html_url: "https://github.com/owner/repo/issues/829#issuecomment-1",
      },
      repository: { full_name: "owner/repo" },
      sender: { login: "author", type: "User" },
      installation: { id: installationId },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ delivered: 1, newChats: 1, failed: 0 });

    const [mappingRow] = await app.db
      .select({
        humanAgentId: githubEntityChatMappings.humanAgentId,
        entityType: githubEntityChatMappings.entityType,
        entityState: githubEntityChatMappings.entityState,
      })
      .from(githubEntityChatMappings)
      .where(eq(githubEntityChatMappings.entityKey, "owner/repo#829"))
      .limit(1);
    expect(mappingRow).toMatchObject({ humanAgentId: human, entityType: "issue", entityState: "closed" });
  });

  it("issue_comment.created on a PR seeds a new closed PR mapping from the issue payload state", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100040;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });

    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
    });
    const humanName = `pr-issue-${randomUUID().slice(0, 6)}`;
    const human = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: humanName,
      delegateMention: delegate,
    });

    const res = await postWebhook(app, "issue_comment", {
      action: "created",
      issue: {
        number: 831,
        title: "Closed PR thread",
        html_url: "https://github.com/owner/repo/pull/831",
        body: "",
        state: "closed",
        pull_request: { html_url: "https://github.com/owner/repo/pull/831", merged_at: null },
      },
      comment: {
        body: `@${humanName} please verify`,
        html_url: "https://github.com/owner/repo/pull/831#issuecomment-1",
      },
      repository: { full_name: "owner/repo" },
      sender: { login: "author", type: "User" },
      installation: { id: installationId },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ delivered: 1, newChats: 1, failed: 0 });

    const [mappingRow] = await app.db
      .select({
        humanAgentId: githubEntityChatMappings.humanAgentId,
        entityType: githubEntityChatMappings.entityType,
        entityState: githubEntityChatMappings.entityState,
      })
      .from(githubEntityChatMappings)
      .where(eq(githubEntityChatMappings.entityKey, "owner/repo#831"))
      .limit(1);
    expect(mappingRow).toMatchObject({ humanAgentId: human, entityType: "pull_request", entityState: "closed" });
  });

  it("pull_request_review_comment.created seeds a new draft PR mapping from the PR payload state", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100039;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });

    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
    });
    const humanName = `pr-${randomUUID().slice(0, 6)}`;
    const human = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: humanName,
      delegateMention: delegate,
    });

    const res = await postWebhook(app, "pull_request_review_comment", {
      action: "created",
      pull_request: {
        number: 830,
        title: "Draft PR review comment",
        html_url: "https://github.com/owner/repo/pull/830",
        body: "",
        state: "open",
        draft: true,
        merged: false,
      },
      comment: {
        body: `@${humanName} please review`,
        html_url: "https://github.com/owner/repo/pull/830#discussion_r1",
      },
      repository: { full_name: "owner/repo" },
      sender: { login: "author", type: "User" },
      installation: { id: installationId },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ delivered: 1, newChats: 1, failed: 0 });

    const [mappingRow] = await app.db
      .select({
        humanAgentId: githubEntityChatMappings.humanAgentId,
        entityType: githubEntityChatMappings.entityType,
        entityState: githubEntityChatMappings.entityState,
      })
      .from(githubEntityChatMappings)
      .where(eq(githubEntityChatMappings.entityKey, "owner/repo#830"))
      .limit(1);
    expect(mappingRow).toMatchObject({ humanAgentId: human, entityType: "pull_request", entityState: "draft" });
  });

  it("issues.closed → syncs entity_state to 'closed' on the issue mapping", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100033;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });

    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
    });
    const human = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `human-${randomUUID().slice(0, 6)}`,
      delegateMention: delegate,
    });
    const chatId = `chat_${randomUUID()}`;
    await app.db.insert(chats).values({ id: chatId, organizationId: admin.organizationId, type: "direct" });
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: admin.organizationId,
      humanAgentId: human,
      delegateAgentId: delegate,
      entityType: "issue",
      entityKey: "owner/repo#900",
      chatId,
      boundVia: "direct",
    });

    const res = await postWebhook(app, "issues", {
      action: "closed",
      issue: {
        number: 900,
        title: "Stale issue",
        html_url: "https://github.com/owner/repo/issues/900",
        body: "",
      },
      repository: { full_name: "owner/repo" },
      sender: { login: "closer", type: "User" },
      installation: { id: installationId },
    });

    expect(res.statusCode).toBe(200);

    const [mappingRow] = await app.db
      .select({ entityState: githubEntityChatMappings.entityState })
      .from(githubEntityChatMappings)
      .where(and(eq(githubEntityChatMappings.chatId, chatId), eq(githubEntityChatMappings.entityKey, "owner/repo#900")))
      .limit(1);
    expect(mappingRow?.entityState).toBe("closed");
  });

  it("pull_request.closed without merge → entity_state 'closed' and no engagement flip", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100031;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });

    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
    });
    const human = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `human-${randomUUID().slice(0, 6)}`,
      delegateMention: delegate,
    });
    const chatId = `chat_${randomUUID()}`;
    await app.db.insert(chats).values({ id: chatId, organizationId: admin.organizationId, type: "direct" });
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: admin.organizationId,
      humanAgentId: human,
      delegateAgentId: delegate,
      entityType: "pull_request",
      entityKey: "owner/repo#821",
      chatId,
      boundVia: "direct",
    });

    const res = await postWebhook(app, "pull_request", {
      action: "closed",
      pull_request: {
        number: 821,
        title: "Abandoned PR",
        html_url: "https://github.com/owner/repo/pull/821",
        body: "",
        merged: false,
      },
      repository: { full_name: "owner/repo" },
      sender: { login: "closer", type: "User" },
      installation: { id: installationId },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().handled).toBe(false);

    const stateRows = await app.db
      .select()
      .from(chatUserState)
      .where(and(eq(chatUserState.chatId, chatId), eq(chatUserState.agentId, human)));
    expect(stateRows).toHaveLength(0);

    const [mappingRow] = await app.db
      .select({ entityState: githubEntityChatMappings.entityState })
      .from(githubEntityChatMappings)
      .where(and(eq(githubEntityChatMappings.chatId, chatId), eq(githubEntityChatMappings.entityKey, "owner/repo#821")))
      .limit(1);
    expect(mappingRow?.entityState).toBe("closed");
  });

  // M1 (#507): audience-empty must distinguish "no involves at all" from
  // "had involves but resolved to zero agents" — the latter usually means
  // a mentioned GitHub login has no `delegateMention`-configured agent in
  // this org, which is a potential mis-configuration worth surfacing.
  it("audience empty with no involves returns reason=audience_empty_no_involves", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100030;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });

    const res = await postWebhook(app, "issues", {
      action: "opened",
      issue: {
        number: 10,
        title: "no involves",
        html_url: "https://github.com/owner/repo/issues/10",
        body: "",
        assignees: [],
      },
      repository: { full_name: "owner/repo" },
      sender: { login: "external", type: "User" },
      installation: { id: installationId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, audience: 0, reason: "audience_empty_no_involves" });
  });

  it("audience empty with involves returns reason=audience_empty_with_involves", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100031;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });

    // Assignee whose GitHub login has no matching agent in this org →
    // involves resolves to an empty audience (mis-config signal).
    const res = await postWebhook(app, "issues", {
      action: "opened",
      issue: {
        number: 11,
        title: "with involves but unknown login",
        html_url: "https://github.com/owner/repo/issues/11",
        body: "",
        assignees: [{ login: "nobody-here", type: "User" }],
      },
      repository: { full_name: "owner/repo" },
      sender: { login: "external", type: "User" },
      installation: { id: installationId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, audience: 0, reason: "audience_empty_with_involves" });
  });

  it("pull_request.opened on the bound context repo creates a Context Reviewer task message", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100041;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });
    const reviewer = await configureContextReviewer(app, admin);

    const res = await postWebhook(app, "pull_request", contextPullRequestPayload(installationId));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      event: "pull_request",
      audience: 0,
      contextReviewer: { handled: true, reused: false },
    });

    const [chat] = await app.db.select().from(chats).limit(1);
    expect(chat?.metadata).toMatchObject({
      source: "github",
      entityType: "pull_request",
      entityKey: "owner/context-tree#42",
      contextTreeReviewer: true,
      reviewerAgentUuid: reviewer,
    });

    const [message] = await app.db
      .select()
      .from(messages)
      .where(eq(messages.chatId, chat?.id ?? ""))
      .limit(1);
    expect(message?.content).toContain("gh pr comment 42 --repo owner/context-tree --body");
    expect(message?.metadata).toMatchObject({
      source: "github",
      event: "pull_request",
      action: "opened",
      contextTreeReviewer: true,
      mentions: [reviewer],
    });
  });

  it("pull_request.opened on an ordinary code repo does not trigger Context Reviewer", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100042;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });
    await configureContextReviewer(app, admin);

    const res = await postWebhook(app, "pull_request", contextPullRequestPayload(installationId, "owner/code"));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      event: "pull_request",
      audience: 0,
      contextReviewer: { handled: false, reason: "repo_mismatch" },
    });
    const chatRows = await app.db.select({ id: chats.id }).from(chats);
    expect(chatRows).toHaveLength(0);
  });

  it("duplicate delivery (same x-github-delivery) is deduped on the second call", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100022;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });
    const deliveryId = randomUUID();

    const payload = {
      action: "opened",
      issue: {
        number: 5,
        title: "x",
        html_url: "https://github.com/owner/repo/issues/5",
        body: "",
        assignees: [],
      },
      repository: { full_name: "owner/repo" },
      sender: { login: "external", type: "User" },
      installation: { id: installationId },
    };

    const first = await postWebhook(app, "issues", payload, { deliveryId });
    expect(first.statusCode).toBe(200);
    const second = await postWebhook(app, "issues", payload, { deliveryId });
    expect(second.statusCode).toBe(200);
    expect(second.json().deduped).toBe(true);
  });

  it("duplicate context reviewer delivery is deduped and does not send another task", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100043;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });
    await configureContextReviewer(app, admin);
    const deliveryId = randomUUID();
    const payload = contextPullRequestPayload(installationId);

    const first = await postWebhook(app, "pull_request", payload, { deliveryId });
    const second = await postWebhook(app, "pull_request", payload, { deliveryId });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().deduped).toBe(true);
    const messageRows = await app.db.select({ id: messages.id }).from(messages);
    expect(messageRows).toHaveLength(1);
  });
});
