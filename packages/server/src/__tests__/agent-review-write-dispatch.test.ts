import { randomUUID } from "node:crypto";
import { AGENT_SELECTOR_HEADER } from "@first-tree/shared";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { authIdentities } from "../db/schema/auth-identities.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chats } from "../db/schema/chats.js";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { members } from "../db/schema/members.js";
import { messages } from "../db/schema/messages.js";
import { createAgent } from "../services/agent.js";
import { putOrgSetting } from "../services/org-settings.js";
import { addChatParticipants } from "../services/participant-mode.js";
import { createAdminContext, useTestApp } from "./helpers.js";

type App = ReturnType<ReturnType<typeof useTestApp>>;
type Admin = Awaited<ReturnType<typeof createAdminContext>>;

type MemberContext = {
  accessToken: string;
  humanAgentUuid: string;
  memberId: string;
  userId: string;
  username: string;
};

type DispatchResponse = {
  chatId: string;
  messageId: string;
  topic: string | null;
  effectiveSenderId: string;
  reviewerAgentUuid: string;
  outcome: "created" | "reused";
};

async function createMember(app: FastifyInstance, admin: Admin, login: string): Promise<MemberContext> {
  const username = `review-writer-${randomUUID().slice(0, 8)}`;
  const createResponse = await app.inject({
    method: "POST",
    url: `/api/v1/orgs/${admin.organizationId}/members`,
    headers: { authorization: `Bearer ${admin.accessToken}` },
    payload: { username, displayName: "Review Writer", role: "member" },
  });
  expect(createResponse.statusCode).toBe(201);
  const created = createResponse.json<{ id: string; password: string; agentId: string }>();
  const loginResponse = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username, password: created.password },
  });
  expect(loginResponse.statusCode).toBe(200);
  const { accessToken } = loginResponse.json<{ accessToken: string }>();
  const [member] = await app.db
    .select({ userId: members.userId })
    .from(members)
    .where(eq(members.id, created.id))
    .limit(1);
  if (!member) throw new Error("member missing after creation");
  await app.db.insert(authIdentities).values({
    id: randomUUID(),
    userId: member.userId,
    provider: "github",
    identifier: `github-${randomUUID()}`,
    email: null,
    verifiedAt: new Date(),
    metadata: { login },
  });
  return {
    accessToken,
    humanAgentUuid: created.agentId,
    memberId: created.id,
    userId: member.userId,
    username,
  };
}

async function createReviewer(app: App, admin: Admin, visibility: "private" | "organization" = "private") {
  return createAgent(app.db, {
    name: `context-reviewer-${randomUUID().slice(0, 8)}`,
    type: "agent",
    displayName: "Context Reviewer",
    managerId: admin.memberId,
    clientId: admin.clientId,
    visibility,
  });
}

async function configureReview(app: App, admin: Admin, reviewerAgentUuid: string): Promise<void> {
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
    { contextReviewer: { enabled: true, agentUuid: reviewerAgentUuid } },
    { updatedBy: admin.userId, memberId: admin.memberId },
  );
}

async function disableReview(app: App, admin: Admin, reviewerAgentUuid: string): Promise<void> {
  await putOrgSetting(
    app.db,
    admin.organizationId,
    "context_tree_features",
    { contextReviewer: { enabled: false, agentUuid: reviewerAgentUuid } },
    { updatedBy: admin.userId, memberId: admin.memberId },
  );
}

function reviewPacket(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    repository: "owner/context-tree",
    pullRequest: 749,
    expectedHead: "a".repeat(40),
    baseRef: "main",
    sourceRef: "agent-review-contract",
    requesterGithubLogin: "writer",
    goal: "Record the approved Agent Review contract.",
    source: {
      label: "Architecture discussion",
      reference: "first-tree-chat:agent-review-contract",
      revision: "2026-07-17",
    },
    decisionSummary: "Use the existing member task Chat for Agent Review.",
    rationale: "This preserves the normal Chat and Inbox boundary.",
    targetPaths: ["system/context-tree-pr-reviewer.md"],
    repairScope: ["system/context-tree-pr-reviewer.md"],
    relevantContextRefs: ["system/context-tree-pr-reviewer.md"],
    unresolvedQuestions: [],
    verify: { status: "passed", summary: "first-tree tree verify passed" },
    evidence: [
      {
        kind: "reference",
        label: "Source discussion",
        reference: "first-tree-chat:agent-review-contract",
      },
    ],
    ...overrides,
  };
}

