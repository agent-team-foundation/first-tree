import { createHash } from "node:crypto";
import {
  AGENT_VISIBILITY,
  GITHUB_TASK_REPLY_RUN_MARKER_PREFIX,
  type GithubTaskReplyRequest,
  type GithubTaskReplyResponse,
  type GithubTaskReplySubmissionState,
  githubEventCardSchema,
  githubTaskReplyRequestSchema,
  githubTaskRunMessageMetadataSchema,
  isRuntimeProviderEnabled,
  runtimeProviderSchema,
} from "@first-tree/shared";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chats } from "../db/schema/chats.js";
import { clients } from "../db/schema/clients.js";
import { githubAppInstallations } from "../db/schema/github-app-installations.js";
import { members } from "../db/schema/members.js";
import { messages } from "../db/schema/messages.js";
import { organizations } from "../db/schema/organizations.js";
import { uuidv7 } from "../uuid.js";
import { agentNotLandingCampaignTrialCondition } from "./access-control.js";
import { validateAgentRuntimeSession } from "./agent-runtime-session.js";
import { normalizeGithubRepo } from "./context-reviewer-pr.js";
import {
  createAppJwt,
  createIssueComment,
  GithubAppApiError,
  type GithubAppCredentials,
  type GithubIssueComment,
  listIssueCommentsForRun,
  mintInstallationToken,
} from "./github-app.js";
import { isGithubAppTargetLogin } from "./github-audience.js";
import { extractMentions } from "./github-normalize.js";
import {
  claimGithubTaskReplyPublication,
  findPublishedGithubTaskReply,
  releaseGithubTaskReplyPublication,
} from "./github-task-reply-publication-claim.js";
import { getOrgContextReviewRuntime } from "./org-settings.js";
import { getTeamAgentUuid } from "./team-agent-settings.js";

type SubmissionState = GithubTaskReplySubmissionState;

type RunFacts = {
  messageId: string;
  chatId: string;
  runId: string;
  organizationId: string;
  repository: string;
  entityType: "issue" | "pull_request";
  entityNumber: number;
  entityUrl: string;
  agentUuid: string;
  managerHumanAgentId: string;
  submission: SubmissionState;
};

export class GithubTaskReplyPublisherError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GithubTaskReplyPublisherError";
  }
}

