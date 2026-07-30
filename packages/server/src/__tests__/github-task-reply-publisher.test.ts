import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import {
  AGENT_RUNTIME_SESSION_HEADER,
  AGENT_SELECTOR_HEADER,
  GITHUB_TASK_REPLY_BODY_MAX_BYTES,
  githubTaskReplyRequestSchema,
} from "@first-tree/shared";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chatMembership } from "../db/schema/chat-membership.js";
import { githubAppInstallations } from "../db/schema/github-app-installations.js";
import { messages } from "../db/schema/messages.js";
import { createAgent } from "../services/agent.js";
import { bindAgentRuntimeSession } from "../services/agent-runtime-session.js";
import { createChat } from "../services/chat.js";
import { upsertInstallationFromMetadata } from "../services/github-app-installations.js";
import { submitGithubTaskReply } from "../services/github-task-reply-publisher.js";
import { sendMessage } from "../services/message.js";
import { putOrgSetting } from "../services/org-settings.js";
import { putTeamAgentAssignment } from "../services/team-agent-settings.js";
import { createAdminContext, seedHealthyAgentRuntime, useTestApp } from "./helpers.js";

const { privateKey: privateKeyPem } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

describe("GitHub App task reply publisher", () => {
  const getApp = useTestApp({ githubAppPrivateKeyPem: privateKeyPem, runtimeHttpTokenEnforcement: false });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("publishes one App-authored Issue comment, returns it idempotently, and rejects a changed payload", async () => {
    const fixture = await createRunFixture(getApp());
    const fetcher = successfulGithubFetcher(fixture.runId);
    const input = publishInput(fixture, fetcher, "Completed the requested work.\n");

    const first = await submitGithubTaskReply(input);
    const second = await submitGithubTaskReply(input);

    expect(second).toEqual(first);
    expect(first).toEqual({
      commentId: 901,
      commentUrl: "https://github.com/owner/repo/issues/42#issuecomment-901",
      appActor: "test-app-slug[bot]",
    });
    const posts = githubCommentPosts(fetcher);
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0]?.[1]?.body))).toEqual({
      body: `Completed the requested work.\n\n<!-- first-tree-github-task-reply-run:${fixture.runId} -->`,
    });
    await expect(
      submitGithubTaskReply({ ...input, request: { body: "A different terminal result." } }),
    ).rejects.toMatchObject({ code: "GITHUB_TASK_REPLY_RUN_PAYLOAD_MISMATCH" });

    const [message] = await fixture.app.db
      .select({ metadata: messages.metadata })
      .from(messages)
      .where(eq(messages.id, fixture.messageId));
    expect(message?.metadata.githubTaskReplySubmission).toMatchObject({
      state: "submitted",
      publisherAgentUuid: fixture.agent.uuid,
      publisherClientId: fixture.admin.clientId,
      commentId: 901,
    });
  });

  it("accepts the exact composed GitHub comment boundary and rejects one extra user byte before GitHub", async () => {
    const acceptedFixture = await createRunFixture(getApp());
    const acceptedFetcher = successfulGithubFetcher(acceptedFixture.runId);
    await expect(
      submitGithubTaskReply(
        publishInput(acceptedFixture, acceptedFetcher, "x".repeat(GITHUB_TASK_REPLY_BODY_MAX_BYTES)),
      ),
    ).resolves.toMatchObject({ commentId: 901 });
    const [post] = githubCommentPosts(acceptedFetcher);
    const postedBody = JSON.parse(String(post?.[1]?.body)) as { body: string };
    expect(Buffer.byteLength(postedBody.body, "utf8")).toBe(64 * 1024);

    expect(
      githubTaskReplyRequestSchema.safeParse({
        body: "x".repeat(GITHUB_TASK_REPLY_BODY_MAX_BYTES + 1),
      }),
    ).toMatchObject({
      success: false,
      error: { issues: [expect.objectContaining({ message: expect.stringContaining("body must not exceed") })] },
    });

    const multibyteBoundary =
      "界".repeat(Math.floor(GITHUB_TASK_REPLY_BODY_MAX_BYTES / 3)) + "x".repeat(GITHUB_TASK_REPLY_BODY_MAX_BYTES % 3);
    expect(Buffer.byteLength(multibyteBoundary, "utf8")).toBe(GITHUB_TASK_REPLY_BODY_MAX_BYTES);
    expect(githubTaskReplyRequestSchema.safeParse({ body: multibyteBoundary })).toMatchObject({ success: true });
    expect(githubTaskReplyRequestSchema.safeParse({ body: `${multibyteBoundary}界` })).toMatchObject({
      success: false,
    });
  });

  it("serializes concurrent same-payload claims to one comment and lets a later retry read the result", async () => {
    const fixture = await createRunFixture(getApp());
    let releasePost: (() => void) | undefined;
    let markPostStarted: (() => void) | undefined;
    const postStarted = new Promise<void>((resolve) => {
      markPostStarted = resolve;
    });
    const postGate = new Promise<void>((resolve) => {
      releasePost = resolve;
    });
    const fetcher = successfulGithubFetcher(fixture.runId, "issues", async () => {
      markPostStarted?.();
      await postGate;
    });
    const input = publishInput(fixture, fetcher, "Concurrent outcome.");

    const winner = submitGithubTaskReply(input);
    await postStarted;
    await expect(submitGithubTaskReply(input)).rejects.toMatchObject({
      code: "GITHUB_TASK_REPLY_GITHUB_UNKNOWN",
    });
    expect(githubCommentPosts(fetcher)).toHaveLength(1);

    releasePost?.();
    const result = await winner;
    await expect(submitGithubTaskReply(input)).resolves.toEqual(result);
    expect(githubCommentPosts(fetcher)).toHaveLength(1);
  });

  it("reconciles a persisted App comment when Cloud state remains submitting after its record write failed", async () => {
    const fixture = await createRunFixture(getApp());
    const body = "Deferred outcome";
    const payloadHash = createHash("sha256")
      .update(JSON.stringify(["owner/repo", "issue", 42, body]))
      .digest("hex");
    const [row] = await fixture.app.db
      .select({ metadata: messages.metadata })
      .from(messages)
      .where(eq(messages.id, fixture.messageId));
    await fixture.app.db
      .update(messages)
      .set({
        metadata: {
          ...row?.metadata,
          githubTaskReplySubmission: {
            state: "submitting",
            payloadHash,
            attemptId: randomUUID(),
            claimedAt: new Date().toISOString(),
            publisherClientId: fixture.admin.clientId,
          },
        },
      })
      .where(eq(messages.id, fixture.messageId));
    const fetcher = unknownThenReconciledGithubFetcher(fixture.runId);

    await expect(submitGithubTaskReply(publishInput(fixture, fetcher, body))).resolves.toMatchObject({
      commentId: 902,
      appActor: "test-app-slug[bot]",
    });
    expect(githubCommentPosts(fetcher)).toHaveLength(0);
    const [reconciled] = await fixture.app.db
      .select({ metadata: messages.metadata })
      .from(messages)
      .where(eq(messages.id, fixture.messageId));
    expect(reconciled?.metadata.githubTaskReplySubmission).toMatchObject({
      state: "submitted",
      payloadHash,
      commentId: 902,
    });
  });

  it("rejects a concurrently changed payload without a second comment POST", async () => {
    const fixture = await createRunFixture(getApp());
    let releasePost: (() => void) | undefined;
    let markPostStarted: (() => void) | undefined;
    const postStarted = new Promise<void>((resolve) => {
      markPostStarted = resolve;
    });
    const postGate = new Promise<void>((resolve) => {
      releasePost = resolve;
    });
    const fetcher = successfulGithubFetcher(fixture.runId, "issues", async () => {
      markPostStarted?.();
      await postGate;
    });
    const winnerInput = publishInput(fixture, fetcher, "First immutable outcome.");
    const changedInput = publishInput(fixture, fetcher, "Conflicting outcome.");

    const winner = submitGithubTaskReply(winnerInput);
    await postStarted;
    await expect(submitGithubTaskReply(changedInput)).rejects.toMatchObject({
      code: "GITHUB_TASK_REPLY_RUN_PAYLOAD_MISMATCH",
    });
    expect(githubCommentPosts(fetcher)).toHaveLength(1);

    releasePost?.();
    await winner;
    await expect(submitGithubTaskReply(changedInput)).rejects.toMatchObject({
      code: "GITHUB_TASK_REPLY_RUN_PAYLOAD_MISMATCH",
    });
    expect(githubCommentPosts(fetcher)).toHaveLength(1);
  });

  it("publishes a pull-request conversation comment with only pull-request write authority", async () => {
    const fixture = await createRunFixture(getApp(), { entityType: "pull_request" });
    const fetcher = successfulGithubFetcher(fixture.runId, "pull_requests");
    await expect(submitGithubTaskReply(publishInput(fixture, fetcher))).resolves.toMatchObject({
      commentId: 901,
      appActor: "test-app-slug[bot]",
    });
    const tokenRequest = fetcher.mock.calls.find(([url]) => String(url).endsWith("/access_tokens"));
    expect(JSON.parse(String(tokenRequest?.[1]?.body))).toEqual({
      repositories: ["repo"],
      permissions: { metadata: "read", pull_requests: "write" },
    });
    expect(githubCommentPosts(fetcher)).toHaveLength(1);
  });

  it("lets the Context Reviewer use only the ordinary comment publisher for a bound-repo App task", async () => {
    const fixture = await createRunFixture(getApp(), { entityType: "pull_request", contextRepository: true });
    const fetcher = successfulGithubFetcher(fixture.runId, "pull_requests");
    await expect(
      submitGithubTaskReply(publishInput(fixture, fetcher, "Ordinary task outcome.")),
    ).resolves.toMatchObject({
      commentId: 901,
    });
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/reviews"))).toBe(false);
    expect(githubCommentPosts(fetcher)).toHaveLength(1);
  });

  it("requires the exact Agent, active runtime proof, and original chat route", async () => {
    const fixture = await createRunFixture(getApp());
    const fetcher = successfulGithubFetcher(fixture.runId);
    await expect(
      submitGithubTaskReply({
        ...publishInput(fixture, fetcher),
        callerAgentUuid: "another-agent",
      }),
    ).rejects.toMatchObject({ code: "GITHUB_TASK_REPLY_RUN_FORBIDDEN" });
    await expect(
      submitGithubTaskReply({
        ...publishInput(fixture, fetcher),
        callerRuntimeSessionToken: "invalid",
      }),
    ).rejects.toMatchObject({ code: "GITHUB_TASK_REPLY_RUN_FORBIDDEN" });
    await expect(
      submitGithubTaskReply({
        ...publishInput(fixture, fetcher),
        chatId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "GITHUB_TASK_REPLY_RUN_NOT_FOUND" });
    expect(fetcher).not.toHaveBeenCalled();

    const missingProof = await fixture.app.inject({
      method: "POST",
      url: `/api/v1/agent/chats/${fixture.chatId}/github-task-runs/${fixture.runId}/reply`,
      headers: {
        authorization: `Bearer ${fixture.admin.accessToken}`,
        [AGENT_SELECTOR_HEADER]: fixture.agent.uuid,
      },
      payload: { body: "Done" },
    });
    expect(missingProof.statusCode).toBe(403);
    expect(missingProof.json()).toMatchObject({ code: "GITHUB_TASK_REPLY_RUNTIME_SESSION_REQUIRED" });

    vi.stubGlobal("fetch", successfulGithubFetcher(fixture.runId));
    const accepted = await fixture.app.inject({
      method: "POST",
      url: `/api/v1/agent/chats/${fixture.chatId}/github-task-runs/${fixture.runId}/reply`,
      headers: {
        authorization: `Bearer ${fixture.admin.accessToken}`,
        [AGENT_SELECTOR_HEADER]: fixture.agent.uuid,
        [AGENT_RUNTIME_SESSION_HEADER]: fixture.runtimeToken,
      },
      payload: { body: "Done" },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ appActor: "test-app-slug[bot]" });
  });

  it("rejects a stale rebound runtime proof and revoked original-chat speaker membership before GitHub", async () => {
    const fixture = await createRunFixture(getApp());
    const fetcher = successfulGithubFetcher(fixture.runId);
    const successorToken = await bindAgentRuntimeSession(fixture.app.db, fixture.agent.uuid, fixture.admin.clientId);

    await expect(submitGithubTaskReply(publishInput(fixture, fetcher))).rejects.toMatchObject({
      code: "GITHUB_TASK_REPLY_RUN_FORBIDDEN",
    });
    await fixture.app.db
      .update(chatMembership)
      .set({ accessMode: "watcher" })
      .where(and(eq(chatMembership.chatId, fixture.chatId), eq(chatMembership.agentId, fixture.agent.uuid)));
    await expect(
      submitGithubTaskReply({
        ...publishInput(fixture, fetcher),
        callerRuntimeSessionToken: successorToken,
      }),
    ).rejects.toMatchObject({ code: "GITHUB_TASK_REPLY_RUN_FORBIDDEN" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("serializes a concurrent speaker removal ahead of the publication claim", async () => {
    const fixture = await createRunFixture(getApp());
    let markMembershipLocked: (() => void) | undefined;
    let releaseRevocation: (() => void) | undefined;
    const membershipLocked = new Promise<void>((resolve) => {
      markMembershipLocked = resolve;
    });
    const revocationGate = new Promise<void>((resolve) => {
      releaseRevocation = resolve;
    });
    const revocation = fixture.app.db.transaction(async (tx) => {
      await tx
        .select({ agentId: chatMembership.agentId })
        .from(chatMembership)
        .where(and(eq(chatMembership.chatId, fixture.chatId), eq(chatMembership.agentId, fixture.agent.uuid)))
        .for("update");
      markMembershipLocked?.();
      await revocationGate;
      await tx
        .delete(chatMembership)
        .where(and(eq(chatMembership.chatId, fixture.chatId), eq(chatMembership.agentId, fixture.agent.uuid)));
    });
    await membershipLocked;

    const fetcher = successfulGithubFetcher(fixture.runId);
    const publication = submitGithubTaskReply(publishInput(fixture, fetcher));
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseRevocation?.();
    await revocation;

    await expect(publication).rejects.toMatchObject({ code: "GITHUB_TASK_REPLY_RUN_FORBIDDEN" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("revokes publication when the selected GitHub Task Agent or installation permission changes", async () => {
    const fixture = await createRunFixture(getApp());
    const replacement = await createAgent(fixture.app.db, {
      name: `replacement-${randomUUID().slice(0, 8)}`,
      type: "agent",
      displayName: "Replacement",
      managerId: fixture.admin.memberId,
      clientId: fixture.admin.clientId,
    });
    await seedHealthyAgentRuntime(fixture.app, {
      agentUuid: replacement.uuid,
      clientId: fixture.admin.clientId,
    });
    await putTeamAgentAssignment(fixture.app.db, fixture.admin.organizationId, replacement.uuid, {
      updatedBy: fixture.admin.userId,
      appSlug: "test-app-slug",
    });
    await expect(
      submitGithubTaskReply(publishInput(fixture, successfulGithubFetcher(fixture.runId))),
    ).rejects.toMatchObject({ code: "GITHUB_TASK_REPLY_RUN_FORBIDDEN" });

    await putTeamAgentAssignment(fixture.app.db, fixture.admin.organizationId, fixture.agent.uuid, {
      updatedBy: fixture.admin.userId,
      appSlug: "test-app-slug",
    });
    await fixture.app.db
      .update(githubAppInstallations)
      .set({ permissions: { metadata: "read", issues: "read", pull_requests: "write" } })
      .where(eq(githubAppInstallations.hubOrganizationId, fixture.admin.organizationId));
    await expect(
      submitGithubTaskReply(publishInput(fixture, successfulGithubFetcher(fixture.runId))),
    ).rejects.toMatchObject({ code: "GITHUB_TASK_REPLY_APP_PERMISSION_REQUIRED" });
  });

  it("fails closed before token mint when the installation is suspended", async () => {
    const fixture = await createRunFixture(getApp());
    await fixture.app.db
      .update(githubAppInstallations)
      .set({ suspendedAt: new Date() })
      .where(eq(githubAppInstallations.hubOrganizationId, fixture.admin.organizationId));
    const fetcher = successfulGithubFetcher(fixture.runId);

    await expect(submitGithubTaskReply(publishInput(fixture, fetcher))).rejects.toMatchObject({
      code: "GITHUB_TASK_REPLY_APP_NOT_INSTALLED",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ["token", 403, "GITHUB_TASK_REPLY_APP_PERMISSION_REQUIRED"],
    ["token", 404, "GITHUB_TASK_REPLY_REPO_NOT_ACCESSIBLE"],
    ["comment", 403, "GITHUB_TASK_REPLY_APP_PERMISSION_REQUIRED"],
    ["comment", 404, "GITHUB_TASK_REPLY_REPO_NOT_ACCESSIBLE"],
    ["comment", 422, "GITHUB_TASK_REPLY_GITHUB_REJECTED"],
    ["comment", 503, "GITHUB_TASK_REPLY_GITHUB_UNKNOWN"],
  ] as const)("maps GitHub %s status %s to stable fail-closed code %s", async (phase, status, code) => {
    const fixture = await createRunFixture(getApp());
    const fetcher = failingGithubFetcher(phase, status);

    await expect(submitGithubTaskReply(publishInput(fixture, fetcher))).rejects.toMatchObject({ code });
    expect(githubCommentPosts(fetcher)).toHaveLength(phase === "comment" ? 1 : 0);
  });

  it("rejects App mentions and reserved hidden markers before GitHub comment mutation", async () => {
    const fixture = await createRunFixture(getApp());
    const fetcher = successfulGithubFetcher(fixture.runId);
    await expect(
      submitGithubTaskReply(publishInput(fixture, fetcher, "Thanks @test-app-slug, done.")),
    ).rejects.toMatchObject({ code: "GITHUB_TASK_REPLY_INVALID_REQUEST" });
    await expect(
      submitGithubTaskReply(
        publishInput(fixture, fetcher, `Done\n<!-- first-tree-github-task-reply-run:${fixture.runId} -->`),
      ),
    ).rejects.toThrow(/reserved GitHub task reply run marker/);
    expect(githubCommentPosts(fetcher)).toHaveLength(0);
  });

  it("reconciles an unknown App write by actor, marker, and exact body without blind replay", async () => {
    const fixture = await createRunFixture(getApp());
    const fetcher = unknownThenReconciledGithubFetcher(fixture.runId);
    const input = publishInput(fixture, fetcher, "Deferred outcome  \n");

    await expect(submitGithubTaskReply(input)).rejects.toMatchObject({ code: "GITHUB_TASK_REPLY_GITHUB_UNKNOWN" });
    await expect(submitGithubTaskReply(input)).resolves.toMatchObject({
      commentId: 902,
      appActor: "test-app-slug[bot]",
    });
    expect(githubCommentPosts(fetcher)).toHaveLength(1);
  });

  it.each([
    "zero",
    "duplicate",
    "list_failure",
  ] as const)("keeps an unknown write unresolved for %s reconciliation without another POST", async (mode) => {
    const fixture = await createRunFixture(getApp());
    const fetcher = unresolvedGithubFetcher(fixture.runId, mode);
    const input = publishInput(fixture, fetcher, "Deferred outcome");

    await expect(submitGithubTaskReply(input)).rejects.toMatchObject({
      code: "GITHUB_TASK_REPLY_GITHUB_UNKNOWN",
    });
    await expect(submitGithubTaskReply(input)).rejects.toMatchObject({
      code: "GITHUB_TASK_REPLY_GITHUB_UNKNOWN",
    });
    await expect(submitGithubTaskReply(input)).rejects.toMatchObject({
      code: "GITHUB_TASK_REPLY_GITHUB_UNKNOWN",
    });
    expect(githubCommentPosts(fetcher)).toHaveLength(1);
  });

  it.each([
    "wrong_actor",
    "wrong_body",
    "invalid_id",
    "invalid_url",
  ] as const)("keeps an unverifiable successful POST with %s in unknown state and never blindly posts again", async (mode) => {
    const fixture = await createRunFixture(getApp());
    const fetcher = mismatchedSuccessGithubFetcher(fixture.runId, mode);
    const input = publishInput(fixture, fetcher, "Exact outcome");

    await expect(submitGithubTaskReply(input)).rejects.toMatchObject({
      code: "GITHUB_TASK_REPLY_GITHUB_UNKNOWN",
    });
    await expect(submitGithubTaskReply(input)).rejects.toMatchObject({
      code: "GITHUB_TASK_REPLY_GITHUB_UNKNOWN",
    });
    expect(githubCommentPosts(fetcher)).toHaveLength(1);
    const [message] = await fixture.app.db
      .select({ metadata: messages.metadata })
      .from(messages)
      .where(eq(messages.id, fixture.messageId));
    expect(message?.metadata.githubTaskReplySubmission).toMatchObject({
      state: "unknown",
      publisherClientId: fixture.admin.clientId,
    });
  });

  it.each([
    {
      label: "wrong organization",
      mutate: (metadata: Record<string, unknown>) => {
        metadata.githubTaskOrganizationId = randomUUID();
      },
    },
    {
      label: "wrong repository",
      mutate: (metadata: Record<string, unknown>) => {
        metadata.githubTaskRepository = "owner/another-repo";
      },
    },
    {
      label: "wrong entity",
      mutate: (metadata: Record<string, unknown>) => {
        metadata.githubTaskEntityNumber = 43;
      },
    },
  ])("rejects $label provenance before GitHub", async ({ mutate }) => {
    const fixture = await createRunFixture(getApp());
    const [row] = await fixture.app.db
      .select({ metadata: messages.metadata })
      .from(messages)
      .where(eq(messages.id, fixture.messageId));
    const metadata = { ...row?.metadata };
    mutate(metadata);
    await fixture.app.db.update(messages).set({ metadata }).where(eq(messages.id, fixture.messageId));

    const fetcher = successfulGithubFetcher(fixture.runId);
    await expect(submitGithubTaskReply(publishInput(fixture, fetcher))).rejects.toMatchObject({
      code: "GITHUB_TASK_REPLY_RUN_FORBIDDEN",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    "boolean",
    "recipient_only",
  ] as const)("rejects a %s legacy task marker as App publication authority", async (marker) => {
    const fixture = await createRunFixture(getApp());
    const [row] = await fixture.app.db
      .select({ content: messages.content, metadata: messages.metadata })
      .from(messages)
      .where(eq(messages.id, fixture.messageId));
    const teamAgentTask = marker === "boolean" ? true : { agentUuid: fixture.agent.uuid };
    await fixture.app.db
      .update(messages)
      .set({
        content: { ...(row?.content as Record<string, unknown>), teamAgentTask },
        metadata: { ...row?.metadata, teamAgentTask },
      })
      .where(eq(messages.id, fixture.messageId));

    const fetcher = successfulGithubFetcher(fixture.runId);
    await expect(submitGithubTaskReply(publishInput(fixture, fetcher))).rejects.toMatchObject({
      code: "GITHUB_TASK_REPLY_RUN_FORBIDDEN",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not allow an ordinary message sender to author reserved GitHub task run provenance", async () => {
    const fixture = await createRunFixture(getApp());
    await expect(
      sendMessage(fixture.app.db, fixture.chatId, fixture.admin.humanAgentUuid, {
        source: "api",
        format: "text",
        content: "spoof",
        metadata: {
          mentions: [fixture.agent.uuid],
          teamAgentTask: { agentUuid: fixture.agent.uuid, runId: "spoof" },
          githubTaskRun: true,
          githubTaskRunId: "spoof",
          githubTaskAgentUuid: fixture.agent.uuid,
        },
      }),
    ).rejects.toThrow(/reserved for server-authored GitHub task reply runs/);
  });
});

async function createRunFixture(
  app: ReturnType<ReturnType<typeof useTestApp>>,
  options: { entityType?: "issue" | "pull_request"; contextRepository?: boolean } = {},
) {
  const admin = await createAdminContext(app);
  const agent = await createAgent(app.db, {
    name: `team-agent-${randomUUID().slice(0, 8)}`,
    type: "agent",
    displayName: "GitHub Task Agent",
    managerId: admin.memberId,
    clientId: admin.clientId,
  });
  await seedHealthyAgentRuntime(app, { agentUuid: agent.uuid, clientId: admin.clientId });
  const runtimeToken = await bindAgentRuntimeSession(app.db, agent.uuid, admin.clientId);
  await upsertInstallationFromMetadata(app.db, {
    installation: {
      id: Number(`8${Math.floor(Math.random() * 1_000_000)}`),
      accountType: "Organization",
      accountLogin: "owner",
      accountGithubId: Math.floor(Math.random() * 1_000_000_000),
      permissions: { metadata: "read", issues: "write", pull_requests: "write" },
      events: ["issues", "issue_comment", "pull_request"],
      suspendedAt: null,
    },
    hubOrganizationId: admin.organizationId,
  });
  if (options.contextRepository) {
    await putOrgSetting(
      app.db,
      admin.organizationId,
      "context_tree",
      { provider: "github", repo: "https://github.com/owner/repo.git", branch: "main" },
      { updatedBy: admin.userId },
    );
    await putOrgSetting(
      app.db,
      admin.organizationId,
      "context_tree_features",
      { contextReviewer: { enabled: true, agentUuid: agent.uuid } },
      { updatedBy: admin.userId, memberId: admin.memberId },
    );
  } else {
    await putTeamAgentAssignment(app.db, admin.organizationId, agent.uuid, {
      updatedBy: admin.userId,
      appSlug: "test-app-slug",
    });
  }
  const chat = await createChat(app.db, admin.humanAgentUuid, {
    type: "group",
    participantIds: [agent.uuid],
  });
  const runId = randomUUID();
  const entityType = options.entityType ?? "issue";
  const entityUrl = `https://github.com/owner/repo/${entityType === "issue" ? "issues" : "pull"}/42`;
  const { message } = await sendMessage(
    app.db,
    chat.id,
    admin.humanAgentUuid,
    {
      source: "github",
      format: "card",
      content: {
        type: "github_event",
        reason: "mentioned",
        event: entityType === "issue" ? "issues" : "pull_request",
        action: "opened",
        kind: "commented",
        repository: "owner/repo",
        sender: "requester",
        title: "Task",
        body: "@test-app-slug do it",
        url: entityUrl,
        entity: { type: entityType, key: "owner/repo#42", url: entityUrl },
        teamAgentTask: { agentUuid: agent.uuid, runId },
      },
      metadata: {
        mentions: [agent.uuid],
        source: "github",
        systemSender: "github",
        teamAgentTask: { agentUuid: agent.uuid, runId },
        githubTaskRun: true,
        githubTaskRunId: runId,
        githubTaskOrganizationId: admin.organizationId,
        githubTaskAgentUuid: agent.uuid,
        githubTaskManagerHumanAgentId: admin.humanAgentUuid,
        githubTaskRepository: "owner/repo",
        githubTaskEntityType: entityType,
        githubTaskEntityNumber: 42,
        githubTaskEntityUrl: entityUrl,
        githubTaskReplySubmission: { state: "pending" },
      },
    },
    { allowSystemSender: true, allowGithubTaskRun: true },
  );
  return { app, admin, agent, runtimeToken, chatId: chat.id, messageId: message.id, runId };
}

function publishInput(
  fixture: Awaited<ReturnType<typeof createRunFixture>>,
  fetcher: ReturnType<typeof vi.fn<typeof fetch>>,
  body = "Done",
) {
  return {
    db: fixture.app.db,
    chatId: fixture.chatId,
    runId: fixture.runId,
    callerAgentUuid: fixture.agent.uuid,
    callerClientId: fixture.admin.clientId,
    callerRuntimeSessionToken: fixture.runtimeToken,
    request: { body },
    appCredentials: fixture.app.config.oauth?.githubApp,
    fetcher,
  };
}

function successfulGithubFetcher(
  runId: string,
  permission: "issues" | "pull_requests" = "issues",
  beforePost?: () => Promise<void>,
) {
  return vi.fn<typeof fetch>(async (url, init) => {
    const target = String(url);
    if (target.endsWith("/access_tokens")) {
      return jsonResponse(
        {
          token: "installation-token",
          expires_at: "2026-12-15T18:00:00Z",
          permissions: { metadata: "read", [permission]: "write" },
          repository_selection: "selected",
        },
        201,
      );
    }
    if (target.endsWith("/issues/42/comments") && init?.method === "POST") {
      await beforePost?.();
      const payload = JSON.parse(String(init.body)) as { body: string };
      expect(payload.body).toContain(`first-tree-github-task-reply-run:${runId}`);
      return jsonResponse({
        id: 901,
        html_url: "https://github.com/owner/repo/issues/42#issuecomment-901",
        user: { login: "test-app-slug[bot]" },
        body: payload.body,
      });
    }
    return new Response("not found", { status: 404 });
  });
}

function failingGithubFetcher(phase: "token" | "comment", status: number) {
  return vi.fn<typeof fetch>(async (url, init) => {
    const target = String(url);
    if (target.endsWith("/access_tokens")) {
      if (phase === "token") return new Response("rejected", { status });
      return jsonResponse(
        {
          token: "installation-token",
          expires_at: "2026-12-15T18:00:00Z",
          permissions: { metadata: "read", issues: "write" },
          repository_selection: "selected",
        },
        201,
      );
    }
    if (target.endsWith("/issues/42/comments") && init?.method === "POST") {
      return new Response("rejected", { status });
    }
    return new Response("not found", { status: 404 });
  });
}

function unresolvedGithubFetcher(runId: string, mode: "zero" | "duplicate" | "list_failure") {
  return vi.fn<typeof fetch>(async (url, init) => {
    const target = String(url);
    if (target.endsWith("/access_tokens")) {
      return jsonResponse(
        {
          token: "installation-token",
          expires_at: "2026-12-15T18:00:00Z",
          permissions: { metadata: "read", issues: "write" },
          repository_selection: "selected",
        },
        201,
      );
    }
    if (target.endsWith("/issues/42/comments") && init?.method === "POST") {
      throw new TypeError("socket closed after request dispatch");
    }
    if (target.endsWith("/issues/42/comments?per_page=100")) {
      if (mode === "list_failure") return new Response("unavailable", { status: 503 });
      if (mode === "zero") return jsonResponse([]);
      const body = `Deferred outcome\n\n<!-- first-tree-github-task-reply-run:${runId} -->`;
      return jsonResponse([
        {
          id: 903,
          html_url: "https://github.com/owner/repo/issues/42#issuecomment-903",
          user: { login: "test-app-slug[bot]" },
          body,
        },
        {
          id: 904,
          html_url: "https://github.com/owner/repo/issues/42#issuecomment-904",
          user: { login: "test-app-slug[bot]" },
          body,
        },
      ]);
    }
    return new Response("not found", { status: 404 });
  });
}

function mismatchedSuccessGithubFetcher(
  runId: string,
  mode: "wrong_actor" | "wrong_body" | "invalid_id" | "invalid_url",
) {
  const expectedBody = `Exact outcome\n\n<!-- first-tree-github-task-reply-run:${runId} -->`;
  const comment = {
    id: mode === "invalid_id" ? 0 : 905,
    html_url: mode === "invalid_url" ? "not-a-url" : "https://github.com/owner/repo/issues/42#issuecomment-905",
    user: { login: mode === "wrong_actor" ? "another-app[bot]" : "test-app-slug[bot]" },
    body: mode === "wrong_body" ? `${expectedBody}\nmutated` : expectedBody,
  };
  return vi.fn<typeof fetch>(async (url, init) => {
    const target = String(url);
    if (target.endsWith("/access_tokens")) {
      return jsonResponse(
        {
          token: "installation-token",
          expires_at: "2026-12-15T18:00:00Z",
          permissions: { metadata: "read", issues: "write" },
          repository_selection: "selected",
        },
        201,
      );
    }
    if (target.endsWith("/issues/42/comments") && init?.method === "POST") return jsonResponse(comment, 201);
    if (target.endsWith("/issues/42/comments?per_page=100")) return jsonResponse([comment]);
    return new Response("not found", { status: 404 });
  });
}

function unknownThenReconciledGithubFetcher(runId: string) {
  return vi.fn<typeof fetch>(async (url, init) => {
    const target = String(url);
    if (target.endsWith("/access_tokens")) {
      return jsonResponse(
        {
          token: "installation-token",
          expires_at: "2026-12-15T18:00:00Z",
          permissions: { metadata: "read", issues: "write" },
          repository_selection: "selected",
        },
        201,
      );
    }
    if (target.endsWith("/issues/42/comments") && init?.method === "POST") {
      throw new TypeError("socket closed after request dispatch");
    }
    if (target.endsWith("/issues/42/comments?per_page=100")) {
      return jsonResponse([
        {
          id: 902,
          html_url: "https://github.com/owner/repo/issues/42#issuecomment-902",
          user: { login: "test-app-slug[bot]" },
          body: `Deferred outcome\n\n<!-- first-tree-github-task-reply-run:${runId} -->`,
        },
      ]);
    }
    return new Response("not found", { status: 404 });
  });
}

function githubCommentPosts(fetcher: ReturnType<typeof vi.fn<typeof fetch>>) {
  return fetcher.mock.calls.filter(
    ([url, init]) => String(url).endsWith("/issues/42/comments") && init?.method === "POST",
  );
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
