import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { formatHttpSpanName } from "../app.js";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chats } from "../db/schema/chats.js";
import { gitlabConnectionAuditEvents } from "../db/schema/gitlab-connection-audit-events.js";
import { gitlabEndpointGenerations } from "../db/schema/gitlab-endpoint-generations.js";
import { gitlabEntities } from "../db/schema/gitlab-entities.js";
import { gitlabEntityChatMappings } from "../db/schema/gitlab-entity-chat-mappings.js";
import { members } from "../db/schema/members.js";
import { messages } from "../db/schema/messages.js";
import { processedEvents } from "../db/schema/processed-events.js";
import { createAgent } from "../services/agent.js";
import {
  completeGitlabConnectionRecovery,
  completeGitlabConnectionRotation,
  createGitlabConnection,
  disableGitlabConnection,
  findActiveGitlabEndpoint,
  getGitlabConnectionSummary,
  markGitlabInboundSeen,
  rearmGitlabConnection,
  rotateGitlabConnection,
  setGitlabAutomaticActions,
  withGitlabIngressFence,
} from "../services/gitlab-connections.js";
import { declareGitlabEntityFollow, observeGitlabEntityAndResolveFollowers } from "../services/gitlab-entity-follow.js";
import { createOrganization } from "../services/organization.js";
import * as scmCardDelivery from "../services/scm-card-delivery.js";
import { uuidv7 } from "../uuid.js";
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
  options: { event?: string; stableId?: string; remoteAddress?: string } = {},
) {
  return app.inject({
    method: "POST",
    url: `/api/v1/webhooks/gitlab/${bearer}`,
    headers: {
      "content-type": "application/json",
      "x-gitlab-event": options.event ?? "Issue Hook",
      ...(options.stableId ? { "idempotency-key": options.stableId } : {}),
    },
    payload: JSON.stringify(body),
    ...(options.remoteAddress ? { remoteAddress: options.remoteAddress } : {}),
  });
}