export async function submitGithubTaskReply(input: {
  db: Database;
  chatId: string;
  runId: string;
  callerAgentUuid: string;
  callerClientId: string;
  callerRuntimeSessionToken: string;
  request: GithubTaskReplyRequest;
  appCredentials: (GithubAppCredentials & { slug?: string }) | undefined;
  fetcher?: typeof fetch;
}): Promise<GithubTaskReplyResponse> {
  const parsed = githubTaskReplyRequestSchema.parse(input.request);
  const request = { body: parsed.body.trimEnd() };

  const inspection = await input.db.transaction(async (rawTx) => {
    const db = rawTx as unknown as Database;
    const snapshot = await loadRunFacts(db, input.chatId, input.runId);
    authorizeRun(snapshot, input.callerAgentUuid);
    const orderingValid = await lockPublisherAuthorityRowsBeforeChat(db, snapshot, {
      callerAgentUuid: input.callerAgentUuid,
      callerClientId: input.callerClientId,
    });
    await lockRunChat(db, input.chatId);
    const run = await loadRunFacts(db, input.chatId, input.runId);
    assertSameRunAuthority(snapshot, run);
    authorizeRun(run, input.callerAgentUuid);

    if (run.submission.state === "submitted") {
      if (run.submission.payloadHash !== hashPayload(run, request.body)) throw payloadMismatch();
      return { kind: "submitted" as const, response: submittedResponse(run.submission) };
    }
    if (run.submission.state === "failed") throw alreadySubmitted();
    if (!orderingValid) throw forbidden("The task Agent runtime changed before App reply publication.");

    const current = await assertCurrentAuthority(db, run, {
      callerAgentUuid: input.callerAgentUuid,
      callerClientId: input.callerClientId,
      runtimeSessionToken: input.callerRuntimeSessionToken,
    });
    if (run.submission.state === "submitting") {
      const payloadHash = hashPayload(run, request.body);
      if (run.submission.payloadHash !== payloadHash) throw payloadMismatch();
      return {
        kind: "reconcile" as const,
        run,
        body: request.body,
        payloadHash,
        publisherClientId: run.submission.publisherClientId,
        current,
      };
    }
    if (run.submission.state === "unknown") {
      const payloadHash = hashPayload(run, request.body);
      if (run.submission.payloadHash !== payloadHash) throw payloadMismatch();
      return {
        kind: "reconcile" as const,
        run,
        body: request.body,
        payloadHash,
        publisherClientId: run.submission.publisherClientId,
        current,
      };
    }
    return { kind: "pending" as const, run, current };
  });
  if (inspection.kind === "submitted") return inspection.response;
  if (input.appCredentials?.slug) {
    assertNoAppMention(request.body, input.appCredentials.slug);
  }

  const github = await prepareGithubPublisher({
    run: inspection.run,
    installationId: inspection.current.installationId,
    appCredentials: input.appCredentials,
    fetcher: input.fetcher,
  });

  if (inspection.kind === "reconcile") {
    return reconcileUnknownSubmission({
      db: input.db,
      run: inspection.run,
      runId: input.runId,
      body: inspection.body,
      payloadHash: inspection.payloadHash,
      publisherClientId: inspection.publisherClientId,
      github,
      fetcher: input.fetcher,
    });
  }

  const payloadHash = hashPayload(inspection.run, request.body);
  const claim = await input.db.transaction(async (rawTx) => {
    const db = rawTx as unknown as Database;
    const snapshot = await loadRunFacts(db, input.chatId, input.runId);
    authorizeRun(snapshot, input.callerAgentUuid);
    const orderingValid = await lockPublisherAuthorityRowsBeforeChat(db, snapshot, {
      callerAgentUuid: input.callerAgentUuid,
      callerClientId: input.callerClientId,
    });
    await lockRunChat(db, input.chatId);
    const run = await loadRunFacts(db, input.chatId, input.runId);
    assertSameRunAuthority(snapshot, run);
    authorizeRun(run, input.callerAgentUuid);
    if (!orderingValid) throw forbidden("The task Agent runtime changed before App reply publication.");
    await assertCurrentAuthority(db, run, {
      callerAgentUuid: input.callerAgentUuid,
      callerClientId: input.callerClientId,
      runtimeSessionToken: input.callerRuntimeSessionToken,
      expectedInstallationId: inspection.current.installationId,
    });

    if (run.submission.state === "submitted") {
      if (run.submission.payloadHash !== payloadHash) throw payloadMismatch();
      return { kind: "submitted" as const, response: submittedResponse(run.submission) };
    }
    if (run.submission.state === "failed") throw alreadySubmitted();
    if (run.submission.state === "submitting") {
      if (run.submission.payloadHash !== payloadHash) throw payloadMismatch();
      return {
        kind: "reconcile" as const,
        run,
        publisherClientId: run.submission.publisherClientId,
      };
    }
    if (run.submission.state === "unknown") {
      if (run.submission.payloadHash !== payloadHash) throw payloadMismatch();
      return {
        kind: "reconcile" as const,
        run,
        publisherClientId: run.submission.publisherClientId,
      };
    }

    // Cross-run guard, taken before this run claims itself. Run-scoped
    // idempotency cannot see a sibling run dispatched for the same entity, so
    // without this every duplicate or concurrent dispatch published its own
    // identical comment. Losing leaves the run `pending` — it is a retryable
    // loss, not a terminal one — and the caller resolves it against GitHub.
    if (!(await claimGithubTaskReplyPublication(db, { organizationId: run.organizationId, payloadHash }))) {
      return { kind: "duplicate" as const, run };
    }

    const attemptId = uuidv7();
    const claimed = await setSubmissionIf(db, run.messageId, "pending", {
      state: "submitting",
      payloadHash,
      attemptId,
      claimedAt: new Date().toISOString(),
      publisherClientId: input.callerClientId,
    });
    if (!claimed) throw alreadySubmitted();
    return { kind: "claimed" as const, run, attemptId };
  });
  if (claim.kind === "submitted") return claim.response;
  if (claim.kind === "duplicate") {
    throw await duplicatePublication({
      db: input.db,
      run: claim.run,
      payloadHash,
      body: request.body,
      github,
      fetcher: input.fetcher,
    });
  }
  if (claim.kind === "reconcile") {
    return reconcileUnknownSubmission({
      db: input.db,
      run: claim.run,
      runId: input.runId,
      body: request.body,
      payloadHash,
      publisherClientId: claim.publisherClientId,
      github,
      fetcher: input.fetcher,
    });
  }

  let comment: GithubIssueComment;
  try {
    comment = await createIssueComment(
      github.token,
      {
        owner: github.owner,
        repo: github.repo,
        issueNumber: claim.run.entityNumber,
        body: replyBody(request.body, input.runId),
      },
      { fetcher: input.fetcher },
    );
  } catch (error) {
    if (isUnknownGithubWrite(error)) {
      await setSubmissionForAttempt(input.db, claim.run.messageId, claim.attemptId, {
        state: "unknown",
        payloadHash,
        attemptId: claim.attemptId,
        failedAt: new Date().toISOString(),
        publisherClientId: input.callerClientId,
      });
      throw new GithubTaskReplyPublisherError(
        502,
        "GITHUB_TASK_REPLY_GITHUB_UNKNOWN",
        "GitHub comment delivery is unknown. This run will reconcile the exact hidden marker before any retry.",
      );
    }
    const mapped = mapGithubMutationError(error);
    // GitHub definitively refused the write, so no comment exists and the
    // reply must become publishable again. Released only on this branch —
    // an unknown outcome keeps the claim so nobody republishes behind a
    // comment that may already be live.
    await releaseGithubTaskReplyPublication(input.db, {
      organizationId: claim.run.organizationId,
      payloadHash,
    });
    await setSubmissionForAttempt(input.db, claim.run.messageId, claim.attemptId, {
      state: "failed",
      payloadHash,
      code: mapped.code,
      failedAt: new Date().toISOString(),
    });
    throw mapped;
  }

  const expectedCommentBody = replyBody(request.body, input.runId);
  if (comment.actor !== `${github.appSlug}[bot]` || comment.body !== expectedCommentBody) {
    await setSubmissionForAttempt(input.db, claim.run.messageId, claim.attemptId, {
      state: "unknown",
      payloadHash,
      attemptId: claim.attemptId,
      failedAt: new Date().toISOString(),
      publisherClientId: input.callerClientId,
    });
    throw new GithubTaskReplyPublisherError(
      502,
      "GITHUB_TASK_REPLY_GITHUB_UNKNOWN",
      "GitHub returned a comment whose App actor or immutable reply payload could not be verified. Reconciliation is required.",
    );
  }

  const submitted = submissionFromComment({
    payloadHash,
    comment,
    run: claim.run,
    callerClientId: input.callerClientId,
  });
  const recorded = await setSubmissionForAttempt(input.db, claim.run.messageId, claim.attemptId, submitted).catch(
    () => false,
  );
  if (!recorded) {
    throw new GithubTaskReplyPublisherError(
      502,
      "GITHUB_TASK_REPLY_GITHUB_UNKNOWN",
      "GitHub accepted the App comment but Cloud could not record it. Reconciliation is required.",
    );
  }
  return submittedResponse(submitted);
}

