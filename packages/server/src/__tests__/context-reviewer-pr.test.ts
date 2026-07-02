import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chats } from "../db/schema/chats.js";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { messages } from "../db/schema/messages.js";
import { createAgent } from "../services/agent.js";
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

const FOLLOW_UP_NOTICE = "A new GitHub event was received. I'll check the current PR state.";

function pullRequestPayload(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    action: "opened",
    pull_request: {
      number: 123,
      title: "Clarify agent routing context",
      html_url: "https://github.com/owner/context-tree/pull/123",
      base: { ref: "main" },
      head: { ref: "context-update" },
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

describe("Context Reviewer PR prompt", () => {
  it("renders the EJS prompt with required review instructions", async () => {
    const prompt = await renderContextReviewerPrPrompt({
      repoFullName: "owner/context-tree",
      prNumber: 123,
      title: "Clarify context",
      htmlUrl: "https://github.com/owner/context-tree/pull/123",
      baseRef: "main",
      headRef: "context-update",
      senderLogin: "writer",
      triggerEvent: "pull_request.opened",
      commentUrl: null,
      commentAuthorLogin: null,
      organizationId: "org-1",
    });

    expect(prompt).toContain("Context Reviewer");
    expect(prompt).toContain("clear, accurate");
    expect(prompt).toContain("missing background");
    expect(prompt).toContain("excessive detail");
    expect(prompt).toContain("gh pr review 123 --repo owner/context-tree --comment --body");
    expect(prompt).toContain("gh pr review 123 --repo owner/context-tree --approve --body");
    expect(prompt).toContain("review action was submitted: `approved`, `commented`, or `failed`");
  });

  it("renders when optional refs are missing", async () => {
    const prompt = await renderContextReviewerPrPrompt({
      repoFullName: "owner/context-tree",
      prNumber: 124,
      title: "No refs",
      htmlUrl: "https://github.com/owner/context-tree/pull/124",
      baseRef: null,
      headRef: null,
      senderLogin: "writer",
      triggerEvent: "pull_request.synchronize",
      commentUrl: null,
      commentAuthorLogin: null,
      organizationId: "org-1",
    });

    expect(prompt).toContain("Base ref: unknown");
    expect(prompt).toContain("Head ref: unknown");
    expect(prompt).toContain("Trigger event: pull_request.synchronize");
    expect(prompt).toContain("gh pr review 124 --repo owner/context-tree --comment --body");
    expect(prompt).toContain("gh pr review 124 --repo owner/context-tree --approve --body");
  });

  it("renders comment trigger context when present", async () => {
    const prompt = await renderContextReviewerPrPrompt({
      repoFullName: "owner/context-tree",
      prNumber: 125,
      title: "Comment trigger",
      htmlUrl: "https://github.com/owner/context-tree/pull/125",
      baseRef: null,
      headRef: null,
      senderLogin: "writer",
      triggerEvent: "issue_comment.created",
      commentUrl: "https://github.com/owner/context-tree/pull/125#issuecomment-1",
      commentAuthorLogin: "commenter",
      organizationId: "org-1",
    });

    expect(prompt).toContain("Trigger event: issue_comment.created");
    expect(prompt).toContain("Comment author: commenter");
    expect(prompt).toContain("Comment URL: https://github.com/owner/context-tree/pull/125#issuecomment-1");
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
    expect(message?.content).toContain("gh pr review 123 --repo owner/context-tree --comment --body");
    expect(message?.content).toContain("gh pr review 123 --repo owner/context-tree --approve --body");
    expect(message?.content).toContain("Trigger event: pull_request.opened");
    expect(message?.metadata).toMatchObject({
      contextTreeReviewer: true,
      mentions: [reviewer.uuid],
    });

    const [entry] = await app.db
      .select({ notify: inboxEntries.notify })
      .from(inboxEntries)
      .where(and(eq(inboxEntries.messageId, result.messageId), eq(inboxEntries.inboxId, reviewer.inboxId)))
      .limit(1);
    expect(entry?.notify).toBe(true);
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
    expect(followUp?.content).toBe(FOLLOW_UP_NOTICE);
    expect(followUp?.content).not.toContain("gh pr review 123 --repo owner/context-tree");
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
    expect(followUp?.content).toBe(FOLLOW_UP_NOTICE);
    expect(followUp?.content).not.toContain("clear, accurate");
    expect(followUp?.content).not.toContain("gh pr review 123 --repo owner/context-tree");
    expect(followUp?.metadata).toMatchObject({
      source: "github",
      event: "pull_request",
      action: "synchronize",
      triggerEvent: "pull_request.synchronize",
      entityKey: "owner/context-tree#123",
      contextTreeReviewer: true,
      mentions: [reviewer.uuid],
    });

    const [entry] = await app.db
      .select({ notify: inboxEntries.notify })
      .from(inboxEntries)
      .where(and(eq(inboxEntries.messageId, second.messageId), eq(inboxEntries.inboxId, reviewer.inboxId)))
      .limit(1);
    expect(entry?.notify).toBe(true);
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
    expect(followUp?.content).toBe(
      [
        FOLLOW_UP_NOTICE,
        "Comment author: commenter",
        "Comment URL: https://github.com/owner/context-tree/pull/123#issuecomment-1",
      ].join("\n"),
    );
    expect(followUp?.content).not.toContain("gh pr review 123 --repo owner/context-tree");
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
    expect(followUp?.content).toBe(
      [
        FOLLOW_UP_NOTICE,
        "Comment author: reviewer-user",
        "Comment URL: https://github.com/owner/context-tree/pull/123#discussion_r1",
      ].join("\n"),
    );
    expect(followUp?.content).not.toContain("gh pr review 123 --repo owner/context-tree");
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
    expect(followUp?.content).toBe(
      [
        FOLLOW_UP_NOTICE,
        "Comment author: MANAGER-LOGIN",
        "Comment URL: https://github.com/owner/context-tree/pull/123#issuecomment-2",
      ].join("\n"),
    );
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
    expect(followUp?.content).toBe(
      [
        FOLLOW_UP_NOTICE,
        "Comment author: unrelated-human",
        "Comment URL: https://github.com/owner/context-tree/pull/123#issuecomment-3",
      ].join("\n"),
    );
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
    });
  });
});
