import { randomUUID } from "node:crypto";
import { AGENT_SELECTOR_HEADER, CONTEXT_REVIEW_MANAGED_MARKER } from "@first-tree/shared";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { authIdentities } from "../db/schema/auth-identities.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chats } from "../db/schema/chats.js";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { members } from "../db/schema/members.js";
import { messages } from "../db/schema/messages.js";
import { createAgent } from "../services/agent.js";
import { handleContextReviewerPrEvent } from "../services/context-reviewer-pr.js";
import { sendMessage } from "../services/message.js";
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

function managedPullRequestPayload(
  options: {
    action?: "opened" | "synchronize" | "ready_for_review" | "reopened" | "edited";
    body?: string;
    headSha?: string;
    changes?: Record<string, unknown>;
  } = {},
) {
  return {
    action: options.action ?? "synchronize",
    pull_request: {
      number: 749,
      title: "Agent Review contract",
      html_url: "https://github.com/owner/context-tree/pull/749",
      body: options.body ?? `${CONTEXT_REVIEW_MANAGED_MARKER}\n\nRepair scope: system/`,
      base: { ref: "main" },
      head: { ref: "agent-review-contract", sha: options.headSha ?? "b".repeat(40) },
      draft: false,
      user: { login: "writer", type: "User" },
    },
    ...(options.changes ? { changes: options.changes } : {}),
    repository: { full_name: "owner/context-tree" },
    sender: { login: "writer", type: "User" },
  };
}

function managedIssueCommentPayload(
  commentBody: string,
  options: { action?: "created" | "edited"; prBody?: string; authorLogin?: string; authorType?: string } = {},
) {
  const authorLogin = options.authorLogin ?? "review-input";
  return {
    action: options.action ?? "created",
    issue: {
      number: 749,
      title: "Agent Review contract",
      html_url: "https://github.com/owner/context-tree/issues/749",
      body: options.prBody ?? `${CONTEXT_REVIEW_MANAGED_MARKER}\n\nRepair scope: system/`,
      user: { login: "writer", type: "User" },
      pull_request: { html_url: "https://github.com/owner/context-tree/pull/749" },
    },
    comment: {
      html_url: "https://github.com/owner/context-tree/pull/749#issuecomment-1",
      user: { login: authorLogin, type: options.authorType ?? "User" },
      body: commentBody,
    },
    repository: { full_name: "owner/context-tree" },
    sender: { login: authorLogin, type: options.authorType ?? "User" },
  };
}

function managedReviewCommentPayload(commentBody: string, action: "created" | "edited") {
  return {
    action,
    pull_request: {
      number: 749,
      title: "Agent Review contract",
      html_url: "https://github.com/owner/context-tree/pull/749",
      body: `${CONTEXT_REVIEW_MANAGED_MARKER}\n\nRepair scope: system/`,
      base: { ref: "main" },
      head: { ref: "agent-review-contract", sha: "b".repeat(40) },
      draft: false,
      user: { login: "writer", type: "User" },
    },
    comment: {
      html_url: "https://github.com/owner/context-tree/pull/749#discussion_r1",
      user: { login: "review-input", type: "User" },
      body: commentBody,
    },
    repository: { full_name: "owner/context-tree" },
    sender: { login: "review-input", type: "User" },
  };
}