async function lockRunChat(db: Database, chatId: string): Promise<void> {
  const [chat] = await db.select({ id: chats.id }).from(chats).where(eq(chats.id, chatId)).for("update").limit(1);
  if (!chat) throw notFound();
}

async function loadRunFacts(db: Database, chatId: string, runId: string): Promise<RunFacts> {
  const rows = await db
    .select({
      messageId: messages.id,
      messageSource: messages.source,
      messageFormat: messages.format,
      messageContent: messages.content,
      messageMetadata: messages.metadata,
      chatId: messages.chatId,
      organizationId: chats.organizationId,
    })
    .from(messages)
    .innerJoin(chats, eq(chats.id, messages.chatId))
    .where(
      and(
        eq(messages.chatId, chatId),
        eq(messages.source, "github"),
        sql`${messages.metadata}->>'githubTaskRunId' = ${runId}`,
      ),
    )
    .limit(2);
  if (rows.length !== 1) throw notFound();
  const row = rows[0];
  if (!row) throw notFound();
  const metadata = githubTaskRunMessageMetadataSchema.safeParse(row.messageMetadata);
  const card = githubEventCardSchema.safeParse(row.messageContent);
  if (!metadata.success || !card.success || row.messageFormat !== "card") {
    throw forbidden("GitHub task reply run provenance is invalid.");
  }
  const task = card.data.teamAgentTask;
  if (
    task === true ||
    !task ||
    !("runId" in task) ||
    task.runId !== metadata.data.githubTaskRunId ||
    task.agentUuid !== metadata.data.githubTaskAgentUuid ||
    row.messageMetadata.systemSender !== "github" ||
    row.messageMetadata.teamAgentTask === true ||
    typeof row.messageMetadata.teamAgentTask !== "object" ||
    row.messageMetadata.teamAgentTask === null ||
    Reflect.get(row.messageMetadata.teamAgentTask, "runId") !== task.runId ||
    Reflect.get(row.messageMetadata.teamAgentTask, "agentUuid") !== task.agentUuid ||
    metadata.data.githubTaskOrganizationId !== row.organizationId ||
    metadata.data.githubTaskRepository !== card.data.repository.toLowerCase() ||
    metadata.data.githubTaskEntityType !== card.data.entity.type ||
    card.data.entity.key.toLowerCase() !==
      `${metadata.data.githubTaskRepository}#${metadata.data.githubTaskEntityNumber}` ||
    card.data.entity.url !== metadata.data.githubTaskEntityUrl
  ) {
    throw forbidden("GitHub task reply run provenance is invalid.");
  }
  return {
    messageId: row.messageId,
    chatId: row.chatId,
    runId: metadata.data.githubTaskRunId,
    organizationId: row.organizationId,
    repository: metadata.data.githubTaskRepository,
    entityType: metadata.data.githubTaskEntityType,
    entityNumber: metadata.data.githubTaskEntityNumber,
    entityUrl: metadata.data.githubTaskEntityUrl,
    agentUuid: metadata.data.githubTaskAgentUuid,
    managerHumanAgentId: metadata.data.githubTaskManagerHumanAgentId,
    submission: metadata.data.githubTaskReplySubmission,
  };
}

