import { generateKeyPairSync, randomUUID } from "node:crypto";
import { AGENT_RUNTIME_SESSION_HEADER, AGENT_SELECTOR_HEADER } from "@first-tree/shared";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agents } from "../db/schema/agents.js";
import { authIdentities } from "../db/schema/auth-identities.js";
import { githubAppInstallations } from "../db/schema/github-app-installations.js";
import { messages } from "../db/schema/messages.js";
import { createAgent } from "../services/agent.js";
import { bindAgentRuntimeSession } from "../services/agent-runtime-session.js";
import { handleContextReviewerPrEvent as handleContextReviewerPrEventService } from "../services/context-reviewer-pr.js";
import { submitContextReviewOutcome } from "../services/context-reviewer-publisher.js";
import { upsertInstallationFromMetadata } from "../services/github-app-installations.js";
import { putOrgSetting } from "../services/org-settings.js";
import { createAdminContext, seedHealthyAgentRuntime, useTestApp } from "./helpers.js";

const { privateKey: privateKeyPem } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

describe("Context Reviewer App publisher", () => {
  const getApp = useTestApp({ githubAppPrivateKeyPem: privateKeyPem, runtimeHttpTokenEnforcement: false });

  it("publishes one App review for GitHub's current head and records durable audit state", async () => {
    const fixture = await createRunFixture(getApp());
    const fetcher = successfulGithubFetcher({ headSha: "b".repeat(40) });
    const request = { event: "APPROVE" as const, body: "## Context approved\n" };

    const first = await submitContextReviewOutcome({
      db: fixture.app.db,
      chatId: fixture.chatId,
      runId: fixture.runId,
      callerAgentUuid: fixture.reviewer.uuid,
      callerClientId: fixture.admin.clientId,
      callerRuntimeSessionToken: fixture.runtimeToken,
      request,
      appCredentials: fixture.app.config.oauth?.githubApp,
      fetcher,
    });
    const second = await submitContextReviewOutcome({
      db: fixture.app.db,
      chatId: fixture.chatId,
      runId: fixture.runId,
      callerAgentUuid: fixture.reviewer.uuid,
      callerClientId: fixture.admin.clientId,
      callerRuntimeSessionToken: fixture.runtimeToken,
      request,
      appCredentials: fixture.app.config.oauth?.githubApp,
      fetcher,
    });

    expect(second).toEqual(first);
    expect(first).toMatchObject({ action: "APPROVE", reviewedHead: "b".repeat(40), reviewId: 9001 });
    const reviewPosts = fetcher.mock.calls.filter(
      ([url, init]) => String(url).endsWith("/reviews") && init?.method === "POST",
    );
    expect(reviewPosts).toHaveLength(1);
    expect(JSON.parse(String(reviewPosts[0]?.[1]?.body))).toMatchObject({
      commit_id: "b".repeat(40),
      event: "APPROVE",
      body: expect.stringContaining(`first-tree-context-review-run:${fixture.runId}`),
    });
    const [message] = await fixture.app.db
      .select({ metadata: messages.metadata })
      .from(messages)
      .where(eq(messages.id, fixture.messageId));
    expect(message?.metadata.contextReviewSubmission).toMatchObject({
      state: "submitted",
      reviewedHead: "b".repeat(40),
      reviewerAgentUuid: fixture.reviewer.uuid,
      reviewerManagerHumanAgentId: fixture.admin.humanAgentUuid,
      reviewerClientId: fixture.admin.clientId,
    });
  });

  it("rejects the wrong reviewer before any GitHub call", async () => {
    const fixture = await createRunFixture(getApp());
    const fetcher = successfulGithubFetcher();
    await expect(
      submitContextReviewOutcome({
        db: fixture.app.db,
        chatId: fixture.chatId,
        runId: fixture.runId,
        callerAgentUuid: "wrong-agent",
        callerClientId: fixture.admin.clientId,
        callerRuntimeSessionToken: fixture.runtimeToken,
        request: { event: "APPROVE", body: "Approved" },
        appCredentials: fixture.app.config.oauth?.githubApp,
        fetcher,
      }),
    ).rejects.toMatchObject({ code: "CONTEXT_REVIEW_RUN_FORBIDDEN" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("allows separate trusted runs to publish without electing one current run", async () => {
    const fixture = await createRunFixture(getApp());
    const followUp = await createFollowUpRun(fixture);
    const fetcher = successfulGithubFetcher();
    const common = {
      db: fixture.app.db,
      chatId: fixture.chatId,
      callerAgentUuid: fixture.reviewer.uuid,
      callerClientId: fixture.admin.clientId,
      callerRuntimeSessionToken: fixture.runtimeToken,
      appCredentials: fixture.app.config.oauth?.githubApp,
      fetcher,
    };

    await expect(
      submitContextReviewOutcome({
        ...common,
        runId: fixture.runId,
        request: { event: "COMMENT", body: "First review" },
      }),
    ).resolves.toMatchObject({ action: "COMMENT" });
    await expect(
      submitContextReviewOutcome({
        ...common,
        runId: followUp.runId,
        request: { event: "APPROVE", body: "Latest review" },
      }),
    ).resolves.toMatchObject({ action: "APPROVE" });
    expect(
      fetcher.mock.calls.filter(([url, init]) => String(url).endsWith("/reviews") && init?.method === "POST"),
    ).toHaveLength(2);
  });

  it("reconciles an unknown write by marker and hashes the exact trimmed body that it sends", async () => {
    const fixture = await createRunFixture(getApp());
    const fetcher = unknownThenReconciledGithubFetcher(fixture.runId);
    const input = {
      db: fixture.app.db,
      chatId: fixture.chatId,
      runId: fixture.runId,
      callerAgentUuid: fixture.reviewer.uuid,
      callerClientId: fixture.admin.clientId,
      callerRuntimeSessionToken: fixture.runtimeToken,
      request: { event: "COMMENT" as const, body: "Deferred  \n\n" },
      appCredentials: fixture.app.config.oauth?.githubApp,
      fetcher,
    };

    await expect(submitContextReviewOutcome(input)).rejects.toMatchObject({ code: "CONTEXT_REVIEW_GITHUB_UNKNOWN" });
    await expect(submitContextReviewOutcome(input)).resolves.toMatchObject({
      action: "COMMENT",
      reviewedHead: "a".repeat(40),
      reviewId: 9002,
    });
    expect(
      fetcher.mock.calls.filter(([url, init]) => String(url).endsWith("/reviews") && init?.method === "POST"),
    ).toHaveLength(1);
  });

  it("reconciles an accepted unknown write after the pull request closes", async () => {
    const fixture = await createRunFixture(getApp());
    const fetcher = unknownThenReconciledGithubFetcher(fixture.runId, { closeAfterUnknownWrite: true });
    const input = {
      db: fixture.app.db,
      chatId: fixture.chatId,
      runId: fixture.runId,
      callerAgentUuid: fixture.reviewer.uuid,
      callerClientId: fixture.admin.clientId,
      callerRuntimeSessionToken: fixture.runtimeToken,
      request: { event: "COMMENT" as const, body: "Deferred" },
      appCredentials: fixture.app.config.oauth?.githubApp,
      fetcher,
    };

    await expect(submitContextReviewOutcome(input)).rejects.toMatchObject({ code: "CONTEXT_REVIEW_GITHUB_UNKNOWN" });
    await expect(submitContextReviewOutcome(input)).resolves.toMatchObject({
      action: "COMMENT",
      reviewedHead: "a".repeat(40),
      reviewId: 9002,
    });
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/pulls/123"))).toHaveLength(1);
  });

  it("does not reconcile an unknown write against another run's marker-bearing review", async () => {
    const fixture = await createRunFixture(getApp());
    const fetcher = unknownThenReconciledGithubFetcher(fixture.runId, { collidingReview: true });
    const input = {
      db: fixture.app.db,
      chatId: fixture.chatId,
      runId: fixture.runId,
      callerAgentUuid: fixture.reviewer.uuid,
      callerClientId: fixture.admin.clientId,
      callerRuntimeSessionToken: fixture.runtimeToken,
      request: { event: "COMMENT" as const, body: "Deferred" },
      appCredentials: fixture.app.config.oauth?.githubApp,
      fetcher,
    };

    await expect(submitContextReviewOutcome(input)).rejects.toMatchObject({ code: "CONTEXT_REVIEW_GITHUB_UNKNOWN" });
    await expect(submitContextReviewOutcome(input)).rejects.toMatchObject({ code: "CONTEXT_REVIEW_GITHUB_UNKNOWN" });
  });

  it("requires runtime-session proof on the narrow agent route", async () => {
    const fixture = await createRunFixture(getApp());
    const missingProof = await fixture.app.inject({
      method: "POST",
      url: `/api/v1/agent/chats/${fixture.chatId}/context-review-runs/${fixture.runId}/submit`,
      headers: {
        authorization: `Bearer ${fixture.admin.accessToken}`,
        [AGENT_SELECTOR_HEADER]: fixture.reviewer.uuid,
      },
      payload: { event: "APPROVE", body: "Approved" },
    });
    expect(missingProof.statusCode).toBe(403);
    expect(missingProof.json()).toMatchObject({ code: "CONTEXT_REVIEW_RUNTIME_SESSION_REQUIRED" });

    vi.stubGlobal("fetch", successfulGithubFetcher());
    const accepted = await fixture.app.inject({
      method: "POST",
      url: `/api/v1/agent/chats/${fixture.chatId}/context-review-runs/${fixture.runId}/submit`,
      headers: {
        authorization: `Bearer ${fixture.admin.accessToken}`,
        [AGENT_SELECTOR_HEADER]: fixture.reviewer.uuid,
        [AGENT_RUNTIME_SESSION_HEADER]: fixture.runtimeToken,
      },
      payload: { event: "APPROVE", body: "Approved" },
    });
    expect(accepted.statusCode).toBe(200);
  });

  it("fails closed when Pull requests: write is unavailable", async () => {
    const fixture = await createRunFixture(getApp());
    await fixture.app.db
      .update(githubAppInstallations)
      .set({ permissions: { pull_requests: "read", metadata: "read" } })
      .where(eq(githubAppInstallations.hubOrganizationId, fixture.admin.organizationId));

    await expect(
      submitContextReviewOutcome({
        db: fixture.app.db,
        chatId: fixture.chatId,
        runId: fixture.runId,
        callerAgentUuid: fixture.reviewer.uuid,
        callerClientId: fixture.admin.clientId,
        callerRuntimeSessionToken: fixture.runtimeToken,
        request: { event: "COMMENT", body: "Deferred" },
        appCredentials: fixture.app.config.oauth?.githubApp,
        fetcher: successfulGithubFetcher(),
      }),
    ).rejects.toMatchObject({ code: "CONTEXT_REVIEW_APP_PERMISSION_REQUIRED" });
  });

  it("revokes publication when the configured Reviewer becomes private mid-run", async () => {
    const fixture = await createRunFixture(getApp());
    await fixture.app.db.update(agents).set({ visibility: "private" }).where(eq(agents.uuid, fixture.reviewer.uuid));

    await expect(
      submitContextReviewOutcome({
        db: fixture.app.db,
        chatId: fixture.chatId,
        runId: fixture.runId,
        callerAgentUuid: fixture.reviewer.uuid,
        callerClientId: fixture.admin.clientId,
        callerRuntimeSessionToken: fixture.runtimeToken,
        request: { event: "COMMENT", body: "Deferred" },
        appCredentials: fixture.app.config.oauth?.githubApp,
        fetcher: successfulGithubFetcher(),
      }),
    ).rejects.toMatchObject({ code: "CONTEXT_REVIEW_RUN_FORBIDDEN" });
  });
});

async function handleContextReviewerPrEvent(
  app: ReturnType<ReturnType<typeof useTestApp>>,
  input: Omit<Parameters<typeof handleContextReviewerPrEventService>[1], "installationId">,
) {
  const [installation] = await app.db
    .select({ installationId: githubAppInstallations.installationId })
    .from(githubAppInstallations)
    .where(eq(githubAppInstallations.hubOrganizationId, input.organizationId))
    .limit(1);
  return handleContextReviewerPrEventService(app, {
    ...input,
    installationId: installation?.installationId ?? 0,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

async function createRunFixture(app: ReturnType<ReturnType<typeof useTestApp>>) {
  const admin = await createAdminContext(app);
  await app.db.insert(authIdentities).values({
    id: randomUUID(),
    userId: admin.userId,
    provider: "github",
    identifier: randomUUID(),
    email: null,
    verifiedAt: new Date(),
    metadata: { login: "writer" },
  });
  const reviewer = await createAgent(app.db, {
    name: `reviewer-${randomUUID().slice(0, 8)}`,
    type: "agent",
    displayName: "Context Reviewer",
    managerId: admin.memberId,
    clientId: admin.clientId,
  });
  await seedHealthyAgentRuntime(app, {
    agentUuid: reviewer.uuid,
    clientId: admin.clientId,
  });
  const runtimeToken = await bindAgentRuntimeSession(app.db, reviewer.uuid, admin.clientId);
  await upsertInstallationFromMetadata(app.db, {
    installation: {
      id: Number(`8${Math.floor(Math.random() * 1_000_000)}`),
      accountType: "Organization",
      accountLogin: "owner",
      accountGithubId: Math.floor(Math.random() * 1_000_000_000),
      permissions: { metadata: "read", pull_requests: "write" },
      events: ["pull_request", "issue_comment", "pull_request_review_comment"],
      suspendedAt: null,
    },
    hubOrganizationId: admin.organizationId,
  });
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
    { contextReviewer: { enabled: true, agentUuid: reviewer.uuid } },
    { updatedBy: admin.userId, memberId: admin.memberId },
  );
  const result = await handleContextReviewerPrEvent(app, {
    eventType: "pull_request",
    organizationId: admin.organizationId,
    payload: pullRequestPayload(),
  });
  if (!result.handled) throw new Error("review run was not created");
  const [message] = await app.db.select().from(messages).where(eq(messages.id, result.messageId));
  const runId = message?.metadata.contextReviewRunId;
  if (typeof runId !== "string") throw new Error("run id missing");
  return { app, admin, reviewer, runtimeToken, chatId: result.chatId, messageId: result.messageId, runId };
}

async function createFollowUpRun(fixture: Awaited<ReturnType<typeof createRunFixture>>) {
  const result = await handleContextReviewerPrEvent(fixture.app, {
    eventType: "issue_comment",
    organizationId: fixture.admin.organizationId,
    payload: {
      action: "created",
      issue: {
        number: 123,
        title: "Review Context",
        html_url: "https://github.com/owner/context-tree/issues/123",
        user: { login: "writer", type: "User" },
        pull_request: { html_url: "https://github.com/owner/context-tree/pull/123" },
      },
      comment: {
        html_url: "https://github.com/owner/context-tree/pull/123#issuecomment-2",
        user: { login: "commenter", type: "User" },
      },
      repository: { full_name: "owner/context-tree" },
      sender: { login: "commenter", type: "User" },
    },
  });
  if (!result.handled) throw new Error("follow-up run missing");
  const [message] = await fixture.app.db.select().from(messages).where(eq(messages.id, result.messageId));
  const runId = message?.metadata.contextReviewRunId;
  if (typeof runId !== "string") throw new Error("follow-up run id missing");
  return { runId };
}

function pullRequestPayload() {
  return {
    action: "opened",
    pull_request: {
      number: 123,
      title: "Review Context",
      html_url: "https://github.com/owner/context-tree/pull/123",
      base: { ref: "main" },
      head: { ref: "change", sha: "a".repeat(40) },
      draft: false,
      user: { login: "writer", type: "User" },
    },
    repository: { full_name: "owner/context-tree" },
    sender: { login: "writer", type: "User" },
  };
}

function successfulGithubFetcher(overrides: { headSha?: string } = {}) {
  return vi.fn<typeof fetch>(async (url, init) => {
    const target = String(url);
    if (target.endsWith("/access_tokens")) {
      return jsonResponse(
        {
          token: "installation-token",
          expires_at: "2026-07-15T18:00:00Z",
          permissions: { metadata: "read", pull_requests: "write" },
          repository_selection: "selected",
        },
        201,
      );
    }
    if (target.endsWith("/pulls/123") && (!init?.method || init.method === "GET")) {
      return jsonResponse({
        number: 123,
        state: "open",
        draft: false,
        merged: false,
        head: { sha: overrides.headSha ?? "a".repeat(40) },
        html_url: "https://github.com/owner/context-tree/pull/123",
      });
    }
    if (target.endsWith("/pulls/123/reviews") && init?.method === "POST") {
      const payload = JSON.parse(String(init.body)) as { commit_id: string; body: string };
      return jsonResponse({
        id: 9001,
        html_url: "https://github.com/owner/context-tree/pull/123#pullrequestreview-9001",
        user: { login: "test-app-slug[bot]" },
        commit_id: payload.commit_id,
        body: payload.body,
      });
    }
    return new Response("not found", { status: 404 });
  });
}

function unknownThenReconciledGithubFetcher(
  runId: string,
  options: { closeAfterUnknownWrite?: boolean; collidingReview?: boolean } = {},
) {
  let pullRequestReads = 0;
  return vi.fn<typeof fetch>(async (url, init) => {
    const target = String(url);
    if (target.endsWith("/access_tokens")) {
      return jsonResponse(
        {
          token: "installation-token",
          expires_at: "2026-07-15T18:00:00Z",
          permissions: { metadata: "read", pull_requests: "write" },
          repository_selection: "selected",
        },
        201,
      );
    }
    if (target.endsWith("/pulls/123") && (!init?.method || init.method === "GET")) {
      pullRequestReads += 1;
      const closed = options.closeAfterUnknownWrite === true && pullRequestReads > 1;
      return jsonResponse({
        number: 123,
        state: closed ? "closed" : "open",
        draft: false,
        merged: closed,
        head: { sha: "a".repeat(40) },
        html_url: "https://github.com/owner/context-tree/pull/123",
      });
    }
    if (target.endsWith("/pulls/123/reviews") && init?.method === "POST") {
      throw new TypeError("socket closed after request dispatch");
    }
    if (target.endsWith("/pulls/123/reviews?per_page=100")) {
      return jsonResponse([
        {
          id: 9002,
          html_url: "https://github.com/owner/context-tree/pull/123#pullrequestreview-9002",
          user: { login: "test-app-slug[bot]" },
          commit_id: "a".repeat(40),
          body: options.collidingReview
            ? `Different outcome\n\n<!-- first-tree-context-review-run:${runId} -->`
            : `Deferred\n\n<!-- first-tree-context-review-run:${runId} -->`,
          state: options.collidingReview ? "APPROVED" : "COMMENTED",
        },
      ]);
    }
    return new Response("not found", { status: 404 });
  });
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