async function waitForBlockedRequesterMembershipLock(
  observer: ReturnType<typeof postgres>,
  blockerPid: number,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await observer<{ query: string; wait_event_type: string | null }[]>`
      SELECT query, wait_event_type
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND ${blockerPid} = ANY(pg_blocking_pids(pid))
    `;
    if (
      rows.some(
        (row) =>
          row.wait_event_type === "Lock" &&
          /\bfrom\s+"?members"?/i.test(row.query) &&
          /\bfor\s+update\b/i.test(row.query),
      )
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for the dispatch transaction to lock requester membership");
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

  it("routes meaningful GitHub App follow-ups into the existing managed task Chat", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);
    const requester = await createMember(app, admin, "writer");
    const reviewer = await createReviewer(app, admin);
    await configureReview(app, admin, reviewer.uuid);

    const created = await dispatch(app, admin, requester, dispatchPayload());
    expect(created.statusCode).toBe(201);
    const task = created.json<DispatchResponse>();
    const followUp = await handleContextReviewerPrEvent(app, {
      eventType: "pull_request",
      payload: managedPullRequestPayload({ action: "synchronize", headSha: "b".repeat(40) }),
      organizationId: admin.organizationId,
    });
    expect(followUp).toMatchObject({ handled: true, chatId: task.chatId, reused: true });

    let chatMessages = await app.db.select().from(messages).where(eq(messages.chatId, task.chatId));
    expect(chatMessages).toHaveLength(2);
    const eventMessage = chatMessages.find((message) => message.id !== task.messageId);
    expect(eventMessage).toMatchObject({
      senderId: requester.humanAgentUuid,
      source: "github",
      content: expect.stringContaining("Treat this webhook only as a trigger"),
    });
    expect(eventMessage?.metadata).toMatchObject({
      systemSender: "github",
      addressedAgentIds: [reviewer.uuid],
      contextReviewManagedEventV1: {
        schemaVersion: 1,
        eventType: "pull_request",
        action: "synchronize",
        triggerEvent: "pull_request.synchronize",
        repository: "owner/context-tree",
        pullRequest: 749,
        headSha: "b".repeat(40),
      },
    });
    const eventDeliveries = await app.db
      .select()
      .from(inboxEntries)
      .where(eq(inboxEntries.messageId, eventMessage?.id ?? "missing"));
    expect(eventDeliveries).toEqual([expect.objectContaining({ inboxId: reviewer.inboxId, notify: true })]);

    const delayedOpened = await handleContextReviewerPrEvent(app, {
      eventType: "pull_request",
      payload: managedPullRequestPayload({ action: "opened" }),
      organizationId: admin.organizationId,
    });
    expect(delayedOpened).toEqual({
      handled: true,
      chatId: task.chatId,
      messageId: task.messageId,
      reused: true,
      suppressed: true,
    });
    const botNoise = await handleContextReviewerPrEvent(app, {
      eventType: "issue_comment",
      payload: managedIssueCommentPayload("Automated status reflection", { authorType: "Bot" }),
      organizationId: admin.organizationId,
    });
    expect(botNoise).toEqual({
      handled: true,
      chatId: task.chatId,
      messageId: task.messageId,
      reused: true,
      suppressed: true,
    });
    const unknownActorNoise = await handleContextReviewerPrEvent(app, {
      eventType: "issue_comment",
      payload: managedIssueCommentPayload("Migrated account reflection", { authorType: "Mannequin" }),
      organizationId: admin.organizationId,
    });
    expect(unknownActorNoise).toEqual({
      handled: true,
      chatId: task.chatId,
      messageId: task.messageId,
      reused: true,
      suppressed: true,
    });
    chatMessages = await app.db.select().from(messages).where(eq(messages.chatId, task.chatId));
    expect(chatMessages).toHaveLength(2);
    expect(await app.db.select().from(chats).where(eq(chats.organizationId, admin.organizationId))).toHaveLength(1);
  });

  it("combines a lazy A to B takeover and GitHub event into one atomic wake", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);
    const requester = await createMember(app, admin, "writer");
    const firstReviewer = await createReviewer(app, admin);
    const secondReviewer = await createReviewer(app, admin);
    await configureReview(app, admin, firstReviewer.uuid);
    const created = await dispatch(app, admin, requester, dispatchPayload());
    const task = created.json<DispatchResponse>();

    await configureReview(app, admin, secondReviewer.uuid);
    const followUp = await handleContextReviewerPrEvent(app, {
      eventType: "issue_comment",
      payload: managedIssueCommentPayload("Please re-review the live PR."),
      organizationId: admin.organizationId,
    });
    expect(followUp).toMatchObject({ handled: true, chatId: task.chatId, reused: true });

    const chatMessages = await app.db.select().from(messages).where(eq(messages.chatId, task.chatId));
    expect(chatMessages).toHaveLength(2);
    const takeoverEvent = chatMessages.find((message) => message.id !== task.messageId);
    expect(takeoverEvent?.metadata).toMatchObject({
      addressedAgentIds: [secondReviewer.uuid],
      contextReviewManagedEventV1: { triggerEvent: "issue_comment.created" },
      contextReviewTakeoverV1: {
        schemaVersion: 1,
        reviewerAgentUuid: secondReviewer.uuid,
        previousReviewerAgentUuid: firstReviewer.uuid,
      },
    });
    expect(takeoverEvent?.content).toContain("reassigned this Agent Review");

    const speakers = await app.db
      .select({ agentId: chatMembership.agentId })
      .from(chatMembership)
      .where(and(eq(chatMembership.chatId, task.chatId), eq(chatMembership.accessMode, "speaker")));
    expect(speakers.map((speaker) => speaker.agentId)).toEqual(
      expect.arrayContaining([requester.humanAgentUuid, secondReviewer.uuid]),
    );
    expect(speakers.map((speaker) => speaker.agentId)).not.toContain(firstReviewer.uuid);
    const deliveries = await app.db
      .select()
      .from(inboxEntries)
      .where(eq(inboxEntries.messageId, takeoverEvent?.id ?? "missing"));
    expect(deliveries).toEqual([expect.objectContaining({ inboxId: secondReviewer.inboxId, notify: true })]);
    const backfilledOpening = await app.db
      .select()
      .from(inboxEntries)
      .where(and(eq(inboxEntries.messageId, task.messageId), eq(inboxEntries.inboxId, secondReviewer.inboxId)));
    expect(backfilledOpening).toEqual([expect.objectContaining({ notify: false })]);
  });

  it("deduplicates a delivery replay while reconciling one A to B takeover", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);
    const requester = await createMember(app, admin, "writer");
    const firstReviewer = await createReviewer(app, admin);
    const secondReviewer = await createReviewer(app, admin);
    await configureReview(app, admin, firstReviewer.uuid);
    const created = await dispatch(app, admin, requester, dispatchPayload());
    const task = created.json<DispatchResponse>();
    const deliveryId = randomUUID();
    const event = {
      eventType: "pull_request",
      payload: managedPullRequestPayload({ action: "synchronize" }),
      organizationId: admin.organizationId,
      deliveryId,
    };

    await expect(handleContextReviewerPrEvent(app, event)).resolves.toMatchObject({
      handled: true,
      chatId: task.chatId,
      reused: true,
    });
    await configureReview(app, admin, secondReviewer.uuid);
    const reassignedReplay = await handleContextReviewerPrEvent(app, event);
    expect(reassignedReplay).toMatchObject({ handled: true, chatId: task.chatId, reused: true });
    expect(reassignedReplay).not.toMatchObject({ suppressed: true });

    let chatMessages = await app.db.select().from(messages).where(eq(messages.chatId, task.chatId));
    expect(chatMessages).toHaveLength(3);
    expect(chatMessages.filter((message) => message.metadata.contextReviewManagedEventV1)).toHaveLength(1);
    const takeovers = chatMessages.filter((message) => message.metadata.contextReviewTakeoverV1);
    expect(takeovers).toHaveLength(1);
    expect(takeovers[0]?.metadata).toMatchObject({
      addressedAgentIds: [secondReviewer.uuid],
      contextReviewTakeoverV1: {
        reviewerAgentUuid: secondReviewer.uuid,
        previousReviewerAgentUuid: firstReviewer.uuid,
      },
    });

    const settledReplay = await handleContextReviewerPrEvent(app, event);
    expect(settledReplay).toMatchObject({
      handled: true,
      chatId: task.chatId,
      reused: true,
      suppressed: true,
    });
    chatMessages = await app.db.select().from(messages).where(eq(messages.chatId, task.chatId));
    expect(chatMessages).toHaveLength(3);
  });

  it("keeps task identity after managed-marker removal and ignores title-only edits", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);
    const requester = await createMember(app, admin, "writer");
    const reviewer = await createReviewer(app, admin);
    await configureReview(app, admin, reviewer.uuid);
    const created = await dispatch(app, admin, requester, dispatchPayload());
    const task = created.json<DispatchResponse>();
    const priorBody = `${CONTEXT_REVIEW_MANAGED_MARKER}\n\nRepair scope: system/`;

    const declarationEdit = await handleContextReviewerPrEvent(app, {
      eventType: "pull_request",
      payload: managedPullRequestPayload({
        action: "edited",
        body: "Managed declaration removed pending correction.",
        changes: { body: { from: priorBody } },
      }),
      organizationId: admin.organizationId,
    });
    expect(declarationEdit).toMatchObject({ handled: true, chatId: task.chatId, reused: true });

    const commentAfterRemoval = await handleContextReviewerPrEvent(app, {
      eventType: "issue_comment",
      payload: managedIssueCommentPayload("The declaration removal was intentional.", {
        action: "edited",
        prBody: "Managed declaration removed pending correction.",
      }),
      organizationId: admin.organizationId,
    });
    expect(commentAfterRemoval).toMatchObject({ handled: true, chatId: task.chatId, reused: true });

    const titleOnly = await handleContextReviewerPrEvent(app, {
      eventType: "pull_request",
      payload: managedPullRequestPayload({
        action: "edited",
        changes: { title: { from: "Old title" } },
      }),
      organizationId: admin.organizationId,
    });
    expect(titleOnly).toEqual({ handled: false, reason: "unsupported_event" });
    const chatMessages = await app.db.select().from(messages).where(eq(messages.chatId, task.chatId));
    expect(chatMessages).toHaveLength(3);
    expect(
      chatMessages.map(
        (message) =>
          (message.metadata.contextReviewManagedEventV1 as { triggerEvent?: string } | undefined)?.triggerEvent,
      ),
    ).toEqual(expect.arrayContaining(["pull_request.edited", "issue_comment.edited"]));
  });

  it("routes every agreed managed PR and review-comment follow-up branch", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);
    const requester = await createMember(app, admin, "writer");
    const reviewer = await createReviewer(app, admin);
    await configureReview(app, admin, reviewer.uuid);
    const created = await dispatch(app, admin, requester, dispatchPayload());
    const task = created.json<DispatchResponse>();

    const events = [
      {
        eventType: "pull_request",
        payload: managedPullRequestPayload({ action: "ready_for_review" }),
      },
      { eventType: "pull_request", payload: managedPullRequestPayload({ action: "reopened" }) },
      {
        eventType: "pull_request_review_comment",
        payload: managedReviewCommentPayload("Please clarify this decision.", "created"),
      },
      {
        eventType: "pull_request_review_comment",
        payload: managedReviewCommentPayload("Updated clarification request.", "edited"),
      },
    ];
    for (const event of events) {
      await expect(
        handleContextReviewerPrEvent(app, { ...event, organizationId: admin.organizationId }),
      ).resolves.toMatchObject({ handled: true, chatId: task.chatId, reused: true });
    }

    const chatMessages = await app.db.select().from(messages).where(eq(messages.chatId, task.chatId));
    expect(chatMessages).toHaveLength(5);
    const triggerEvents = chatMessages.flatMap((message) => {
      const event = message.metadata.contextReviewManagedEventV1 as { triggerEvent?: string } | undefined;
      return event?.triggerEvent ? [event.triggerEvent] : [];
    });
    expect(new Set(triggerEvents)).toEqual(
      new Set([
        "pull_request.ready_for_review",
        "pull_request.reopened",
        "pull_request_review_comment.created",
        "pull_request_review_comment.edited",
      ]),
    );
  });

  it("suppresses only an exact authoritative Reviewer result projection", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);
    const requester = await createMember(app, admin, "writer");
    const reviewer = await createReviewer(app, admin);
    await configureReview(app, admin, reviewer.uuid);
    await app.db.insert(authIdentities).values({
      id: randomUUID(),
      userId: admin.userId,
      provider: "github",
      identifier: `github-${randomUUID()}`,
      email: null,
      verifiedAt: new Date(),
      metadata: { login: "review-input" },
    });
    const created = await dispatch(app, admin, requester, dispatchPayload());
    const task = created.json<DispatchResponse>();
    const marker = `<!-- first-tree-context-review-result:v1 chat=${task.chatId} reviewer=${reviewer.uuid} head=${"a".repeat(40)} -->`;
    const canonicalProjection = `${marker}\n\nREADY\n\nAll managed checks passed.`;

    const preTerminalReflection = await handleContextReviewerPrEvent(app, {
      eventType: "issue_comment",
      payload: managedIssueCommentPayload(canonicalProjection),
      organizationId: admin.organizationId,
    });
    expect(preTerminalReflection).toMatchObject({ handled: true, chatId: task.chatId, reused: true });
    expect(preTerminalReflection).not.toMatchObject({ suppressed: true });

    const terminal = await sendMessage(
      app.db,
      task.chatId,
      reviewer.uuid,
      {
        format: "markdown",
        content: canonicalProjection,
        metadata: { mentions: [requester.humanAgentUuid] },
        source: "api",
      },
      { addressedToAgentIds: [requester.humanAgentUuid] },
    );

    const reflected = await handleContextReviewerPrEvent(app, {
      eventType: "issue_comment",
      payload: managedIssueCommentPayload(canonicalProjection),
      organizationId: admin.organizationId,
    });
    expect(reflected).toEqual({
      handled: true,
      chatId: task.chatId,
      messageId: terminal.message.id,
      reused: true,
      suppressed: true,
    });
    expect(await app.db.select().from(messages).where(eq(messages.chatId, task.chatId))).toHaveLength(3);

    const copiedProjection = await handleContextReviewerPrEvent(app, {
      eventType: "issue_comment",
      payload: managedIssueCommentPayload(canonicalProjection, { authorLogin: "result-copier" }),
      organizationId: admin.organizationId,
    });
    expect(copiedProjection).toMatchObject({ handled: true, chatId: task.chatId, reused: true });
    expect(copiedProjection).not.toMatchObject({ suppressed: true });
    expect(await app.db.select().from(messages).where(eq(messages.chatId, task.chatId))).toHaveLength(4);

    await app.db
      .update(messages)
      .set({ metadata: { ...terminal.message.metadata, editedAt: new Date().toISOString() } })
      .where(eq(messages.id, terminal.message.id));
    const editedTerminalProjection = await handleContextReviewerPrEvent(app, {
      eventType: "issue_comment",
      payload: managedIssueCommentPayload(canonicalProjection),
      organizationId: admin.organizationId,
    });
    expect(editedTerminalProjection).toMatchObject({ handled: true, chatId: task.chatId, reused: true });
    expect(editedTerminalProjection).not.toMatchObject({ suppressed: true });
    expect(await app.db.select().from(messages).where(eq(messages.chatId, task.chatId))).toHaveLength(5);

    const editedProjection = await handleContextReviewerPrEvent(app, {
      eventType: "issue_comment",
      payload: managedIssueCommentPayload(canonicalProjection, { action: "edited" }),
      organizationId: admin.organizationId,
    });
    expect(editedProjection).toMatchObject({ handled: true, chatId: task.chatId, reused: true });
    expect(editedProjection).not.toMatchObject({ suppressed: true });
    expect(await app.db.select().from(messages).where(eq(messages.chatId, task.chatId))).toHaveLength(6);

    const copiedMarkerWithNewInput = `${marker}\n\nNEEDS_HUMAN\n\nThe owner changed the decision.`;
    const newInput = await handleContextReviewerPrEvent(app, {
      eventType: "issue_comment",
      payload: managedIssueCommentPayload(copiedMarkerWithNewInput),
      organizationId: admin.organizationId,
    });
    expect(newInput).toMatchObject({ handled: true, chatId: task.chatId, reused: true });
    expect(newInput).not.toMatchObject({ suppressed: true });
    expect(await app.db.select().from(messages).where(eq(messages.chatId, task.chatId))).toHaveLength(7);
  });

  it("fails closed without partial webhook activity after requester removal", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);
    const requester = await createMember(app, admin, "writer");
    const reviewer = await createReviewer(app, admin);
    await configureReview(app, admin, reviewer.uuid);
    const created = await dispatch(app, admin, requester, dispatchPayload());
    const task = created.json<DispatchResponse>();
    const messagesBefore = await app.db.select().from(messages).where(eq(messages.chatId, task.chatId));
    const membershipBefore = await app.db.select().from(chatMembership).where(eq(chatMembership.chatId, task.chatId));
    await app.db.update(members).set({ status: "removed" }).where(eq(members.id, requester.memberId));
    await app.db.update(agents).set({ status: "suspended" }).where(eq(agents.uuid, requester.humanAgentUuid));

    await expect(
      handleContextReviewerPrEvent(app, {
        eventType: "pull_request",
        payload: managedPullRequestPayload({ action: "synchronize" }),
        organizationId: admin.organizationId,
      }),
    ).rejects.toThrow("active Team membership");
    expect(await app.db.select().from(messages).where(eq(messages.chatId, task.chatId))).toEqual(messagesBefore);
    expect(await app.db.select().from(chatMembership).where(eq(chatMembership.chatId, task.chatId))).toEqual(
      membershipBefore,
    );
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

  it("persists no first task when the requester leaves after route preflight", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);
    const requester = await createMember(app, admin, "writer");
    const reviewer = await createReviewer(app, admin);
    await configureReview(app, admin, reviewer.uuid);

    const chatsBefore = await app.db.select({ id: chats.id }).from(chats);
    const messagesBefore = await app.db.select({ id: messages.id }).from(messages);
    const inboxBefore = await app.db.select({ id: inboxEntries.id }).from(inboxEntries);
    const membershipBefore = await app.db.select({ chatId: chatMembership.chatId }).from(chatMembership);
    const blocker = postgres(process.env.DATABASE_URL ?? "", { max: 1 });
    const observer = postgres(process.env.DATABASE_URL ?? "", { max: 1 });
    let revocationCommitted = false;
    try {
      await blocker`BEGIN`;
      const [blockerSession] = await blocker<{ pid: number }[]>`SELECT pg_backend_pid()::integer AS pid`;
      if (!blockerSession) throw new Error("membership revocation session missing");
      await blocker`UPDATE members SET status = 'left' WHERE id = ${requester.memberId}`;
      await blocker`UPDATE agents SET status = 'suspended' WHERE uuid = ${requester.humanAgentUuid}`;

      // Ordinary route/preflight reads still see the last committed `active`
      // row. The keyed transaction then blocks on its member FOR UPDATE until
      // this revocation commits, after which its in-transaction tuple check
      // must reject instead of creating Chat/message/Inbox state.
      const pending = dispatch(app, admin, requester, dispatchPayload());
      await waitForBlockedRequesterMembershipLock(observer, blockerSession.pid);
      await blocker`COMMIT`;
      revocationCommitted = true;

      const response = await pending;
      expect(response.statusCode).toBe(403);
      expect(response.body).toContain("active Team membership");
      expect(await app.db.select({ id: chats.id }).from(chats)).toHaveLength(chatsBefore.length);
      expect(await app.db.select({ id: messages.id }).from(messages)).toHaveLength(messagesBefore.length);
      expect(await app.db.select({ id: inboxEntries.id }).from(inboxEntries)).toHaveLength(inboxBefore.length);
      expect(await app.db.select({ chatId: chatMembership.chatId }).from(chatMembership)).toHaveLength(
        membershipBefore.length,
      );
    } finally {
      if (!revocationCommitted) await blocker`ROLLBACK`;
      await observer.end();
      await blocker.end();
    }
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

  it("does not reconcile A to B when the requester is removed after route preflight", async () => {
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
    const messagesBefore = await app.db.select().from(messages).where(eq(messages.chatId, firstBody.chatId));
    const inboxBefore = await app.db.select().from(inboxEntries);
    const membershipBefore = await app.db
      .select()
      .from(chatMembership)
      .where(eq(chatMembership.chatId, firstBody.chatId));

    const blocker = postgres(process.env.DATABASE_URL ?? "", { max: 1 });
    const observer = postgres(process.env.DATABASE_URL ?? "", { max: 1 });
    let revocationCommitted = false;
    try {
      await blocker`BEGIN`;
      const [blockerSession] = await blocker<{ pid: number }[]>`SELECT pg_backend_pid()::integer AS pid`;
      if (!blockerSession) throw new Error("membership revocation session missing");
      await blocker`UPDATE members SET status = 'removed' WHERE id = ${requester.memberId}`;
      await blocker`UPDATE agents SET status = 'suspended' WHERE uuid = ${requester.humanAgentUuid}`;

      const pending = dispatch(app, admin, requester, dispatchPayload());
      await waitForBlockedRequesterMembershipLock(observer, blockerSession.pid);
      await blocker`COMMIT`;
      revocationCommitted = true;

      const response = await pending;
      expect(response.statusCode).toBe(403);
      expect(response.body).toContain("active Team membership");
      expect(await app.db.select().from(messages).where(eq(messages.chatId, firstBody.chatId))).toEqual(messagesBefore);
      expect(await app.db.select().from(inboxEntries)).toEqual(inboxBefore);
      expect(await app.db.select().from(chatMembership).where(eq(chatMembership.chatId, firstBody.chatId))).toEqual(
        membershipBefore,
      );
    } finally {
      if (!revocationCommitted) await blocker`ROLLBACK`;
      await observer.end();
      await blocker.end();
    }
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
