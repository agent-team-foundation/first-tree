import { createHmac, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { chatUserState } from "../db/schema/chat-user-state.js";
import { chats } from "../db/schema/chats.js";
import { githubAppInstallations } from "../db/schema/github-app-installations.js";
import { githubEntityChatMappings } from "../db/schema/github-entity-chat-mappings.js";
import { messages } from "../db/schema/messages.js";
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
    type: "autonomous_agent",
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
});
