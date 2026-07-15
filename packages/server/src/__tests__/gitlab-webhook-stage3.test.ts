import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { gitlabAutomaticActionsAudit } from "../db/schema/gitlab-automatic-actions-audit.js";
import { gitlabConnections } from "../db/schema/gitlab-connections.js";
import { gitlabEntityChatMappings } from "../db/schema/gitlab-entity-chat-mappings.js";
import { gitlabIdentityLinks } from "../db/schema/gitlab-identity-links.js";
import { gitlabIdentityTransitionAudit } from "../db/schema/gitlab-identity-transition-audit.js";
import { gitlabSkippedTargetAudit } from "../db/schema/gitlab-skipped-target-audit.js";
import { members } from "../db/schema/members.js";
import { messages } from "../db/schema/messages.js";
import { processedEvents } from "../db/schema/processed-events.js";
import { createAgent } from "../services/agent.js";
import {
  confirmGitlabAssigneeMode,
  createGitlabConnection,
  deleteGitlabConnection,
  getGitlabConnectionSummary,
  replaceGitlabConnection,
  setGitlabAutomaticActions,
} from "../services/gitlab-connections.js";
import {
  createGitlabIdentityLink,
  reconfirmGitlabIdentityLink,
  revokeGitlabIdentityLink,
  suspendGitlabIdentityLink,
} from "../services/gitlab-identities.js";
import { applyGitlabPersonnelEvidence, normalizeGitlabWebhook } from "../services/gitlab-webhook.js";
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

