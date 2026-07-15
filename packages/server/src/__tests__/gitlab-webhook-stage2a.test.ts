import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { formatHttpSpanName } from "../app.js";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chats } from "../db/schema/chats.js";
import { gitlabConnections } from "../db/schema/gitlab-connections.js";
import { gitlabEntityChatMappings } from "../db/schema/gitlab-entity-chat-mappings.js";
import { members } from "../db/schema/members.js";
import { messages } from "../db/schema/messages.js";
import { processedEvents } from "../db/schema/processed-events.js";
import { createAgent } from "../services/agent.js";
import {
  createGitlabConnection,
  deleteGitlabConnection,
  findActiveGitlabEndpoint,
  getGitlabConnectionSummary,
  markGitlabInboundSeen,
  regenerateGitlabConnectionBearer,
  replaceGitlabConnection,
  withGitlabIngressFence,
} from "../services/gitlab-connections.js";
import { declareGitlabEntityFollow, observeGitlabEntityAndResolveFollowers } from "../services/gitlab-entity-follow.js";
import { createOrganization } from "../services/organization.js";
import * as scmCardDelivery from "../services/scm-card-delivery.js";
import { createTestAdmin, createTestAgent, useTestApp } from "./helpers.js";

type App = ReturnType<ReturnType<typeof useTestApp>>;

function issuePayload(iid = 42, input: { projectId?: number; projectPath?: string } = {}) {
  const projectId = input.projectId ?? 501;
  const projectPath = input.projectPath ?? "Acme/API";
  return {
    object_kind: "issue",
    project: {
      id: projectId,
      path_with_namespace: projectPath,
      web_url: `https://gitlab.internal/${projectPath}`,
    },
    user: { username: "alice" },
    object_attributes: {
      iid,
      action: "open",
      title: "Webhook issue",
      description: "Please investigate",
      url: `https://gitlab.internal/${projectPath}/-/issues/${iid}`,
      state: "opened",
    },
  };
}

async function postWebhook(
  app: App,
  bearer: string,
  body: object,
  options: {
    event?: string;
    stableId?: string;
    webhookId?: string;
    webhookUuid?: string;
    remoteAddress?: string;
  } = {},
) {
  return app.inject({
    method: "POST",
    url: `/api/v1/webhooks/gitlab/${bearer}`,
    headers: {
      "content-type": "application/json",
      "x-gitlab-event": options.event ?? "Issue Hook",
      ...(options.stableId ? { "idempotency-key": options.stableId } : {}),
      ...(options.webhookId ? { "webhook-id": options.webhookId } : {}),
      ...(options.webhookUuid ? { "x-gitlab-webhook-uuid": options.webhookUuid } : {}),
    },
    payload: JSON.stringify(body),
    ...(options.remoteAddress ? { remoteAddress: options.remoteAddress } : {}),
  });
}

