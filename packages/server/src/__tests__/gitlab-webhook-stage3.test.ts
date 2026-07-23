import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agentChatSessions } from "../db/schema/agent-chat-sessions.js";
import { agents } from "../db/schema/agents.js";
import { chats } from "../db/schema/chats.js";
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
import { declareGitlabEntityFollow, removeCurrentGitlabEntityFollow } from "../services/gitlab-entity-follow.js";
import {
  createGitlabIdentityLink,
  reconfirmGitlabIdentityLink,
  removeGitlabIdentityLink,
  suspendGitlabLinksForMembership,
} from "../services/gitlab-identities.js";
import { applyGitlabPersonnelEvidence, normalizeGitlabWebhook } from "../services/gitlab-webhook.js";
import { pollInbox } from "../services/inbox.js";
import { getCallerEngagement, setChatEngagement } from "../services/me-chat.js";
import { deleteMember } from "../services/member.js";
import { deactivateMembership, MEMBER_STATUSES, reactivateMembership } from "../services/membership.js";
import { putOrgSetting } from "../services/org-settings.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

type App = ReturnType<ReturnType<typeof useTestApp>>;

function mergeRequestPayload(input: {
  action?: string | null;
  reviewers?: unknown;
  assignees?: unknown;
  changes?: unknown;
  iid?: number;
  actor?: string;
  projectPath?: string;
  title?: string;
  draft?: boolean;
  oldrev?: string;
}) {
  const projectPath = input.projectPath ?? "Acme/Reviews";
  return {
    object_kind: "merge_request",
    project: {
      id: 801,
      path_with_namespace: projectPath,
      web_url: `https://gitlab.internal/${projectPath}`,
    },
    user: { username: input.actor ?? "author" },
    ...(Object.hasOwn(input, "reviewers") ? { reviewers: input.reviewers } : {}),
    ...(Object.hasOwn(input, "assignees") ? { assignees: input.assignees } : {}),
    ...(Object.hasOwn(input, "changes") ? { changes: input.changes } : {}),
    object_attributes: {
      iid: input.iid ?? 17,
      ...(input.action === null ? {} : { action: input.action ?? "open" }),
      title: input.title ?? "Review this change",
      description: "Please review",
      url: `https://gitlab.internal/${projectPath}/-/merge_requests/${input.iid ?? 17}`,
      state: "opened",
      ...(input.draft === undefined ? {} : { draft: input.draft }),
      ...(input.oldrev === undefined ? {} : { oldrev: input.oldrev }),
    },
  };
}

