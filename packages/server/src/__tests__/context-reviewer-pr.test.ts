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
    },
    repository: { full_name: "owner/context-tree" },
    sender: { login: "writer", type: "User" },
    ...overrides,
  };
}

async function createReviewer(app: App, admin: Awaited<ReturnType<typeof createAdminContext>>) {
  return createAgent(app.db, {
    name: `reviewer-${randomUUID().slice(0, 8)}`,
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
      organizationId: "org-1",
    });

    expect(prompt).toContain("Context Reviewer");
    expect(prompt).toContain("clear, accurate");
    expect(prompt).toContain("missing background");
    expect(prompt).toContain("excessive detail");
    expect(prompt).toContain("gh pr comment 123 --repo owner/context-tree --body");
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
      organizationId: "org-1",
    });

    expect(prompt).toContain("Base ref: unknown");
    expect(prompt).toContain("Head ref: unknown");
    expect(prompt).toContain("gh pr comment 124 --repo owner/context-tree --body");
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

describe("handleContextReviewerPullRequest", () => {
  const getApp = useTestApp();

  it("skips when webhook repo is not the bound context repo", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);
    const reviewer = await createReviewer(app, admin);
    await enableReviewer(app, admin, reviewer.uuid);

    const result = await handleContextReviewerPullRequest(app, {
      eventType: "pull_request",
      payload: pullRequestPayload({ repository: { full_name: "owner/code" } }),
      organizationId: admin.organizationId,
    });

    expect(result).toEqual({ handled: false, reason: "repo_mismatch" });
    const rows = await app.db.select({ id: chats.id }).from(chats);
    expect(rows).toHaveLength(0);
  });

  it("skips when the feature is disabled, context repo is missing, reviewer is missing, or action is not opened", async () => {
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
      handleContextReviewerPullRequest(app, {
        eventType: "pull_request",
        payload: pullRequestPayload({ action: "synchronize" }),
        organizationId: admin.organizationId,
      }),
    ).resolves.toEqual({ handled: false, reason: "unsupported_event" });
  });

  it("creates a reviewer chat, membership, task message, and inbox notification for an opened context repo PR", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);
    const reviewer = await createReviewer(app, admin);
    await enableReviewer(app, admin, reviewer.uuid);

    const result = await handleContextReviewerPullRequest(app, {
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
    expect(message?.content).toContain("gh pr comment 123 --repo owner/context-tree --body");
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

    const first = await handleContextReviewerPullRequest(app, {
      eventType: "pull_request",
      payload: pullRequestPayload(),
      organizationId: admin.organizationId,
    });
    const second = await handleContextReviewerPullRequest(app, {
      eventType: "pull_request",
      payload: pullRequestPayload(),
      organizationId: admin.organizationId,
    });

    expect(first.handled && second.handled && second.chatId === first.chatId).toBe(true);
    expect(second).toMatchObject({ handled: true, reused: true });

    const messageRows = await app.db.select({ id: messages.id }).from(messages);
    expect(messageRows).toHaveLength(2);
    const chatRows = await app.db.select({ id: chats.id }).from(chats);
    expect(chatRows).toHaveLength(1);
  });

  it("extracts pull request info defensively", () => {
    expect(contextReviewerPrTestInternals.extractPullRequestPayloadInfo(pullRequestPayload(), "org-1")).toMatchObject({
      repoFullName: "owner/context-tree",
      entityKey: "owner/context-tree#123",
      baseRef: "main",
      headRef: "context-update",
    });
    expect(
      contextReviewerPrTestInternals.extractPullRequestPayloadInfo(
        pullRequestPayload({ pull_request: { number: 123 } }),
        "org-1",
      ),
    ).toBeNull();
  });
});
