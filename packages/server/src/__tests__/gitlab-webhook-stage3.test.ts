import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agentChatSessions } from "../db/schema/agent-chat-sessions.js";
import { agents } from "../db/schema/agents.js";
import { gitlabConnections } from "../db/schema/gitlab-connections.js";
import { gitlabEntityChatMappings } from "../db/schema/gitlab-entity-chat-mappings.js";
import { gitlabIdentityLinks } from "../db/schema/gitlab-identity-links.js";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { members } from "../db/schema/members.js";
import { messages } from "../db/schema/messages.js";
import { processedEvents } from "../db/schema/processed-events.js";
import { createAgent } from "../services/agent.js";
import { createChat } from "../services/chat.js";
import {
  createGitlabConnection,
  deleteGitlabConnection,
  getGitlabConnectionSummary,
  parseDeclaredGitlabVersion,
  regenerateGitlabConnectionBearer,
  replaceGitlabConnection,
} from "../services/gitlab-connections.js";
import { declareGitlabEntityFollow } from "../services/gitlab-entity-follow.js";
import {
  createGitlabIdentityLink,
  reconfirmGitlabIdentityLink,
  removeGitlabIdentityLink,
  suspendGitlabLinksForMembership,
} from "../services/gitlab-identities.js";
import { applyGitlabPersonnelEvidence, normalizeGitlabWebhook } from "../services/gitlab-webhook.js";
import { pollInbox } from "../services/inbox.js";
import { deleteMember } from "../services/member.js";
import { deactivateMembership, MEMBER_STATUSES, reactivateMembership } from "../services/membership.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

type App = ReturnType<ReturnType<typeof useTestApp>>;

function mergeRequestPayload(input: {
  action?: string | null;
  reviewers?: unknown;
  assignees?: unknown;
  changes?: unknown;
  iid?: number;
  actor?: string;
}) {
  return {
    object_kind: "merge_request",
    project: {
      id: 801,
      path_with_namespace: "Acme/Reviews",
      web_url: "https://gitlab.internal/Acme/Reviews",
    },
    user: { username: input.actor ?? "author" },
    ...(Object.hasOwn(input, "reviewers") ? { reviewers: input.reviewers } : {}),
    ...(Object.hasOwn(input, "assignees") ? { assignees: input.assignees } : {}),
    ...(Object.hasOwn(input, "changes") ? { changes: input.changes } : {}),
    object_attributes: {
      iid: input.iid ?? 17,
      ...(input.action === null ? {} : { action: input.action ?? "open" }),
      title: "Review this change",
      description: "Please review",
      url: `https://gitlab.internal/Acme/Reviews/-/merge_requests/${input.iid ?? 17}`,
      state: "opened",
    },
  };
}

async function postMr(app: App, bearer: string, body: object, stableId?: string, userAgent = "GitLab/15.3.0") {
  return app.inject({
    method: "POST",
    url: `/api/v1/webhooks/gitlab/${bearer}`,
    headers: {
      "content-type": "application/json",
      "x-gitlab-event": "Merge Request Hook",
      "user-agent": userAgent,
      ...(stableId ? { "idempotency-key": stableId } : {}),
    },
    payload: JSON.stringify(body),
  });
}

