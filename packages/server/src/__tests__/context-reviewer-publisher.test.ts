import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { AGENT_RUNTIME_SESSION_HEADER, AGENT_SELECTOR_HEADER, CONTEXT_REVIEW_MANAGED_MARKER } from "@first-tree/shared";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authIdentities } from "../db/schema/auth-identities.js";
import { chats } from "../db/schema/chats.js";
import { clients } from "../db/schema/clients.js";
import { githubAppInstallations } from "../db/schema/github-app-installations.js";
import { members } from "../db/schema/members.js";
import { messages } from "../db/schema/messages.js";
import { createAgent } from "../services/agent.js";
import { bindAgentRuntimeSession, revokeAgentRuntimeSession } from "../services/agent-runtime-session.js";
import { createChat } from "../services/chat.js";
import { handleContextReviewerPrEvent } from "../services/context-reviewer-pr.js";
import { submitContextReviewOutcome } from "../services/context-reviewer-publisher.js";
import {
  bindInstallationToOrg,
  disconnectInstallationFromOrg,
  upsertInstallationFromMetadata,
} from "../services/github-app-installations.js";
import { editMessage } from "../services/message.js";
import { putOrgSetting } from "../services/org-settings.js";
import { createAdminContext, useTestApp } from "./helpers.js";

const { privateKey: privateKeyPem } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