async function postMr(app: App, bearer: string, body: object, stableId?: string, userAgent = "GitLab/15.3.0") {
  return app.inject({
    method: "POST",
    url: `/api/v1/webhooks/gitlab/${bearer}`,
    headers: {
      "content-type": "application/json",
      "x-gitlab-event": "System Hook",
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

  it("dispatches one reserved Context Reviewer run for an old-GitLab MR without personnel routing", async () => {
    const app = getApp();
    const { admin, delegate, connection } = await setupTarget(app);
    await putOrgSetting(
      app.db,
      admin.organizationId,
      "context_tree",
      {
        provider: "gitlab",
        repo: "git@gitlab.internal:Acme/Reviews.git",
        branch: "main",
      },
      {
        updatedBy: admin.userId,
        memberId: admin.memberId,
        gitlabEgressAllowlist: [
          { origin: "https://gitlab.internal", addressPolicy: { kind: "cidrs", cidrs: ["10.0.0.0/8"] } },
        ],
      },
    );
    await putOrgSetting(
      app.db,
      admin.organizationId,
      "context_tree_features",
      { contextReviewer: { enabled: true, agentUuid: delegate.uuid } },
      { updatedBy: admin.userId, memberId: admin.memberId },
    );

    const payload = mergeRequestPayload({ projectPath: "Acme/Reviews" });
    const rejectedProjectHook = await app.inject({
      method: "POST",
      url: `/api/v1/webhooks/gitlab/${connection.bearer}`,
      headers: {
        "content-type": "application/json",
        "x-gitlab-event": "Merge Request Hook",
      },
      payload: JSON.stringify(payload),
    });
    expect(rejectedProjectHook.statusCode).toBe(400);
    expect(
      (await app.db.select().from(chats)).filter((chat) => chat.metadata.contextTreeReviewer === true),
    ).toHaveLength(0);

    const first = await postMr(app, connection.bearer, payload, "context-review-old-gitlab", "GitLab/11.11.3");
    expect(first.statusCode).toBe(200);

    const reviewerChats = await app.db.select().from(chats).where(eq(chats.organizationId, admin.organizationId));
    const reviewerChat = reviewerChats.find((chat) => chat.metadata.contextTreeReviewer === true);
    expect(reviewerChat?.metadata).toMatchObject({
      source: "gitlab",
      entityType: "pull_request",
      contextTreeReviewer: true,
      reviewerAgentUuid: delegate.uuid,
    });
    expect(reviewerChat?.topic).toBe("Context Review · Reviews!17");

    const reviewerMessages = reviewerChat
      ? await app.db.select().from(messages).where(eq(messages.chatId, reviewerChat.id))
      : [];
    expect(reviewerMessages).toHaveLength(1);
    expect(reviewerMessages[0]?.metadata).toMatchObject({
      source: "gitlab",
      contextTreeReviewer: true,
      contextReviewConnectionId: connection.connectionId,
      contextReviewInstanceOrigin: "https://gitlab.internal",
      contextReviewProjectId: 801,
      contextReviewMrIid: 17,
      contextReviewReviewerAgentUuid: delegate.uuid,
    });
    expect(reviewerMessages[0]?.metadata).not.toHaveProperty("contextReviewSubmission");
    expect(reviewerMessages[0]?.content).toContain(`GitLab connection: ${connection.connectionId}`);
    expect(reviewerMessages[0]?.content).toContain("Never call `first-tree tree review`");
    expect(reviewerMessages[0]?.content).toContain("exact-SHA squash merge");

    const duplicate = await postMr(app, connection.bearer, payload, "context-review-old-gitlab", "GitLab/14.10.5");
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toMatchObject({ outcome: "duplicate" });
    expect(
      reviewerChat ? await app.db.select().from(messages).where(eq(messages.chatId, reviewerChat.id)) : [],
    ).toHaveLength(1);
  });

  it("fails closed for wrong repo, disabled or invalid Reviewer, handles draft-to-ready update, and ignores Notes", async () => {
    const app = getApp();
    const { admin, delegate, connection } = await setupTarget(app);
    await putOrgSetting(
      app.db,
      admin.organizationId,
      "context_tree",
      {
        provider: "gitlab",
        repo: "https://gitlab.internal/Acme/Reviews.git",
        branch: "main",
      },
      {
        updatedBy: admin.userId,
        memberId: admin.memberId,
        gitlabEgressAllowlist: [
          { origin: "https://gitlab.internal", addressPolicy: { kind: "cidrs", cidrs: ["10.0.0.0/8"] } },
        ],
      },
    );

    expect(
      (
        await postMr(
          app,
          connection.bearer,
          mergeRequestPayload({ projectPath: "Acme/Other", iid: 40 }),
          "wrong-context-repo",
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await postMr(
          app,
          connection.bearer,
          mergeRequestPayload({ projectPath: "Acme/Reviews", iid: 41 }),
          "disabled-context-reviewer",
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (await app.db.select().from(chats)).filter((chat) => chat.metadata.contextTreeReviewer === true),
    ).toHaveLength(0);

    await putOrgSetting(
      app.db,
      admin.organizationId,
      "context_tree_features",
      { contextReviewer: { enabled: true, agentUuid: delegate.uuid } },
      { updatedBy: admin.userId, memberId: admin.memberId },
    );
    await app.db.update(agents).set({ status: "suspended" }).where(eq(agents.uuid, delegate.uuid));
    expect(
      (
        await postMr(
          app,
          connection.bearer,
          mergeRequestPayload({ projectPath: "Acme/Reviews", iid: 42 }),
          "invalid-context-reviewer",
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (await app.db.select().from(chats)).filter((chat) => chat.metadata.contextTreeReviewer === true),
    ).toHaveLength(0);

    await app.db.update(agents).set({ status: "active" }).where(eq(agents.uuid, delegate.uuid));
    const draft = await postMr(
      app,
      connection.bearer,
      mergeRequestPayload({ projectPath: "Acme/Reviews", iid: 43, draft: true }),
      "draft-context-reviewer",
    );
    expect(draft.statusCode).toBe(200);
    const ready = await postMr(
      app,
      connection.bearer,
      mergeRequestPayload({
        action: "update",
        projectPath: "Acme/Reviews",
        iid: 43,
        draft: false,
        changes: { draft: { previous: true, current: false } },
      }),
      "ready-context-reviewer",
    );
    expect(ready.statusCode).toBe(200);

    const [reviewerChat] = (await app.db.select().from(chats)).filter(
      (chat) => chat.metadata.contextTreeReviewer === true,
    );
    expect(reviewerChat).toBeDefined();
    const beforeNoteMessages = reviewerChat
      ? await app.db.select().from(messages).where(eq(messages.chatId, reviewerChat.id))
      : [];
    expect(beforeNoteMessages).toHaveLength(2);
    expect(beforeNoteMessages.map((message) => message.metadata)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ mergeRequestDraft: true }),
        expect.objectContaining({ mergeRequestDraft: false, action: "update" }),
      ]),
    );

    const sourceUpdate = await postMr(
      app,
      connection.bearer,
      mergeRequestPayload({
        action: "update",
        projectPath: "Acme/Reviews",
        iid: 43,
        draft: false,
        oldrev: "0123456789abcdef0123456789abcdef01234567",
      }),
      "source-update-context-reviewer",
    );
    expect(sourceUpdate.statusCode).toBe(200);
    const afterSourceUpdateMessages = reviewerChat
      ? await app.db.select().from(messages).where(eq(messages.chatId, reviewerChat.id))
      : [];
    expect(afterSourceUpdateMessages).toHaveLength(3);
    expect(afterSourceUpdateMessages.filter((message) => message.metadata.action === "update")).toHaveLength(2);
    expect(afterSourceUpdateMessages.map((message) => message.metadata)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "update",
          triggerEvent: "merge_request.update",
        }),
      ]),
    );

    const note = await app.inject({
      method: "POST",
      url: `/api/v1/webhooks/gitlab/${connection.bearer}`,
      headers: {
        "content-type": "application/json",
        "x-gitlab-event": "Note Hook",
        "idempotency-key": "context-reviewer-note",
      },
      payload: JSON.stringify({
        object_kind: "note",
        project: {
          id: 801,
          path_with_namespace: "Acme/Reviews",
          web_url: "https://gitlab.internal/Acme/Reviews",
        },
        user: { username: "review-agent" },
        object_attributes: {
          id: 501,
          note: "review output",
          url: "https://gitlab.internal/Acme/Reviews/-/merge_requests/43#note_501",
          noteable_type: "MergeRequest",
        },
        merge_request: {
          iid: 43,
          title: "Review this change",
          url: "https://gitlab.internal/Acme/Reviews/-/merge_requests/43",
          state: "opened",
        },
      }),
    });
    expect(note.statusCode).toBe(400);
    expect(
      reviewerChat ? await app.db.select().from(messages).where(eq(messages.chatId, reviewerChat.id)) : [],
    ).toHaveLength(3);
  });

  it("fences the replaced connection bearer before Context Reviewer dispatch", async () => {
    const app = getApp();
    const { admin, delegate, connection } = await setupTarget(app);
    await putOrgSetting(
      app.db,
      admin.organizationId,
      "context_tree",
      {
        provider: "gitlab",
        repo: "https://gitlab.internal/Acme/Reviews.git",
        branch: "main",
      },
      {
        updatedBy: admin.userId,
        memberId: admin.memberId,
        gitlabEgressAllowlist: [
          { origin: "https://gitlab.internal", addressPolicy: { kind: "cidrs", cidrs: ["10.0.0.0/8"] } },
        ],
      },
    );
    await putOrgSetting(
      app.db,
      admin.organizationId,
      "context_tree_features",
      { contextReviewer: { enabled: true, agentUuid: delegate.uuid } },
      { updatedBy: admin.userId, memberId: admin.memberId },
    );
    await replaceGitlabConnection(app.db, {
      expectedConnectionId: connection.connectionId,
      organizationId: admin.organizationId,
      memberId: admin.memberId,
      displayName: "Replacement GitLab",
      instanceOrigin: "https://gitlab.internal",
    });

    const stale = await postMr(
      app,
      connection.bearer,
      mergeRequestPayload({ projectPath: "Acme/Reviews", iid: 44 }),
      "stale-replaced-connection",
    );
    expect(stale.statusCode).toBe(404);
    expect(
      (await app.db.select().from(chats)).filter((chat) => chat.metadata.contextTreeReviewer === true),
    ).toHaveLength(0);
  });

  it("normalizes capability-driven reviewer, legacy assignee, delta, and schema-anomaly semantics", () => {
    const normalize = (body: object) =>
      normalizeGitlabWebhook({
        organizationId: "org-1",
        connectionId: "connection-1",
        instanceOrigin: "https://gitlab.internal",
        stableDeliveryId: null,
        eventHeader: "System Hook",
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
    expect(afterReroute).toHaveLength(3);
    expect(afterReroute.filter((row) => row.active)).toMatchObject([{ delegateAgentId: nextDelegate.uuid }]);
    expect(afterReroute.filter((row) => row.delegateAgentId === setup.delegate.uuid)).toHaveLength(1);
    expect(afterReroute.filter((row) => !row.active)).toHaveLength(2);
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
    const [automaticChat] = await app.db.select().from(chats).where(eq(chats.id, mapping.chatId));
    expect(automaticChat?.topic).toBe("MR Review Reviews!17: Review this change");
    const visibleBindings = await app.inject({
      method: "GET",
      url: `/api/v1/chats/${mapping.chatId}/gitlab-entities`,
      headers: { authorization: `Bearer ${setup.admin.accessToken}` },
    });
    expect(visibleBindings.statusCode).toBe(200);
    expect(visibleBindings.json()).toMatchObject({
      entities: [],
      items: [
        {
          entityType: "pull_request",
          entityUrl: "https://gitlab.internal/Acme/Reviews/-/merge_requests/17",
          projectPath: "Acme/Reviews",
          entityIid: 17,
          title: "Review this change",
          state: "open",
          status: "active",
          boundVia: "identity_target",
        },
      ],
    });
    expect(JSON.stringify(visibleBindings.json())).not.toMatch(
      /connectionId|organizationId|identityLinkId|humanAgentId|delegateAgentId|declaredByAgentId/,
    );
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

  it("refreshes an automatic GitLab anchor topic but preserves a manual rename", async () => {
    const app = getApp();
    const setup = await setupTarget(app);
    const iid = 25;
    expect(
      (
        await postMr(
          app,
          setup.connection.bearer,
          mergeRequestPayload({ iid, reviewers: [{ username: "Reviewer.One" }] }),
        )
      ).statusCode,
    ).toBe(200);
    const [mapping] = await app.db
      .select()
      .from(gitlabEntityChatMappings)
      .where(
        and(
          eq(gitlabEntityChatMappings.connectionId, setup.connection.connectionId),
          eq(gitlabEntityChatMappings.entityIid, iid),
        ),
      );
    if (!mapping) throw new Error("automatic mapping missing");

    expect(
      (
        await postMr(
          app,
          setup.connection.bearer,
          mergeRequestPayload({
            action: "update",
            iid,
            reviewers: [],
            projectPath: "Acme/Renamed",
            title: "Renamed title",
            changes: { title: { previous: "Review this change", current: "Renamed title" } },
          }),
        )
      ).statusCode,
    ).toBe(200);
    expect((await app.db.select().from(chats).where(eq(chats.id, mapping.chatId)))[0]?.topic).toBe(
      "MR Review Renamed!25: Renamed title",
    );

    await app.db.update(chats).set({ topic: "Manual topic" }).where(eq(chats.id, mapping.chatId));
    expect(
      (
        await postMr(
          app,
          setup.connection.bearer,
          mergeRequestPayload({
            action: "update",
            iid,
            reviewers: [],
            projectPath: "Acme/Renamed",
            title: "Another title",
            changes: { title: { previous: "Renamed title", current: "Another title" } },
          }),
        )
      ).statusCode,
    ).toBe(200);
    expect((await app.db.select().from(chats).where(eq(chats.id, mapping.chatId)))[0]?.topic).toBe("Manual topic");
  });

  it("reuses one reviewer membership chat without inventing a target line", async () => {
    const app = getApp();
    const setup = await setupTarget(app);
    const iid = 23;
    const chat = await createChat(app.db, setup.admin.humanAgentUuid, {
      type: "group",
      participantIds: [setup.delegate.uuid],
    });
    await app.db.insert(gitlabEntityChatMappings).values({
      id: randomUUID(),
      organizationId: setup.admin.organizationId,
      connectionId: setup.connection.connectionId,
      chatId: chat.id,
      declaredByAgentId: setup.delegate.uuid,
      boundVia: "agent_declared",
      humanAgentId: null,
      delegateAgentId: null,
      active: true,
      entityType: "pull_request",
      entityIid: iid,
      projectId: 801,
      projectPath: "Acme/Reviews",
      projectPathNormalized: "acme/reviews",
      entityUrl: `https://gitlab.internal/Acme/Reviews/-/merge_requests/${iid}`,
      title: "Review this change",
      entityState: "open",
    });

    expect(
      (
        await postMr(
          app,
          setup.connection.bearer,
          mergeRequestPayload({ iid, reviewers: [{ username: "Reviewer.One" }] }),
        )
      ).statusCode,
    ).toBe(200);
    const rows = await app.db
      .select()
      .from(gitlabEntityChatMappings)
      .where(
        and(
          eq(gitlabEntityChatMappings.connectionId, setup.connection.connectionId),
          eq(gitlabEntityChatMappings.entityIid, iid),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ chatId: chat.id, boundVia: "agent_declared" });
    expect(
      await app.db
        .select()
        .from(messages)
        .where(and(eq(messages.chatId, chat.id), eq(messages.source, "gitlab"))),
    ).toHaveLength(1);
  });

  it("does not reuse entity membership for an assignment target", async () => {
    const app = getApp();
    const setup = await setupTarget(app);
    const iid = 24;
    const existingChat = await createChat(app.db, setup.admin.humanAgentUuid, {
      type: "group",
      participantIds: [setup.delegate.uuid],
    });
    await app.db.insert(gitlabEntityChatMappings).values({
      id: randomUUID(),
      organizationId: setup.admin.organizationId,
      connectionId: setup.connection.connectionId,
      chatId: existingChat.id,
      declaredByAgentId: setup.delegate.uuid,
      boundVia: "agent_declared",
      humanAgentId: null,
      delegateAgentId: null,
      active: true,
      entityType: "pull_request",
      entityIid: iid,
      projectId: 801,
      projectPath: "Acme/Reviews",
      projectPathNormalized: "acme/reviews",
      entityUrl: `https://gitlab.internal/Acme/Reviews/-/merge_requests/${iid}`,
      title: "Review this change",
      entityState: "open",
    });

    expect(
      (
        await postMr(
          app,
          setup.connection.bearer,
          mergeRequestPayload({
            iid,
            reviewers: [],
            assignees: [{ username: "Reviewer.One" }],
          }),
        )
      ).statusCode,
    ).toBe(200);
    const rows = await app.db
      .select()
      .from(gitlabEntityChatMappings)
      .where(
        and(
          eq(gitlabEntityChatMappings.connectionId, setup.connection.connectionId),
          eq(gitlabEntityChatMappings.entityIid, iid),
        ),
      );
    expect(rows).toHaveLength(2);
    const targetLine = rows.find((row) => row.boundVia === "identity_target");
    expect(targetLine?.chatId).toBeTruthy();
    expect(targetLine?.chatId).not.toBe(existingChat.id);
  });

  it("unfollows an automatic route and lets a later reviewer event create a fresh chat", async () => {
    const app = getApp();
    const setup = await setupTarget(app);
    const payload = mergeRequestPayload({ iid: 19, reviewers: [{ username: "Reviewer.One" }] });
    expect((await postMr(app, setup.connection.bearer, payload)).statusCode).toBe(200);
    const [firstMapping] = await app.db
      .select()
      .from(gitlabEntityChatMappings)
      .where(eq(gitlabEntityChatMappings.boundVia, "identity_target"));
    if (!firstMapping) throw new Error("initial identity mapping missing");

    expect(
      await removeCurrentGitlabEntityFollow(app.db, {
        organizationId: setup.admin.organizationId,
        chatId: firstMapping.chatId,
        entityUrl: "https://gitlab.internal/Acme/Reviews/-/merge_requests/19",
      }),
    ).toEqual({ removed: 1 });
    expect(
      await app.db
        .select()
        .from(gitlabEntityChatMappings)
        .where(eq(gitlabEntityChatMappings.boundVia, "identity_target")),
    ).toHaveLength(0);

    expect((await postMr(app, setup.connection.bearer, payload)).statusCode).toBe(200);
    const [nextMapping] = await app.db
      .select()
      .from(gitlabEntityChatMappings)
      .where(eq(gitlabEntityChatMappings.boundVia, "identity_target"));
    expect(nextMapping?.chatId).toBeTruthy();
    expect(nextMapping?.chatId).not.toBe(firstMapping.chatId);
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
      humanAgentId: setup.admin.humanAgentUuid,
      delegateAgentId: setup.delegate.uuid,
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

  it("revives an archived chat when a GitLab card arrives through the shared message path", async () => {
    const app = getApp();
    const setup = await setupTarget(app);
    const iid = 63;
    const chat = await createChat(app.db, setup.admin.humanAgentUuid, {
      type: "group",
      participantIds: [setup.delegate.uuid],
      topic: `GitLab revive ${iid}`,
      metadata: {},
    });
    await declareGitlabEntityFollow(app.db, {
      organizationId: setup.admin.organizationId,
      connectionId: setup.connection.connectionId,
      chatId: chat.id,
      declaredByAgentId: setup.delegate.uuid,
      humanAgentId: setup.admin.humanAgentUuid,
      delegateAgentId: setup.delegate.uuid,
      boundVia: "agent_declared",
      entityUrl: `https://gitlab.internal/Acme/Reviews/-/merge_requests/${iid}`,
    });
    await setChatEngagement(app.db, chat.id, setup.admin.humanAgentUuid, "archived");

    const response = await postMr(
      app,
      setup.connection.bearer,
      mergeRequestPayload({ iid, actor: "another.user", reviewers: [] }),
    );

    expect(response.statusCode).toBe(200);
    expect(
      await app.db
        .select()
        .from(messages)
        .where(and(eq(messages.chatId, chat.id), eq(messages.source, "gitlab"))),
    ).toHaveLength(1);
    await expect(getCallerEngagement(app.db, chat.id, setup.admin.humanAgentUuid)).resolves.toBe("active");
  });

  it("wakes the stored delegate for an ordinary event on an explicit attention line", async () => {
    const app = getApp();
    const setup = await setupTarget(app);
    const iid = 64;
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
      declaredByAgentId: setup.delegate.uuid,
      humanAgentId: setup.admin.humanAgentUuid,
      delegateAgentId: setup.delegate.uuid,
      boundVia: "agent_declared",
      entityUrl: `https://gitlab.internal/Acme/Reviews/-/merge_requests/${iid}`,
    });

    expect(
      (await postMr(app, setup.connection.bearer, mergeRequestPayload({ iid, actor: "another.user", reviewers: [] })))
        .statusCode,
    ).toBe(200);
    const [card] = await app.db
      .select()
      .from(messages)
      .where(and(eq(messages.chatId, chat.id), eq(messages.source, "gitlab")));
    expect(card?.content).toMatchObject({ reason: "subscribed" });
    expect(card?.metadata).toMatchObject({ mentions: [setup.delegate.uuid] });
    const [delegate] = await app.db
      .select({ inboxId: agents.inboxId })
      .from(agents)
      .where(eq(agents.uuid, setup.delegate.uuid));
    expect(
      await app.db
        .select({ notify: inboxEntries.notify })
        .from(inboxEntries)
        .where(and(eq(inboxEntries.inboxId, delegate?.inboxId ?? ""), eq(inboxEntries.messageId, card?.id ?? ""))),
    ).toEqual([{ notify: true }]);
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
