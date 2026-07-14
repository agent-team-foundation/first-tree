import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { authIdentities } from "../db/schema/auth-identities.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chats } from "../db/schema/chats.js";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { messages } from "../db/schema/messages.js";
import { createAgent } from "../services/agent.js";
import { createChat } from "../services/chat.js";
import {
  contextReviewerPrTestInternals,
  handleContextReviewerPrEvent,
  handleContextReviewerPullRequest,
  normalizeGithubRepo,
  renderContextReviewerPrPrompt,
} from "../services/context-reviewer-pr.js";
import { putOrgSetting } from "../services/org-settings.js";
import { createAdminContext, useTestApp } from "./helpers.js";

type App = ReturnType<ReturnType<typeof useTestApp>>;

function pullRequestPayload(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    action: "opened",
    pull_request: {
      number: 123,
      title: "Clarify agent routing context",
      html_url: "https://github.com/owner/context-tree/pull/123",
      base: { ref: "main" },
      head: { ref: "context-update" },
      draft: false,
      user: { login: "writer", type: "User" },
    },
    repository: { full_name: "owner/context-tree" },
    sender: { login: "writer", type: "User" },
    ...overrides,
  };
}

function issueCommentPayload(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    action: "created",
    issue: {
      number: 123,
      title: "Clarify agent routing context",
      html_url: "https://github.com/owner/context-tree/issues/123",
      user: { login: "writer", type: "User" },
      pull_request: { html_url: "https://github.com/owner/context-tree/pull/123" },
    },
    comment: {
      html_url: "https://github.com/owner/context-tree/pull/123#issuecomment-1",
      user: { login: "commenter" },
      body: "Please re-check this context.",
    },
    repository: { full_name: "owner/context-tree" },
    sender: { login: "commenter", type: "User" },
    ...overrides,
  };
}

function reviewCommentPayload(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    action: "created",
    pull_request: {
      number: 123,
      title: "Clarify agent routing context",
      html_url: "https://github.com/owner/context-tree/pull/123",
      base: { ref: "main" },
      head: { ref: "context-update" },
      user: { login: "writer", type: "User" },
    },
    comment: {
      html_url: "https://github.com/owner/context-tree/pull/123#discussion_r1",
      user: { login: "reviewer-user" },
      body: "This line needs another look.",
    },
    repository: { full_name: "owner/context-tree" },
    sender: { login: "reviewer-user", type: "User" },
    ...overrides,
  };
}

async function createReviewer(
  app: App,
  admin: Awaited<ReturnType<typeof createAdminContext>>,
  options: { name?: string } = {},
) {
  return createAgent(app.db, {
    name: options.name ?? `reviewer-${randomUUID().slice(0, 8)}`,
    type: "agent",
    displayName: "Context Reviewer",
    managerId: admin.memberId,
    clientId: admin.clientId,
  });
}

async function enableReviewer(app: App, admin: Awaited<ReturnType<typeof createAdminContext>>, reviewerUuid: string) {
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
    { contextReviewer: { enabled: true, agentUuid: reviewerUuid } },
    { updatedBy: admin.userId, memberId: admin.memberId },
  );
}

async function seedGithubIdentity(app: App, userId: string, login: string) {
  await app.db.insert(authIdentities).values({
    id: randomUUID(),
    userId,
    provider: "github",
    identifier: randomUUID(),
    email: null,
    verifiedAt: new Date(),
    metadata: { login },
  });
}