function authorizeRun(run: RunFacts, callerAgentUuid: string): void {
  if (run.agentUuid !== callerAgentUuid) {
    throw forbidden("Only the exact task Agent recorded on this run can publish its App reply.");
  }
}

function assertSameRunAuthority(snapshot: RunFacts, current: RunFacts): void {
  if (
    current.messageId !== snapshot.messageId ||
    current.chatId !== snapshot.chatId ||
    current.organizationId !== snapshot.organizationId ||
    current.repository !== snapshot.repository ||
    current.entityType !== snapshot.entityType ||
    current.entityNumber !== snapshot.entityNumber ||
    current.entityUrl !== snapshot.entityUrl ||
    current.agentUuid !== snapshot.agentUuid ||
    current.managerHumanAgentId !== snapshot.managerHumanAgentId
  ) {
    throw forbidden("GitHub task reply run authority changed before publication.");
  }
}

async function lockPublisherAuthorityRowsBeforeChat(
  db: Database,
  run: RunFacts,
  input: { callerAgentUuid: string; callerClientId: string },
): Promise<boolean> {
  const [organization] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, run.organizationId))
    .for("update")
    .limit(1);
  if (!organization) return false;
  const [snapshot] = await db
    .select({ managerId: agents.managerId, clientId: agents.clientId })
    .from(agents)
    .where(eq(agents.uuid, input.callerAgentUuid))
    .limit(1);
  if (!snapshot) return false;
  await db.select({ id: members.id }).from(members).where(eq(members.id, snapshot.managerId)).for("update").limit(1);
  await db.select({ id: clients.id }).from(clients).where(eq(clients.id, input.callerClientId)).for("update").limit(1);
  const [agent] = await db
    .select({ managerId: agents.managerId, clientId: agents.clientId })
    .from(agents)
    .where(eq(agents.uuid, input.callerAgentUuid))
    .for("update")
    .limit(1);
  return agent?.managerId === snapshot.managerId && agent.clientId === snapshot.clientId;
}