describe("GitLab Stage 2A backend", () => {
  const getApp = useTestApp();

  async function connection(app: App) {
    const admin = await createTestAdmin(app, { username: `gitlab-${randomUUID().slice(0, 8)}` });
    const created = await createGitlabConnection(app.db, {
      organizationId: admin.organizationId,
      memberId: admin.memberId,
      displayName: "Private GitLab",
      instanceOrigin: "https://gitlab.internal",
    });
    return { admin, ...created };
  }

  it("stores only a token hash and enforces planned/incident endpoint lifecycle", async () => {
    const app = getApp();
    const first = await connection(app);
    const persisted = await app.db
      .select()
      .from(gitlabEndpointGenerations)
      .where(eq(gitlabEndpointGenerations.connectionId, first.connectionId));
    expect(persisted).toHaveLength(1);
    expect(JSON.stringify(persisted)).not.toContain(first.bearer);
    expect(JSON.stringify(await getGitlabConnectionSummary(app.db, first.connectionId))).not.toContain(first.bearer);

    const rotated = await rotateGitlabConnection(app.db, first.connectionId, first.admin.memberId);
    expect(await findActiveGitlabEndpoint(app.db, first.bearer)).not.toBeNull();
    expect(await findActiveGitlabEndpoint(app.db, rotated.bearer)).not.toBeNull();
    await expect(completeGitlabConnectionRotation(app.db, first.connectionId, first.admin.memberId)).rejects.toThrow(
      "must receive",
    );

    const test = await postWebhook(app, rotated.bearer, { object_kind: "test" }, { event: "Test Hook" });
    expect(test.statusCode).toBe(200);
    await completeGitlabConnectionRotation(app.db, first.connectionId, first.admin.memberId);
    expect(await findActiveGitlabEndpoint(app.db, first.bearer)).toBeNull();
    expect(await findActiveGitlabEndpoint(app.db, rotated.bearer)).not.toBeNull();

    const recoveryChatId = `chat_${randomUUID()}`;
    await app.db.insert(chats).values({
      id: recoveryChatId,
      organizationId: first.admin.organizationId,
      type: "group",
      metadata: {},
    });
    await app.db.insert(chatMembership).values({
      chatId: recoveryChatId,
      agentId: first.admin.humanAgentUuid,
      role: "owner",
      accessMode: "speaker",
    });
    await declareGitlabEntityFollow(app.db, {
      organizationId: first.admin.organizationId,
      connectionId: first.connectionId,
      chatId: recoveryChatId,
      declaredByAgentId: first.admin.humanAgentUuid,
      entityUrl: "https://gitlab.internal/Acme/API/-/issues/42",
    });
    await setGitlabAutomaticActions(app.db, first.connectionId, first.admin.memberId, true);

    await disableGitlabConnection(app.db, first.connectionId, "incident", first.admin.memberId);
    expect(await findActiveGitlabEndpoint(app.db, rotated.bearer)).toBeNull();
    expect((await getGitlabConnectionSummary(app.db, first.connectionId)).active).toBe(false);

    const rearmed = await rearmGitlabConnection(app.db, first.connectionId, first.admin.memberId);
    expect(await findActiveGitlabEndpoint(app.db, rotated.bearer)).toBeNull();
    expect(await getGitlabConnectionSummary(app.db, first.connectionId)).toMatchObject({
      recoveryPending: true,
      automaticActionsEnabled: false,
    });
    await expect(completeGitlabConnectionRecovery(app.db, first.connectionId, first.admin.memberId)).rejects.toThrow(
      "must receive",
    );
    expect((await postWebhook(app, rearmed.bearer, issuePayload())).statusCode).toBe(200);
    expect(
      await app.db
        .select()
        .from(messages)
        .where(and(eq(messages.chatId, recoveryChatId), eq(messages.source, "gitlab"))),
    ).toHaveLength(0);
    expect((await postWebhook(app, rearmed.bearer, { object_kind: "test" }, { event: "Test Hook" })).statusCode).toBe(
      200,
    );
    await completeGitlabConnectionRecovery(app.db, first.connectionId, first.admin.memberId);
    expect((await getGitlabConnectionSummary(app.db, first.connectionId)).recoveryPending).toBe(false);
    const cardKickSpy = vi.spyOn(app.notifier, "notifyChatMessage").mockResolvedValue();
    expect((await postWebhook(app, rearmed.bearer, issuePayload())).statusCode).toBe(200);
    const recoveredMessages = await app.db
      .select()
      .from(messages)
      .where(and(eq(messages.chatId, recoveryChatId), eq(messages.source, "gitlab")));
    expect(recoveredMessages).toHaveLength(1);
    expect(cardKickSpy).toHaveBeenCalledWith(recoveryChatId, recoveredMessages[0]?.id);
    cardKickSpy.mockRestore();
    const audit = await app.db
      .select({ event: gitlabConnectionAuditEvents.event })
      .from(gitlabConnectionAuditEvents)
      .where(eq(gitlabConnectionAuditEvents.connectionId, first.connectionId));
    expect(audit.map((row) => row.event)).toEqual(
      expect.arrayContaining([
        "rotation_started",
        "rotation_completed",
        "disabled_incident",
        "rearmed",
        "recovery_completed",
      ]),
    );
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

    const missingAcceptance = await app.inject({
      method: "PUT",
      url: `/api/v1/gitlab-connections/${created.connection.id}/automatic-actions`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { enabled: true },
    });
    expect(missingAcceptance.statusCode).toBe(400);
    const accepted = await app.inject({
      method: "PUT",
      url: `/api/v1/gitlab-connections/${created.connection.id}/automatic-actions`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { enabled: true, acceptTeamWideUrlBearerRisk: true },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ automaticActionsEnabled: true });
    const revoked = await app.inject({
      method: "PUT",
      url: `/api/v1/gitlab-connections/${created.connection.id}/automatic-actions`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { enabled: false },
    });
    expect(revoked.statusCode).toBe(200);
    const actionAudit = await app.db
      .select({ event: gitlabConnectionAuditEvents.event })
      .from(gitlabConnectionAuditEvents)
      .where(eq(gitlabConnectionAuditEvents.connectionId, created.connection.id));
    expect(actionAudit.map((row) => row.event)).toEqual(
      expect.arrayContaining(["automatic_actions_accepted", "automatic_actions_revoked"]),
    );

    const disabled = await app.inject({
      method: "POST",
      url: `/api/v1/gitlab-connections/${created.connection.id}/disable`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { mode: "incident" },
    });
    expect(disabled.statusCode).toBe(200);
    const rearmed = await app.inject({
      method: "POST",
      url: `/api/v1/gitlab-connections/${created.connection.id}/rearm`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(rearmed.statusCode).toBe(200);
    const freshUrl = (rearmed.json() as { webhookUrl: string }).webhookUrl;
    const freshBearer = freshUrl.split("/").at(-1);
    if (!freshBearer) throw new Error("fresh GitLab bearer missing");
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/gitlab-connections/${created.connection.id}/complete-recovery`,
          headers: { authorization: `Bearer ${admin.accessToken}` },
        })
      ).statusCode,
    ).toBe(409);
    expect((await postWebhook(app, freshBearer, { object_kind: "test" }, { event: "Test Hook" })).statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/gitlab-connections/${created.connection.id}/complete-recovery`,
          headers: { authorization: `Bearer ${admin.accessToken}` },
        })
      ).statusCode,
    ).toBe(200);

    await app.db.update(members).set({ role: "member" }).where(eq(members.id, admin.memberId));
    const read = await app.inject({
      method: "GET",
      url: `/api/v1/gitlab-connections/${created.connection.id}`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(read.statusCode).toBe(200);
    expect(read.body).not.toContain(created.webhookUrl);
    const rotate = await app.inject({
      method: "POST",
      url: `/api/v1/gitlab-connections/${created.connection.id}/rotate`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(rotate.statusCode).toBe(404);
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
    const second = await connection(app);
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
    expect((await postWebhook(app, first.bearer, issuePayload(43))).statusCode).toBe(200);
    const after = await app.db.select().from(processedEvents).where(eq(processedEvents.platform, "gitlab"));
    expect(after).toHaveLength(before);
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
    expect(repeated?.status).toBe("observed");
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

  it("keeps a pending declaration unresolved when its chat is already bound to a different numeric project", async () => {
    const app = getApp();
    const first = await connection(app);
    const chatId = `chat_${randomUUID()}`;
    await app.db
      .insert(chats)
      .values({ id: chatId, organizationId: first.admin.organizationId, type: "group", metadata: {} });
    const pending = await declareGitlabEntityFollow(app.db, {
      organizationId: first.admin.organizationId,
      connectionId: first.connectionId,
      chatId,
      declaredByAgentId: first.admin.humanAgentUuid,
      entityUrl: "https://gitlab.internal/Acme/API/-/issues/42",
    });
    await app.db.insert(gitlabEntityChatMappings).values({
      id: uuidv7(),
      organizationId: first.admin.organizationId,
      connectionId: first.connectionId,
      chatId,
      declaredByAgentId: first.admin.humanAgentUuid,
      entityType: "issue",
      entityIid: 42,
      projectId: 999,
      projectPath: "Other/API",
      projectPathNormalized: "other/api",
      entityUrl: "https://gitlab.internal/Other/API/-/issues/42",
      status: "observed",
    });
    const resolved = await observeGitlabEntityAndResolveFollowers(
      app.db,
      first.admin.organizationId,
      first.connectionId,
      {
        entityType: "issue",
        entityIid: 42,
        projectId: 501,
        projectPath: "Acme/API",
        entityUrl: "https://gitlab.internal/Acme/API/-/issues/42",
        title: "Webhook issue",
        entityState: "opened",
      },
    );
    expect(resolved).toHaveLength(0);
    const [stored] = await app.db
      .select()
      .from(gitlabEntityChatMappings)
      .where(eq(gitlabEntityChatMappings.id, pending?.id ?? ""));
    expect(stored).toMatchObject({ status: "pending", lastConflictReason: "chat_already_bound_to_different_project" });
  });

  it("serializes incident disable against in-flight ingress and queued follow declarations", async () => {
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
    const inFlight = withGitlabIngressFence(app.db, first.connectionId, endpoint.endpoint.id, async (tx) => {
      enterFence();
      await release;
      await markGitlabInboundSeen(tx, first.connectionId, endpoint.endpoint.id);
    });
    await entered;
    let disabled = false;
    const disabling = disableGitlabConnection(app.db, first.connectionId, "incident", first.admin.memberId).then(() => {
      disabled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(disabled).toBe(false);
    const declaring = declareGitlabEntityFollow(app.db, {
      organizationId: first.admin.organizationId,
      connectionId: first.connectionId,
      chatId,
      declaredByAgentId: first.admin.humanAgentUuid,
      entityUrl: "https://gitlab.internal/Acme/API/-/issues/42",
    });
    releaseFence();
    await inFlight;
    await disabling;
    await expect(declaring).rejects.toThrow("not found");
    expect((await postWebhook(app, first.bearer, issuePayload())).statusCode).toBe(404);
  });

  it("persists observed entity identity before follow and resolves later follows in every chat", async () => {
    const app = getApp();
    const first = await connection(app);
    expect((await postWebhook(app, first.bearer, issuePayload())).statusCode).toBe(200);
    const observed = await app.db
      .select()
      .from(gitlabEntities)
      .where(eq(gitlabEntities.connectionId, first.connectionId));
    expect(observed).toHaveLength(1);

    for (const suffix of ["a", "b"]) {
      const chatId = `chat_${suffix}_${randomUUID()}`;
      await app.db.insert(chats).values({
        id: chatId,
        organizationId: first.admin.organizationId,
        type: "group",
        metadata: {},
      });
      const follow = await declareGitlabEntityFollow(app.db, {
        organizationId: first.admin.organizationId,
        connectionId: first.connectionId,
        chatId,
        declaredByAgentId: first.admin.humanAgentUuid,
        entityUrl: "https://gitlab.internal/Acme/API/-/issues/42",
      });
      expect(follow).toMatchObject({ status: "observed", projectId: 501, entityId: observed[0]?.id });
    }
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
    expect((await postWebhook(app, first.bearer, issuePayload())).statusCode).toBe(200);
    expect(
      (
        await declareGitlabEntityFollow(app.db, {
          organizationId: first.admin.organizationId,
          connectionId: first.connectionId,
          chatId,
          declaredByAgentId: first.admin.humanAgentUuid,
          entityUrl: "https://gitlab.internal/Acme/API/-/issues/42",
        })
      )?.status,
    ).toBe("observed");
    expect(
      (
        await declareGitlabEntityFollow(app.db, {
          organizationId: first.admin.organizationId,
          connectionId: first.connectionId,
          chatId,
          declaredByAgentId: first.admin.humanAgentUuid,
          entityUrl: "https://gitlab.internal/Acme/Renamed/-/issues/42",
        })
      )?.status,
    ).toBe("pending");
    expect((await postWebhook(app, first.bearer, issuePayload(42, { projectPath: "Acme/Renamed" }))).statusCode).toBe(
      200,
    );
    const mappings = await app.db
      .select()
      .from(gitlabEntityChatMappings)
      .where(eq(gitlabEntityChatMappings.chatId, chatId));
    expect(mappings).toHaveLength(1);
    expect(mappings[0]).toMatchObject({ status: "observed", projectId: 501, projectPath: "Acme/Renamed" });
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

  it("rejects malformed JSON and rate-limits planned generations by connection", async () => {
    const app = getApp();
    const malformedConnection = await connection(app);
    const malformed = await app.inject({
      method: "POST",
      url: `/api/v1/webhooks/gitlab/${malformedConnection.bearer}`,
      headers: { "content-type": "application/json", "x-gitlab-event": "Issue Hook" },
      payload: '{"object_kind":',
    });
    expect(malformed.statusCode).toBe(400);

    const limited = await connection(app);
    const rotated = await rotateGitlabConnection(app.db, limited.connectionId, limited.admin.memberId);
    for (let index = 0; index < 119; index += 1) {
      const bearer = index % 2 === 0 ? limited.bearer : rotated.bearer;
      const response = await postWebhook(app, bearer, { object_kind: "test" }, { event: "Test Hook" });
      expect(response.statusCode).toBe(200);
    }
    const missingEventHeader = await app.inject({
      method: "POST",
      url: `/api/v1/webhooks/gitlab/${rotated.bearer}`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ object_kind: "test" }),
    });
    expect(missingEventHeader.statusCode).toBe(400);
    expect((await postWebhook(app, rotated.bearer, { object_kind: "test" }, { event: "Test Hook" })).statusCode).toBe(
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