describe("Context Reviewer PR prompt", () => {
  it("renders event facts and delegates the workflow to context-tree-review", async () => {
    const prompt = await renderContextReviewerPrPrompt({
      repoFullName: "owner/context-tree",
      prNumber: 123,
      title: "Clarify context",
      htmlUrl: "https://github.com/owner/context-tree/pull/123",
      baseRef: "main",
      headRef: "context-update",
      authorLogin: "writer",
      senderLogin: "writer",
      triggerEvent: "pull_request.opened",
      isDraft: false,
      commentUrl: null,
      commentAuthorLogin: null,
      organizationId: "org-1",
      reviewerManagerGithubLogin: "reviewer-manager",
      reviewerManagerIsPrAuthor: false,
    });

    expect(prompt).toContain("Context Tree pull request event");
    expect(prompt).toContain("Load the installed `context-tree-review` skill");
    expect(prompt).toContain("strictly execute that skill");
    expect(prompt).toContain("Repository: owner/context-tree");
    expect(prompt).toContain("Pull request: #123");
    expect(prompt).toContain("PR author: writer");
    expect(prompt).toContain("Event sender: writer");
    expect(prompt).toContain("Reviewer manager GitHub login: reviewer-manager");
    expect(prompt).toContain("Known self-approval blocker: not known from First Tree metadata");
    expect(prompt).toContain("Draft status from webhook: ready for review");
    expect(prompt).not.toContain("Review goals:");
    expect(prompt).not.toContain("Required workflow:");
    expect(prompt).not.toContain("gh pr review");
    expect(prompt).not.toContain("gh api user");
    expect(prompt).not.toContain("Context changes requested");
  });

  it("renders when optional refs are missing", async () => {
    const prompt = await renderContextReviewerPrPrompt({
      repoFullName: "owner/context-tree",
      prNumber: 124,
      title: "No refs",
      htmlUrl: "https://github.com/owner/context-tree/pull/124",
      baseRef: null,
      headRef: null,
      authorLogin: "writer",
      senderLogin: "writer",
      triggerEvent: "pull_request.synchronize",
      isDraft: null,
      commentUrl: null,
      commentAuthorLogin: null,
      organizationId: "org-1",
      reviewerManagerGithubLogin: null,
      reviewerManagerIsPrAuthor: false,
    });

    expect(prompt).toContain("Base ref: unknown");
    expect(prompt).toContain("Head ref: unknown");
    expect(prompt).toContain("Trigger event: pull_request.synchronize");
    expect(prompt).toContain("Draft status from webhook: unknown");
    expect(prompt).toContain("Load the installed `context-tree-review` skill");
  });

  it("renders draft-specific non-approval instructions", async () => {
    const prompt = await renderContextReviewerPrPrompt({
      repoFullName: "owner/context-tree",
      prNumber: 126,
      title: "Draft context",
      htmlUrl: "https://github.com/owner/context-tree/pull/126",
      baseRef: "main",
      headRef: "draft-context",
      authorLogin: "writer",
      senderLogin: "writer",
      triggerEvent: "pull_request.opened",
      isDraft: true,
      commentUrl: null,
      commentAuthorLogin: null,
      organizationId: "org-1",
      reviewerManagerGithubLogin: null,
      reviewerManagerIsPrAuthor: false,
    });

    expect(prompt).toContain("Draft status from webhook: draft");
    expect(prompt).not.toContain("If the pull request is still a draft");
    expect(prompt).not.toContain("approval is deferred until the PR is ready for review");
  });

  it("renders comment trigger context when present", async () => {
    const prompt = await renderContextReviewerPrPrompt({
      repoFullName: "owner/context-tree",
      prNumber: 125,
      title: "Comment trigger",
      htmlUrl: "https://github.com/owner/context-tree/pull/125",
      baseRef: null,
      headRef: null,
      authorLogin: "writer",
      senderLogin: "writer",
      triggerEvent: "issue_comment.created",
      isDraft: null,
      commentUrl: "https://github.com/owner/context-tree/pull/125#issuecomment-1",
      commentAuthorLogin: "commenter",
      organizationId: "org-1",
      reviewerManagerGithubLogin: null,
      reviewerManagerIsPrAuthor: false,
    });

    expect(prompt).toContain("Trigger event: issue_comment.created");
    expect(prompt).toContain("Comment author: commenter");
    expect(prompt).toContain("Comment URL: https://github.com/owner/context-tree/pull/125#issuecomment-1");
  });

  it("renders a known self-approval event fact without duplicating the outcome workflow", async () => {
    const prompt = await renderContextReviewerPrPrompt({
      repoFullName: "owner/context-tree",
      prNumber: 127,
      title: "Self-authored context",
      htmlUrl: "https://github.com/owner/context-tree/pull/127",
      baseRef: "main",
      headRef: "self-authored-context",
      authorLogin: "writer",
      senderLogin: "writer",
      triggerEvent: "pull_request.opened",
      isDraft: false,
      commentUrl: null,
      commentAuthorLogin: null,
      organizationId: "org-1",
      reviewerManagerGithubLogin: "Writer",
      reviewerManagerIsPrAuthor: true,
    });

    expect(prompt).toContain("Known self-approval blocker: yes");
    expect(prompt).not.toContain("Independent approval required");
    expect(prompt).not.toContain("gh pr review");
  });
});