async function assertCurrentAuthority(
  db: Database,
  run: RunFacts,
  input: {
    callerAgentUuid: string;
    callerClientId: string;
    runtimeSessionToken: string;
    expectedInstallationId?: number;
  },
): Promise<{ owner: string; repo: string; installationId: number }> {
  const runtime = await getOrgContextReviewRuntime(db, run.organizationId);
  const isContextRepository =
    runtime.bindingState === "bound" &&
    runtime.provider === "github" &&
    runtime.providerMatchesRepository &&
    normalizeGithubRepo(runtime.repo) === run.repository;
  const selectedAgentUuid = isContextRepository
    ? runtime.contextReviewer.agentUuid
    : await getTeamAgentUuid(db, run.organizationId);
  if (selectedAgentUuid !== input.callerAgentUuid) {
    throw forbidden("The caller is no longer the repository-scoped Agent selected for this task.");
  }

  const [snapshot] = await db
    .select({ managerId: agents.managerId, clientId: agents.clientId })
    .from(agents)
    .where(and(eq(agents.uuid, input.callerAgentUuid), agentNotLandingCampaignTrialCondition()))
    .limit(1);
  if (!snapshot) throw forbidden("The task Agent runtime is no longer active.");
  const [manager] = await db
    .select({
      organizationId: members.organizationId,
      userId: members.userId,
      agentId: members.agentId,
      status: members.status,
    })
    .from(members)
    .where(eq(members.id, snapshot.managerId))
    .for("update")
    .limit(1);
  const [client] = await db
    .select({ userId: clients.userId, retiredAt: clients.retiredAt })
    .from(clients)
    .where(eq(clients.id, input.callerClientId))
    .for("update")
    .limit(1);
  const [agent] = await db
    .select({
      organizationId: agents.organizationId,
      type: agents.type,
      status: agents.status,
      visibility: agents.visibility,
      runtimeProvider: agents.runtimeProvider,
      clientId: agents.clientId,
      managerId: agents.managerId,
    })
    .from(agents)
    .where(and(eq(agents.uuid, input.callerAgentUuid), agentNotLandingCampaignTrialCondition()))
    .for("update")
    .limit(1);
  const [membership] = await db
    .select({ accessMode: chatMembership.accessMode })
    .from(chatMembership)
    .where(and(eq(chatMembership.chatId, run.chatId), eq(chatMembership.agentId, input.callerAgentUuid)))
    .for("update")
    .limit(1);
  if (
    !agent ||
    agent.organizationId !== run.organizationId ||
    agent.type !== "agent" ||
    agent.status !== "active" ||
    agent.visibility !== AGENT_VISIBILITY.ORGANIZATION ||
    !runtimeProviderSchema.safeParse(agent.runtimeProvider).success ||
    !isRuntimeProviderEnabled(agent.runtimeProvider) ||
    agent.clientId !== input.callerClientId ||
    agent.clientId !== snapshot.clientId ||
    agent.managerId !== snapshot.managerId ||
    membership?.accessMode !== "speaker"
  ) {
    throw forbidden("The task Agent runtime or original Chat participation is no longer active.");
  }
  if (
    !client ||
    client.retiredAt !== null ||
    !client.userId ||
    !manager ||
    manager.organizationId !== run.organizationId ||
    manager.status !== "active" ||
    manager.agentId !== run.managerHumanAgentId ||
    manager.userId !== client.userId ||
    !(await validateAgentRuntimeSession(db, input.callerAgentUuid, input.callerClientId, input.runtimeSessionToken))
  ) {
    throw forbidden("The task manager, client, or runtime session authority was revoked before publication.");
  }

  const [installation] = await db
    .select({
      installationId: githubAppInstallations.installationId,
      permissions: githubAppInstallations.permissions,
      suspendedAt: githubAppInstallations.suspendedAt,
    })
    .from(githubAppInstallations)
    .where(eq(githubAppInstallations.hubOrganizationId, run.organizationId))
    .for("update")
    .limit(1);
  if (
    !installation ||
    (input.expectedInstallationId !== undefined && installation.installationId !== input.expectedInstallationId)
  ) {
    throw new GithubTaskReplyPublisherError(
      422,
      "GITHUB_TASK_REPLY_APP_NOT_INSTALLED",
      "The GitHub App installation binding changed before the task reply claim.",
    );
  }
  if (installation.suspendedAt) {
    throw new GithubTaskReplyPublisherError(
      422,
      "GITHUB_TASK_REPLY_APP_NOT_INSTALLED",
      "The team's GitHub App installation is suspended.",
    );
  }
  const requiredPermission = run.entityType === "issue" ? "issues" : "pull_requests";
  if (installation.permissions[requiredPermission] !== "write") {
    throw new GithubTaskReplyPublisherError(
      422,
      "GITHUB_TASK_REPLY_APP_PERMISSION_REQUIRED",
      `The GitHub App installation must grant ${requiredPermission.replace("_", " ")}: write.`,
    );
  }
  const [owner, repo] = run.repository.split("/");
  if (!owner || !repo) throw forbidden("The task repository identity is invalid.");
  return { owner, repo, installationId: installation.installationId };
}