describe("Context Reviewer App publisher", () => {
  const getApp = useTestApp({ githubAppPrivateKeyPem: privateKeyPem, runtimeHttpTokenEnforcement: false });

  it("publishes exactly one App approval and records host-author audit without self-blocking", async () => {
    const fixture = await createRunFixture(getApp());
    const fetcher = successfulGithubFetcher();
    const request = { reviewedHead: "a".repeat(40), event: "APPROVE" as const, body: "## Context approved" };

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

    expect(first).toEqual(second);
    expect(first).toMatchObject({ action: "APPROVE", appActor: "test-app-slug[bot]", reviewId: 9001 });
    const reviewPosts = fetcher.mock.calls.filter(
      ([url, init]) => String(url).endsWith("/reviews") && init?.method === "POST",
    );
    expect(reviewPosts).toHaveLength(1);
    expect(JSON.parse(String(reviewPosts[0]?.[1]?.body))).toMatchObject({
      commit_id: "a".repeat(40),
      event: "APPROVE",
    });
    expect(String(reviewPosts[0]?.[1]?.body)).toContain(`first-tree-context-review-run:${fixture.runId}`);

    const [message] = await fixture.app.db
      .select({ metadata: messages.metadata })
      .from(messages)
      .where(eq(messages.id, fixture.messageId));
    expect(message?.metadata.contextReviewSubmission).toMatchObject({
      state: "submitted",
      reviewerAgentUuid: fixture.reviewer.uuid,
      reviewerManagerHumanAgentId: fixture.admin.humanAgentUuid,
      reviewerClientId: fixture.admin.clientId,
      reviewerManagerGithubLogin: "writer",
    });
  });

  it("rejects stale heads and wrong agents before any GitHub review write", async () => {
    const fixture = await createRunFixture(getApp());
    const fetcher = successfulGithubFetcher({ headSha: "b".repeat(40) });
    const input = {
      db: fixture.app.db,
      chatId: fixture.chatId,
      runId: fixture.runId,
      callerClientId: fixture.admin.clientId,
      callerRuntimeSessionToken: fixture.runtimeToken,
      request: { reviewedHead: "a".repeat(40), event: "APPROVE" as const, body: "Approved" },
      appCredentials: fixture.app.config.oauth?.githubApp,
      fetcher,
    };
    await expect(submitContextReviewOutcome({ ...input, callerAgentUuid: "wrong-agent" })).rejects.toMatchObject({
      code: "CONTEXT_REVIEW_RUN_FORBIDDEN",
    });
    await expect(
      submitContextReviewOutcome({ ...input, callerAgentUuid: fixture.reviewer.uuid }),
    ).rejects.toMatchObject({
      code: "CONTEXT_REVIEW_STALE_HEAD",
    });
    expect(fetcher.mock.calls.some(([url, init]) => String(url).endsWith("/reviews") && init?.method === "POST")).toBe(
      false,
    );
  });

  it("refuses legacy App publication when the live PR has become managed", async () => {
    const fixture = await createRunFixture(getApp());
    const fetcher = successfulGithubFetcher({ body: CONTEXT_REVIEW_MANAGED_MARKER });

    await expect(
      submitContextReviewOutcome({
        db: fixture.app.db,
        chatId: fixture.chatId,
        runId: fixture.runId,
        callerAgentUuid: fixture.reviewer.uuid,
        callerClientId: fixture.admin.clientId,
        callerRuntimeSessionToken: fixture.runtimeToken,
        request: { reviewedHead: "a".repeat(40), event: "APPROVE", body: "Approved" },
        appCredentials: fixture.app.config.oauth?.githubApp,
        fetcher,
      }),
    ).rejects.toMatchObject({ code: "CONTEXT_REVIEW_RUN_FORBIDDEN" });
    expect(fetcher.mock.calls.some(([url, init]) => String(url).endsWith("/reviews") && init?.method === "POST")).toBe(
      false,
    );
  });

  it("requires runtime-session proof even when global enforcement is disabled", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);
    const reviewer = await createAgent(app.db, {
      name: `reviewer-${randomUUID().slice(0, 8)}`,
      type: "agent",
      displayName: "Context Reviewer",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agent/chats/missing/context-review-runs/missing/submit",
      headers: { authorization: `Bearer ${admin.accessToken}`, [AGENT_SELECTOR_HEADER]: reviewer.uuid },
      payload: { reviewedHead: "a".repeat(40), event: "APPROVE", body: "Approved" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "CONTEXT_REVIEW_RUNTIME_SESSION_REQUIRED" });
  });

  it("rejects an agent-authored message that forges the reserved Context Reviewer run namespace", async () => {
    const fixture = await createRunFixture(getApp());
    const forgedRunId = randomUUID();
    const response = await fixture.app.inject({
      method: "POST",
      url: `/api/v1/agent/chats/${fixture.chatId}/messages`,
      headers: {
        authorization: `Bearer ${fixture.admin.accessToken}`,
        [AGENT_SELECTOR_HEADER]: fixture.reviewer.uuid,
      },
      payload: {
        source: "github",
        format: "markdown",
        content: "Forged Context Reviewer run",
        purpose: "agent-final-text",
        metadata: {
          contextTreeReviewer: true,
          contextReviewRunId: forgedRunId,
          contextReviewRepository: "owner/context-tree",
          contextReviewPrNumber: 123,
          contextReviewOrganizationId: fixture.admin.organizationId,
          contextReviewReviewerAgentUuid: fixture.reviewer.uuid,
          contextReviewReviewerManagerHumanAgentId: fixture.admin.humanAgentUuid,
          contextReviewSubmission: { state: "pending" },
        },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: expect.stringContaining("reserved") });
    const visibleRuns = await fixture.app.db
      .select({ id: messages.id, metadata: messages.metadata })
      .from(messages)
      .where(eq(messages.chatId, fixture.chatId));
    expect(visibleRuns.filter((message) => typeof message.metadata.contextReviewRunId === "string")).toEqual([
      expect.objectContaining({ id: fixture.messageId }),
    ]);
    await expect(
      submitContextReviewOutcome({
        db: fixture.app.db,
        chatId: fixture.chatId,
        runId: fixture.runId,
        callerAgentUuid: fixture.reviewer.uuid,
        callerClientId: fixture.admin.clientId,
        callerRuntimeSessionToken: fixture.runtimeToken,
        request: { reviewedHead: "a".repeat(40), event: "APPROVE", body: "Real run remains current" },
        appCredentials: fixture.app.config.oauth?.githubApp,
        fetcher: successfulGithubFetcher(),
      }),
    ).resolves.toMatchObject({ action: "APPROVE" });
  });

  it("accepts a valid runtime-session request through the narrow agent route", async () => {
    const fixture = await createRunFixture(getApp());
    const runtimeToken = await bindAgentRuntimeSession(fixture.app.db, fixture.reviewer.uuid, fixture.admin.clientId);
    vi.stubGlobal("fetch", successfulGithubFetcher());

    const response = await fixture.app.inject({
      method: "POST",
      url: `/api/v1/agent/chats/${fixture.chatId}/context-review-runs/${fixture.runId}/submit`,
      headers: {
        authorization: `Bearer ${fixture.admin.accessToken}`,
        [AGENT_SELECTOR_HEADER]: fixture.reviewer.uuid,
        [AGENT_RUNTIME_SESSION_HEADER]: runtimeToken,
      },
      payload: { reviewedHead: "a".repeat(40), event: "APPROVE", body: "Approved" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ action: "APPROVE", appActor: "test-app-slug[bot]" });
  });

  it.each([
    {
      name: "installation disconnect and rebind",
      code: "CONTEXT_REVIEW_APP_NOT_INSTALLED",
      mutate: async (fixture: RunFixture) => {
        const [installation] = await fixture.app.db
          .select({ installationId: githubAppInstallations.installationId })
          .from(githubAppInstallations)
          .where(eq(githubAppInstallations.hubOrganizationId, fixture.admin.organizationId));
        if (!installation) throw new Error("missing installation");
        await disconnectInstallationFromOrg(fixture.app.db, fixture.admin.organizationId);
        const replacementInstallationId = installation.installationId + 1;
        await upsertInstallationFromMetadata(fixture.app.db, {
          installation: {
            id: replacementInstallationId,
            accountType: "Organization",
            accountLogin: "replacement-owner",
            accountGithubId: replacementInstallationId,
            permissions: { metadata: "read", pull_requests: "write" },
            events: ["pull_request"],
            suspendedAt: null,
          },
          hubOrganizationId: fixture.admin.organizationId,
        });
        await bindInstallationToOrg(fixture.app.db, replacementInstallationId, fixture.admin.organizationId);
      },
    },
    {
      name: "installation permission downgrade",
      code: "CONTEXT_REVIEW_APP_PERMISSION_REQUIRED",
      mutate: async (fixture: RunFixture) => {
        await fixture.app.db
          .update(githubAppInstallations)
          .set({ permissions: { metadata: "read", pull_requests: "read" } })
          .where(eq(githubAppInstallations.hubOrganizationId, fixture.admin.organizationId));
      },
    },
    {
      name: "installation suspension",
      code: "CONTEXT_REVIEW_APP_NOT_INSTALLED",
      mutate: async (fixture: RunFixture) => {
        await fixture.app.db
          .update(githubAppInstallations)
          .set({ suspendedAt: new Date() })
          .where(eq(githubAppInstallations.hubOrganizationId, fixture.admin.organizationId));
      },
    },
    {
      name: "client retirement",
      code: "CONTEXT_REVIEW_RUN_FORBIDDEN",
      mutate: async (fixture: RunFixture) => {
        await fixture.app.db
          .update(clients)
          .set({ retiredAt: new Date() })
          .where(eq(clients.id, fixture.admin.clientId));
      },
    },
    {
      name: "runtime-session revocation",
      code: "CONTEXT_REVIEW_RUN_FORBIDDEN",
      mutate: async (fixture: RunFixture) => {
        await revokeAgentRuntimeSession(fixture.app.db, fixture.reviewer.uuid, fixture.admin.clientId);
      },
    },
    {
      name: "configured reviewer replacement",
      code: "CONTEXT_REVIEW_RUN_FORBIDDEN",
      mutate: async (fixture: RunFixture) => {
        const replacement = await createAgent(fixture.app.db, {
          name: `replacement-${randomUUID().slice(0, 8)}`,
          type: "agent",
          displayName: "Replacement Context Reviewer",
          managerId: fixture.admin.memberId,
          clientId: fixture.admin.clientId,
        });
        await putOrgSetting(
          fixture.app.db,
          fixture.admin.organizationId,
          "context_tree_features",
          { contextReviewer: { enabled: true, agentUuid: replacement.uuid } },
          { updatedBy: fixture.admin.userId, memberId: fixture.admin.memberId },
        );
      },
    },
    {
      name: "manager membership removal",
      code: "CONTEXT_REVIEW_RUN_FORBIDDEN",
      mutate: async (fixture: RunFixture) => {
        await fixture.app.db.update(members).set({ status: "removed" }).where(eq(members.id, fixture.admin.memberId));
      },
    },
  ])("revalidates $name at the durable publication claim", async ({ code, mutate }) => {
    const fixture = await createRunFixture(getApp());
    const fetcher = successfulGithubFetcher({ beforePullRequestResponse: () => mutate(fixture) });

    await expect(
      submitContextReviewOutcome({
        db: fixture.app.db,
        chatId: fixture.chatId,
        runId: fixture.runId,
        callerAgentUuid: fixture.reviewer.uuid,
        callerClientId: fixture.admin.clientId,
        callerRuntimeSessionToken: fixture.runtimeToken,
        request: { reviewedHead: "a".repeat(40), event: "APPROVE", body: "Approved" },
        appCredentials: fixture.app.config.oauth?.githubApp,
        fetcher,
      }),
    ).rejects.toMatchObject({ code });
    expect(fetcher.mock.calls.some(([url, init]) => String(url).endsWith("/reviews") && init?.method === "POST")).toBe(
      false,
    );
    const [message] = await fixture.app.db
      .select({ metadata: messages.metadata })
      .from(messages)
      .where(eq(messages.id, fixture.messageId));
    expect(message?.metadata.contextReviewSubmission).toEqual({ state: "pending" });
  });

  it("allows one logical outcome under concurrent duplicate submissions", async () => {
    const fixture = await createRunFixture(getApp());
    const fetcher = successfulGithubFetcher();
    const input = {
      db: fixture.app.db,
      chatId: fixture.chatId,
      runId: fixture.runId,
      callerAgentUuid: fixture.reviewer.uuid,
      callerClientId: fixture.admin.clientId,
      callerRuntimeSessionToken: fixture.runtimeToken,
      request: { reviewedHead: "a".repeat(40), event: "APPROVE" as const, body: "Approved" },
      appCredentials: fixture.app.config.oauth?.githubApp,
      fetcher,
    };

    const results = await Promise.allSettled([submitContextReviewOutcome(input), submitContextReviewOutcome(input)]);
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    expect(
      fetcher.mock.calls.filter(([url, init]) => String(url).endsWith("/reviews") && init?.method === "POST"),
    ).toHaveLength(1);
  });

  it.each([
    { newerEvent: "REQUEST_CHANGES" as const, olderEvent: "APPROVE" as const },
    { newerEvent: "APPROVE" as const, olderEvent: "REQUEST_CHANGES" as const },
  ])("rejects a late $olderEvent from a superseded run after newer $newerEvent", async (events) => {
    const fixture = await createRunFixture(getApp());
    const newer = await createFollowUpRun(fixture);
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
        runId: newer.runId,
        request: { reviewedHead: "a".repeat(40), event: events.newerEvent, body: "Newer outcome" },
      }),
    ).resolves.toMatchObject({ action: events.newerEvent });
    await expect(
      submitContextReviewOutcome({
        ...common,
        runId: fixture.runId,
        request: { reviewedHead: "a".repeat(40), event: events.olderEvent, body: "Late older outcome" },
      }),
    ).rejects.toMatchObject({ code: "CONTEXT_REVIEW_RUN_SUPERSEDED" });

    const reviewPosts = fetcher.mock.calls.filter(
      ([url, init]) => String(url).endsWith("/reviews") && init?.method === "POST",
    );
    expect(reviewPosts).toHaveLength(1);
    expect(JSON.parse(String(reviewPosts[0]?.[1]?.body))).toMatchObject({ event: events.newerEvent });
  });

  it("blocks a new run while an App review publication is in flight", async () => {
    const fixture = await createRunFixture(getApp());
    const baseFetcher = successfulGithubFetcher();
    let releasePost: () => void = () => undefined;
    let markPostStarted: () => void = () => undefined;
    const postGate = new Promise<void>((resolve) => {
      releasePost = resolve;
    });
    const postStarted = new Promise<void>((resolve) => {
      markPostStarted = resolve;
    });
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("/reviews") && init?.method === "POST") {
        markPostStarted();
        await postGate;
      }
      return baseFetcher(url, init);
    });

    const olderSubmission = submitContextReviewOutcome({
      db: fixture.app.db,
      chatId: fixture.chatId,
      runId: fixture.runId,
      callerAgentUuid: fixture.reviewer.uuid,
      callerClientId: fixture.admin.clientId,
      callerRuntimeSessionToken: fixture.runtimeToken,
      request: { reviewedHead: "a".repeat(40), event: "APPROVE", body: "Older run approved" },
      appCredentials: fixture.app.config.oauth?.githubApp,
      fetcher,
    });
    await postStarted;

    await expect(createFollowUpRun(fixture)).rejects.toThrow("unresolved GitHub review delivery");
    const visibleRuns = await fixture.app.db
      .select({ id: messages.id, metadata: messages.metadata })
      .from(messages)
      .where(eq(messages.chatId, fixture.chatId));
    expect(visibleRuns.filter((message) => typeof message.metadata.contextReviewRunId === "string")).toHaveLength(1);

    releasePost();
    await expect(olderSubmission).resolves.toMatchObject({ action: "APPROVE" });
    const newer = await createFollowUpRun(fixture);
    await expect(
      submitContextReviewOutcome({
        db: fixture.app.db,
        chatId: fixture.chatId,
        runId: newer.runId,
        callerAgentUuid: fixture.reviewer.uuid,
        callerClientId: fixture.admin.clientId,
        callerRuntimeSessionToken: fixture.runtimeToken,
        request: { reviewedHead: "a".repeat(40), event: "REQUEST_CHANGES", body: "Newer run blocks" },
        appCredentials: fixture.app.config.oauth?.githubApp,
        fetcher,
      }),
    ).resolves.toMatchObject({ action: "REQUEST_CHANGES" });

    const events = fetcher.mock.calls
      .filter(([url, init]) => String(url).endsWith("/reviews") && init?.method === "POST")
      .map(([, init]) => JSON.parse(String(init?.body)).event);
    expect(events).toEqual(["APPROVE", "REQUEST_CHANGES"]);
  });

  it("does not let a sender edit roll back server-owned submission metadata", async () => {
    const fixture = await createRunFixture(getApp());
    const fetcher = successfulGithubFetcher();
    const [submission, edit] = await Promise.allSettled([
      submitContextReviewOutcome({
        db: fixture.app.db,
        chatId: fixture.chatId,
        runId: fixture.runId,
        callerAgentUuid: fixture.reviewer.uuid,
        callerClientId: fixture.admin.clientId,
        callerRuntimeSessionToken: fixture.runtimeToken,
        request: { reviewedHead: "a".repeat(40), event: "APPROVE", body: "Approved" },
        appCredentials: fixture.app.config.oauth?.githubApp,
        fetcher,
      }),
      editMessage(fixture.app.db, fixture.chatId, fixture.messageId, fixture.admin.humanAgentUuid, {
        content: "Edited task body",
      }),
    ]);

    expect(submission.status).toBe("fulfilled");
    expect(edit).toMatchObject({ status: "rejected", reason: { statusCode: 403 } });
    const [message] = await fixture.app.db
      .select({ metadata: messages.metadata })
      .from(messages)
      .where(eq(messages.id, fixture.messageId));
    expect(message?.metadata.contextReviewSubmission).toMatchObject({ state: "submitted" });
    expect(
      fetcher.mock.calls.filter(([url, init]) => String(url).endsWith("/reviews") && init?.method === "POST"),
    ).toHaveLength(1);
  });

  it("reconciles an unknown write by marker without repeating the review POST", async () => {
    const fixture = await createRunFixture(getApp());
    const fetcher = unknownThenReconciledGithubFetcher(fixture.runId);
    const input = {
      db: fixture.app.db,
      chatId: fixture.chatId,
      runId: fixture.runId,
      callerAgentUuid: fixture.reviewer.uuid,
      callerClientId: fixture.admin.clientId,
      callerRuntimeSessionToken: fixture.runtimeToken,
      request: { reviewedHead: "a".repeat(40), event: "COMMENT" as const, body: "Deferred" },
      appCredentials: fixture.app.config.oauth?.githubApp,
      fetcher,
    };

    await expect(submitContextReviewOutcome(input)).rejects.toMatchObject({ code: "CONTEXT_REVIEW_GITHUB_UNKNOWN" });
    await expect(submitContextReviewOutcome(input)).resolves.toMatchObject({ action: "COMMENT", reviewId: 9002 });
    expect(
      fetcher.mock.calls.filter(([url, init]) => String(url).endsWith("/reviews") && init?.method === "POST"),
    ).toHaveLength(1);
    const [message] = await fixture.app.db
      .select({ metadata: messages.metadata })
      .from(messages)
      .where(eq(messages.id, fixture.messageId));
    expect(message?.metadata.contextReviewSubmission).toMatchObject({
      state: "submitted",
      reviewerClientId: fixture.admin.clientId,
    });
  });

  it("normalizes uppercase reviewed heads before unknown-write reconciliation", async () => {
    const fixture = await createRunFixture(getApp());
    const fetcher = unknownThenReconciledGithubFetcher(fixture.runId);
    const input = {
      db: fixture.app.db,
      chatId: fixture.chatId,
      runId: fixture.runId,
      callerAgentUuid: fixture.reviewer.uuid,
      callerClientId: fixture.admin.clientId,
      callerRuntimeSessionToken: fixture.runtimeToken,
      request: { reviewedHead: "A".repeat(40), event: "COMMENT" as const, body: "Deferred" },
      appCredentials: fixture.app.config.oauth?.githubApp,
      fetcher,
    };

    await expect(submitContextReviewOutcome(input)).rejects.toMatchObject({ code: "CONTEXT_REVIEW_GITHUB_UNKNOWN" });
    await expect(submitContextReviewOutcome(input)).resolves.toMatchObject({ action: "COMMENT", reviewId: 9002 });
    const [message] = await fixture.app.db
      .select({ metadata: messages.metadata })
      .from(messages)
      .where(eq(messages.id, fixture.messageId));
    expect(message?.metadata.contextReviewSubmission).toMatchObject({
      state: "submitted",
      reviewedHead: "a".repeat(40),
    });
  });

  it("reconciles a durable submitting claim after a lost process without a second review POST", async () => {
    const fixture = await createRunFixture(getApp());
    const request = { reviewedHead: "a".repeat(40), event: "COMMENT" as const, body: "Deferred" };
    await setRunSubmission(fixture, {
      state: "submitting",
      payloadHash: reviewPayloadHash(request),
      attemptId: randomUUID(),
      reviewedHead: request.reviewedHead,
      event: request.event,
      claimedAt: new Date().toISOString(),
      reviewerClientId: fixture.admin.clientId,
    });
    const fetcher = unknownThenReconciledGithubFetcher(fixture.runId);

    await expect(
      submitContextReviewOutcome({
        db: fixture.app.db,
        chatId: fixture.chatId,
        runId: fixture.runId,
        callerAgentUuid: fixture.reviewer.uuid,
        callerClientId: fixture.admin.clientId,
        callerRuntimeSessionToken: fixture.runtimeToken,
        request,
        appCredentials: fixture.app.config.oauth?.githubApp,
        fetcher,
      }),
    ).resolves.toMatchObject({ action: "COMMENT", reviewId: 9002 });
    expect(
      fetcher.mock.calls.filter(([url, init]) => String(url).endsWith("/reviews") && init?.method === "POST"),
    ).toHaveLength(0);
  });

  it("allows a synchronize run to supersede an unresolved old-head delivery", async () => {
    const fixture = await createRunFixture(getApp());
    await setRunSubmission(fixture, unresolvedSubmission("a".repeat(40), fixture.admin.clientId));

    const newer = await handleContextReviewerPrEvent(fixture.app, {
      eventType: "pull_request",
      organizationId: fixture.admin.organizationId,
      payload: synchronizePayload("b".repeat(40)),
    });

    expect(newer).toMatchObject({ handled: true, reused: true });
    if (!newer.handled) throw new Error("new run missing");
    const [message] = await fixture.app.db.select().from(messages).where(eq(messages.id, newer.messageId));
    expect(message?.metadata.contextReviewBlockedByRunId).toBe(fixture.runId);
  });

  it("reconciles the old-head marker before publishing the blocked new-head verdict", async () => {
    const fixture = await createRunFixture(getApp());
    await setRunSubmission(fixture, unresolvedSubmission("a".repeat(40), fixture.admin.clientId));
    const newer = await createSynchronizeRun(fixture, "b".repeat(40));
    const fetcher = blockingReviewReconciledGithubFetcher(fixture.runId);

    await expect(
      submitContextReviewOutcome({
        db: fixture.app.db,
        chatId: fixture.chatId,
        runId: newer.runId,
        callerAgentUuid: fixture.reviewer.uuid,
        callerClientId: fixture.admin.clientId,
        callerRuntimeSessionToken: fixture.runtimeToken,
        request: { reviewedHead: "b".repeat(40), event: "REQUEST_CHANGES", body: "New-head outcome" },
        appCredentials: fixture.app.config.oauth?.githubApp,
        fetcher,
      }),
    ).resolves.toMatchObject({ action: "REQUEST_CHANGES" });

    const [oldMessage] = await fixture.app.db
      .select({ metadata: messages.metadata })
      .from(messages)
      .where(eq(messages.id, fixture.messageId));
    expect(oldMessage?.metadata.contextReviewSubmission).toMatchObject({
      state: "submitted",
      event: "APPROVE",
      reviewedHead: "a".repeat(40),
    });
    const reviewPosts = fetcher.mock.calls.filter(
      ([url, init]) => String(url).endsWith("/reviews") && init?.method === "POST",
    );
    expect(reviewPosts).toHaveLength(1);
    expect(JSON.parse(String(reviewPosts[0]?.[1]?.body))).toMatchObject({
      commit_id: "b".repeat(40),
      event: "REQUEST_CHANGES",
    });
  });

  it.each([
    { oldEvent: "REQUEST_CHANGES" as const, newEvent: "APPROVE" as const },
    { oldEvent: "APPROVE" as const, newEvent: "REQUEST_CHANGES" as const },
  ])("publishes new-head $newEvent only after a late old-head $oldEvent has landed", async (events) => {
    const fixture = await createRunFixture(getApp());
    const github = sequencedGithubFetcher();
    const common = {
      db: fixture.app.db,
      chatId: fixture.chatId,
      callerAgentUuid: fixture.reviewer.uuid,
      callerClientId: fixture.admin.clientId,
      callerRuntimeSessionToken: fixture.runtimeToken,
      appCredentials: fixture.app.config.oauth?.githubApp,
      fetcher: github.fetcher,
    };
    const oldSubmission = submitContextReviewOutcome({
      ...common,
      runId: fixture.runId,
      request: { reviewedHead: "a".repeat(40), event: events.oldEvent, body: "Old-head outcome" },
    });
    await github.oldPostStarted;

    github.setCurrentHead("b".repeat(40));
    const newer = await createSynchronizeRun(fixture, "b".repeat(40));
    await expect(
      submitContextReviewOutcome({
        ...common,
        runId: newer.runId,
        request: { reviewedHead: "b".repeat(40), event: events.newEvent, body: "New-head outcome" },
      }),
    ).rejects.toMatchObject({ code: "CONTEXT_REVIEW_GITHUB_UNKNOWN" });
    expect(github.startedEvents).toEqual([events.oldEvent]);

    github.releaseOldPost();
    await expect(oldSubmission).resolves.toMatchObject({ action: events.oldEvent });
    await expect(
      submitContextReviewOutcome({
        ...common,
        runId: newer.runId,
        request: { reviewedHead: "b".repeat(40), event: events.newEvent, body: "New-head outcome" },
      }),
    ).resolves.toMatchObject({ action: events.newEvent });
    expect(github.completedEvents).toEqual([events.oldEvent, events.newEvent]);
  });

  it("blocks a synchronize run while the same-head delivery is unresolved", async () => {
    const fixture = await createRunFixture(getApp());
    await setRunSubmission(fixture, unresolvedSubmission("a".repeat(40), fixture.admin.clientId));

    await expect(
      handleContextReviewerPrEvent(fixture.app, {
        eventType: "pull_request",
        organizationId: fixture.admin.organizationId,
        payload: synchronizePayload("a".repeat(40)),
      }),
    ).rejects.toThrow("unresolved GitHub review delivery for this head");
  });

  it("fails closed when the installation permission snapshot is not upgraded", async () => {
    const fixture = await createRunFixture(getApp());
    const [installation] = await import("../db/schema/github-app-installations.js").then(({ githubAppInstallations }) =>
      fixture.app.db
        .select()
        .from(githubAppInstallations)
        .where(eq(githubAppInstallations.hubOrganizationId, fixture.admin.organizationId)),
    );
    if (!installation) throw new Error("missing installation");
    const { githubAppInstallations } = await import("../db/schema/github-app-installations.js");
    await fixture.app.db
      .update(githubAppInstallations)
      .set({ permissions: { pull_requests: "read", metadata: "read" } })
      .where(eq(githubAppInstallations.id, installation.id));

    await expect(
      submitContextReviewOutcome({
        db: fixture.app.db,
        chatId: fixture.chatId,
        runId: fixture.runId,
        callerAgentUuid: fixture.reviewer.uuid,
        callerClientId: fixture.admin.clientId,
        callerRuntimeSessionToken: fixture.runtimeToken,
        request: { reviewedHead: "a".repeat(40), event: "COMMENT", body: "Deferred" },
        appCredentials: fixture.app.config.oauth?.githubApp,
        fetcher: successfulGithubFetcher(),
      }),
    ).rejects.toMatchObject({ code: "CONTEXT_REVIEW_APP_PERMISSION_REQUIRED" });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

type RunFixture = Awaited<ReturnType<typeof createRunFixture>>;

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
  const runtimeToken = await bindAgentRuntimeSession(app.db, reviewer.uuid, admin.clientId);
  await upsertInstallationFromMetadata(app.db, {
    installation: {
      id: Number(`8${Math.floor(Math.random() * 1_000_000)}`),
      accountType: "Organization",
      accountLogin: "owner",
      accountGithubId: Math.floor(Math.random() * 1_000_000_000),
      permissions: { metadata: "read", pull_requests: "write" },
      events: ["pull_request"],
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
  const legacy = await createChat(app.db, {
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
    .where(eq(chats.id, legacy.chat.id));
  const result = await handleContextReviewerPrEvent(app, {
    eventType: "pull_request",
    organizationId: admin.organizationId,
    payload: {
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
    },
  });
  if (!result.handled) throw new Error("review run was not created");
  const [message] = await app.db.select().from(messages).where(eq(messages.id, result.messageId));
  const runId = message?.metadata.contextReviewRunId;
  if (typeof runId !== "string") throw new Error("run id missing");
  return { app, admin, reviewer, runtimeToken, chatId: result.chatId, messageId: result.messageId, runId };
}

async function setRunSubmission(
  fixture: Awaited<ReturnType<typeof createRunFixture>>,
  submission: Record<string, unknown>,
) {
  await fixture.app.db
    .update(messages)
    .set({
      metadata: sql`jsonb_set(${messages.metadata}, '{contextReviewSubmission}', ${JSON.stringify(submission)}::jsonb)`,
    })
    .where(eq(messages.id, fixture.messageId));
}

function unresolvedSubmission(reviewedHead: string, reviewerClientId: string) {
  const request = { reviewedHead, event: "APPROVE" as const, body: "Approved" };
  return {
    state: "unknown",
    payloadHash: reviewPayloadHash(request),
    attemptId: randomUUID(),
    reviewedHead,
    event: request.event,
    failedAt: new Date().toISOString(),
    reviewerClientId,
  };
}

function reviewPayloadHash(request: { reviewedHead: string; event: string; body: string }) {
  return createHash("sha256")
    .update(JSON.stringify([request.reviewedHead.toLowerCase(), request.event, request.body]))
    .digest("hex");
}

function synchronizePayload(headSha: string) {
  return {
    action: "synchronize",
    pull_request: {
      number: 123,
      title: "Review Context",
      html_url: "https://github.com/owner/context-tree/pull/123",
      base: { ref: "main" },
      head: { ref: "change", sha: headSha },
      draft: false,
      user: { login: "writer", type: "User" },
    },
    repository: { full_name: "owner/context-tree" },
    sender: { login: "writer", type: "User" },
  };
}

async function createSynchronizeRun(fixture: Awaited<ReturnType<typeof createRunFixture>>, headSha: string) {
  const result = await handleContextReviewerPrEvent(fixture.app, {
    eventType: "pull_request",
    organizationId: fixture.admin.organizationId,
    payload: synchronizePayload(headSha),
  });
  if (!result.handled) throw new Error("synchronize review run was not created");
  const [message] = await fixture.app.db.select().from(messages).where(eq(messages.id, result.messageId));
  const runId = message?.metadata.contextReviewRunId;
  if (typeof runId !== "string") throw new Error("synchronize run id missing");
  return { runId, messageId: result.messageId };
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
        body: "Please review the current head again.",
      },
      repository: { full_name: "owner/context-tree" },
      sender: { login: "commenter", type: "User" },
    },
  });
  if (!result.handled) throw new Error("follow-up review run was not created");
  const [message] = await fixture.app.db.select().from(messages).where(eq(messages.id, result.messageId));
  const runId = message?.metadata.contextReviewRunId;
  if (typeof runId !== "string") throw new Error("follow-up run id missing");
  return { runId, messageId: result.messageId };
}

function successfulGithubFetcher(
  overrides: { headSha?: string; body?: string; beforePullRequestResponse?: () => Promise<void> } = {},
) {
  let preflightHookRan = false;
  return vi.fn<typeof fetch>(async (url, init) => {
    const target = String(url);
    if (target.endsWith("/access_tokens")) {
      return new Response(
        JSON.stringify({
          token: "installation-token",
          expires_at: "2026-07-15T18:00:00Z",
          permissions: { metadata: "read", pull_requests: "write" },
          repository_selection: "selected",
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }
    if (target.endsWith("/pulls/123") && (!init?.method || init.method === "GET")) {
      if (!preflightHookRan && overrides.beforePullRequestResponse) {
        preflightHookRan = true;
        await overrides.beforePullRequestResponse();
      }
      return new Response(
        JSON.stringify({
          number: 123,
          state: "open",
          draft: false,
          merged: false,
          merged_at: null,
          head: { sha: overrides.headSha ?? "a".repeat(40) },
          html_url: "https://github.com/owner/context-tree/pull/123",
          body: overrides.body ?? "",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (target.endsWith("/pulls/123/reviews") && init?.method === "POST") {
      return new Response(
        JSON.stringify({
          id: 9001,
          html_url: "https://github.com/owner/context-tree/pull/123#pullrequestreview-9001",
          user: { login: "test-app-slug[bot]" },
          commit_id: "a".repeat(40),
          body: "approved",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("not found", { status: 404 });
  });
}

function sequencedGithubFetcher() {
  let currentHead = "a".repeat(40);
  let releaseOldPost: () => void = () => undefined;
  let markOldPostStarted: () => void = () => undefined;
  const oldPostGate = new Promise<void>((resolve) => {
    releaseOldPost = resolve;
  });
  const oldPostStarted = new Promise<void>((resolve) => {
    markOldPostStarted = resolve;
  });
  const reviews: Array<Record<string, unknown>> = [];
  const startedEvents: string[] = [];
  const completedEvents: string[] = [];
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const target = String(url);
    if (target.endsWith("/access_tokens")) {
      return new Response(
        JSON.stringify({
          token: "installation-token",
          expires_at: "2026-07-15T18:00:00Z",
          permissions: { metadata: "read", pull_requests: "write" },
          repository_selection: "selected",
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }
    if (target.endsWith("/pulls/123") && (!init?.method || init.method === "GET")) {
      return new Response(
        JSON.stringify({
          number: 123,
          state: "open",
          draft: false,
          merged: false,
          merged_at: null,
          head: { sha: currentHead },
          html_url: "https://github.com/owner/context-tree/pull/123",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (target.endsWith("/pulls/123/reviews") && init?.method === "POST") {
      const payload = JSON.parse(String(init.body)) as { commit_id: string; event: string; body: string };
      startedEvents.push(payload.event);
      if (payload.commit_id === "a".repeat(40)) {
        markOldPostStarted();
        await oldPostGate;
      }
      const state =
        payload.event === "APPROVE"
          ? "APPROVED"
          : payload.event === "REQUEST_CHANGES"
            ? "CHANGES_REQUESTED"
            : "COMMENTED";
      const review = {
        id: 9100 + reviews.length,
        html_url: `https://github.com/owner/context-tree/pull/123#pullrequestreview-${9100 + reviews.length}`,
        user: { login: "test-app-slug[bot]" },
        commit_id: payload.commit_id,
        body: payload.body,
        state,
      };
      reviews.push(review);
      completedEvents.push(payload.event);
      return new Response(JSON.stringify(review), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (target.endsWith("/pulls/123/reviews?per_page=100")) {
      return new Response(JSON.stringify(reviews), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  });
  return {
    fetcher,
    oldPostStarted,
    startedEvents,
    completedEvents,
    setCurrentHead(head: string) {
      currentHead = head;
    },
    releaseOldPost,
  };
}

function unknownThenReconciledGithubFetcher(runId: string) {
  return vi.fn<typeof fetch>(async (url, init) => {
    const target = String(url);
    if (target.endsWith("/access_tokens")) {
      return new Response(
        JSON.stringify({
          token: "installation-token",
          expires_at: "2026-07-15T18:00:00Z",
          permissions: { metadata: "read", pull_requests: "write" },
          repository_selection: "selected",
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }
    if (target.endsWith("/pulls/123") && (!init?.method || init.method === "GET")) {
      return new Response(
        JSON.stringify({
          number: 123,
          state: "open",
          draft: false,
          merged: false,
          head: { sha: "a".repeat(40) },
          html_url: "https://github.com/owner/context-tree/pull/123",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (target.endsWith("/pulls/123/reviews") && init?.method === "POST") {
      throw new TypeError("socket closed after request dispatch");
    }
    if (target.endsWith("/pulls/123/reviews?per_page=100")) {
      return new Response(
        JSON.stringify([
          {
            id: 9002,
            html_url: "https://github.com/owner/context-tree/pull/123#pullrequestreview-9002",
            user: { login: "test-app-slug[bot]" },
            commit_id: "a".repeat(40),
            body: `Deferred\n\n<!-- first-tree-context-review-run:${runId} -->`,
            state: "COMMENTED",
          },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("not found", { status: 404 });
  });
}

function blockingReviewReconciledGithubFetcher(runId: string) {
  return vi.fn<typeof fetch>(async (url, init) => {
    const target = String(url);
    if (target.endsWith("/access_tokens")) {
      return new Response(
        JSON.stringify({
          token: "installation-token",
          expires_at: "2026-07-15T18:00:00Z",
          permissions: { metadata: "read", pull_requests: "write" },
          repository_selection: "selected",
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }
    if (target.endsWith("/pulls/123") && (!init?.method || init.method === "GET")) {
      return new Response(
        JSON.stringify({
          number: 123,
          state: "open",
          draft: false,
          merged: false,
          merged_at: null,
          head: { sha: "b".repeat(40) },
          html_url: "https://github.com/owner/context-tree/pull/123",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (target.endsWith("/pulls/123/reviews?per_page=100")) {
      return new Response(
        JSON.stringify([
          {
            id: 9200,
            html_url: "https://github.com/owner/context-tree/pull/123#pullrequestreview-9200",
            user: { login: "test-app-slug[bot]" },
            commit_id: "a".repeat(40),
            body: `Approved\n\n<!-- first-tree-context-review-run:${runId} -->`,
            state: "APPROVED",
          },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (target.endsWith("/pulls/123/reviews") && init?.method === "POST") {
      const payload = JSON.parse(String(init.body)) as { commit_id: string; event: string; body: string };
      return new Response(
        JSON.stringify({
          id: 9201,
          html_url: "https://github.com/owner/context-tree/pull/123#pullrequestreview-9201",
          user: { login: "test-app-slug[bot]" },
          commit_id: payload.commit_id,
          body: payload.body,
          state: "CHANGES_REQUESTED",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("not found", { status: 404 });
  });
}