describe("normalizeGithubRepo", () => {
  it.each([
    ["https://github.com/Owner/Repo.git", "owner/repo"],
    ["https://github.com/Owner/Repo.git///", "owner/repo"],
    ["ssh://git@github.com/Owner/Repo.git", "owner/repo"],
    ["git@github.com:Owner/Repo.git", "owner/repo"],
    ["git@github.com:Owner/Repo.git///", "owner/repo"],
    ["Owner/Repo.git", "owner/repo"],
    ["Owner/Repo.git///", "owner/repo"],
    ["owner/repo", "owner/repo"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeGithubRepo(input)).toBe(expected);
  });

  it("normalizes slash-heavy repo values in linear time", () => {
    expect(normalizeGithubRepo(`https://github.com/Owner/Repo.git${"/".repeat(10_000)}`)).toBe("owner/repo");
  });

  it("rejects non-GitHub URLs and malformed values", () => {
    expect(normalizeGithubRepo("https://gitlab.com/owner/repo")).toBeNull();
    expect(normalizeGithubRepo("/owner/repo")).toBeNull();
    expect(normalizeGithubRepo("owner/repo/extra")).toBeNull();
    expect(normalizeGithubRepo("not-a-repo")).toBeNull();
  });

  it("covers parser guard branches for malformed owner and path segments", () => {
    const { parseBareRepo, parseScpLikeRepo, parseUrlRepo } = contextReviewerPrTestInternals;

    expect(parseBareRepo("owner//")).toBeNull();
    expect(parseBareRepo("//repo")).toBeNull();
    expect(parseBareRepo("owner/repo/extra")).toBeNull();

    expect(parseScpLikeRepo("git@gitlab.com:Owner/Repo")).toBeNull();
    expect(parseScpLikeRepo("git@github.com:")).toBeNull();
    expect(parseScpLikeRepo("git@github.com:Owner")).toBeNull();
    expect(parseScpLikeRepo("git@github.com:Owner//")).toBeNull();

    expect(parseUrlRepo("ftp://github.com/owner/repo")).toBeNull();
    expect(parseUrlRepo("https://github.com/owner")).toBeNull();
    expect(parseUrlRepo("https://github.com/owner//")).toBeNull();
  });
});