async function prepareGithubPublisher(input: {
  run: RunFacts;
  installationId: number;
  appCredentials: (GithubAppCredentials & { slug?: string }) | undefined;
  fetcher?: typeof fetch;
}): Promise<{ token: string; appSlug: string; owner: string; repo: string }> {
  if (!input.appCredentials?.slug) {
    throw new GithubTaskReplyPublisherError(
      503,
      "GITHUB_TASK_REPLY_APP_NOT_INSTALLED",
      "GitHub App task reply publication is not configured on this First Tree environment.",
    );
  }
  const [owner, repo] = input.run.repository.split("/");
  if (!owner || !repo) throw forbidden("The task repository identity is invalid.");
  const requiredPermission = input.run.entityType === "issue" ? "issues" : "pull_requests";
  try {
    const appJwt = await createAppJwt(input.appCredentials);
    const minted = await mintInstallationToken(appJwt, input.installationId, {
      fetcher: input.fetcher,
      repositories: [repo],
      permissions: { metadata: "read", [requiredPermission]: "write" },
    });
    if (minted.permissions[requiredPermission] !== "write") {
      throw new GithubTaskReplyPublisherError(
        422,
        "GITHUB_TASK_REPLY_APP_PERMISSION_REQUIRED",
        `The live installation token does not grant ${requiredPermission.replace("_", " ")}: write.`,
      );
    }
    return { token: minted.token, appSlug: input.appCredentials.slug, owner, repo };
  } catch (error) {
    if (error instanceof GithubTaskReplyPublisherError) throw error;
    if (error instanceof GithubAppApiError && (error.status === 403 || error.status === 404 || error.status === 422)) {
      throw new GithubTaskReplyPublisherError(
        422,
        error.status === 403 ? "GITHUB_TASK_REPLY_APP_PERMISSION_REQUIRED" : "GITHUB_TASK_REPLY_REPO_NOT_ACCESSIBLE",
        "The GitHub App cannot mint a repository-scoped comment token. Check installation permissions and repo access.",
      );
    }
    throw new GithubTaskReplyPublisherError(
      503,
      "GITHUB_TASK_REPLY_GITHUB_REJECTED",
      "GitHub App token minting is temporarily unavailable.",
    );
  }
}

async function reconcileUnknownSubmission(input: {
  db: Database;
  run: RunFacts;
  runId: string;
  body: string;
  payloadHash: string;
  publisherClientId: string;
  github: { token: string; appSlug: string; owner: string; repo: string };
  fetcher?: typeof fetch;
}): Promise<GithubTaskReplyResponse> {
  const comments = await listIssueCommentsForRun(
    input.github.token,
    {
      owner: input.github.owner,
      repo: input.github.repo,
      issueNumber: input.run.entityNumber,
      marker: runMarker(input.runId),
      appSlug: input.github.appSlug,
    },
    { fetcher: input.fetcher },
  ).catch(() => {
    throw new GithubTaskReplyPublisherError(
      502,
      "GITHUB_TASK_REPLY_GITHUB_UNKNOWN",
      "Unable to reconcile the unknown GitHub comment delivery.",
    );
  });
  const expectedBody = replyBody(input.body, input.runId);
  const matching = comments.filter((comment) => comment.body === expectedBody);
  if (matching.length !== 1) {
    throw new GithubTaskReplyPublisherError(
      502,
      "GITHUB_TASK_REPLY_GITHUB_UNKNOWN",
      "The unknown GitHub comment delivery remains unresolved. Do not repeat the mutation.",
    );
  }
  const comment = matching[0];
  if (!comment) {
    throw new GithubTaskReplyPublisherError(502, "GITHUB_TASK_REPLY_GITHUB_UNKNOWN", "Comment missing.");
  }
  const submitted = submissionFromComment({
    payloadHash: input.payloadHash,
    comment,
    run: input.run,
    callerClientId: input.publisherClientId,
  });
  await setSubmissionForPayload(input.db, input.run.messageId, input.payloadHash, submitted);
  return submittedResponse(submitted);
}