function dispatchPayload(
  packetOverrides: Record<string, unknown> = {},
  opening = "Please review this Context Tree PR.",
) {
  return {
    mode: "keyed_task",
    initialMessage: {
      format: "markdown",
      content: opening,
      metadata: {
        taskType: "context_tree_pr_review",
        reviewPacketV1: reviewPacket(packetOverrides),
      },
    },
  };
}

async function dispatch(app: App, admin: Admin, member: MemberContext, payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: `/api/v1/orgs/${admin.organizationId}/chats`,
    headers: { authorization: `Bearer ${member.accessToken}` },
    payload,
  });
}

describe("member Agent Review task dispatch", () => {
  const getApp = useTestApp();

  it("creates one human-authored task for the configured private Reviewer without a GitHub App", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);
    const requester = await createMember(app, admin, "writer");
    const reviewer = await createReviewer(app, admin, "private");
    await configureReview(app, admin, reviewer.uuid);

    const response = await dispatch(app, admin, requester, dispatchPayload());
    expect(response.statusCode).toBe(201);
    const body = response.json<DispatchResponse>();
    expect(body).toEqual({
      chatId: expect.any(String),
      messageId: expect.any(String),
      topic: "Agent Review: owner/context-tree#749",
      effectiveSenderId: requester.humanAgentUuid,
      reviewerAgentUuid: reviewer.uuid,
      outcome: "created",
    });

    const [storedMessage] = await app.db.select().from(messages).where(eq(messages.id, body.messageId)).limit(1);
    expect(storedMessage).toMatchObject({
      chatId: body.chatId,
      senderId: requester.humanAgentUuid,
      format: "markdown",
      content: "Please review this Context Tree PR.",
      source: "api",
    });
    expect(storedMessage?.metadata).toMatchObject({
      taskType: "context_tree_pr_review",
      reviewPacketV1: { pullRequest: 749, requesterGithubLogin: "writer" },
      mentions: [reviewer.uuid],
    });
    expect((storedMessage?.metadata as Record<string, unknown> | undefined)?.sender).toBeUndefined();

    const deliveries = await app.db.select().from(inboxEntries).where(eq(inboxEntries.messageId, body.messageId));
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.inboxId).toBe(reviewer.inboxId);
  });

  it("converges concurrent retries to one Chat, one opening, and one delivery", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);
    const requester = await createMember(app, admin, "writer");
    const reviewer = await createReviewer(app, admin);
    await configureReview(app, admin, reviewer.uuid);

    const [left, right] = await Promise.all([
      dispatch(app, admin, requester, dispatchPayload()),
      dispatch(app, admin, requester, dispatchPayload()),
    ]);
    expect([left.statusCode, right.statusCode].sort()).toEqual([200, 201]);
    const leftBody = left.json<DispatchResponse>();
    const rightBody = right.json<DispatchResponse>();
    expect(leftBody.chatId).toBe(rightBody.chatId);
    expect(leftBody.messageId).toBe(rightBody.messageId);
    expect(new Set([leftBody.outcome, rightBody.outcome])).toEqual(new Set(["created", "reused"]));

    const chatMessages = await app.db.select().from(messages).where(eq(messages.chatId, leftBody.chatId));
    expect(chatMessages).toHaveLength(1);
    const deliveries = await app.db.select().from(inboxEntries).where(eq(inboxEntries.messageId, leftBody.messageId));
    expect(deliveries).toHaveLength(1);
  });

  it("keeps the first opening and packet immutable when the same member retries with a new head", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);
    const requester = await createMember(app, admin, "writer");
    const reviewer = await createReviewer(app, admin);
    await configureReview(app, admin, reviewer.uuid);

    const first = await dispatch(app, admin, requester, dispatchPayload());
    expect(first.statusCode).toBe(201);
    const firstBody = first.json<DispatchResponse>();
    const retry = await dispatch(
      app,
      admin,
      requester,
      dispatchPayload({ expectedHead: "b".repeat(40), decisionSummary: "A later packet." }, "A later opening."),
    );
    expect(retry.statusCode).toBe(200);
    expect(retry.json<DispatchResponse>()).toMatchObject({
      chatId: firstBody.chatId,
      messageId: firstBody.messageId,
      outcome: "reused",
    });

    const rows = await app.db.select().from(messages).where(eq(messages.chatId, firstBody.chatId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.content).toBe("Please review this Context Tree PR.");
    expect((rows[0]?.metadata.reviewPacketV1 as { expectedHead?: string }).expectedHead).toBe("a".repeat(40));
  });

  it("rejects sender edits to the managed opening and takeover history", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);
    const requester = await createMember(app, admin, "writer");
    const firstReviewer = await createReviewer(app, admin);
    const secondReviewer = await createReviewer(app, admin);
    await configureReview(app, admin, firstReviewer.uuid);

    const first = await dispatch(app, admin, requester, dispatchPayload());
    expect(first.statusCode).toBe(201);
    const firstBody = first.json<DispatchResponse>();
    const editOpening = await app.inject({
      method: "PATCH",
      url: `/api/v1/agent/chats/${firstBody.chatId}/messages/${firstBody.messageId}`,
      headers: {
        authorization: `Bearer ${requester.accessToken}`,
        [AGENT_SELECTOR_HEADER]: requester.humanAgentUuid,
      },
      payload: { content: "Rewritten opening" },
    });
    expect(editOpening.statusCode).toBe(403);
    expect(editOpening.body).toContain("cannot be edited");

    await configureReview(app, admin, secondReviewer.uuid);
    const reassigned = await dispatch(app, admin, requester, dispatchPayload());
    expect(reassigned.statusCode).toBe(200);
    const chatMessages = await app.db.select().from(messages).where(eq(messages.chatId, firstBody.chatId));
    const takeover = chatMessages.find((message) => message.id !== firstBody.messageId);
    expect(takeover).toBeDefined();

    const editTakeover = await app.inject({
      method: "PATCH",
      url: `/api/v1/agent/chats/${firstBody.chatId}/messages/${takeover?.id ?? "missing"}`,
      headers: {
        authorization: `Bearer ${requester.accessToken}`,
        [AGENT_SELECTOR_HEADER]: requester.humanAgentUuid,
      },
      payload: { content: "Rewritten takeover" },
    });
    expect(editTakeover.statusCode).toBe(403);
    expect(editTakeover.body).toContain("cannot be edited");

    const unchangedMessages = await app.db.select().from(messages).where(eq(messages.chatId, firstBody.chatId));
    expect(unchangedMessages.find((message) => message.id === firstBody.messageId)?.content).toBe(
      "Please review this Context Tree PR.",
    );
    expect(unchangedMessages.find((message) => message.id === takeover?.id)?.content).toContain(
      "First Tree reassigned this Agent Review",
    );
  });

  it("returns a non-leaking conflict when another member owns the same PR task", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);
    const firstRequester = await createMember(app, admin, "writer");
    const secondRequester = await createMember(app, admin, "second-writer");
    const reviewer = await createReviewer(app, admin);
    await configureReview(app, admin, reviewer.uuid);

    const first = await dispatch(app, admin, firstRequester, dispatchPayload());
    expect(first.statusCode).toBe(201);
    const firstBody = first.json<DispatchResponse>();
    const second = await dispatch(
      app,
      admin,
      secondRequester,
      dispatchPayload({ requesterGithubLogin: "second-writer" }),
    );
    expect(second.statusCode).toBe(409);
    expect(second.body).not.toContain(firstBody.chatId);
    expect(second.body).not.toContain(firstBody.messageId);

    const rows = await app.db.select().from(messages).where(eq(messages.chatId, firstBody.chatId));
    expect(rows).toHaveLength(1);
  });

  it("rejects binding, identity, and serialized-budget failures before persistence", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);
    const requester = await createMember(app, admin, "writer");
    const reviewer = await createReviewer(app, admin);
    await configureReview(app, admin, reviewer.uuid);

    const before = await app.db.select({ id: chats.id }).from(chats);
    const wrongRepo = await dispatch(app, admin, requester, dispatchPayload({ repository: "owner/other-tree" }));
    expect(wrongRepo.statusCode).toBe(400);
    const wrongBranch = await dispatch(app, admin, requester, dispatchPayload({ baseRef: "trunk" }));
    expect(wrongBranch.statusCode).toBe(400);
    const wrongIdentity = await dispatch(
      app,
      admin,
      requester,
      dispatchPayload({ requesterGithubLogin: "impersonated-writer" }),
    );
    expect(wrongIdentity.statusCode).toBe(403);
    const oversized = await dispatch(app, admin, requester, dispatchPayload({ decisionSummary: "界".repeat(11_000) }));
    expect(oversized.statusCode).toBe(400);
    const after = await app.db.select({ id: chats.id }).from(chats);
    expect(after).toHaveLength(before.length);
  });

  it("revalidates status and reconciles A to B atomically in the same Chat", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);
    const requester = await createMember(app, admin, "writer");
    const firstReviewer = await createReviewer(app, admin);
    await configureReview(app, admin, firstReviewer.uuid);

    const first = await dispatch(app, admin, requester, dispatchPayload());
    expect(first.statusCode).toBe(201);
    const firstBody = first.json<DispatchResponse>();

    await app.db.update(agents).set({ status: "suspended" }).where(eq(agents.uuid, firstReviewer.uuid));
    const suspended = await dispatch(app, admin, requester, dispatchPayload());
    expect(suspended.statusCode).toBe(409);

    await app.db.update(agents).set({ status: "active" }).where(eq(agents.uuid, firstReviewer.uuid));
    const secondReviewer = await createReviewer(app, admin);
    await configureReview(app, admin, secondReviewer.uuid);
    const reassigned = await dispatch(app, admin, requester, dispatchPayload());
    expect(reassigned.statusCode).toBe(200);
    const reassignedBody = reassigned.json<DispatchResponse>();
    expect(reassignedBody.reviewerAgentUuid).toBe(secondReviewer.uuid);
    expect(reassignedBody).toMatchObject({
      chatId: firstBody.chatId,
      messageId: firstBody.messageId,
      outcome: "reused",
    });

    const speakerRows = await app.db
      .select({ agentId: chatMembership.agentId })
      .from(chatMembership)
      .where(eq(chatMembership.chatId, firstBody.chatId));
    expect(speakerRows.map((row) => row.agentId)).toEqual(
      expect.arrayContaining([requester.humanAgentUuid, secondReviewer.uuid]),
    );
    expect(speakerRows.map((row) => row.agentId)).not.toContain(firstReviewer.uuid);

    const chatMessages = await app.db.select().from(messages).where(eq(messages.chatId, firstBody.chatId));
    expect(chatMessages).toHaveLength(2);
    const opening = chatMessages.find((message) => message.id === firstBody.messageId);
    expect(opening?.metadata.mentions).toEqual([firstReviewer.uuid]);
    const takeover = chatMessages.find((message) => message.id !== firstBody.messageId);
    expect(takeover?.metadata).toMatchObject({
      addressedAgentIds: [secondReviewer.uuid],
      contextReviewTakeoverV1: {
        schemaVersion: 1,
        reviewerAgentUuid: secondReviewer.uuid,
        previousReviewerAgentUuid: firstReviewer.uuid,
      },
    });

    const takeoverDeliveries = await app.db
      .select()
      .from(inboxEntries)
      .where(eq(inboxEntries.messageId, takeover?.id ?? "missing"));
    expect(takeoverDeliveries).toHaveLength(1);
    expect(takeoverDeliveries[0]).toMatchObject({ inboxId: secondReviewer.inboxId, notify: true });
    const backfilledOpening = await app.db
      .select()
      .from(inboxEntries)
      .where(eq(inboxEntries.messageId, firstBody.messageId));
    expect(backfilledOpening).toEqual(
      expect.arrayContaining([expect.objectContaining({ inboxId: secondReviewer.inboxId, notify: false })]),
    );
  });

  it("keeps mutable Chat topic outside task identity during A to B takeover", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);
    const requester = await createMember(app, admin, "writer");
    const firstReviewer = await createReviewer(app, admin);
    const secondReviewer = await createReviewer(app, admin);
    await configureReview(app, admin, firstReviewer.uuid);

    const first = await dispatch(app, admin, requester, dispatchPayload());
    expect(first.statusCode).toBe(201);
    const firstBody = first.json<DispatchResponse>();

    const rename = await app.inject({
      method: "PATCH",
      url: `/api/v1/chats/${firstBody.chatId}`,
      headers: { authorization: `Bearer ${requester.accessToken}` },
      payload: { topic: "Human-maintained review topic" },
    });
    expect(rename.statusCode).toBe(200);

    await configureReview(app, admin, secondReviewer.uuid);
    const reassigned = await dispatch(app, admin, requester, dispatchPayload());
    expect(reassigned.statusCode).toBe(200);
    expect(reassigned.json<DispatchResponse>()).toMatchObject({
      chatId: firstBody.chatId,
      messageId: firstBody.messageId,
      topic: "Human-maintained review topic",
      reviewerAgentUuid: secondReviewer.uuid,
      outcome: "reused",
    });

    const [storedChat] = await app.db
      .select({ topic: chats.topic })
      .from(chats)
      .where(eq(chats.id, firstBody.chatId))
      .limit(1);
    expect(storedChat?.topic).toBe("Human-maintained review topic");
    expect(await app.db.select().from(messages).where(eq(messages.chatId, firstBody.chatId))).toHaveLength(2);

    const clearTopic = await app.inject({
      method: "PATCH",
      url: `/api/v1/chats/${firstBody.chatId}`,
      headers: { authorization: `Bearer ${requester.accessToken}` },
      payload: { topic: null },
    });
    expect(clearTopic.statusCode).toBe(200);
    const retry = await dispatch(app, admin, requester, dispatchPayload());
    expect(retry.statusCode).toBe(200);
    expect(retry.json<DispatchResponse>()).toMatchObject({ chatId: firstBody.chatId, topic: null, outcome: "reused" });
    expect(await app.db.select().from(messages).where(eq(messages.chatId, firstBody.chatId))).toHaveLength(2);
  });

  it("converges concurrent A to B retries and an ABA reassignment without duplicate takeover", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);
    const requester = await createMember(app, admin, "writer");
    const firstReviewer = await createReviewer(app, admin);
    const secondReviewer = await createReviewer(app, admin);
    await configureReview(app, admin, firstReviewer.uuid);

    const first = await dispatch(app, admin, requester, dispatchPayload());
    expect(first.statusCode).toBe(201);
    const firstBody = first.json<DispatchResponse>();

    await configureReview(app, admin, secondReviewer.uuid);
    const [left, right] = await Promise.all([
      dispatch(app, admin, requester, dispatchPayload()),
      dispatch(app, admin, requester, dispatchPayload()),
    ]);
    expect([left.statusCode, right.statusCode]).toEqual([200, 200]);
    expect(left.json<DispatchResponse>().chatId).toBe(firstBody.chatId);
    expect(right.json<DispatchResponse>().chatId).toBe(firstBody.chatId);

    let chatMessages = await app.db.select().from(messages).where(eq(messages.chatId, firstBody.chatId));
    expect(chatMessages).toHaveLength(2);
    expect(
      chatMessages.filter(
        (message) =>
          (message.metadata.contextReviewTakeoverV1 as { reviewerAgentUuid?: string } | undefined)
            ?.reviewerAgentUuid === secondReviewer.uuid,
      ),
    ).toHaveLength(1);

    await configureReview(app, admin, firstReviewer.uuid);
    const backToFirst = await dispatch(app, admin, requester, dispatchPayload());
    expect(backToFirst.statusCode).toBe(200);
    expect(backToFirst.json<DispatchResponse>()).toMatchObject({
      chatId: firstBody.chatId,
      messageId: firstBody.messageId,
      reviewerAgentUuid: firstReviewer.uuid,
      outcome: "reused",
    });

    chatMessages = await app.db.select().from(messages).where(eq(messages.chatId, firstBody.chatId));
    expect(chatMessages).toHaveLength(3);
    expect(
      chatMessages.filter(
        (message) =>
          (message.metadata.contextReviewTakeoverV1 as { reviewerAgentUuid?: string } | undefined)
            ?.reviewerAgentUuid === firstReviewer.uuid,
      ),
    ).toHaveLength(1);

    const speakers = await app.db
      .select({ agentId: chatMembership.agentId, accessMode: chatMembership.accessMode })
      .from(chatMembership)
      .where(eq(chatMembership.chatId, firstBody.chatId));
    expect(speakers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agentId: requester.humanAgentUuid, accessMode: "speaker" }),
        expect.objectContaining({ agentId: firstReviewer.uuid, accessMode: "speaker" }),
      ]),
    );
    expect(speakers.some((row) => row.agentId === secondReviewer.uuid && row.accessMode === "speaker")).toBe(false);

    const sameReviewerRetry = await dispatch(app, admin, requester, dispatchPayload());
    expect(sameReviewerRetry.statusCode).toBe(200);
    expect(await app.db.select().from(messages).where(eq(messages.chatId, firstBody.chatId))).toHaveLength(3);
  });

  it("keeps the same Chat and delivery when the same Reviewer is disabled then re-enabled", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);
    const requester = await createMember(app, admin, "writer");
    const reviewer = await createReviewer(app, admin);
    await configureReview(app, admin, reviewer.uuid);

    const first = await dispatch(app, admin, requester, dispatchPayload());
    expect(first.statusCode).toBe(201);
    const firstBody = first.json<DispatchResponse>();

    await disableReview(app, admin, reviewer.uuid);
    const disabled = await dispatch(app, admin, requester, dispatchPayload());
    expect(disabled.statusCode).toBe(409);

    await configureReview(app, admin, reviewer.uuid);
    const reenabled = await dispatch(app, admin, requester, dispatchPayload());
    expect(reenabled.statusCode).toBe(200);
    expect(reenabled.json<DispatchResponse>()).toMatchObject({
      chatId: firstBody.chatId,
      messageId: firstBody.messageId,
      reviewerAgentUuid: reviewer.uuid,
      outcome: "reused",
    });
    expect(await app.db.select().from(messages).where(eq(messages.chatId, firstBody.chatId))).toHaveLength(1);
    expect(
      await app.db.select().from(inboxEntries).where(eq(inboxEntries.messageId, firstBody.messageId)),
    ).toHaveLength(1);
  });

  it("fails closed without partial reconciliation when Reviewer speakers are ambiguous", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);
    const requester = await createMember(app, admin, "writer");
    const firstReviewer = await createReviewer(app, admin);
    const extraReviewer = await createReviewer(app, admin);
    const nextReviewer = await createReviewer(app, admin);
    await configureReview(app, admin, firstReviewer.uuid);

    const first = await dispatch(app, admin, requester, dispatchPayload());
    expect(first.statusCode).toBe(201);
    const firstBody = first.json<DispatchResponse>();
    await addChatParticipants(app.db, firstBody.chatId, [{ agentId: extraReviewer.uuid }]);
    await configureReview(app, admin, nextReviewer.uuid);

    const response = await dispatch(app, admin, requester, dispatchPayload());
    expect(response.statusCode).toBe(409);
    expect(await app.db.select().from(messages).where(eq(messages.chatId, firstBody.chatId))).toHaveLength(1);
    const memberships = await app.db
      .select({ agentId: chatMembership.agentId })
      .from(chatMembership)
      .where(eq(chatMembership.chatId, firstBody.chatId));
    expect(memberships.map((row) => row.agentId)).not.toContain(nextReviewer.uuid);
  });

  it("does not guess a lone unrelated Agent speaker is the previous Reviewer", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);
    const requester = await createMember(app, admin, "writer");
    const firstReviewer = await createReviewer(app, admin);
    const unrelatedAgent = await createReviewer(app, admin);
    const nextReviewer = await createReviewer(app, admin);
    await configureReview(app, admin, firstReviewer.uuid);

    const first = await dispatch(app, admin, requester, dispatchPayload());
    expect(first.statusCode).toBe(201);
    const firstBody = first.json<DispatchResponse>();
    await addChatParticipants(app.db, firstBody.chatId, [{ agentId: unrelatedAgent.uuid }]);
    await app.db
      .delete(chatMembership)
      .where(and(eq(chatMembership.chatId, firstBody.chatId), eq(chatMembership.agentId, firstReviewer.uuid)));
    await configureReview(app, admin, nextReviewer.uuid);

    const response = await dispatch(app, admin, requester, dispatchPayload());
    expect(response.statusCode).toBe(409);
    expect(await app.db.select().from(messages).where(eq(messages.chatId, firstBody.chatId))).toHaveLength(1);
    const memberships = await app.db
      .select({ agentId: chatMembership.agentId })
      .from(chatMembership)
      .where(eq(chatMembership.chatId, firstBody.chatId));
    expect(memberships.map((row) => row.agentId)).toContain(unrelatedAgent.uuid);
    expect(memberships.map((row) => row.agentId)).not.toContain(nextReviewer.uuid);
  });

  it("fails closed when protected takeover history does not continue from the recorded Reviewer", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);
    const requester = await createMember(app, admin, "writer");
    const firstReviewer = await createReviewer(app, admin);
    const nextReviewer = await createReviewer(app, admin);
    await configureReview(app, admin, firstReviewer.uuid);

    const first = await dispatch(app, admin, requester, dispatchPayload());
    expect(first.statusCode).toBe(201);
    const firstBody = first.json<DispatchResponse>();
    await app.db.insert(messages).values({
      id: randomUUID(),
      chatId: firstBody.chatId,
      senderId: requester.humanAgentUuid,
      format: "markdown",
      content: "Inconsistent takeover history fixture.",
      metadata: {
        contextReviewTakeoverV1: {
          schemaVersion: 1,
          reviewerAgentUuid: nextReviewer.uuid,
          previousReviewerAgentUuid: randomUUID(),
        },
      },
      source: "api",
    });
    await configureReview(app, admin, nextReviewer.uuid);

    const response = await dispatch(app, admin, requester, dispatchPayload());
    expect(response.statusCode).toBe(409);
    const speakers = await app.db
      .select({ agentId: chatMembership.agentId })
      .from(chatMembership)
      .where(and(eq(chatMembership.chatId, firstBody.chatId), eq(chatMembership.accessMode, "speaker")));
    expect(speakers.map((row) => row.agentId)).toContain(firstReviewer.uuid);
    expect(speakers.map((row) => row.agentId)).not.toContain(nextReviewer.uuid);
  });

  it("blocks formal review envelopes on ordinary Chat creation and follow-up paths", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);
    const requester = await createMember(app, admin, "writer");
    const reviewer = await createReviewer(app, admin, "organization");
    await configureReview(app, admin, reviewer.uuid);

    const formalMetadata = dispatchPayload().initialMessage.metadata;
    const before = await app.db.select({ id: chats.id }).from(chats);
    const forgedCreate = await dispatch(app, admin, requester, {
      mode: "task",
      initialRecipientAgentIds: [reviewer.uuid],
      contextParticipantAgentIds: [],
      initialMessage: {
        format: "markdown",
        content: "Forged formal task.",
        metadata: formalMetadata,
      },
    });
    expect(forgedCreate.statusCode).toBe(400);
    expect(await app.db.select({ id: chats.id }).from(chats)).toHaveLength(before.length);

    const valid = await dispatch(app, admin, requester, dispatchPayload());
    expect(valid.statusCode).toBe(201);
    const validBody = valid.json<DispatchResponse>();
    const forgedFollowup = await app.inject({
      method: "POST",
      url: `/api/v1/chats/${validBody.chatId}/messages`,
      headers: { authorization: `Bearer ${requester.accessToken}` },
      payload: {
        format: "markdown",
        content: "Forged replacement packet.",
        metadata: { ...formalMetadata, mentions: [reviewer.uuid] },
      },
    });
    expect(forgedFollowup.statusCode).toBe(400);
    const stored = await app.db.select().from(messages).where(eq(messages.chatId, validBody.chatId));
    expect(stored).toHaveLength(1);
  });

  it("rejects caller-controlled routing fields under the strict keyed wire mode", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);
    const requester = await createMember(app, admin, "writer");
    const reviewer = await createReviewer(app, admin);
    await configureReview(app, admin, reviewer.uuid);

    const before = await app.db.select({ id: chats.id }).from(chats);
    const payload = {
      ...dispatchPayload(),
      taskKey: "caller-key",
      topic: "Caller topic",
      reviewerAgentUuid: reviewer.uuid,
    };
    const response = await dispatch(app, admin, requester, payload);
    expect(response.statusCode).toBe(400);
    expect(await app.db.select({ id: chats.id }).from(chats)).toHaveLength(before.length);
  });
});