describe("GitLab Stage 2A backend", () => {
  const getApp = useTestApp();

  async function connection(app: App, options: { isolatedOrg?: boolean } = {}) {
    let admin = await createTestAdmin(app, { username: `gitlab-${randomUUID().slice(0, 8)}` });
    if (options.isolatedOrg) {
      const organization = await createOrganization(app.db, {
        name: `gitlab-${randomUUID().slice(0, 8)}`,
        displayName: "Isolated GitLab team",
      });
      await app.db.transaction(async (tx) => {
        await tx.update(agents).set({ organizationId: organization.id }).where(eq(agents.uuid, admin.humanAgentUuid));
        await tx.update(members).set({ organizationId: organization.id }).where(eq(members.id, admin.memberId));
      });
      admin = { ...admin, organizationId: organization.id };
    }
    const created = await createGitlabConnection(app.db, {
      organizationId: admin.organizationId,
      memberId: admin.memberId,
      displayName: "Private GitLab",
      instanceOrigin: "https://gitlab.internal",
    });
    return { admin, ...created };
  }

  it("stores only one bearer hash per org and atomically replaces the binding", async () => {
    const app = getApp();
    const first = await connection(app);
    const [persisted] = await app.db
      .select()
      .from(gitlabConnections)
      .where(eq(gitlabConnections.id, first.connectionId));
    expect(JSON.stringify(persisted)).not.toContain(first.bearer);
    expect(JSON.stringify(await getGitlabConnectionSummary(app.db, first.connectionId))).not.toContain(first.bearer);

    const regenerated = await regenerateGitlabConnectionBearer(app.db, first.connectionId, first.admin.memberId);
    expect(await findActiveGitlabEndpoint(app.db, first.bearer)).toBeNull();
    expect(await findActiveGitlabEndpoint(app.db, regenerated.bearer)).not.toBeNull();
    expect((await getGitlabConnectionSummary(app.db, first.connectionId)).endpointSeen).toBe(false);
    const test = await postWebhook(app, regenerated.bearer, { object_kind: "test" }, { event: "Test Hook" });
    expect(test.statusCode).toBe(200);
    expect((await getGitlabConnectionSummary(app.db, first.connectionId)).endpointSeen).toBe(true);

    const followedChatId = `chat_${randomUUID()}`;
    await app.db.insert(chats).values({
      id: followedChatId,
      organizationId: first.admin.organizationId,
      type: "group",
      metadata: {},
    });
    await app.db.insert(chatMembership).values({
      chatId: followedChatId,
      agentId: first.admin.humanAgentUuid,
      role: "owner",
      accessMode: "speaker",
    });
    await declareGitlabEntityFollow(app.db, {
      organizationId: first.admin.organizationId,
      connectionId: first.connectionId,
      chatId: followedChatId,
      declaredByAgentId: first.admin.humanAgentUuid,
      entityUrl: "https://gitlab.internal/Acme/API/-/issues/42",
    });
    const replaced = await replaceGitlabConnection(app.db, {
      expectedConnectionId: first.connectionId,
      organizationId: first.admin.organizationId,
      memberId: first.admin.memberId,
      displayName: "Replacement GitLab",
      instanceOrigin: "https://gitlab.replacement",
    });
    expect(replaced.connectionId).not.toBe(first.connectionId);
    expect(await findActiveGitlabEndpoint(app.db, regenerated.bearer)).toBeNull();
    await expect(getGitlabConnectionSummary(app.db, first.connectionId)).rejects.toThrow("not found");
    expect(
      await app.db
        .select()
        .from(gitlabEntityChatMappings)
        .where(eq(gitlabEntityChatMappings.connectionId, first.connectionId)),
    ).toHaveLength(0);
  });

  it("exposes a one-time secret to admins while member reads remain redacted and mutations stay admin-only", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `gitlab-api-${randomUUID().slice(0, 8)}` });
    const create = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${admin.organizationId}/gitlab-connections`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { displayName: "Customer GitLab", instanceOrigin: "https://gitlab.customer" },
    });
    expect(create.statusCode).toBe(201);
    const created = create.json() as { connection: { id: string }; webhookUrl: string };
    expect(created.webhookUrl).toMatch(/\/api\/v1\/webhooks\/gitlab\/[A-Za-z0-9_-]{43}$/);

    const duplicate = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${admin.organizationId}/gitlab-connections`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { displayName: "Duplicate", instanceOrigin: "https://gitlab.duplicate" },
    });
    expect(duplicate.statusCode).toBe(409);

    const regenerated = await app.inject({
      method: "POST",
      url: `/api/v1/gitlab-connections/${created.connection.id}/regenerate`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(regenerated.statusCode).toBe(200);
    expect(regenerated.body).not.toContain(created.webhookUrl);

    const replacedResponse = await app.inject({
      method: "POST",
      url: `/api/v1/gitlab-connections/${created.connection.id}/replace`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { displayName: "Replacement", instanceOrigin: "https://gitlab.replacement" },
    });
    expect(replacedResponse.statusCode).toBe(200);
    const replaced = replacedResponse.json() as { connection: { id: string }; webhookUrl: string };
    expect(replaced.connection.id).not.toBe(created.connection.id);
    expect(replaced.webhookUrl).toMatch(/\/api\/v1\/webhooks\/gitlab\/[A-Za-z0-9_-]{43}$/);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/gitlab-connections/${created.connection.id}`,
          headers: { authorization: `Bearer ${admin.accessToken}` },
        })
      ).statusCode,
    ).toBe(404);

    await app.db.update(members).set({ role: "member" }).where(eq(members.id, admin.memberId));
    const read = await app.inject({
      method: "GET",
      url: `/api/v1/gitlab-connections/${replaced.connection.id}`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(read.statusCode).toBe(200);
    expect(read.body).not.toContain(created.webhookUrl);
    const regenerate = await app.inject({
      method: "POST",
      url: `/api/v1/gitlab-connections/${replaced.connection.id}/regenerate`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(regenerate.statusCode).toBe(404);
    await app.db.update(members).set({ role: "admin" }).where(eq(members.id, admin.memberId));
    const removed = await app.inject({
      method: "DELETE",
      url: `/api/v1/gitlab-connections/${replaced.connection.id}`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(removed.statusCode).toBe(204);
  });

  it("keeps connection reads isolated to the endpoint-derived organization", async () => {
    const app = getApp();
    const owner = await connection(app);
    const outsider = await createTestAdmin(app, { username: `gitlab-other-${randomUUID().slice(0, 8)}` });
    const otherOrg = await createOrganization(app.db, {
      name: `other-${randomUUID().slice(0, 8)}`,
      displayName: "Other team",
    });
    await app.db.transaction(async (tx) => {
      await tx.update(agents).set({ organizationId: otherOrg.id }).where(eq(agents.uuid, outsider.humanAgentUuid));
      await tx.update(members).set({ organizationId: otherOrg.id }).where(eq(members.id, outsider.memberId));
    });
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/gitlab-connections/${owner.connectionId}`,
      headers: { authorization: `Bearer ${outsider.accessToken}` },
    });
    expect(response.statusCode).toBe(404);
  });

  it("uses a connection-scoped stable claim and skips claims when the provider has no stable id", async () => {
    const app = getApp();
    const first = await connection(app);
    const second = await connection(app, { isolatedOrg: true });
    const stableId = `shared-${randomUUID()}`;
    expect((await postWebhook(app, first.bearer, issuePayload(), { stableId })).statusCode).toBe(200);
    expect((await postWebhook(app, second.bearer, issuePayload(), { stableId })).statusCode).toBe(200);
    const claimed = await app.db
      .select()
      .from(processedEvents)
      .where(and(eq(processedEvents.platform, "gitlab")));
    expect(claimed.filter((row) => row.eventId.startsWith(first.connectionId))).toHaveLength(1);
    expect(claimed.filter((row) => row.eventId.startsWith(second.connectionId))).toHaveLength(1);

    const before = claimed.length;
    expect(
      (
        await postWebhook(app, first.bearer, issuePayload(43), {
          webhookUuid: `request-${randomUUID()}`,
        })
      ).statusCode,
    ).toBe(200);
    const after = await app.db.select().from(processedEvents).where(eq(processedEvents.platform, "gitlab"));
    expect(after).toHaveLength(before);

    const webhookStableId = `standard-${randomUUID()}`;
    expect((await postWebhook(app, first.bearer, issuePayload(44), { webhookId: webhookStableId })).statusCode).toBe(
      200,
    );
    const afterWebhookId = await app.db.select().from(processedEvents).where(eq(processedEvents.platform, "gitlab"));
    expect(afterWebhookId).toHaveLength(before + 1);
  });

  it("resolves a pending follow and delivers one basic card per chat without wake or outbound fetch", async () => {
    const app = getApp();
    const first = await connection(app);
    const chatId = `chat_${randomUUID()}`;
    await app.db
      .insert(chats)
      .values({ id: chatId, organizationId: first.admin.organizationId, type: "group", metadata: {} });
    await app.db.insert(chatMembership).values({
      chatId,
      agentId: first.admin.humanAgentUuid,
      role: "owner",
      accessMode: "speaker",
    });
    await declareGitlabEntityFollow(app.db, {
      organizationId: first.admin.organizationId,
      connectionId: first.connectionId,
      chatId,
      declaredByAgentId: first.admin.humanAgentUuid,
      entityUrl: "https://gitlab.internal/Acme/API/-/issues/42",
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      expect((await postWebhook(app, first.bearer, issuePayload())).statusCode).toBe(200);
      expect((await postWebhook(app, first.bearer, issuePayload())).statusCode).toBe(200);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
    const repeated = await declareGitlabEntityFollow(app.db, {
      organizationId: first.admin.organizationId,
      connectionId: first.connectionId,
      chatId,
      declaredByAgentId: first.admin.humanAgentUuid,
      entityUrl: "https://gitlab.internal/Acme/API/-/issues/42",
    });
    expect(repeated?.projectId).toBe(501);
    const follows = await app.db
      .select()
      .from(gitlabEntityChatMappings)
      .where(eq(gitlabEntityChatMappings.chatId, chatId));
    expect(follows).toHaveLength(1);
    const cards = await app.db
      .select()
      .from(messages)
      .where(and(eq(messages.chatId, chatId), eq(messages.source, "gitlab")));
    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatchObject({ format: "card", senderId: first.admin.humanAgentUuid });
    expect(cards[0]?.content).toMatchObject({ type: "gitlab_event", project: "Acme/API" });
    expect(cards[0]?.metadata).toMatchObject({ source: "gitlab", systemSender: "gitlab" });
    expect(cards[0]?.metadata).not.toHaveProperty("mentions");

    const stableId = `dedup-${randomUUID()}`;
    expect((await postWebhook(app, first.bearer, issuePayload(), { stableId })).json()).toMatchObject({
      outcome: "delivered",
    });
    expect((await postWebhook(app, first.bearer, issuePayload(), { stableId })).json()).toMatchObject({
      outcome: "duplicate",
    });
    const after = await app.db
      .select()
      .from(messages)
      .where(and(eq(messages.chatId, chatId), eq(messages.source, "gitlab")));
    expect(after).toHaveLength(3);
  });

  it("rejects malformed or mismatched payloads before claiming", async () => {
    const app = getApp();
    const first = await connection(app);
    const stableId = `malformed-${randomUUID()}`;
    const before = await app.db.select().from(processedEvents).where(eq(processedEvents.platform, "gitlab"));
    const response = await postWebhook(app, first.bearer, { object_kind: "merge_request" }, { stableId });
    expect(response.statusCode).toBe(400);
    const after = await app.db.select().from(processedEvents).where(eq(processedEvents.platform, "gitlab"));
    expect(after).toHaveLength(before.length);
  });

  it("applies content/body guards while accepting valid unsupported events as no-ops", async () => {
    const app = getApp();
    const first = await connection(app);
    const unsupported = await postWebhook(app, first.bearer, { object_kind: "push" }, { event: "Push Hook" });
    expect(unsupported.statusCode).toBe(200);
    expect(unsupported.json()).toMatchObject({ outcome: "provider_only" });

    const wrongType = await app.inject({
      method: "POST",
      url: `/api/v1/webhooks/gitlab/${first.bearer}`,
      headers: { "content-type": "text/plain", "x-gitlab-event": "Issue Hook" },
      payload: JSON.stringify(issuePayload()),
    });
    expect(wrongType.statusCode).toBeGreaterThanOrEqual(400);

    const oversized = await postWebhook(app, first.bearer, {
      ...issuePayload(),
      padding: "x".repeat(513 * 1024),
    });
    expect(oversized.statusCode).toBe(413);
  });

  it("allows one chat to follow the same type and IID in two numeric projects", async () => {
    const app = getApp();
    const first = await connection(app);
    const chatId = `chat_${randomUUID()}`;
    await app.db
      .insert(chats)
      .values({ id: chatId, organizationId: first.admin.organizationId, type: "group", metadata: {} });
    for (const projectPath of ["Acme/API", "Other/API"]) {
      await declareGitlabEntityFollow(app.db, {
        organizationId: first.admin.organizationId,
        connectionId: first.connectionId,
        chatId,
        declaredByAgentId: first.admin.humanAgentUuid,
        entityUrl: `https://gitlab.internal/${projectPath}/-/issues/42`,
      });
    }
    const identity = (projectId: number, projectPath: string) => ({
      entityType: "issue" as const,
      entityIid: 42,
      projectId,
      projectPath,
      entityUrl: `https://gitlab.internal/${projectPath}/-/issues/42`,
      title: "Webhook issue",
      entityState: "opened",
    });
    expect(
      await observeGitlabEntityAndResolveFollowers(app.db, first.connectionId, identity(501, "Acme/API")),
    ).toHaveLength(1);
    expect(
      await observeGitlabEntityAndResolveFollowers(app.db, first.connectionId, identity(502, "Other/API")),
    ).toHaveLength(1);
    const secondProjectRepeat = await observeGitlabEntityAndResolveFollowers(
      app.db,
      first.connectionId,
      identity(502, "Other/API"),
    );
    expect(secondProjectRepeat).toHaveLength(1);
    expect(secondProjectRepeat[0]).toMatchObject({
      chatId,
      projectId: 502,
      entityType: "issue",
      entityIid: 42,
    });
    const stored = await app.db
      .select()
      .from(gitlabEntityChatMappings)
      .where(
        and(
          eq(gitlabEntityChatMappings.connectionId, first.connectionId),
          eq(gitlabEntityChatMappings.chatId, chatId),
          eq(gitlabEntityChatMappings.entityType, "issue"),
          eq(gitlabEntityChatMappings.entityIid, 42),
        ),
      );
    expect(stored).toHaveLength(2);
    expect(stored).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ projectId: 501 }),
        expect.objectContaining({ projectId: 502 }),
      ]),
    );
  });

  it("rejects stale replacement after a newer replace or delete", async () => {
    const app = getApp();
    const replacedOrg = await connection(app, { isolatedOrg: true });
    const replacement = await replaceGitlabConnection(app.db, {
      expectedConnectionId: replacedOrg.connectionId,
      organizationId: replacedOrg.admin.organizationId,
      memberId: replacedOrg.admin.memberId,
      displayName: "Current replacement",
      instanceOrigin: "https://gitlab.current",
    });

    await expect(
      replaceGitlabConnection(app.db, {
        expectedConnectionId: replacedOrg.connectionId,
        organizationId: replacedOrg.admin.organizationId,
        memberId: replacedOrg.admin.memberId,
        displayName: "Stale replacement",
        instanceOrigin: "https://gitlab.stale",
      }),
    ).rejects.toThrow("changed or was removed");
    expect((await getGitlabConnectionSummary(app.db, replacement.connectionId)).displayName).toBe(
      "Current replacement",
    );
    expect(await findActiveGitlabEndpoint(app.db, replacement.bearer)).not.toBeNull();

    const deletedOrg = await connection(app, { isolatedOrg: true });
    await deleteGitlabConnection(app.db, deletedOrg.connectionId);
    await expect(
      replaceGitlabConnection(app.db, {
        expectedConnectionId: deletedOrg.connectionId,
        organizationId: deletedOrg.admin.organizationId,
        memberId: deletedOrg.admin.memberId,
        displayName: "Resurrected binding",
        instanceOrigin: "https://gitlab.resurrected",
      }),
    ).rejects.toThrow("changed or was removed");
    const remaining = await app.db
      .select({ id: gitlabConnections.id })
      .from(gitlabConnections)
      .where(eq(gitlabConnections.organizationId, deletedOrg.admin.organizationId));
    expect(remaining).toHaveLength(0);
  });

  it("serializes replacement against in-flight ingress and queued follow declarations", async () => {
    const app = getApp();
    const first = await connection(app);
    const endpoint = await findActiveGitlabEndpoint(app.db, first.bearer);
    if (!endpoint) throw new Error("endpoint missing");
    const chatId = `chat_${randomUUID()}`;
    await app.db.insert(chats).values({
      id: chatId,
      organizationId: first.admin.organizationId,
      type: "group",
      metadata: {},
    });

    let enterFence!: () => void;
    let releaseFence!: () => void;
    const entered = new Promise<void>((resolve) => {
      enterFence = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseFence = resolve;
    });
    const inFlight = withGitlabIngressFence(app.db, first.connectionId, endpoint.connection.tokenHash, async (tx) => {
      enterFence();
      await release;
      await markGitlabInboundSeen(tx, first.connectionId, endpoint.connection.tokenHash);
    });
    await entered;
    let replaced = false;
    const replacing = replaceGitlabConnection(app.db, {
      expectedConnectionId: first.connectionId,
      organizationId: first.admin.organizationId,
      memberId: first.admin.memberId,
      displayName: "Replacement",
      instanceOrigin: "https://gitlab.replacement",
    }).then(() => {
      replaced = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(replaced).toBe(false);
    const declaring = declareGitlabEntityFollow(app.db, {
      organizationId: first.admin.organizationId,
      connectionId: first.connectionId,
      chatId,
      declaredByAgentId: first.admin.humanAgentUuid,
      entityUrl: "https://gitlab.internal/Acme/API/-/issues/42",
    });
    releaseFence();
    await inFlight;
    await replacing;
    await expect(declaring).rejects.toThrow("not found");
    expect((await postWebhook(app, first.bearer, issuePayload())).statusCode).toBe(404);
  });

  it("does not persist an unfollowed webhook and resolves later pending follows on the next event", async () => {
    const app = getApp();
    const first = await connection(app);
    expect((await postWebhook(app, first.bearer, issuePayload())).statusCode).toBe(200);
    const unseen = await app.db
      .select()
      .from(gitlabEntityChatMappings)
      .where(eq(gitlabEntityChatMappings.connectionId, first.connectionId));
    expect(unseen).toHaveLength(0);

    for (const suffix of ["a", "b"]) {
      const chatId = `chat_${suffix}_${randomUUID()}`;
      await app.db.insert(chats).values({
        id: chatId,
        organizationId: first.admin.organizationId,
        type: "group",
        metadata: {},
      });
      await app.db.insert(chatMembership).values({
        chatId,
        agentId: first.admin.humanAgentUuid,
        role: "owner",
        accessMode: "speaker",
      });
      const follow = await declareGitlabEntityFollow(app.db, {
        organizationId: first.admin.organizationId,
        connectionId: first.connectionId,
        chatId,
        declaredByAgentId: first.admin.humanAgentUuid,
        entityUrl: "https://gitlab.internal/Acme/API/-/issues/42",
      });
      expect(follow).toMatchObject({ projectId: null });
    }
    expect((await postWebhook(app, first.bearer, issuePayload())).statusCode).toBe(200);
    const observed = await app.db
      .select()
      .from(gitlabEntityChatMappings)
      .where(eq(gitlabEntityChatMappings.connectionId, first.connectionId));
    expect(observed).toHaveLength(2);
    expect(observed.every((row) => row.projectId === 501)).toBe(true);
  });

  it("collapses a renamed-path pending follow into the stable numeric observed mapping", async () => {
    const app = getApp();
    const first = await connection(app);
    const chatId = `chat_${randomUUID()}`;
    await app.db.insert(chats).values({
      id: chatId,
      organizationId: first.admin.organizationId,
      type: "group",
      metadata: {},
    });
    await app.db.insert(chatMembership).values({
      chatId,
      agentId: first.admin.humanAgentUuid,
      role: "owner",
      accessMode: "speaker",
    });
    expect(
      (
        await declareGitlabEntityFollow(app.db, {
          organizationId: first.admin.organizationId,
          connectionId: first.connectionId,
          chatId,
          declaredByAgentId: first.admin.humanAgentUuid,
          entityUrl: "https://gitlab.internal/Acme/API/-/issues/42",
        })
      )?.projectId,
    ).toBeNull();
    expect((await postWebhook(app, first.bearer, issuePayload())).statusCode).toBe(200);
    expect(
      (
        await declareGitlabEntityFollow(app.db, {
          organizationId: first.admin.organizationId,
          connectionId: first.connectionId,
          chatId,
          declaredByAgentId: first.admin.humanAgentUuid,
          entityUrl: "https://gitlab.internal/Acme/Renamed/-/issues/42",
        })
      )?.projectId,
    ).toBeNull();
    expect((await postWebhook(app, first.bearer, issuePayload(42, { projectPath: "Acme/Renamed" }))).statusCode).toBe(
      200,
    );
    const mappings = await app.db
      .select()
      .from(gitlabEntityChatMappings)
      .where(eq(gitlabEntityChatMappings.chatId, chatId));
    expect(mappings).toHaveLength(1);
    expect(mappings[0]).toMatchObject({ projectId: 501, projectPath: "Acme/Renamed" });
  });

  it("isolates per-chat delivery failure and retains the whole-request stable claim", async () => {
    const app = getApp();
    const first = await connection(app);
    for (const suffix of ["a", "b"]) {
      const chatId = `chat_${suffix}_${randomUUID()}`;
      await app.db.insert(chats).values({
        id: chatId,
        organizationId: first.admin.organizationId,
        type: "group",
        metadata: {},
      });
      await app.db.insert(chatMembership).values({
        chatId,
        agentId: first.admin.humanAgentUuid,
        role: "owner",
        accessMode: "speaker",
      });
      await declareGitlabEntityFollow(app.db, {
        organizationId: first.admin.organizationId,
        connectionId: first.connectionId,
        chatId,
        declaredByAgentId: first.admin.humanAgentUuid,
        entityUrl: "https://gitlab.internal/Acme/API/-/issues/42",
      });
    }
    const before = await app.db.select().from(messages).where(eq(messages.source, "gitlab"));
    const sendSpy = vi.spyOn(scmCardDelivery, "sendScmSystemCard").mockRejectedValueOnce(new Error("chat down"));
    const stableId = `partial-${randomUUID()}`;
    const firstDelivery = await postWebhook(app, first.bearer, issuePayload(), { stableId });
    sendSpy.mockRestore();
    expect(firstDelivery.statusCode).toBe(200);
    expect(firstDelivery.json()).toMatchObject({ outcome: "delivered" });
    const after = await app.db.select().from(messages).where(eq(messages.source, "gitlab"));
    expect(after).toHaveLength(before.length + 1);
    expect((await postWebhook(app, first.bearer, issuePayload(), { stableId })).json()).toMatchObject({
      outcome: "duplicate",
    });
  });

  it("defers SCM card kicks and inbox notifications until the outer transaction commits", async () => {
    const app = getApp();
    const first = await connection(app);
    const recipient = await createAgent(app.db, {
      name: `gitlab-recipient-${randomUUID().slice(0, 8)}`,
      type: "agent",
      displayName: "GitLab Recipient",
      managerId: first.admin.memberId,
    });
    const chatId = `chat_${randomUUID()}`;
    await app.db.insert(chats).values({
      id: chatId,
      organizationId: first.admin.organizationId,
      type: "group",
      metadata: {},
    });
    await app.db.insert(chatMembership).values([
      {
        chatId,
        agentId: first.admin.humanAgentUuid,
        role: "owner",
        accessMode: "speaker",
      },
      { chatId, agentId: recipient.uuid, role: "member", accessMode: "speaker" },
    ]);
    const kickSpy = vi.spyOn(app.notifier, "notifyChatMessage").mockResolvedValue();
    const inboxSpy = vi.spyOn(app.notifier, "notify").mockResolvedValue();
    const cardInput = {
      chatId,
      senderId: first.admin.humanAgentUuid,
      provider: "gitlab" as const,
      content: { type: "gitlab_event" },
      metadata: { mentions: [recipient.uuid] },
    };

    const committed = await app.db.transaction(async (tx) => {
      const sent = await scmCardDelivery.sendScmSystemCard(app, {
        ...cardInput,
        database: tx as unknown as typeof app.db,
        deferPostCommitEffects: true,
      });
      expect(kickSpy).not.toHaveBeenCalled();
      expect(inboxSpy).not.toHaveBeenCalled();
      if (!sent.deferredPostCommitEffects) throw new Error("missing deferred effects");
      return sent;
    });
    expect(await app.db.select().from(messages).where(eq(messages.id, committed.message.id))).toHaveLength(1);
    const committedEffects = committed.deferredPostCommitEffects;
    if (!committedEffects) throw new Error("missing committed effects");
    await scmCardDelivery.runDeferredScmCardPostCommitEffects(app, committedEffects);
    expect(kickSpy).toHaveBeenCalledWith(chatId, committed.message.id);
    expect(inboxSpy).toHaveBeenCalledWith(recipient.inboxId, committed.message.id);

    kickSpy.mockClear();
    inboxSpy.mockClear();
    let rolledBackMessageId: string | undefined;
    await expect(
      app.db.transaction(async (tx) => {
        const sent = await scmCardDelivery.sendScmSystemCard(app, {
          ...cardInput,
          database: tx as unknown as typeof app.db,
          deferPostCommitEffects: true,
        });
        rolledBackMessageId = sent.message.id;
        throw new Error("force outer rollback");
      }),
    ).rejects.toThrow("force outer rollback");
    expect(kickSpy).not.toHaveBeenCalled();
    expect(inboxSpy).not.toHaveBeenCalled();
    if (!rolledBackMessageId) throw new Error("missing rolled-back message id");
    expect(await app.db.select().from(messages).where(eq(messages.id, rolledBackMessageId))).toHaveLength(0);
    kickSpy.mockRestore();
    inboxSpy.mockRestore();
  });

  it("rejects malformed JSON and rate-limits each current connection", async () => {
    const app = getApp();
    const malformedConnection = await connection(app);
    const malformed = await app.inject({
      method: "POST",
      url: `/api/v1/webhooks/gitlab/${malformedConnection.bearer}`,
      headers: { "content-type": "application/json", "x-gitlab-event": "Issue Hook" },
      payload: '{"object_kind":',
    });
    expect(malformed.statusCode).toBe(400);

    const limited = await connection(app, { isolatedOrg: true });
    for (let index = 0; index < 119; index += 1) {
      const response = await postWebhook(app, limited.bearer, { object_kind: "test" }, { event: "Test Hook" });
      expect(response.statusCode).toBe(200);
    }
    const missingEventHeader = await app.inject({
      method: "POST",
      url: `/api/v1/webhooks/gitlab/${limited.bearer}`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ object_kind: "test" }),
    });
    expect(missingEventHeader.statusCode).toBe(400);
    expect((await postWebhook(app, limited.bearer, { object_kind: "test" }, { event: "Test Hook" })).statusCode).toBe(
      429,
    );
    const rateLimitedBeforeJsonParsing = await app.inject({
      method: "POST",
      url: `/api/v1/webhooks/gitlab/${limited.bearer}`,
      headers: { "content-type": "application/json", "x-gitlab-event": "Issue Hook" },
      payload: '{"object_kind":',
    });
    expect(rateLimitedBeforeJsonParsing.statusCode).toBe(429);
    expect((await getGitlabConnectionSummary(app.db, limited.connectionId)).health.lastProcessingFailureCode).toBe(
      "missing_or_invalid_event_header",
    );
    expect(
      (await postWebhook(app, malformedConnection.bearer, { object_kind: "test" }, { event: "Test Hook" })).statusCode,
    ).toBe(200);

    const unknownSourceIp = "203.0.113.77";
    for (let index = 0; index < 119; index += 1) {
      const unknown = await app.inject({
        method: "POST",
        url: `/api/v1/webhooks/gitlab/invalid-${index}`,
        remoteAddress: unknownSourceIp,
      });
      expect(unknown.statusCode).toBe(404);
    }
    const unknownWellFormed = await app.inject({
      method: "POST",
      url: `/api/v1/webhooks/gitlab/${"x".repeat(43)}`,
      remoteAddress: unknownSourceIp,
    });
    expect(unknownWellFormed.statusCode).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/webhooks/gitlab/invalid-over-limit",
          remoteAddress: unknownSourceIp,
        })
      ).statusCode,
    ).toBe(429);
    expect(
      (
        await postWebhook(
          app,
          malformedConnection.bearer,
          { object_kind: "test" },
          {
            event: "Test Hook",
            remoteAddress: unknownSourceIp,
          },
        )
      ).statusCode,
    ).toBe(200);
  }, 30_000);

  it("redacts unmatched webhook bearer span names and requires direct human membership for follow writes", async () => {
    expect(
      formatHttpSpanName({
        method: "POST",
        url: "/api/v1/webhooks/gitlab/sensitive-bearer/extra?token=also-sensitive",
      }),
    ).toBe("POST /api/v1/webhooks/gitlab/***/extra");

    const app = getApp();
    const manager = await createTestAgent(app, { name: `managed-${randomUUID().slice(0, 8)}` });
    const created = await createGitlabConnection(app.db, {
      organizationId: manager.organizationId,
      memberId: manager.memberId,
      displayName: "Managed GitLab",
      instanceOrigin: "https://gitlab.internal",
    });
    const chatId = `chat_${randomUUID()}`;
    await app.db.insert(chats).values({
      id: chatId,
      organizationId: manager.organizationId,
      type: "group",
      metadata: {},
    });
    await app.db.insert(chatMembership).values({
      chatId,
      agentId: manager.agent.uuid,
      role: "member",
      accessMode: "speaker",
    });
    const follow = () =>
      app.inject({
        method: "POST",
        url: `/api/v1/chats/${chatId}/gitlab-entities`,
        headers: { authorization: `Bearer ${manager.accessToken}` },
        payload: {
          connectionId: created.connectionId,
          entityUrl: "https://gitlab.internal/Acme/API/-/issues/42",
        },
      });
    expect((await follow()).statusCode).toBe(404);
    await app.db.insert(chatMembership).values({
      chatId,
      agentId: manager.humanAgentUuid,
      role: "member",
      accessMode: "watcher",
    });
    const directFollow = await follow();
    expect(directFollow.statusCode).toBe(201);
    const malformedEncoding = await app.inject({
      method: "POST",
      url: `/api/v1/chats/${chatId}/gitlab-entities`,
      headers: { authorization: `Bearer ${manager.accessToken}` },
      payload: {
        connectionId: created.connectionId,
        entityUrl: "https://gitlab.internal/Acme/%E0%A4/-/issues/43",
      },
    });
    expect(malformedEncoding.statusCode).toBe(400);
    const mappingId = (directFollow.json() as { entity: { id: string } }).entity.id;
    await app.db
      .delete(chatMembership)
      .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.agentId, manager.humanAgentUuid)));
    const supervisorDelete = await app.inject({
      method: "DELETE",
      url: `/api/v1/chats/${chatId}/gitlab-entities?mappingId=${mappingId}`,
      headers: { authorization: `Bearer ${manager.accessToken}` },
    });
    expect(supervisorDelete.statusCode).toBe(404);
  });
});