/**
 * Resolve a lost publication claim into a definite answer for the losing run.
 *
 * Reads the hidden run marker back off the entity's existing App comments —
 * the guard the marker was always shaped for but never used as. Finding this
 * exact reply already published makes the loss terminal, so the run stops
 * instead of rephrasing and trying again. Not finding it means the owning run
 * is still in flight, so the run stays `pending` and can take the claim over
 * later if that owner ends up releasing it.
 */
async function duplicatePublication(input: {
  db: Database;
  run: RunFacts;
  payloadHash: string;
  body: string;
  github: { token: string; appSlug: string; owner: string; repo: string };
  fetcher?: typeof fetch;
}): Promise<GithubTaskReplyPublisherError> {
  const published = await findPublishedGithubTaskReply({
    token: input.github.token,
    appSlug: input.github.appSlug,
    owner: input.github.owner,
    repo: input.github.repo,
    entityNumber: input.run.entityNumber,
    body: input.body,
    fetcher: input.fetcher,
  });
  if (!published) {
    return new GithubTaskReplyPublisherError(
      409,
      "GITHUB_TASK_REPLY_DUPLICATE_PUBLICATION",
      `Another run already claimed publication of this exact reply on ${input.run.repository}#${input.run.entityNumber} and it is still in flight. Do not publish it again.`,
    );
  }
  await setSubmissionIf(input.db, input.run.messageId, "pending", {
    state: "failed",
    payloadHash: input.payloadHash,
    code: "GITHUB_TASK_REPLY_DUPLICATE_PUBLICATION",
    failedAt: new Date().toISOString(),
  });
  return new GithubTaskReplyPublisherError(
    409,
    "GITHUB_TASK_REPLY_DUPLICATE_PUBLICATION",
    `This exact reply is already published on ${input.run.repository}#${input.run.entityNumber} at ${published.htmlUrl}. Do not publish it again.`,
  );
}

function submissionFromComment(input: {
  payloadHash: string;
  comment: GithubIssueComment;
  run: RunFacts;
  callerClientId: string;
}): Extract<SubmissionState, { state: "submitted" }> {
  return {
    state: "submitted",
    payloadHash: input.payloadHash,
    commentId: input.comment.id,
    commentUrl: input.comment.htmlUrl,
    appActor: input.comment.actor,
    submittedAt: new Date().toISOString(),
    publisherAgentUuid: input.run.agentUuid,
    publisherClientId: input.callerClientId,
  };
}

function submittedResponse(state: Extract<SubmissionState, { state: "submitted" }>): GithubTaskReplyResponse {
  return {
    commentId: state.commentId,
    commentUrl: state.commentUrl,
    appActor: state.appActor,
  };
}

async function setSubmissionIf(
  db: Database,
  messageId: string,
  expectedState: string,
  next: SubmissionState,
): Promise<boolean> {
  const [row] = await db
    .update(messages)
    .set({
      metadata: sql`jsonb_set(${messages.metadata}, '{githubTaskReplySubmission}', ${JSON.stringify(next)}::jsonb)`,
    })
    .where(
      and(
        eq(messages.id, messageId),
        sql`${messages.metadata}->'githubTaskReplySubmission'->>'state' = ${expectedState}`,
      ),
    )
    .returning({ id: messages.id });
  return row !== undefined;
}