describe("handleContextReviewerPrEvent", () => {
  const getApp = useTestApp();

  it("skips when webhook repo is not the bound context repo", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);
    const reviewer = await createReviewer(app, admin);
    await enableReviewer(app, admin, reviewer.uuid);

    const result = await handleContextReviewerPrEvent(app, {
      eventType: "pull_request",
      payload: pullRequestPayload({ repository: { full_name: "owner/code" } }),
      organizationId: admin.organizationId,
    });

    expect(result).toEqual({ handled: false, reason: "repo_mismatch" });
    const rows = await app.db.select({ id: chats.id }).from(chats);
    expect(rows).toHaveLength(0);
  });

  it("skips when the feature is disabled, context repo is missing, reviewer is missing, or action is unsupported", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);
    const reviewer = await createReviewer(app, admin);

    await putOrgSetting(
      app.db,
      admin.organizationId,
      "context_tree",
      { repo: "https://github.com/owner/context-tree" },
      { updatedBy: admin.userId },
    );
    await expect(
      handleContextReviewerPullRequest(app, {
        eventType: "pull_request",
        payload: pullRequestPayload(),
        organizationId: admin.organizationId,
      }),
    ).resolves.toEqual({ handled: false, reason: "feature_disabled" });

    await putOrgSetting(
      app.db,
      admin.organizationId,
      "context_tree_features",
      { contextReviewer: { enabled: true, agentUuid: reviewer.uuid } },
      { updatedBy: admin.userId, memberId: admin.memberId },
    );
    await app.db.update(agents).set({ status: "suspended" }).where(eq(agents.uuid, reviewer.uuid));
    await expect(
      handleContextReviewerPullRequest(app, {
        eventType: "pull_request",
        payload: pullRequestPayload(),
        organizationId: admin.organizationId,
      }),
    ).resolves.toEqual({ handled: false, reason: "reviewer_agent_invalid" });

    await expect(
      handleContextReviewerPrEvent(app, {
        eventType: "pull_request",
        payload: pullRequestPayload({ action: "labeled" }),
        organizationId: admin.organizationId,
      }),
    ).resolves.toEqual({ handled: false, reason: "unsupported_event" });
  });

  it("skips before DB work when the payload is not an object", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);

    await expect(
      handleContextReviewerPrEvent(app, {
        eventType: "pull_request",
        payload: null,
        organizationId: admin.organizationId,
      }),
    ).resolves.toEqual({ handled: false, reason: "unsupported_event" });
  });

  it("skips when the context tree repo is missing", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);

    await expect(
      handleContextReviewerPrEvent(app, {
        eventType: "pull_request",
        payload: pullRequestPayload(),
        organizationId: admin.organizationId,
      }),
    ).resolves.toEqual({ handled: false, reason: "context_tree_repo_unset" });
  });

  it("creates a reviewer chat, membership, task message, and inbox notification for an opened context repo PR", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);
    const reviewer = await createReviewer(app, admin);
    await enableReviewer(app, admin, reviewer.uuid);

    const result = await handleContextReviewerPrEvent(app, {
      eventType: "pull_request",
      payload: pullRequestPayload(),
      organizationId: admin.organizationId,
    });

    expect(result).toMatchObject({ handled: true, reused: false });
    if (!result.handled) throw new Error("expected handled result");

    const [chat] = await app.db.select().from(chats).where(eq(chats.id, result.chatId)).limit(1);
    expect(chat?.metadata).toMatchObject({
      source: "github",
      entityType: "pull_request",
      entityKey: "owner/context-tree#123",
      contextTreeReviewer: true,
      reviewerAgentUuid: reviewer.uuid,
    });

    const memberships = await app.db
      .select({ agentId: chatMembership.agentId, accessMode: chatMembership.accessMode })
      .from(chatMembership)
      .where(eq(chatMembership.chatId, result.chatId));
    expect(memberships).toEqual(
      expect.arrayContaining([
        { agentId: admin.humanAgentUuid, accessMode: "speaker" },
        { agentId: reviewer.uuid, accessMode: "speaker" },
      ]),
    );

    const [message] = await app.db.select().from(messages).where(eq(messages.id, result.messageId)).limit(1);
    expect(message?.content).toContain("Load the installed `context-tree-review` skill");
    expect(message?.content).not.toContain("gh pr review");
    expect(message?.content).not.toContain("Context changes requested");
    expect(message?.content).toContain("Trigger event: pull_request.opened");
    expect(message?.content).toContain("Draft status from webhook: ready for review");
    expect(message?.content).toContain("PR author: writer");
    expect(message?.metadata).toMatchObject({
      contextTreeReviewer: true,
      pullRequestDraft: false,
      pullRequestAuthorLogin: "writer",
      mentions: [reviewer.uuid],
    });

    const [entry] = await app.db
      .select({ notify: inboxEntries.notify })
      .from(inboxEntries)
      .where(and(eq(inboxEntries.messageId, result.messageId), eq(inboxEntries.inboxId, reviewer.inboxId)))
      .limit(1);
    expect(entry?.notify).toBe(true);
  });

  it("marks approval as blocked when the reviewer manager GitHub login is the PR author", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);
    await seedGithubIdentity(app, admin.userId, "Writer");
    const reviewer = await createReviewer(app, admin);
    await enableReviewer(app, admin, reviewer.uuid);

    const result = await handleContextReviewerPrEvent(app, {
      eventType: "pull_request",
      payload: pullRequestPayload(),
      organizationId: admin.organizationId,
    });

    expect(result).toMatchObject({ handled: true, reused: false });
    if (!result.handled) throw new Error("expected handled result");

    const [message] = await app.db.select().from(messages).where(eq(messages.id, result.messageId)).limit(1);
    expect(message?.content).toContain("Reviewer manager GitHub login: Writer");
    expect(message?.content).toContain("Known self-approval blocker: yes");
    expect(message?.content).not.toContain("Independent approval required");
    expect(message?.metadata).toMatchObject({
      contextTreeReviewer: true,
      pullRequestAuthorLogin: "writer",
      reviewerManagerGithubLogin: "Writer",
      reviewerManagerIsPrAuthor: true,
    });
  });

  it("reuses an existing reviewer chat for the same PR", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);
    const reviewer = await createReviewer(app, admin);
    await enableReviewer(app, admin, reviewer.uuid);

    const first = await handleContextReviewerPrEvent(app, {
      eventType: "pull_request",
      payload: pullRequestPayload(),
      organizationId: admin.organizationId,
    });
    const second = await handleContextReviewerPrEvent(app, {
      eventType: "pull_request",
      payload: pullRequestPayload(),
      organizationId: admin.organizationId,
    });

    if (!first.handled || !second.handled) throw new Error("expected handled results");
    expect(second.chatId).toBe(first.chatId);
    expect(second).toMatchObject({ handled: true, reused: true });

    const messageRows = await app.db.select({ id: messages.id }).from(messages);
    expect(messageRows).toHaveLength(2);
    const [followUp] = await app.db.select().from(messages).where(eq(messages.id, second.messageId)).limit(1);
    expect(followUp?.content).toContain("Trigger event: pull_request.opened");
    expect(followUp?.content).toContain("Load the installed `context-tree-review` skill");
    expect(followUp?.content).not.toContain("gh pr review");
    const chatRows = await app.db.select({ id: chats.id }).from(chats);
    expect(chatRows).toHaveLength(1);
  });

  it("reuses the reviewer chat for pull_request.synchronize and notifies the reviewer", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);
    const reviewer = await createReviewer(app, admin);
    await enableReviewer(app, admin, reviewer.uuid);

    const first = await handleContextReviewerPrEvent(app, {
      eventType: "pull_request",
      payload: pullRequestPayload(),
      organizationId: admin.organizationId,
    });
    if (!first.handled) throw new Error("expected first event handled");

    const second = await handleContextReviewerPrEvent(app, {
      eventType: "pull_request",
      payload: pullRequestPayload({ action: "synchronize" }),
      organizationId: admin.organizationId,
    });

    expect(second).toMatchObject({ handled: true, reused: true, chatId: first.chatId });
    if (!second.handled) throw new Error("expected second event handled");

    const messageRows = await app.db.select().from(messages).where(eq(messages.chatId, first.chatId));
    expect(messageRows).toHaveLength(2);
    const followUp = messageRows.find((row) => row.id === second.messageId);
    expect(followUp?.source).toBe("github");
    expect(followUp?.format).toBe("markdown");
    expect(followUp?.content).toContain("Trigger event: pull_request.synchronize");
    expect(followUp?.content).toContain("Load the installed `context-tree-review` skill");
    expect(followUp?.content).not.toContain("gh pr review");
    expect(followUp?.metadata).toMatchObject({
      source: "github",
      event: "pull_request",
      action: "synchronize",
      triggerEvent: "pull_request.synchronize",
      entityKey: "owner/context-tree#123",
      contextTreeReviewer: true,
      pullRequestDraft: false,
      mentions: [reviewer.uuid],
    });

    const [entry] = await app.db
      .select({ notify: inboxEntries.notify })
      .from(inboxEntries)
      .where(and(eq(inboxEntries.messageId, second.messageId), eq(inboxEntries.inboxId, reviewer.inboxId)))
      .limit(1);
    expect(entry?.notify).toBe(true);
  });

  it("reuses the reviewer chat for pull_request.ready_for_review and requests a fresh review", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);
    const reviewer = await createReviewer(app, admin);
    await enableReviewer(app, admin, reviewer.uuid);

    const first = await handleContextReviewerPrEvent(app, {
      eventType: "pull_request",
      payload: pullRequestPayload({ pull_request: { ...pullRequestPayload().pull_request, draft: true } }),
      organizationId: admin.organizationId,
    });
    if (!first.handled) throw new Error("expected first event handled");

    const second = await handleContextReviewerPrEvent(app, {
      eventType: "pull_request",
      payload: pullRequestPayload({ action: "ready_for_review" }),
      organizationId: admin.organizationId,
    });

    expect(second).toMatchObject({ handled: true, reused: true, chatId: first.chatId });
    if (!second.handled) throw new Error("expected second event handled");

    const [followUp] = await app.db.select().from(messages).where(eq(messages.id, second.messageId)).limit(1);
    expect(followUp?.content).toContain("Trigger event: pull_request.ready_for_review");
    expect(followUp?.content).toContain("Draft status from webhook: ready for review");
    expect(followUp?.content).toContain("Load the installed `context-tree-review` skill");
    expect(followUp?.content).not.toContain("gh pr review");
    expect(followUp?.metadata).toMatchObject({
      source: "github",
      event: "pull_request",
      action: "ready_for_review",
      triggerEvent: "pull_request.ready_for_review",
      entityKey: "owner/context-tree#123",
      contextTreeReviewer: true,
      pullRequestDraft: false,
      mentions: [reviewer.uuid],
    });
  });

  it("reuses the reviewer chat for PR issue_comment.created and notifies the reviewer", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);
    const reviewer = await createReviewer(app, admin);
    await enableReviewer(app, admin, reviewer.uuid);

    const first = await handleContextReviewerPrEvent(app, {
      eventType: "pull_request",
      payload: pullRequestPayload(),
      organizationId: admin.organizationId,
    });
    if (!first.handled) throw new Error("expected first event handled");

    const second = await handleContextReviewerPrEvent(app, {
      eventType: "issue_comment",
      payload: issueCommentPayload(),
      organizationId: admin.organizationId,
    });

    expect(second).toMatchObject({ handled: true, reused: true, chatId: first.chatId });
    if (!second.handled) throw new Error("expected second event handled");

    const [followUp] = await app.db.select().from(messages).where(eq(messages.id, second.messageId)).limit(1);
    expect(followUp?.content).toContain("Trigger event: issue_comment.created");
    expect(followUp?.content).toContain("Comment author: commenter");
    expect(followUp?.content).toContain("Comment URL: https://github.com/owner/context-tree/pull/123#issuecomment-1");
    expect(followUp?.content).toContain("Load the installed `context-tree-review` skill");
    expect(followUp?.metadata).toMatchObject({
      source: "github",
      event: "issue_comment",
      action: "created",
      triggerEvent: "issue_comment.created",
      entityKey: "owner/context-tree#123",
      contextTreeReviewer: true,
      commentAuthorLogin: "commenter",
      commentUrl: "https://github.com/owner/context-tree/pull/123#issuecomment-1",
      mentions: [reviewer.uuid],
    });

    const [entry] = await app.db
      .select({ notify: inboxEntries.notify })
      .from(inboxEntries)
      .where(and(eq(inboxEntries.messageId, second.messageId), eq(inboxEntries.inboxId, reviewer.inboxId)))
      .limit(1);
    expect(entry?.notify).toBe(true);
  });

  it("reuses the reviewer chat for pull_request_review_comment.created and notifies the reviewer", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);
    const reviewer = await createReviewer(app, admin);
    await enableReviewer(app, admin, reviewer.uuid);

    const first = await handleContextReviewerPrEvent(app, {
      eventType: "pull_request",
      payload: pullRequestPayload(),
      organizationId: admin.organizationId,
    });
    if (!first.handled) throw new Error("expected first event handled");

    const second = await handleContextReviewerPrEvent(app, {
      eventType: "pull_request_review_comment",
      payload: reviewCommentPayload(),
      organizationId: admin.organizationId,
    });

    expect(second).toMatchObject({ handled: true, reused: true, chatId: first.chatId });
    if (!second.handled) throw new Error("expected second event handled");

    const [followUp] = await app.db.select().from(messages).where(eq(messages.id, second.messageId)).limit(1);
    expect(followUp?.content).toContain("Trigger event: pull_request_review_comment.created");
    expect(followUp?.content).toContain("Comment author: reviewer-user");
    expect(followUp?.content).toContain("Comment URL: https://github.com/owner/context-tree/pull/123#discussion_r1");
    expect(followUp?.content).toContain("Load the installed `context-tree-review` skill");
    expect(followUp?.metadata).toMatchObject({
      source: "github",
      event: "pull_request_review_comment",
      action: "created",
      triggerEvent: "pull_request_review_comment.created",
      entityKey: "owner/context-tree#123",
      contextTreeReviewer: true,
      commentAuthorLogin: "reviewer-user",
      commentUrl: "https://github.com/owner/context-tree/pull/123#discussion_r1",
      mentions: [reviewer.uuid],
    });

    const [entry] = await app.db
      .select({ notify: inboxEntries.notify })
      .from(inboxEntries)
      .where(and(eq(inboxEntries.messageId, second.messageId), eq(inboxEntries.inboxId, reviewer.inboxId)))
      .limit(1);
    expect(entry?.notify).toBe(true);
  });

  it("creates a follow-up for a manager-authored PR comment after the initial opened task", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);
    const reviewer = await createReviewer(app, admin, { name: `context-reviewer-${randomUUID().slice(0, 8)}` });
    await enableReviewer(app, admin, reviewer.uuid);

    const first = await handleContextReviewerPrEvent(app, {
      eventType: "pull_request",
      payload: pullRequestPayload(),
      organizationId: admin.organizationId,
    });
    if (!first.handled) throw new Error("expected first event handled");

    const second = await handleContextReviewerPrEvent(app, {
      eventType: "issue_comment",
      payload: issueCommentPayload({
        comment: {
          html_url: "https://github.com/owner/context-tree/pull/123#issuecomment-2",
          user: { login: "MANAGER-LOGIN", type: "User" },
          body: "Context Reviewer found no blocking gaps.",
        },
        sender: { login: "MANAGER-LOGIN", type: "User" },
      }),
      organizationId: admin.organizationId,
    });

    expect(second).toMatchObject({ handled: true, reused: true, chatId: first.chatId });
    if (!second.handled) throw new Error("expected second event handled");
    expect(second).not.toMatchObject({ suppressed: true });
    expect(second.messageId).not.toBe(first.messageId);

    const messageRows = await app.db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.chatId, first.chatId));
    expect(messageRows).toHaveLength(2);
    const [followUp] = await app.db.select().from(messages).where(eq(messages.id, second.messageId)).limit(1);
    expect(followUp?.content).toContain("Trigger event: issue_comment.created");
    expect(followUp?.content).toContain("Comment author: MANAGER-LOGIN");
    expect(followUp?.content).toContain("Comment URL: https://github.com/owner/context-tree/pull/123#issuecomment-2");
    expect(followUp?.content).toContain("Load the installed `context-tree-review` skill");
    expect(followUp?.metadata).toMatchObject({
      source: "github",
      event: "issue_comment",
      action: "created",
      triggerEvent: "issue_comment.created",
      entityKey: "owner/context-tree#123",
      contextTreeReviewer: true,
      commentAuthorLogin: "MANAGER-LOGIN",
      commentUrl: "https://github.com/owner/context-tree/pull/123#issuecomment-2",
      mentions: [reviewer.uuid],
    });
  });

  it("suppresses the configured GitHub App bot PR comment echo after the initial opened task", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);
    const reviewer = await createReviewer(app, admin);
    await enableReviewer(app, admin, reviewer.uuid);

    const first = await handleContextReviewerPrEvent(app, {
      eventType: "pull_request",
      payload: pullRequestPayload(),
      organizationId: admin.organizationId,
    });
    if (!first.handled) throw new Error("expected first event handled");

    const second = await handleContextReviewerPrEvent(app, {
      eventType: "issue_comment",
      payload: issueCommentPayload({
        comment: {
          html_url: "https://github.com/owner/context-tree/pull/123#issuecomment-4",
          user: { login: "TEST-APP-SLUG[bot]", type: "Bot" },
          body: "Posted by the First Tree GitHub App.",
        },
        sender: { login: "TEST-APP-SLUG[bot]", type: "Bot" },
      }),
      organizationId: admin.organizationId,
    });

    expect(second).toMatchObject({ handled: true, reused: true, suppressed: true, chatId: first.chatId });
    if (!second.handled) throw new Error("expected second event handled");
    expect(second.messageId).toBe(first.messageId);

    const messageRows = await app.db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.chatId, first.chatId));
    expect(messageRows).toHaveLength(1);
    const inboxRows = await app.db
      .select({ messageId: inboxEntries.messageId, notify: inboxEntries.notify })
      .from(inboxEntries)
      .where(eq(inboxEntries.inboxId, reviewer.inboxId));
    expect(inboxRows).toEqual([{ messageId: first.messageId, notify: true }]);
  });

  it("does not suppress when only the reviewer agent name matches an unrelated human GitHub login", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);
    const reviewer = await createReviewer(app, admin, { name: "unrelated-human" });
    await enableReviewer(app, admin, reviewer.uuid);

    const first = await handleContextReviewerPrEvent(app, {
      eventType: "pull_request",
      payload: pullRequestPayload(),
      organizationId: admin.organizationId,
    });
    if (!first.handled) throw new Error("expected first event handled");

    const second = await handleContextReviewerPrEvent(app, {
      eventType: "issue_comment",
      payload: issueCommentPayload({
        comment: {
          html_url: "https://github.com/owner/context-tree/pull/123#issuecomment-3",
          user: { login: "unrelated-human", type: "User" },
          body: "This is not the manager.",
        },
        sender: { login: "unrelated-human", type: "User" },
      }),
      organizationId: admin.organizationId,
    });

    expect(second).toMatchObject({ handled: true, reused: true, chatId: first.chatId });
    if (!second.handled) throw new Error("expected second event handled");
    expect(second).not.toMatchObject({ suppressed: true });

    const messageRows = await app.db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.chatId, first.chatId));
    expect(messageRows).toHaveLength(2);
    const [followUp] = await app.db.select().from(messages).where(eq(messages.id, second.messageId)).limit(1);
    expect(followUp?.content).toContain("Trigger event: issue_comment.created");
    expect(followUp?.content).toContain("Comment author: unrelated-human");
    expect(followUp?.content).toContain("Comment URL: https://github.com/owner/context-tree/pull/123#issuecomment-3");
    expect(followUp?.content).toContain("Load the installed `context-tree-review` skill");
  });

  it("skips non-PR issue_comment.created without creating a reviewer chat", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);
    const reviewer = await createReviewer(app, admin);
    await enableReviewer(app, admin, reviewer.uuid);

    const result = await handleContextReviewerPrEvent(app, {
      eventType: "issue_comment",
      payload: issueCommentPayload({
        issue: {
          number: 123,
          title: "Plain issue",
          html_url: "https://github.com/owner/context-tree/issues/123",
        },
      }),
      organizationId: admin.organizationId,
    });

    expect(result).toEqual({ handled: false, reason: "malformed_payload" });
    const chatRows = await app.db.select({ id: chats.id }).from(chats);
    expect(chatRows).toHaveLength(0);
  });

  it("extracts pull request info defensively", () => {
    expect(
      contextReviewerPrTestInternals.extractPullRequestPayloadInfo("pull_request", pullRequestPayload(), "org-1"),
    ).toMatchObject({
      repoFullName: "owner/context-tree",
      entityKey: "owner/context-tree#123",
      baseRef: "main",
      headRef: "context-update",
      triggerEvent: "pull_request.opened",
      isDraft: false,
      authorLogin: "writer",
    });
    expect(
      contextReviewerPrTestInternals.extractPullRequestPayloadInfo(
        "pull_request",
        pullRequestPayload({ pull_request: { number: 123 } }),
        "org-1",
      ),
    ).toBeNull();
    expect(
      contextReviewerPrTestInternals.extractPullRequestPayloadInfo("issue_comment", issueCommentPayload(), "org-1"),
    ).toMatchObject({
      repoFullName: "owner/context-tree",
      entityKey: "owner/context-tree#123",
      baseRef: null,
      headRef: null,
      commentUrl: "https://github.com/owner/context-tree/pull/123#issuecomment-1",
      commentAuthorLogin: "commenter",
      triggerEvent: "issue_comment.created",
      isDraft: null,
      authorLogin: "writer",
    });
    expect(
      contextReviewerPrTestInternals.extractPullRequestPayloadInfo(
        "pull_request",
        pullRequestPayload({ action: "ready_for_review" }),
        "org-1",
      ),
    ).toMatchObject({
      triggerEvent: "pull_request.ready_for_review",
      isDraft: false,
    });
  });

  it("rejects malformed payload shapes defensively", () => {
    const { extractPullRequestPayloadInfo } = contextReviewerPrTestInternals;

    expect(extractPullRequestPayloadInfo("pull_request", null, "org-1")).toBeNull();
    expect(extractPullRequestPayloadInfo("pull_request", pullRequestPayload({ action: "closed" }), "org-1")).toBeNull();
    expect(
      extractPullRequestPayloadInfo("pull_request", pullRequestPayload({ repository: null, sender: null }), "org-1"),
    ).toBeNull();
    expect(
      extractPullRequestPayloadInfo(
        "pull_request",
        pullRequestPayload({ repository: { full_name: "not-a-repo" }, pull_request: null }),
        "org-1",
      ),
    ).toBeNull();
    expect(
      extractPullRequestPayloadInfo("issue_comment", issueCommentPayload({ issue: null, comment: null }), "org-1"),
    ).toBeNull();
    expect(
      extractPullRequestPayloadInfo(
        "pull_request_review_comment",
        reviewCommentPayload({ pull_request: { number: 123 }, comment: null }),
        "org-1",
      ),
    ).toBeNull();
  });

  it("extracts review comment payload fallbacks", () => {
    expect(
      contextReviewerPrTestInternals.extractPullRequestPayloadInfo(
        "pull_request_review_comment",
        reviewCommentPayload({
          action: "edited",
          pull_request: {
            number: 123,
            title: "Clarify agent routing context",
            html_url: "https://github.com/owner/context-tree/pull/123",
            base: null,
            head: null,
            draft: "unknown",
          },
          comment: {},
        }),
        "org-1",
      ),
    ).toMatchObject({
      triggerEvent: "pull_request_review_comment.edited",
      baseRef: null,
      headRef: null,
      isDraft: null,
      commentUrl: null,
      commentAuthorLogin: "reviewer-user",
      commentAuthorType: "User",
    });
  });

  it("returns null when an app-bot echo has no recent opened task to suppress", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);
    const reviewer = await createReviewer(app, admin);
    const created = await createChat(app.db, {
      mode: "task",
      initiatorAgentId: admin.humanAgentUuid,
      organizationId: admin.organizationId,
      initialRecipientAgentIds: [reviewer.uuid],
      contextParticipantAgentIds: [],
      topic: "Context review",
      initialMessage: {
        source: "api",
        format: "markdown",
        content: "seed",
        metadata: {},
      },
      source: "manual",
    });
    const info = contextReviewerPrTestInternals.extractPullRequestPayloadInfo(
      "issue_comment",
      issueCommentPayload({
        comment: {
          html_url: "https://github.com/owner/context-tree/pull/123#issuecomment-9",
          user: { login: "test-app[bot]", type: "Bot" },
        },
        sender: { login: "test-app[bot]", type: "Bot" },
      }),
      admin.organizationId,
    );
    if (!info) throw new Error("expected issue comment payload info");

    await expect(
      contextReviewerPrTestInternals.findSuppressibleReviewerEchoMessageId(app.db, {
        chatId: created.chat.id,
        info,
        reviewer: {
          uuid: reviewer.uuid,
          managerHumanAgentId: admin.humanAgentUuid,
          managerGithubLogin: null,
        },
        appSlug: null,
      }),
    ).resolves.toBeNull();
    await expect(
      contextReviewerPrTestInternals.findSuppressibleReviewerEchoMessageId(app.db, {
        chatId: created.chat.id,
        info,
        reviewer: {
          uuid: reviewer.uuid,
          managerHumanAgentId: admin.humanAgentUuid,
          managerGithubLogin: null,
        },
        appSlug: "test-app",
      }),
    ).resolves.toBeNull();
  });
});