describe("GitLab Stage 3 personnel routing", () => {
  const getApp = useTestApp();

  async function setupTarget(app: App) {
    const admin = await createTestAdmin(app, { username: `gitlab-stage3-${randomUUID().slice(0, 8)}` });
    const delegate = await createAgent(app.db, {
      name: `review-agent-${randomUUID().slice(0, 8)}`,
      type: "agent",
      displayName: "Review Agent",
      managerId: admin.memberId,
      organizationId: admin.organizationId,
    });
    await app.db.update(agents).set({ delegateMention: delegate.uuid }).where(eq(agents.uuid, admin.humanAgentUuid));
    const connection = await createGitlabConnection(app.db, {
      organizationId: admin.organizationId,
      memberId: admin.memberId,
      displayName: "Private GitLab",
      instanceOrigin: "https://gitlab.internal",
    });
    const link = await createGitlabIdentityLink(app.db, {
      organizationId: admin.organizationId,
      connectionId: connection.connectionId,
      membershipId: admin.memberId,
      username: "Reviewer.One",
    });
    return { admin, delegate, connection, link };
  }

  it("normalizes capability-driven reviewer, legacy assignee, delta, and schema-anomaly semantics", () => {
    const normalize = (body: object) =>
      normalizeGitlabWebhook({
        organizationId: "org-1",
        connectionId: "connection-1",
        instanceOrigin: "https://gitlab.internal",
        stableDeliveryId: null,
        eventHeader: "Merge Request Hook",
        body,
      });

    const opened = normalize(
      mergeRequestPayload({
        reviewers: [{ username: "Reviewer.One" }],
        assignees: [{ username: "Owner.One" }],
      }),
    );
    expect(applyGitlabPersonnelEvidence(opened, "unknown")).toMatchObject({
      schemaAnomalyCode: null,
      candidates: [
        { externalUsername: "Reviewer.One", targetClass: "reviewer" },
        { externalUsername: "Owner.One", targetClass: "assignee" },
      ],
    });

    const empty = normalize(mergeRequestPayload({ reviewers: [], assignees: [{ username: "Owner.One" }] }));
    expect(applyGitlabPersonnelEvidence(empty, "unknown")).toMatchObject({
      candidates: [{ externalUsername: "Owner.One", targetClass: "assignee" }],
    });

    const legacy = normalize(mergeRequestPayload({ assignees: [{ username: "Reviewer.One" }] }));
    expect(applyGitlabPersonnelEvidence(legacy, "unknown")).toMatchObject({
      candidates: [{ externalUsername: "Reviewer.One", targetClass: "reviewer" }],
    });
    expect(applyGitlabPersonnelEvidence(legacy, "assignee")).toMatchObject({
      candidates: [{ externalUsername: "Reviewer.One", targetClass: "reviewer" }],
    });
    expect(applyGitlabPersonnelEvidence(legacy, "reviewers")).toMatchObject({
      candidates: [{ externalUsername: "Reviewer.One", targetClass: "assignee" }],
      schemaAnomalyCode: null,
    });

    const update = normalize(
      mergeRequestPayload({
        action: "update",
        reviewers: [{ username: "Reviewer.One" }, { username: "Reviewer.Two" }],
        changes: {
          reviewers: {
            previous: [{ username: "Reviewer.One" }],
            current: [{ username: "Reviewer.One" }, { username: "Reviewer.Two" }],
          },
        },
      }),
    );
    expect(applyGitlabPersonnelEvidence(update, "reviewers").candidates).toEqual([
      { externalUsername: "Reviewer.Two", targetClass: "reviewer" },
    ]);

    const customTemplate = normalize(
      mergeRequestPayload({
        action: "update",
        reviewers: [{ username: "Reviewer.One" }],
        assignees: [{ username: "Owner.Two" }],
        changes: {
          assignees: { previous: [{ username: "Owner.One" }], current: [{ username: "Owner.Two" }] },
        },
      }),
    );
    expect(applyGitlabPersonnelEvidence(customTemplate, "reviewers")).toMatchObject({
      candidates: [{ externalUsername: "Owner.Two", targetClass: "assignee" }],
      schemaAnomalyCode: "reviewers_delta_missing",
    });

    for (const action of ["close", "reopen", "merge", null] as const) {
      const nonTargetAction = normalize(
        mergeRequestPayload({
          action,
          reviewers: [{ username: "Reviewer.One" }],
          assignees: [{ username: "Owner.One" }],
        }),
      );
      expect(applyGitlabPersonnelEvidence(nonTargetAction, "unknown")).toMatchObject({
        candidates: [],
      });
    }
  });

  it("enforces exact current-binding uniqueness, in-place reconfirmation, and removal", async () => {
    const app = getApp();
    const first = await setupTarget(app);
    await expect(
      createGitlabIdentityLink(app.db, {
        organizationId: first.admin.organizationId,
        connectionId: first.connection.connectionId,
        membershipId: first.admin.memberId,
        username: "another.username",
      }),
    ).rejects.toThrow("already has a link");
    const secondMember = await createTestAdmin(app, { username: `gitlab-second-${randomUUID().slice(0, 8)}` });
    await expect(
      createGitlabIdentityLink(app.db, {
        organizationId: first.admin.organizationId,
        connectionId: first.connection.connectionId,
        membershipId: secondMember.memberId,
        username: "reviewer.one",
      }),
    ).rejects.toThrow("already has a link");

    await suspendGitlabLinksForMembership(app.db, first.admin.memberId);
    const [suspended] = await app.db
      .select()
      .from(gitlabIdentityLinks)
      .where(eq(gitlabIdentityLinks.id, first.link.id));
    expect(suspended?.state).toBe("suspended");
    const reconfirmed = await reconfirmGitlabIdentityLink(app.db, {
      organizationId: first.admin.organizationId,
      linkId: first.link.id,
    });
    expect(reconfirmed).toMatchObject({ state: "active", membershipId: first.admin.memberId });
    expect(reconfirmed.id).toBe(first.link.id);
    await removeGitlabIdentityLink(app.db, {
      organizationId: first.admin.organizationId,
      linkId: reconfirmed.id,
    });
    expect(
      await app.db.select().from(gitlabIdentityLinks).where(eq(gitlabIdentityLinks.id, first.link.id)),
    ).toHaveLength(0);
  });

  it("latches reviewer capability without routing personnel on non-target MR actions", async () => {
    const app = getApp();
    const setup = await setupTarget(app);
    for (const [index, action] of ["close", "reopen", "merge", null].entries()) {
      const response = await postMr(
        app,
        setup.connection.bearer,
        mergeRequestPayload({
          action,
          iid: 30 + index,
          reviewers: [{ username: "Reviewer.One" }],
          assignees: [{ username: "Reviewer.One" }],
        }),
      );
      expect(response.statusCode).toBe(200);
    }
    expect((await getGitlabConnectionSummary(app.db, setup.connection.connectionId)).reviewerCapability.mode).toBe(
      "reviewers",
    );
    expect(
      await app.db
        .select()
        .from(gitlabEntityChatMappings)
        .where(eq(gitlabEntityChatMappings.boundVia, "identity_target")),
    ).toHaveLength(0);
  });

  it("suspends links on member leave and requires admin reconfirmation after membership restoration", async () => {
    const app = getApp();
    const setup = await setupTarget(app);
    await createTestAdmin(app, { username: `gitlab-fallback-${randomUUID().slice(0, 8)}` });
    await deactivateMembership(app.db, setup.admin.memberId, MEMBER_STATUSES.LEFT);
    const [leftLink] = await app.db.select().from(gitlabIdentityLinks).where(eq(gitlabIdentityLinks.id, setup.link.id));
    expect(leftLink).toMatchObject({ state: "suspended" });

    await app.db.transaction(async (tx) => {
      await reactivateMembership(
        tx,
        {
          id: setup.admin.memberId,
          agentId: setup.admin.humanAgentUuid,
          organizationId: setup.admin.organizationId,
          status: "left",
        },
        { displayName: "Test Admin", username: setup.admin.username },
      );
    });
    const [stillSuspended] = await app.db
      .select()
      .from(gitlabIdentityLinks)
      .where(eq(gitlabIdentityLinks.id, setup.link.id));
    expect(stillSuspended?.state).toBe("suspended");
    const reconfirmed = await reconfirmGitlabIdentityLink(app.db, {
      organizationId: setup.admin.organizationId,
      linkId: setup.link.id,
    });
    expect(reconfirmed).toMatchObject({ state: "active", membershipId: setup.admin.memberId });
    expect(reconfirmed.id).toBe(setup.link.id);
  });

  it("reconfirms after delegate changes without reactivating historical mappings", async () => {
    const app = getApp();
    const setup = await setupTarget(app);
    const iid = 86;

    expect(
      (
        await postMr(
          app,
          setup.connection.bearer,
          mergeRequestPayload({ iid, reviewers: [{ username: "Reviewer.One" }] }),
        )
      ).statusCode,
    ).toBe(200);

    const nextDelegate = await createAgent(app.db, {
      name: `next-review-agent-${randomUUID().slice(0, 8)}`,
      type: "agent",
      displayName: "Next Review Agent",
      managerId: setup.admin.memberId,
      organizationId: setup.admin.organizationId,
    });
    await app.db
      .update(agents)
      .set({ delegateMention: nextDelegate.uuid })
      .where(eq(agents.uuid, setup.admin.humanAgentUuid));

    expect(
      (
        await postMr(
          app,
          setup.connection.bearer,
          mergeRequestPayload({ iid, reviewers: [{ username: "Reviewer.One" }] }),
        )
      ).statusCode,
    ).toBe(200);
    const mappingScope = and(
      eq(gitlabEntityChatMappings.connectionId, setup.connection.connectionId),
      eq(gitlabEntityChatMappings.identityLinkId, setup.link.id),
      eq(gitlabEntityChatMappings.entityIid, iid),
    );
    const beforeLeave = await app.db.select().from(gitlabEntityChatMappings).where(mappingScope);
    expect(beforeLeave).toHaveLength(2);
    expect(beforeLeave.filter((row) => row.active)).toMatchObject([{ delegateAgentId: nextDelegate.uuid }]);
    expect(beforeLeave.find((row) => row.delegateAgentId === setup.delegate.uuid)?.active).toBe(false);

    await createTestAdmin(app, { username: `gitlab-reconfirm-fallback-${randomUUID().slice(0, 8)}` });
    await deactivateMembership(app.db, setup.admin.memberId, MEMBER_STATUSES.LEFT);
    expect((await app.db.select().from(gitlabEntityChatMappings).where(mappingScope)).every((row) => !row.active)).toBe(
      true,
    );
    await app.db.transaction(async (tx) => {
      await reactivateMembership(
        tx,
        {
          id: setup.admin.memberId,
          agentId: setup.admin.humanAgentUuid,
          organizationId: setup.admin.organizationId,
          status: "left",
        },
        { displayName: "Test Admin", username: setup.admin.username },
      );
    });

    await expect(
      reconfirmGitlabIdentityLink(app.db, {
        organizationId: setup.admin.organizationId,
        linkId: setup.link.id,
      }),
    ).resolves.toMatchObject({ id: setup.link.id, state: "active" });
    expect((await app.db.select().from(gitlabEntityChatMappings).where(mappingScope)).every((row) => !row.active)).toBe(
      true,
    );

    expect(
      (
        await postMr(
          app,
          setup.connection.bearer,
          mergeRequestPayload({ iid, reviewers: [{ username: "Reviewer.One" }] }),
        )
      ).statusCode,
    ).toBe(200);
    const afterReroute = await app.db.select().from(gitlabEntityChatMappings).where(mappingScope);
    expect(afterReroute).toHaveLength(2);
    expect(afterReroute.filter((row) => row.active)).toMatchObject([{ delegateAgentId: nextDelegate.uuid }]);
    expect(afterReroute.find((row) => row.delegateAgentId === setup.delegate.uuid)?.active).toBe(false);
  });

  it("suspends the current binding on admin member removal", async () => {
    const app = getApp();
    const setup = await setupTarget(app);
    await createTestAdmin(app, {
      username: `gitlab-removing-admin-${randomUUID().slice(0, 8)}`,
    });
    await deleteMember(app.db, setup.admin.memberId, setup.admin.organizationId);
    const [link] = await app.db.select().from(gitlabIdentityLinks).where(eq(gitlabIdentityLinks.id, setup.link.id));
    expect(link).toMatchObject({ state: "suspended" });
  });

  it("keeps identity mutation surfaces admin-only and omits manual suspension", async () => {
    const app = getApp();
    const setup = await setupTarget(app);
    await app.db.update(members).set({ role: "member" }).where(eq(members.id, setup.admin.memberId));
    const list = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${setup.admin.organizationId}/gitlab-identity-links`,
      headers: { authorization: `Bearer ${setup.admin.accessToken}` },
    });
    expect(list.statusCode).toBe(403);
    const suspend = await app.inject({
      method: "POST",
      url: `/api/v1/gitlab-identity-links/${setup.link.id}/suspend`,
      headers: { authorization: `Bearer ${setup.admin.accessToken}` },
      payload: {},
    });
    expect(suspend.statusCode).toBe(404);
    const remove = await app.inject({
      method: "DELETE",
      url: `/api/v1/gitlab-identity-links/${setup.link.id}`,
      headers: { authorization: `Bearer ${setup.admin.accessToken}` },
    });
    expect(remove.statusCode).toBe(404);
  });

  it("routes a reviewer once per chat, wakes its delegate, and keeps source review pending", async () => {
    const app = getApp();
    const setup = await setupTarget(app);
    const stableId = `stage3-${randomUUID()}`;
    const first = await postMr(
      app,
      setup.connection.bearer,
      mergeRequestPayload({ reviewers: [{ username: "reviewer.one" }] }),
      stableId,
    );
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ outcome: "delivered" });
    expect(
      (
        await postMr(
          app,
          setup.connection.bearer,
          mergeRequestPayload({ reviewers: [{ username: "reviewer.one" }] }),
          stableId,
        )
      ).json(),
    ).toMatchObject({ outcome: "duplicate" });

    const mappings = await app.db
      .select()
      .from(gitlabEntityChatMappings)
      .where(
        and(
          eq(gitlabEntityChatMappings.connectionId, setup.connection.connectionId),
          eq(gitlabEntityChatMappings.boundVia, "identity_target"),
        ),
      );
    expect(mappings).toHaveLength(1);
    const mapping = mappings[0];
    if (!mapping) throw new Error("identity mapping missing");
    expect(mapping).toMatchObject({
      humanAgentId: setup.admin.humanAgentUuid,
      delegateAgentId: setup.delegate.uuid,
      identityLinkId: setup.link.id,
      active: true,
    });
    const cards = await app.db
      .select()
      .from(messages)
      .where(and(eq(messages.chatId, mapping.chatId), eq(messages.source, "gitlab")));
    expect(cards).toHaveLength(1);
    expect(cards[0]?.content).toMatchObject({
      reason: "review_requested",
      reviewRoutingStatus: "routed_source_not_ready",
    });
    expect(cards[0]?.metadata).toMatchObject({ mentions: [setup.delegate.uuid] });
    const card = cards[0];
    if (!card) throw new Error("GitLab card missing");
    const delegateInbox = await app.db
      .select({ inboxId: agents.inboxId })
      .from(agents)
      .where(eq(agents.uuid, setup.delegate.uuid))
      .limit(1);
    const inboxId = delegateInbox[0]?.inboxId;
    if (!inboxId) throw new Error("delegate inbox missing");
    expect(
      await app.db
        .select({
          notify: inboxEntries.notify,
          status: inboxEntries.status,
        })
        .from(inboxEntries)
        .where(and(eq(inboxEntries.inboxId, inboxId), eq(inboxEntries.messageId, card.id))),
    ).toEqual([
      {
        notify: true,
        status: "pending",
      },
    ]);
    expect(
      await app.db
        .select()
        .from(agentChatSessions)
        .where(and(eq(agentChatSessions.agentId, setup.delegate.uuid), eq(agentChatSessions.chatId, mapping.chatId))),
    ).toHaveLength(1);
    await removeGitlabIdentityLink(app.db, {
      organizationId: setup.admin.organizationId,
      linkId: setup.link.id,
    });
    expect((await pollInbox(app.db, inboxId, 20)).some((row) => row.messageId === card.id)).toBe(true);
    expect((await getGitlabConnectionSummary(app.db, setup.connection.connectionId)).reviewerCapability.mode).toBe(
      "reviewers",
    );
    const [queued] = await app.db
      .select({ notify: inboxEntries.notify, status: inboxEntries.status })
      .from(inboxEntries)
      .where(and(eq(inboxEntries.inboxId, inboxId), eq(inboxEntries.messageId, card.id)));
    expect(queued).toEqual({ notify: true, status: "delivered" });
  });

  it("keeps reviewer priority when an existing identity line is also assigned", async () => {
    const app = getApp();
    const setup = await setupTarget(app);

    const response = await postMr(
      app,
      setup.connection.bearer,
      mergeRequestPayload({
        iid: 18,
        reviewers: [{ username: "Reviewer.One" }],
        assignees: [{ username: "reviewer.one" }],
      }),
    );
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ outcome: "delivered" });
    const mappings = await app.db
      .select()
      .from(gitlabEntityChatMappings)
      .where(
        and(
          eq(gitlabEntityChatMappings.connectionId, setup.connection.connectionId),
          eq(gitlabEntityChatMappings.boundVia, "identity_target"),
        ),
      );
    expect(mappings).toHaveLength(1);
    const second = await postMr(
      app,
      setup.connection.bearer,
      mergeRequestPayload({
        iid: 18,
        reviewers: [{ username: "Reviewer.One" }],
        assignees: [{ username: "reviewer.one" }],
      }),
    );
    expect(second.statusCode).toBe(200);
    const cards = await app.db.select().from(messages).where(eq(messages.source, "gitlab")).orderBy(messages.createdAt);
    expect(cards).toHaveLength(2);
    expect(cards[1]?.content).toMatchObject({
      reason: "review_requested",
      reviewRoutingStatus: "routed_source_not_ready",
    });
  });

  it.each([
    { boundVia: "human_declared" as const, declaredBy: "human" as const },
    { boundVia: "agent_declared" as const, declaredBy: "agent" as const },
  ])("prunes actor echo from an explicit $boundVia follow", async ({ boundVia, declaredBy }) => {
    const app = getApp();
    const setup = await setupTarget(app);
    const iid = declaredBy === "human" ? 61 : 62;
    const chat = await createChat(app.db, setup.admin.humanAgentUuid, {
      type: "group",
      participantIds: [setup.delegate.uuid],
      topic: `Explicit GitLab follow ${iid}`,
      metadata: {},
    });
    await declareGitlabEntityFollow(app.db, {
      organizationId: setup.admin.organizationId,
      connectionId: setup.connection.connectionId,
      chatId: chat.id,
      declaredByAgentId: declaredBy === "human" ? setup.admin.humanAgentUuid : setup.delegate.uuid,
      boundVia,
      entityUrl: `https://gitlab.internal/Acme/Reviews/-/merge_requests/${iid}`,
    });

    const response = await postMr(
      app,
      setup.connection.bearer,
      mergeRequestPayload({ iid, actor: "reviewer.one", reviewers: [] }),
    );
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ outcome: "delivered" });
    expect(
      await app.db
        .select()
        .from(messages)
        .where(and(eq(messages.chatId, chat.id), eq(messages.source, "gitlab"))),
    ).toHaveLength(0);
  });

  it("rejects oversized personnel payloads before claim or connection health mutation", async () => {
    const app = getApp();
    const setup = await setupTarget(app);
    const before = await getGitlabConnectionSummary(app.db, setup.connection.connectionId);
    const response = await postMr(
      app,
      setup.connection.bearer,
      mergeRequestPayload({
        reviewers: Array.from({ length: 51 }, (_, index) => ({ username: `reviewer${index}` })),
      }),
      `oversized-${randomUUID()}`,
    );
    expect(response.statusCode).toBe(400);
    const after = await getGitlabConnectionSummary(app.db, setup.connection.connectionId);
    expect(after.health).toEqual(before.health);
    expect(await app.db.select().from(processedEvents).where(eq(processedEvents.platform, "gitlab"))).toHaveLength(0);
  });

  it("revalidates a persisted identity routing line before every delivery", async () => {
    const app = getApp();
    const setup = await setupTarget(app);
    expect(
      (await postMr(app, setup.connection.bearer, mergeRequestPayload({ reviewers: [{ username: "Reviewer.One" }] })))
        .statusCode,
    ).toBe(200);
    expect(await app.db.select().from(messages).where(eq(messages.source, "gitlab"))).toHaveLength(1);

    await app.db.update(agents).set({ status: "suspended" }).where(eq(agents.uuid, setup.delegate.uuid));
    const response = await postMr(app, setup.connection.bearer, mergeRequestPayload({ reviewers: [] }));
    expect(response.statusCode).toBe(200);
    expect(await app.db.select().from(messages).where(eq(messages.source, "gitlab"))).toHaveLength(1);
  });

  it("routes personnel automatically when a configured webhook arrives", async () => {
    const app = getApp();
    const setup = await setupTarget(app);
    const response = await postMr(
      app,
      setup.connection.bearer,
      mergeRequestPayload({ reviewers: [{ username: "Reviewer.One" }] }),
    );
    expect(response.statusCode).toBe(200);
    const identityMappings = await app.db
      .select()
      .from(gitlabEntityChatMappings)
      .where(eq(gitlabEntityChatMappings.boundVia, "identity_target"));
    expect(identityMappings).toHaveLength(1);
  });

  it("uses declared GitLab version for legacy fallback and never downgrades modern mode", async () => {
    const app = getApp();
    const setup = await setupTarget(app);
    expect(parseDeclaredGitlabVersion("GitLab/15.2.9")).toMatchObject({ supportsReviewerWebhooks: false });
    expect(parseDeclaredGitlabVersion("GitLab/15.3.0")).toMatchObject({ supportsReviewerWebhooks: true });
    expect(parseDeclaredGitlabVersion("curl/8.0")).toBeNull();
    expect(
      (
        await postMr(
          app,
          setup.connection.bearer,
          mergeRequestPayload({ iid: 80, assignees: [{ username: "Reviewer.One" }] }),
          undefined,
          "GitLab/15.2.9",
        )
      ).statusCode,
    ).toBe(200);
    expect(await getGitlabConnectionSummary(app.db, setup.connection.connectionId)).toMatchObject({
      reviewerCapability: { mode: "assignee", lastObservedVersion: "15.2.9" },
    });
    expect(
      (
        await postMr(
          app,
          setup.connection.bearer,
          mergeRequestPayload({ iid: 81, reviewers: [] }),
          undefined,
          "GitLab/15.3.0",
        )
      ).statusCode,
    ).toBe(200);
    expect(await getGitlabConnectionSummary(app.db, setup.connection.connectionId)).toMatchObject({
      reviewerCapability: { mode: "reviewers", lastObservedVersion: "15.3.0" },
    });
    expect(
      (
        await postMr(
          app,
          setup.connection.bearer,
          mergeRequestPayload({ iid: 82, assignees: [{ username: "Reviewer.One" }] }),
          undefined,
          "GitLab/15.2.9",
        )
      ).statusCode,
    ).toBe(200);
    expect((await getGitlabConnectionSummary(app.db, setup.connection.connectionId)).reviewerCapability.mode).toBe(
      "reviewers",
    );
  });

  it("clears bearer-scoped reviewer compatibility on regeneration and learns it again", async () => {
    const app = getApp();
    const setup = await setupTarget(app);
    expect(
      (
        await postMr(
          app,
          setup.connection.bearer,
          mergeRequestPayload({ iid: 84, reviewers: [] }),
          undefined,
          "GitLab/17.11.2",
        )
      ).statusCode,
    ).toBe(200);
    expect(await getGitlabConnectionSummary(app.db, setup.connection.connectionId)).toMatchObject({
      reviewerCapability: { mode: "reviewers", lastObservedVersion: "17.11.2" },
    });

    const regenerated = await regenerateGitlabConnectionBearer(
      app.db,
      setup.connection.connectionId,
      setup.admin.memberId,
    );
    expect(await getGitlabConnectionSummary(app.db, setup.connection.connectionId)).toMatchObject({
      reviewerCapability: {
        mode: "unknown",
        lastObservedVersion: null,
        lastSchemaAnomalyAt: null,
        lastSchemaAnomalyCode: null,
      },
    });
    expect(
      (
        await postMr(
          app,
          regenerated.bearer,
          mergeRequestPayload({ iid: 85, reviewers: [] }),
          undefined,
          "GitLab/15.3.0",
        )
      ).statusCode,
    ).toBe(200);
    expect(await getGitlabConnectionSummary(app.db, setup.connection.connectionId)).toMatchObject({
      reviewerCapability: { mode: "reviewers", lastObservedVersion: "15.3.0" },
    });
  });

  it("uses assignee fallback without latching mode when GitLab version is unavailable", async () => {
    const app = getApp();
    const setup = await setupTarget(app);
    const response = await postMr(
      app,
      setup.connection.bearer,
      mergeRequestPayload({ iid: 83, assignees: [{ username: "Reviewer.One" }] }),
      undefined,
      "custom-hook-client",
    );
    expect(response.statusCode).toBe(200);
    expect(await getGitlabConnectionSummary(app.db, setup.connection.connectionId)).toMatchObject({
      reviewerCapability: { mode: "unknown", lastObservedVersion: null },
    });
    const [card] = await app.db.select().from(messages).where(eq(messages.source, "gitlab"));
    expect(card?.content).toMatchObject({ reason: "review_requested" });
  });

  it("deletes identity-owned routing and bindings with the connection", async () => {
    const app = getApp();
    const setup = await setupTarget(app);
    await postMr(app, setup.connection.bearer, mergeRequestPayload({ reviewers: [{ username: "Reviewer.One" }] }));
    const removed = await app.inject({
      method: "DELETE",
      url: `/api/v1/gitlab-connections/${setup.connection.connectionId}`,
      headers: { authorization: `Bearer ${setup.admin.accessToken}` },
    });
    expect(removed.statusCode).toBe(204);
    expect(
      await app.db.select().from(gitlabIdentityLinks).where(eq(gitlabIdentityLinks.id, setup.link.id)),
    ).toHaveLength(0);
    expect(await app.db.select().from(gitlabEntityChatMappings)).toHaveLength(0);
    expect(
      await app.db.select().from(gitlabConnections).where(eq(gitlabConnections.id, setup.connection.connectionId)),
    ).toHaveLength(0);
  });

  it("replaces the connection without retaining the old identity binding", async () => {
    const app = getApp();
    const enabled = await setupTarget(app);
    const replacement = await replaceGitlabConnection(app.db, {
      expectedConnectionId: enabled.connection.connectionId,
      organizationId: enabled.admin.organizationId,
      memberId: enabled.admin.memberId,
      displayName: "Replacement GitLab",
      instanceOrigin: "https://gitlab.replacement",
    });
    expect(
      await app.db.select().from(gitlabIdentityLinks).where(eq(gitlabIdentityLinks.id, enabled.link.id)),
    ).toHaveLength(0);
    await deleteGitlabConnection(app.db, replacement.connectionId);
  });
});