async function setSubmissionForAttempt(
  db: Database,
  messageId: string,
  attemptId: string,
  next: SubmissionState,
): Promise<boolean> {
  const [row] = await db
    .update(messages)
    .set({
      metadata: sql`jsonb_set(${messages.metadata}, '{githubTaskReplySubmission}', ${JSON.stringify(next)}::jsonb)`,
    })
    .where(
      and(
        eq(messages.id, messageId),
        sql`${messages.metadata}->'githubTaskReplySubmission'->>'attemptId' = ${attemptId}`,
      ),
    )
    .returning({ id: messages.id });
  return row !== undefined;
}

async function setSubmissionForPayload(
  db: Database,
  messageId: string,
  payloadHash: string,
  next: SubmissionState,
): Promise<boolean> {
  const [row] = await db
    .update(messages)
    .set({
      metadata: sql`jsonb_set(${messages.metadata}, '{githubTaskReplySubmission}', ${JSON.stringify(next)}::jsonb)`,
    })
    .where(
      and(
        eq(messages.id, messageId),
        sql`${messages.metadata}->'githubTaskReplySubmission'->>'payloadHash' = ${payloadHash}`,
        sql`${messages.metadata}->'githubTaskReplySubmission'->>'state' in ('submitting', 'unknown')`,
      ),
    )
    .returning({ id: messages.id });
  return row !== undefined;
}

function hashPayload(run: RunFacts, body: string): string {
  return createHash("sha256")
    .update(JSON.stringify([run.repository, run.entityType, run.entityNumber, body.trimEnd()]))
    .digest("hex");
}

function runMarker(runId: string): string {
  return `${GITHUB_TASK_REPLY_RUN_MARKER_PREFIX}${runId} -->`;
}

function replyBody(body: string, runId: string): string {
  return `${body.trimEnd()}\n\n${runMarker(runId)}`;
}

function assertNoAppMention(body: string, appSlug: string): void {
  if (extractMentions(body).some((login) => isGithubAppTargetLogin(login, appSlug))) {
    throw new GithubTaskReplyPublisherError(
      400,
      "GITHUB_TASK_REPLY_INVALID_REQUEST",
      "The App-authored terminal reply must not mention the GitHub App again.",
    );
  }
}

function payloadMismatch(): GithubTaskReplyPublisherError {
  return new GithubTaskReplyPublisherError(
    409,
    "GITHUB_TASK_REPLY_RUN_PAYLOAD_MISMATCH",
    "This run was already claimed with a different immutable reply payload.",
  );
}

function alreadySubmitted(): GithubTaskReplyPublisherError {
  return new GithubTaskReplyPublisherError(
    409,
    "GITHUB_TASK_REPLY_RUN_ALREADY_SUBMITTED",
    "This GitHub task reply run already has an active or terminal publication claim.",
  );
}

function notFound(): GithubTaskReplyPublisherError {
  return new GithubTaskReplyPublisherError(
    404,
    "GITHUB_TASK_REPLY_RUN_NOT_FOUND",
    "GitHub task reply run not found in this Chat.",
  );
}

function forbidden(message: string): GithubTaskReplyPublisherError {
  return new GithubTaskReplyPublisherError(403, "GITHUB_TASK_REPLY_RUN_FORBIDDEN", message);
}

function mapGithubMutationError(error: unknown): GithubTaskReplyPublisherError {
  if (error instanceof GithubAppApiError) {
    if (error.status === 401 || error.status === 403) {
      return new GithubTaskReplyPublisherError(
        422,
        "GITHUB_TASK_REPLY_APP_PERMISSION_REQUIRED",
        "GitHub rejected the App comment permission.",
      );
    }
    if (error.status === 404) {
      return new GithubTaskReplyPublisherError(
        422,
        "GITHUB_TASK_REPLY_REPO_NOT_ACCESSIBLE",
        "GitHub no longer exposes the original Issue or pull request to this App installation.",
      );
    }
    if (error.status === 422) {
      return new GithubTaskReplyPublisherError(
        422,
        "GITHUB_TASK_REPLY_GITHUB_REJECTED",
        "GitHub rejected the App-authored conversation comment.",
      );
    }
  }
  return new GithubTaskReplyPublisherError(
    502,
    "GITHUB_TASK_REPLY_GITHUB_REJECTED",
    "GitHub task reply submission failed.",
  );
}

function isUnknownGithubWrite(error: unknown): boolean {
  return !(error instanceof GithubAppApiError) || error.status >= 500;
}
