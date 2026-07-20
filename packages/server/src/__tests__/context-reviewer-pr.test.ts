import { randomUUID } from "node:crypto";
import { CONTEXT_REVIEW_MANAGED_MARKER } from "@first-tree/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { chats } from "../db/schema/chats.js";
import { messages } from "../db/schema/messages.js";
import { organizationSettings } from "../db/schema/organization-settings.js";
import { createAgent } from "../services/agent.js";
import { createChat } from "../services/chat.js";
import {
  contextReviewerPrTestInternals,
  handleContextReviewerPrEvent,
  handleContextReviewerPullRequest,
  normalizeGithubRepo,
  renderContextReviewerPrPrompt,
} from "../services/context-reviewer-pr.js";
import { upsertInstallationFromMetadata } from "../services/github-app-installations.js";
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
  await seedReviewerInstallation(app, admin.organizationId);
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

async function seedReviewerInstallation(app: App, organizationId: string): Promise<void> {
  const numericId = Number.parseInt(randomUUID().replaceAll("-", "").slice(0, 10), 16);
  await upsertInstallationFromMetadata(app.db, {
    installation: {
      id: numericId,
      accountType: "Organization",
      accountLogin: "owner",
      accountGithubId: numericId + 1,
      permissions: { metadata: "read", pull_requests: "write" },
      events: ["pull_request"],
      suspendedAt: null,
    },
    hubOrganizationId: organizationId,
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
      contextReviewRunId: "01900000-0000-7000-8000-000000000001",
      reviewerManagerGithubLogin: "reviewer-manager",
    });

    expect(prompt).toContain("Context Tree pull request event");
    expect(prompt).toContain("Load the installed `context-tree-review` skill");
    expect(prompt).toContain("strictly execute that skill");
    expect(prompt).toContain("Repository: owner/context-tree");
    expect(prompt).toContain("Pull request: #123");
    expect(prompt).toContain("PR author: writer");
    expect(prompt).toContain("Event sender: writer");
    expect(prompt).toContain("Reviewer manager GitHub login: reviewer-manager");
    expect(prompt).toContain("Context review run: 01900000-0000-7000-8000-000000000001");
    expect(prompt).not.toContain("Known self-approval blocker");
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
      contextReviewRunId: "01900000-0000-7000-8000-000000000002",
      reviewerManagerGithubLogin: null,
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
      contextReviewRunId: "01900000-0000-7000-8000-000000000003",
      reviewerManagerGithubLogin: null,
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
      contextReviewRunId: "01900000-0000-7000-8000-000000000004",
      reviewerManagerGithubLogin: null,
    });

    expect(prompt).toContain("Trigger event: issue_comment.created");
    expect(prompt).toContain("Comment author: commenter");
    expect(prompt).toContain("Comment URL: https://github.com/owner/context-tree/pull/125#issuecomment-1");
  });

  it("renders the server-authored App publication run without a host self-approval branch", async () => {
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
      contextReviewRunId: "01900000-0000-7000-8000-000000000005",
      reviewerManagerGithubLogin: "Writer",
    });

    expect(prompt).toContain("Context review run: 01900000-0000-7000-8000-000000000005");
    expect(prompt).not.toContain("Known self-approval blocker");
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

    expect(result).toEqual({ handled: false, reason: "repo_mismatch", routingDecision: "not_applicable" });
    const rows = await app.db.select({ id: chats.id }).from(chats);
    expect(rows).toHaveLength(0);
  });

  it("suppresses the legacy App path for a managed Reviewer task PR", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);
    const reviewer = await createReviewer(app, admin);
    await enableReviewer(app, admin, reviewer.uuid);
    const payload = pullRequestPayload();
    (payload.pull_request as Record<string, unknown>).body =
      `${CONTEXT_REVIEW_MANAGED_MARKER}\n\nRepair scope: system/`;

    await expect(
      handleContextReviewerPrEvent(app, {
        eventType: "pull_request",
        payload,
        organizationId: admin.organizationId,
      }),
    ).resolves.toEqual({
      handled: false,
      reason: "managed_task_missing",
      routingDecision: "managed_missing",
    });
    await expect(app.db.select({ id: chats.id }).from(chats)).resolves.toHaveLength(0);
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
    ).resolves.toEqual({ handled: false, reason: "feature_disabled", routingDecision: "not_applicable" });

    await seedReviewerInstallation(app, admin.organizationId);
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
    ).resolves.toEqual({
      handled: false,
      reason: "reviewer_agent_invalid",
      routingDecision: "not_applicable",
    });

    await expect(
      handleContextReviewerPrEvent(app, {
        eventType: "pull_request",
        payload: pullRequestPayload({ action: "labeled" }),
        organizationId: admin.organizationId,
      }),
    ).resolves.toEqual({ handled: false, reason: "unsupported_event", routingDecision: "not_applicable" });
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
    ).resolves.toEqual({ handled: false, reason: "unsupported_event", routingDecision: "not_applicable" });
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
    ).resolves.toEqual({
      handled: false,
      reason: "context_tree_repo_unset",
      routingDecision: "not_applicable",
    });
  });

  it("skips when the stored Context Tree binding is not runtime-safe", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);
    await app.db.insert(organizationSettings).values({
      organizationId: admin.organizationId,
      namespace: "context_tree",
      value: { repo: "http://legacy.example/context-tree.git", branch: "bad..branch" },
      version: 1,
      updatedBy: admin.userId,
    });

    await expect(
      handleContextReviewerPrEvent(app, {
        eventType: "pull_request",
        payload: pullRequestPayload(),
        organizationId: admin.organizationId,
      }),
    ).resolves.toEqual({
      handled: false,
      reason: "context_tree_repo_unset",
      routingDecision: "not_applicable",
    });
    await expect(app.db.select({ id: chats.id }).from(chats)).resolves.toHaveLength(0);
  });

  it("does not create a legacy Reviewer Chat for an unmanaged Context PR", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);
    const reviewer = await createReviewer(app, admin);
    await enableReviewer(app, admin, reviewer.uuid);

    const result = await handleContextReviewerPrEvent(app, {
      eventType: "pull_request",
      payload: pullRequestPayload(),
      organizationId: admin.organizationId,
    });

    expect(result).toEqual({
      handled: false,
      reason: "legacy_creation_disabled",
      routingDecision: "not_applicable",
    });
    await expect(app.db.select({ id: chats.id }).from(chats)).resolves.toHaveLength(0);
  });

  it("drains unmanaged follow-ups only into a pre-existing legacy Reviewer Chat", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);
    const reviewer = await createReviewer(app, admin);
    await enableReviewer(app, admin, reviewer.uuid);
    const existing = await createChat(app.db, {
      mode: "task",
      initiatorAgentId: admin.humanAgentUuid,
      organizationId: admin.organizationId,
      initialRecipientAgentIds: [reviewer.uuid],
      contextParticipantAgentIds: [],
      topic: "Legacy Context Review PR #123",
      initialMessage: { source: "api", format: "markdown", content: "legacy opening", metadata: {} },
      source: "manual",
    });
    await app.db
      .update(chats)
      .set({
        metadata: {
          source: "github",
          entityType: "pull_request",
          entityKey: "owner/context-tree#123",
          entityUrl: "https://github.com/owner/context-tree/pull/123",
          contextTreeReviewer: true,
          reviewerAgentUuid: reviewer.uuid,
        },
      })
      .where(eq(chats.id, existing.chat.id));

    const result = await handleContextReviewerPrEvent(app, {
      eventType: "pull_request",
      payload: pullRequestPayload({ action: "synchronize" }),
      organizationId: admin.organizationId,
    });

    expect(result).toMatchObject({
      handled: true,
      chatId: existing.chat.id,
      reused: true,
      routingDecision: "legacy_existing",
    });
    await expect(app.db.select({ id: chats.id }).from(chats)).resolves.toHaveLength(1);
    await expect(
      app.db.select({ id: messages.id }).from(messages).where(eq(messages.chatId, existing.chat.id)),
    ).resolves.toHaveLength(2);
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

    expect(result).toEqual({ handled: false, reason: "malformed_payload", routingDecision: "not_applicable" });
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
    expect(
      extractPullRequestPayloadInfo("pull_request", pullRequestPayload({ action: "closed" }), "org-1"),
    ).toMatchObject({
      action: "closed",
      triggerEvent: "pull_request.closed",
    });
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