async function postMr(app: App, bearer: string, body: object, stableId?: string) {
  return app.inject({
    method: "POST",
    url: `/api/v1/webhooks/gitlab/${bearer}`,
    headers: {
      "content-type": "application/json",
      "x-gitlab-event": "Merge Request Hook",
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
      actorMemberId: admin.memberId,
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
      observeReviewers: true,
      schemaAnomalyCode: null,
      candidates: [
        { externalUsername: "Reviewer.One", targetClass: "reviewer" },
        { externalUsername: "Owner.One", targetClass: "assignee" },
      ],
    });

    const empty = normalize(mergeRequestPayload({ reviewers: [], assignees: [{ username: "Owner.One" }] }));
    expect(applyGitlabPersonnelEvidence(empty, "unknown")).toMatchObject({
      observeReviewers: true,
      candidates: [{ externalUsername: "Owner.One", targetClass: "assignee" }],
    });

    const legacy = normalize(mergeRequestPayload({ assignees: [{ username: "Reviewer.One" }] }));
    expect(applyGitlabPersonnelEvidence(legacy, "unknown")).toMatchObject({
      candidates: [{ externalUsername: "Reviewer.One", targetClass: "assignee" }],
      skippedBeforeIdentity: [{ targetClass: "reviewer", reason: "reviewer_mode_unconfirmed" }],
    });
    expect(applyGitlabPersonnelEvidence(legacy, "assignee")).toMatchObject({
      candidates: [{ externalUsername: "Reviewer.One", targetClass: "reviewer" }],
    });
    expect(applyGitlabPersonnelEvidence(legacy, "reviewers")).toMatchObject({
      candidates: [],
      schemaAnomalyCode: "reviewers_missing_after_capability",
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
      mergeRequestPayload({ action: "update", reviewers: [{ username: "Reviewer.One" }] }),
    );
    expect(applyGitlabPersonnelEvidence(customTemplate, "reviewers")).toMatchObject({
      observeReviewers: true,
      candidates: [],
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
        observeReviewers: true,
        candidates: [],
      });
    }
  });

  it("enforces exact identity uniqueness and terminal lifecycle semantics", async () => {
    const app = getApp();
    const first = await setupTarget(app);
    await expect(
      createGitlabIdentityLink(app.db, {
        organizationId: first.admin.organizationId,
        connectionId: first.connection.connectionId,
        membershipId: first.admin.memberId,
        username: "another.username",
        actorMemberId: first.admin.memberId,
      }),
    ).rejects.toThrow("already has an active link");
    const secondMember = await createTestAdmin(app, { username: `gitlab-second-${randomUUID().slice(0, 8)}` });
    await expect(
      createGitlabIdentityLink(app.db, {
        organizationId: first.admin.organizationId,
        connectionId: first.connection.connectionId,
        membershipId: secondMember.memberId,
        username: "reviewer.one",
        actorMemberId: first.admin.memberId,
      }),
    ).rejects.toThrow("already has an active link");

    const suspended = await suspendGitlabIdentityLink(app.db, {
      organizationId: first.admin.organizationId,
      linkId: first.link.id,
      actorMemberId: first.admin.memberId,
    });
    expect(suspended.state).toBe("suspended");
    expect(
      (
        await reconfirmGitlabIdentityLink(app.db, {
          organizationId: first.admin.organizationId,
          linkId: first.link.id,
          actorMemberId: first.admin.memberId,
        })
      ).state,
    ).toBe("active");
    expect(
      (
        await revokeGitlabIdentityLink(app.db, {
          organizationId: first.admin.organizationId,
          linkId: first.link.id,
          actorMemberId: first.admin.memberId,
        })
      ).state,
    ).toBe("revoked");
    await expect(
      reconfirmGitlabIdentityLink(app.db, {
        organizationId: first.admin.organizationId,
        linkId: first.link.id,
        actorMemberId: first.admin.memberId,
      }),
    ).rejects.toThrow("cannot be reactivated");
    const transitions = await app.db
      .select()
      .from(gitlabIdentityTransitionAudit)
      .where(eq(gitlabIdentityTransitionAudit.identityLinkId, first.link.id))
      .orderBy(gitlabIdentityTransitionAudit.createdAt);
    expect(transitions.map((row) => row.transition)).toEqual(["created", "suspended", "reconfirmed", "revoked"]);
    expect(transitions.find((row) => row.transition === "suspended")).toMatchObject({
      actorMemberId: first.admin.memberId,
      reason: "admin_suspended",
    });
  });

  it("latches reviewer capability without routing personnel on non-target MR actions", async () => {
    const app = getApp();
    const setup = await setupTarget(app);
    await setGitlabAutomaticActions(app.db, {
      connectionId: setup.connection.connectionId,
      organizationId: setup.admin.organizationId,
      actorMemberId: setup.admin.memberId,
      enabled: true,
      acceptTeamWideForgeryRisk: true,
    });
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
    expect(
      await app.db
        .select()
        .from(gitlabSkippedTargetAudit)
        .where(eq(gitlabSkippedTargetAudit.organizationId, setup.admin.organizationId)),
    ).toHaveLength(0);
  });

  it("suspends links on member leave and requires admin reconfirmation after membership restoration", async () => {
    const app = getApp();
    const setup = await setupTarget(app);
    await createTestAdmin(app, { username: `gitlab-fallback-${randomUUID().slice(0, 8)}` });
    await deactivateMembership(app.db, setup.admin.memberId, MEMBER_STATUSES.LEFT);
    const [leftLink] = await app.db.select().from(gitlabIdentityLinks).where(eq(gitlabIdentityLinks.id, setup.link.id));
    expect(leftLink).toMatchObject({ state: "suspended", stateReason: "member_left" });

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
    expect(
      (
        await reconfirmGitlabIdentityLink(app.db, {
          organizationId: setup.admin.organizationId,
          linkId: setup.link.id,
          actorMemberId: setup.admin.memberId,
        })
      ).state,
    ).toBe("active");
    const history = await app.db
      .select()
      .from(gitlabIdentityTransitionAudit)
      .where(eq(gitlabIdentityTransitionAudit.identityLinkId, setup.link.id))
      .orderBy(gitlabIdentityTransitionAudit.createdAt);
    expect(history.map((row) => row.transition)).toEqual(["created", "member_left", "reconfirmed"]);
    expect(history.find((row) => row.transition === "member_left")?.actorMemberId).toBe(setup.admin.memberId);
  });

  it("attributes admin member removal in the identity transition audit", async () => {
    const app = getApp();
    const setup = await setupTarget(app);
    const removingAdmin = await createTestAdmin(app, {
      username: `gitlab-removing-admin-${randomUUID().slice(0, 8)}`,
    });
    await deleteMember(app.db, setup.admin.memberId, setup.admin.organizationId, removingAdmin.memberId);
    const history = await app.db
      .select()
      .from(gitlabIdentityTransitionAudit)
      .where(eq(gitlabIdentityTransitionAudit.identityLinkId, setup.link.id))
      .orderBy(gitlabIdentityTransitionAudit.createdAt);
    expect(history.find((row) => row.transition === "member_removed")).toMatchObject({
      actorMemberId: removingAdmin.memberId,
      reason: "member_removed",
    });
  });

  it("keeps identity and audit mutation surfaces admin-only", async () => {
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
    const audit = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${setup.admin.organizationId}/gitlab-connections/automatic-actions-audit`,
      headers: { authorization: `Bearer ${setup.admin.accessToken}` },
    });
    expect(audit.statusCode).toBe(403);
    const identityAudit = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${setup.admin.organizationId}/gitlab-identity-links/audit`,
      headers: { authorization: `Bearer ${setup.admin.accessToken}` },
    });
    expect(identityAudit.statusCode).toBe(403);
  });

  it("requires Team risk acceptance, routes a reviewer once per chat, wakes after commit, and keeps review source pending", async () => {
    const app = getApp();
    const setup = await setupTarget(app);
    await expect(
      setGitlabAutomaticActions(app.db, {
        connectionId: setup.connection.connectionId,
        organizationId: setup.admin.organizationId,
        actorMemberId: setup.admin.memberId,
        enabled: true,
      }),
    ).rejects.toThrow("accepting the Team-wide");
    await setGitlabAutomaticActions(app.db, {
      connectionId: setup.connection.connectionId,
      organizationId: setup.admin.organizationId,
      actorMemberId: setup.admin.memberId,
      enabled: true,
      acceptTeamWideForgeryRisk: true,
    });
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
    expect((await getGitlabConnectionSummary(app.db, setup.connection.connectionId)).reviewerCapability.mode).toBe(
      "reviewers",
    );
    expect(await app.db.select().from(gitlabAutomaticActionsAudit)).toHaveLength(1);
  });

  it("keeps reviewer priority when an existing identity line is also assigned", async () => {
    const app = getApp();
    const setup = await setupTarget(app);
    await setGitlabAutomaticActions(app.db, {
      connectionId: setup.connection.connectionId,
      organizationId: setup.admin.organizationId,
      actorMemberId: setup.admin.memberId,
      enabled: true,
      acceptTeamWideForgeryRisk: true,
    });

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
    await setGitlabAutomaticActions(app.db, {
      connectionId: setup.connection.connectionId,
      organizationId: setup.admin.organizationId,
      actorMemberId: setup.admin.memberId,
      enabled: true,
      acceptTeamWideForgeryRisk: true,
    });
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

  it("keeps basic processing live while automation is off and records actionable skipped reasons", async () => {
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
    expect(identityMappings).toHaveLength(0);
    const skipped = await app.db
      .select()
      .from(gitlabSkippedTargetAudit)
      .where(eq(gitlabSkippedTargetAudit.organizationId, setup.admin.organizationId));
    expect(skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: "automatic_actions_disabled", externalUsername: "Reviewer.One" }),
      ]),
    );
  });

  it("uses explicit admin confirmation for legacy assignee and never downgrades after reviewers are observed", async () => {
    const app = getApp();
    const setup = await setupTarget(app);
    expect(
      (
        await confirmGitlabAssigneeMode(app.db, {
          connectionId: setup.connection.connectionId,
          organizationId: setup.admin.organizationId,
          actorMemberId: setup.admin.memberId,
        })
      ).reviewerCapability.mode,
    ).toBe("assignee");
    await setGitlabAutomaticActions(app.db, {
      connectionId: setup.connection.connectionId,
      organizationId: setup.admin.organizationId,
      actorMemberId: setup.admin.memberId,
      enabled: true,
      acceptTeamWideForgeryRisk: true,
    });
    expect(
      (await postMr(app, setup.connection.bearer, mergeRequestPayload({ assignees: [{ username: "Reviewer.One" }] })))
        .statusCode,
    ).toBe(200);
    expect((await getGitlabConnectionSummary(app.db, setup.connection.connectionId)).reviewerCapability.mode).toBe(
      "assignee",
    );
    expect((await postMr(app, setup.connection.bearer, mergeRequestPayload({ reviewers: [] }))).statusCode).toBe(200);
    expect((await getGitlabConnectionSummary(app.db, setup.connection.connectionId)).reviewerCapability.mode).toBe(
      "reviewers",
    );
    await expect(
      confirmGitlabAssigneeMode(app.db, {
        connectionId: setup.connection.connectionId,
        organizationId: setup.admin.organizationId,
        actorMemberId: setup.admin.memberId,
      }),
    ).rejects.toThrow("cannot downgrade");
  });

  it("suspends identity-owned routing on connection removal while retaining the audit snapshot", async () => {
    const app = getApp();
    const setup = await setupTarget(app);
    await setGitlabAutomaticActions(app.db, {
      connectionId: setup.connection.connectionId,
      organizationId: setup.admin.organizationId,
      actorMemberId: setup.admin.memberId,
      enabled: true,
      acceptTeamWideForgeryRisk: true,
    });
    await postMr(app, setup.connection.bearer, mergeRequestPayload({ reviewers: [{ username: "Reviewer.One" }] }));
    const removed = await app.inject({
      method: "DELETE",
      url: `/api/v1/gitlab-connections/${setup.connection.connectionId}`,
      headers: { authorization: `Bearer ${setup.admin.accessToken}` },
    });
    expect(removed.statusCode).toBe(204);
    const [link] = await app.db.select().from(gitlabIdentityLinks).where(eq(gitlabIdentityLinks.id, setup.link.id));
    expect(link).toMatchObject({ state: "suspended", stateReason: "connection_removed", connectionId: null });
    expect(
      await app.db.select().from(gitlabAutomaticActionsAudit).orderBy(gitlabAutomaticActionsAudit.createdAt),
    ).toEqual([
      expect.objectContaining({ enabled: true, actorMemberId: setup.admin.memberId }),
      expect.objectContaining({
        connectionId: setup.connection.connectionId,
        enabled: false,
        actorMemberId: setup.admin.memberId,
        reason: "connection_deleted",
      }),
    ]);
    expect(await app.db.select().from(gitlabEntityChatMappings)).toHaveLength(0);
    expect(
      await app.db
        .select()
        .from(gitlabIdentityTransitionAudit)
        .where(
          and(
            eq(gitlabIdentityTransitionAudit.identityLinkId, setup.link.id),
            eq(gitlabIdentityTransitionAudit.transition, "connection_removed"),
          ),
        ),
    ).toEqual([
      expect.objectContaining({
        connectionId: setup.connection.connectionId,
        actorMemberId: setup.admin.memberId,
        instanceOrigin: "https://gitlab.internal",
      }),
    ]);
    expect(
      await app.db.select().from(gitlabConnections).where(eq(gitlabConnections.id, setup.connection.connectionId)),
    ).toHaveLength(0);
  });

  it("closes automatic-action audit on replace without inventing withdrawals for disabled connections", async () => {
    const app = getApp();
    const enabled = await setupTarget(app);
    await setGitlabAutomaticActions(app.db, {
      connectionId: enabled.connection.connectionId,
      organizationId: enabled.admin.organizationId,
      actorMemberId: enabled.admin.memberId,
      enabled: true,
      acceptTeamWideForgeryRisk: true,
    });
    const replacement = await replaceGitlabConnection(app.db, {
      expectedConnectionId: enabled.connection.connectionId,
      organizationId: enabled.admin.organizationId,
      memberId: enabled.admin.memberId,
      displayName: "Replacement GitLab",
      instanceOrigin: "https://gitlab.replacement",
    });
    const expectedAudit = [
      expect.objectContaining({ enabled: true, connectionId: enabled.connection.connectionId }),
      expect.objectContaining({
        enabled: false,
        connectionId: enabled.connection.connectionId,
        actorMemberId: enabled.admin.memberId,
        reason: "connection_replaced",
      }),
    ];
    expect(
      await app.db.select().from(gitlabAutomaticActionsAudit).orderBy(gitlabAutomaticActionsAudit.createdAt),
    ).toEqual(expectedAudit);

    await deleteGitlabConnection(app.db, replacement.connectionId, enabled.admin.memberId);
    expect(
      await app.db.select().from(gitlabAutomaticActionsAudit).orderBy(gitlabAutomaticActionsAudit.createdAt),
    ).toEqual(expectedAudit);
  });
});
