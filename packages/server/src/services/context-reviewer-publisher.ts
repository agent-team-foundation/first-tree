import { createHash } from "node:crypto";
import {
  type ContextReviewEvent,
  type ContextReviewSubmissionState,
  type ContextReviewSubmitRequest,
  type ContextReviewSubmitResponse,
  contextReviewSubmissionStateSchema,
  contextReviewSubmitRequestSchema,
} from "@first-tree/shared";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { chats } from "../db/schema/chats.js";
import { clients } from "../db/schema/clients.js";
import { githubAppInstallations } from "../db/schema/github-app-installations.js";
import { members } from "../db/schema/members.js";
import { messages } from "../db/schema/messages.js";
import { organizations } from "../db/schema/organizations.js";
import { uuidv7 } from "../uuid.js";
import { validateAgentRuntimeSession } from "./agent-runtime-session.js";
import { normalizeGithubRepo } from "./context-reviewer-pr.js";
import {
  createAppJwt,
  createPullRequestReview,
  GithubAppApiError,
  type GithubAppCredentials,
  type GithubPullRequestReview,
  getPullRequestForReview,
  listPullRequestReviewsForRun,
  mintInstallationToken,
} from "./github-app.js";
import { getOrgContextTreeBinding, getOrgSetting } from "./org-settings.js";

type SubmissionState = ContextReviewSubmissionState;

type RunFacts = {
  messageId: string;
  runId: string;
  chatId: string;
  organizationId: string;
  repository: string;
  prNumber: number;
  reviewerAgentUuid: string;
  reviewerManagerHumanAgentId: string;
  reviewerManagerGithubLogin: string | null;
  submission: SubmissionState;
};

type PreparedReviewRequest = ContextReviewSubmitRequest & { reviewedHead: string };

export class ContextReviewPublisherError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ContextReviewPublisherError";
  }
}

export async function submitContextReviewOutcome(input: {
  db: Database;
  chatId: string;
  runId: string;
  callerAgentUuid: string;
  callerClientId: string;
  callerRuntimeSessionToken: string;
  request: ContextReviewSubmitRequest;
  appCredentials: (GithubAppCredentials & { slug?: string }) | undefined;
  fetcher?: typeof fetch;
}): Promise<ContextReviewSubmitResponse> {
  const parsedRequest = contextReviewSubmitRequestSchema.parse(input.request);
  const request = { ...parsedRequest, body: parsedRequest.body.trimEnd() };
  const inspection = await input.db.transaction(async (tx) => {
    const db = tx as unknown as Database;
    await lockReviewChat(db, input.chatId);
    const run = await loadRunFacts(db, input.chatId, input.runId);
    authorizeRun(run, input.callerAgentUuid);

    if (run.submission.state === "submitted") {
      if (run.submission.payloadHash !== hashPayload({ ...request, reviewedHead: run.submission.reviewedHead })) {
        throw payloadMismatch();
      }
      return { kind: "submitted" as const, response: submittedResponse(run.submission) };
    }
    if (run.submission.state === "failed") {
      throw alreadySubmitted();
    }

    const current = await assertCurrentAuthority(db, run, {
      callerAgentUuid: input.callerAgentUuid,
      callerClientId: input.callerClientId,
      runtimeSessionToken: input.callerRuntimeSessionToken,
    });
    if (run.submission.state === "submitting" || run.submission.state === "unknown") {
      const prepared = { ...request, reviewedHead: run.submission.reviewedHead };
      if (run.submission.payloadHash !== hashPayload(prepared)) throw payloadMismatch();
      return {
        kind: "reconcile" as const,
        run,
        request: prepared,
        payloadHash: run.submission.payloadHash,
        current,
        reviewerClientId: run.submission.reviewerClientId,
      };
    }
    return { kind: "pending" as const, run, current };
  });
  if (inspection.kind === "submitted") return inspection.response;
  const github = await prepareGithubPublisher({
    repository: inspection.run.repository,
    installationId: inspection.current.installationId,
    appCredentials: input.appCredentials,
    fetcher: input.fetcher,
  });

  if (inspection.kind === "reconcile") {
    return reconcileUnknownSubmission({
      db: input.db,
      run: inspection.run,
      runId: input.runId,
      request: inspection.request,
      github,
      payloadHash: inspection.payloadHash,
      reviewerClientId: inspection.reviewerClientId,
      fetcher: input.fetcher,
    });
  }

  const pullRequest = await getPullRequestForReview(
    github.token,
    inspection.current.owner,
    inspection.current.repo,
    inspection.run.prNumber,
    { fetcher: input.fetcher },
  ).catch((error: unknown) => {
    throw mapGithubPreflightError(error);
  });
  assertPullRequestReviewable(pullRequest, request);

  const reviewedHead = normalizeCommitOid(pullRequest.headSha);
  if (!reviewedHead) {
    throw new ContextReviewPublisherError(
      422,
      "CONTEXT_REVIEW_PR_NOT_REVIEWABLE",
      "GitHub did not return a full pull request head commit.",
    );
  }
  const preparedRequest: PreparedReviewRequest = { ...request, reviewedHead };
  const payloadHash = hashPayload(preparedRequest);

  const claim = await input.db.transaction(async (tx) => {
    const db = tx as unknown as Database;
    await lockReviewChat(db, input.chatId);
    const run = await loadRunFacts(db, input.chatId, input.runId);
    authorizeRun(run, input.callerAgentUuid);
    await assertCurrentAuthority(db, run, {
      callerAgentUuid: input.callerAgentUuid,
      callerClientId: input.callerClientId,
      runtimeSessionToken: input.callerRuntimeSessionToken,
      expectedInstallationId: inspection.current.installationId,
    });

    if (run.submission.state === "submitted") {
      if (run.submission.payloadHash !== hashPayload({ ...request, reviewedHead: run.submission.reviewedHead })) {
        throw payloadMismatch();
      }
      return { kind: "submitted" as const, response: submittedResponse(run.submission) };
    }
    if (run.submission.state === "failed") {
      throw alreadySubmitted();
    }
    if (run.submission.state === "submitting" || run.submission.state === "unknown") {
      const claimedRequest = { ...request, reviewedHead: run.submission.reviewedHead };
      if (run.submission.payloadHash !== hashPayload(claimedRequest)) throw payloadMismatch();
      return {
        kind: "reconcile" as const,
        run,
        request: claimedRequest,
        payloadHash: run.submission.payloadHash,
        reviewerClientId: run.submission.reviewerClientId,
      };
    }

    const attemptId = uuidv7();
    const claimed = await setSubmissionIf(db, run.messageId, "pending", {
      state: "submitting",
      payloadHash,
      attemptId,
      reviewedHead: preparedRequest.reviewedHead,
      event: request.event,
      claimedAt: new Date().toISOString(),
      reviewerClientId: input.callerClientId,
    });
    if (!claimed) throw alreadySubmitted();
    return { kind: "claimed" as const, run, attemptId };
  });
  if (claim.kind === "submitted") return claim.response;
  if (claim.kind === "reconcile") {
    return reconcileUnknownSubmission({
      db: input.db,
      run: claim.run,
      runId: input.runId,
      request: claim.request,
      github,
      payloadHash: claim.payloadHash,
      reviewerClientId: claim.reviewerClientId,
      fetcher: input.fetcher,
    });
  }

  const marker = runMarker(input.runId);
  let review: GithubPullRequestReview;
  try {
    review = await createPullRequestReview(
      github.token,
      {
        owner: inspection.current.owner,
        repo: inspection.current.repo,
        prNumber: claim.run.prNumber,
        commitId: preparedRequest.reviewedHead,
        event: request.event,
        body: `${request.body}\n\n${marker}`,
      },
      { fetcher: input.fetcher },
    );
  } catch (error) {
    if (isUnknownGithubWrite(error)) {
      await setSubmissionForAttempt(input.db, claim.run.messageId, claim.attemptId, {
        state: "unknown",
        payloadHash,
        attemptId: claim.attemptId,
        reviewedHead: preparedRequest.reviewedHead,
        event: request.event,
        failedAt: new Date().toISOString(),
        reviewerClientId: input.callerClientId,
      });
      throw new ContextReviewPublisherError(
        502,
        "CONTEXT_REVIEW_GITHUB_UNKNOWN",
        "GitHub review delivery is unknown. The run is fail-closed and will be reconciled before any retry.",
      );
    }
    const mapped = mapGithubMutationError(error);
    await setSubmissionForAttempt(input.db, claim.run.messageId, claim.attemptId, {
      state: "failed",
      payloadHash,
      code: mapped.code,
      failedAt: new Date().toISOString(),
    });
    throw mapped;
  }

  const submitted = submissionFromReview({
    reviewedHead: preparedRequest.reviewedHead,
    event: request.event,
    payloadHash,
    review,
    run: claim.run,
    callerClientId: input.callerClientId,
  });
  const recorded = await setSubmissionForAttempt(input.db, claim.run.messageId, claim.attemptId, submitted).catch(
    () => false,
  );
  if (!recorded) {
    throw new ContextReviewPublisherError(
      502,
      "CONTEXT_REVIEW_GITHUB_UNKNOWN",
      "GitHub accepted the App review but Cloud could not record it. Reconciliation is required.",
    );
  }
  return submittedResponse(submitted);
}

async function lockReviewChat(db: Database, chatId: string): Promise<void> {
  const [chat] = await db.select({ id: chats.id }).from(chats).where(eq(chats.id, chatId)).for("update").limit(1);
  if (!chat) {
    throw new ContextReviewPublisherError(404, "CONTEXT_REVIEW_RUN_NOT_FOUND", "Context Reviewer chat not found.");
  }
}

async function loadRunFacts(db: Database, chatId: string, runId: string): Promise<RunFacts> {
  const rows = await db
    .select({
      messageId: messages.id,
      senderId: messages.senderId,
      chatId: messages.chatId,
      messageSource: messages.source,
      messageMetadata: messages.metadata,
      organizationId: chats.organizationId,
      chatMetadata: chats.metadata,
    })
    .from(messages)
    .innerJoin(chats, eq(chats.id, messages.chatId))
    .where(
      and(
        eq(messages.chatId, chatId),
        eq(messages.source, "github"),
        sql`${messages.metadata}->>'contextReviewRunId' = ${runId}`,
      ),
    )
    .limit(2);
  if (rows.length !== 1) {
    throw new ContextReviewPublisherError(404, "CONTEXT_REVIEW_RUN_NOT_FOUND", "Context Reviewer run not found.");
  }
  const row = rows[0];
  if (!row) throw new ContextReviewPublisherError(404, "CONTEXT_REVIEW_RUN_NOT_FOUND", "Run not found.");
  const metadata = row.messageMetadata;
  const chatMetadata = row.chatMetadata;
  const repository = readNonEmptyString(metadata.contextReviewRepository);
  const prNumber = readPositiveInteger(metadata.contextReviewPrNumber);
  const reviewerAgentUuid = readNonEmptyString(metadata.contextReviewReviewerAgentUuid);
  const reviewerManagerHumanAgentId = readNonEmptyString(metadata.contextReviewReviewerManagerHumanAgentId);
  const metadataOrg = readNonEmptyString(metadata.contextReviewOrganizationId);
  const metadataRunId = readNonEmptyString(metadata.contextReviewRunId);
  const entityKey = repository && prNumber ? `${repository}#${prNumber}` : null;
  if (
    metadata.contextTreeReviewer !== true ||
    chatMetadata.contextTreeReviewer !== true ||
    chatMetadata.reviewerAgentUuid !== reviewerAgentUuid ||
    chatMetadata.entityKey !== entityKey ||
    !repository ||
    !prNumber ||
    !reviewerAgentUuid ||
    !reviewerManagerHumanAgentId ||
    !metadataRunId ||
    row.senderId !== reviewerManagerHumanAgentId ||
    metadataOrg !== row.organizationId
  ) {
    throw new ContextReviewPublisherError(
      403,
      "CONTEXT_REVIEW_RUN_FORBIDDEN",
      "Context Reviewer run provenance is invalid.",
    );
  }
  return {
    messageId: row.messageId,
    runId: metadataRunId,
    chatId: row.chatId,
    organizationId: row.organizationId,
    repository,
    prNumber,
    reviewerAgentUuid,
    reviewerManagerHumanAgentId,
    reviewerManagerGithubLogin: readNonEmptyString(metadata.reviewerManagerGithubLogin),
    submission: parseSubmission(metadata.contextReviewSubmission),
  };
}

function authorizeRun(run: RunFacts, callerAgentUuid: string): void {
  if (run.reviewerAgentUuid !== callerAgentUuid) {
    throw new ContextReviewPublisherError(
      403,
      "CONTEXT_REVIEW_RUN_FORBIDDEN",
      "Only the configured reviewer recorded on this run can submit its outcome.",
    );
  }
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
) {
  const [organization] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, run.organizationId))
    .for("update")
    .limit(1);
  if (!organization) {
    throw new ContextReviewPublisherError(403, "CONTEXT_REVIEW_RUN_FORBIDDEN", "Organization is unavailable.");
  }

  const features = await getOrgSetting(db, run.organizationId, "context_tree_features");
  if (!features.contextReviewer.enabled || features.contextReviewer.agentUuid !== input.callerAgentUuid) {
    throw new ContextReviewPublisherError(
      403,
      "CONTEXT_REVIEW_RUN_FORBIDDEN",
      "The caller is no longer the organization's configured Context Reviewer.",
    );
  }
  const binding = await getOrgContextTreeBinding(db, run.organizationId);
  const repository = normalizeGithubRepo(binding?.repo);
  if (!repository || repository !== run.repository) {
    throw new ContextReviewPublisherError(
      403,
      "CONTEXT_REVIEW_RUN_FORBIDDEN",
      "The run repository no longer matches the organization's bound Context Tree repository.",
    );
  }
  const [owner, repo] = repository.split("/");
  if (!owner || !repo) throw new ContextReviewPublisherError(403, "CONTEXT_REVIEW_RUN_FORBIDDEN", "Invalid repo.");

  const [reviewer] = await db
    .select({
      uuid: agents.uuid,
      organizationId: agents.organizationId,
      type: agents.type,
      status: agents.status,
      clientId: agents.clientId,
      managerId: agents.managerId,
    })
    .from(agents)
    .where(eq(agents.uuid, input.callerAgentUuid))
    .for("update")
    .limit(1);
  if (
    !reviewer ||
    reviewer.organizationId !== run.organizationId ||
    reviewer.type !== "agent" ||
    reviewer.status !== "active" ||
    reviewer.clientId !== input.callerClientId
  ) {
    throw new ContextReviewPublisherError(
      403,
      "CONTEXT_REVIEW_RUN_FORBIDDEN",
      "The configured Context Reviewer runtime is no longer active for this run.",
    );
  }

  const [client] = await db
    .select({
      id: clients.id,
      organizationId: clients.organizationId,
      userId: clients.userId,
      retiredAt: clients.retiredAt,
    })
    .from(clients)
    .where(eq(clients.id, input.callerClientId))
    .for("update")
    .limit(1);
  const [manager] = await db
    .select({
      id: members.id,
      organizationId: members.organizationId,
      userId: members.userId,
      agentId: members.agentId,
      status: members.status,
    })
    .from(members)
    .where(eq(members.id, reviewer.managerId))
    .for("update")
    .limit(1);
  if (
    !client ||
    client.organizationId !== run.organizationId ||
    client.retiredAt !== null ||
    !client.userId ||
    !manager ||
    manager.organizationId !== run.organizationId ||
    manager.status !== "active" ||
    manager.agentId !== run.reviewerManagerHumanAgentId ||
    manager.userId !== client.userId ||
    !(await validateAgentRuntimeSession(db, input.callerAgentUuid, input.callerClientId, input.runtimeSessionToken))
  ) {
    throw new ContextReviewPublisherError(
      403,
      "CONTEXT_REVIEW_RUN_FORBIDDEN",
      "The reviewer manager, client, or runtime session authority was revoked before publication.",
    );
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
    throw new ContextReviewPublisherError(
      422,
      "CONTEXT_REVIEW_APP_NOT_INSTALLED",
      "The GitHub App installation binding changed before the review publication claim.",
    );
  }
  if (installation.suspendedAt) {
    throw new ContextReviewPublisherError(
      422,
      "CONTEXT_REVIEW_APP_NOT_INSTALLED",
      "The team's GitHub App installation is suspended.",
    );
  }
  if (installation.permissions.pull_requests !== "write") {
    throw new ContextReviewPublisherError(
      422,
      "CONTEXT_REVIEW_APP_PERMISSION_REQUIRED",
      "The installation owner must accept the GitHub App Pull requests: write permission upgrade.",
    );
  }
  return { owner, repo, installationId: installation.installationId };
}

async function prepareGithubPublisher(input: {
  repository: string;
  installationId: number;
  appCredentials: (GithubAppCredentials & { slug?: string }) | undefined;
  fetcher?: typeof fetch;
}) {
  if (!input.appCredentials?.slug) {
    throw new ContextReviewPublisherError(
      503,
      "CONTEXT_REVIEW_APP_NOT_INSTALLED",
      "GitHub App publication is not configured on this First Tree environment.",
    );
  }
  const [, repo] = input.repository.split("/");
  if (!repo) throw new ContextReviewPublisherError(403, "CONTEXT_REVIEW_RUN_FORBIDDEN", "Invalid repo.");
  try {
    const appJwt = await createAppJwt(input.appCredentials);
    const minted = await mintInstallationToken(appJwt, input.installationId, {
      fetcher: input.fetcher,
      repositories: [repo],
      permissions: { metadata: "read", pull_requests: "write" },
    });
    if (minted.permissions.pull_requests !== "write") {
      throw new ContextReviewPublisherError(
        422,
        "CONTEXT_REVIEW_APP_PERMISSION_REQUIRED",
        "The live installation token does not grant Pull requests: write.",
      );
    }
    return { token: minted.token, appSlug: input.appCredentials.slug };
  } catch (error) {
    if (error instanceof ContextReviewPublisherError) throw error;
    if (error instanceof GithubAppApiError && (error.status === 403 || error.status === 404 || error.status === 422)) {
      throw new ContextReviewPublisherError(
        422,
        error.status === 403 ? "CONTEXT_REVIEW_APP_PERMISSION_REQUIRED" : "CONTEXT_REVIEW_REPO_NOT_ACCESSIBLE",
        "The GitHub App cannot mint a repository-scoped review token. Check installation permissions and repo access.",
      );
    }
    throw new ContextReviewPublisherError(
      503,
      "CONTEXT_REVIEW_GITHUB_REJECTED",
      "GitHub App token minting is temporarily unavailable.",
    );
  }
}

async function reconcileUnknownSubmission(input: {
  db: Database;
  run: RunFacts;
  runId: string;
  request: PreparedReviewRequest;
  github: { token: string; appSlug: string };
  payloadHash: string;
  reviewerClientId: string;
  fetcher?: typeof fetch;
}): Promise<ContextReviewSubmitResponse> {
  const [owner, repo] = input.run.repository.split("/");
  if (!owner || !repo) throw new ContextReviewPublisherError(403, "CONTEXT_REVIEW_RUN_FORBIDDEN", "Invalid repo.");
  const reviews = await listPullRequestReviewsForRun(
    input.github.token,
    { owner, repo, prNumber: input.run.prNumber, marker: runMarker(input.runId), appSlug: input.github.appSlug },
    { fetcher: input.fetcher },
  ).catch(() => {
    throw new ContextReviewPublisherError(
      502,
      "CONTEXT_REVIEW_GITHUB_UNKNOWN",
      "Unable to reconcile the unknown GitHub review delivery.",
    );
  });
  const matching = reviews.filter((review) => review.commitId === input.request.reviewedHead);
  if (matching.length !== 1) {
    throw new ContextReviewPublisherError(
      502,
      "CONTEXT_REVIEW_GITHUB_UNKNOWN",
      "The unknown GitHub review delivery remains unresolved. Do not repeat the mutation.",
    );
  }
  const review = matching[0];
  if (!review) throw new ContextReviewPublisherError(502, "CONTEXT_REVIEW_GITHUB_UNKNOWN", "Review missing.");
  const submitted = submissionFromReview({
    reviewedHead: input.request.reviewedHead,
    event: input.request.event,
    payloadHash: input.payloadHash,
    review,
    run: input.run,
    callerClientId: input.reviewerClientId,
  });
  await setSubmissionForPayload(input.db, input.run.messageId, input.payloadHash, submitted);
  return submittedResponse(submitted);
}

function assertPullRequestReviewable(
  pullRequest: { state: string; merged: boolean; draft: boolean; headSha: string; body: string | null },
  request: ContextReviewSubmitRequest,
): void {
  if (pullRequest.state !== "open" || pullRequest.merged || (request.event === "APPROVE" && pullRequest.draft)) {
    throw new ContextReviewPublisherError(
      422,
      "CONTEXT_REVIEW_PR_NOT_REVIEWABLE",
      "The pull request is closed, merged, or draft for an APPROVE outcome.",
    );
  }
}

function submissionFromReview(input: {
  reviewedHead: string;
  event: ContextReviewEvent;
  payloadHash: string;
  review: { id: number; htmlUrl: string; actor: string };
  run: RunFacts;
  callerClientId: string;
}): Extract<SubmissionState, { state: "submitted" }> {
  return {
    state: "submitted",
    payloadHash: input.payloadHash,
    reviewedHead: input.reviewedHead,
    event: input.event,
    reviewId: input.review.id,
    reviewUrl: input.review.htmlUrl,
    appActor: input.review.actor,
    submittedAt: new Date().toISOString(),
    reviewerAgentUuid: input.run.reviewerAgentUuid,
    reviewerManagerHumanAgentId: input.run.reviewerManagerHumanAgentId,
    reviewerClientId: input.callerClientId,
    reviewerManagerGithubLogin: input.run.reviewerManagerGithubLogin,
  };
}

function submittedResponse(state: Extract<SubmissionState, { state: "submitted" }>): ContextReviewSubmitResponse {
  return {
    action: state.event,
    reviewedHead: state.reviewedHead,
    reviewId: state.reviewId,
    reviewUrl: state.reviewUrl,
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
      metadata: sql`jsonb_set(${messages.metadata}, '{contextReviewSubmission}', ${JSON.stringify(next)}::jsonb)`,
    })
    .where(
      and(
        eq(messages.id, messageId),
        sql`${messages.metadata}->'contextReviewSubmission'->>'state' = ${expectedState}`,
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
      metadata: sql`jsonb_set(${messages.metadata}, '{contextReviewSubmission}', ${JSON.stringify(next)}::jsonb)`,
    })
    .where(
      and(
        eq(messages.id, messageId),
        sql`${messages.metadata}->'contextReviewSubmission'->>'attemptId' = ${attemptId}`,
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
      metadata: sql`jsonb_set(${messages.metadata}, '{contextReviewSubmission}', ${JSON.stringify(next)}::jsonb)`,
    })
    .where(
      and(
        eq(messages.id, messageId),
        sql`${messages.metadata}->'contextReviewSubmission'->>'payloadHash' = ${payloadHash}`,
        sql`${messages.metadata}->'contextReviewSubmission'->>'state' in ('submitting', 'unknown')`,
      ),
    )
    .returning({ id: messages.id });
  return row !== undefined;
}

function parseSubmission(value: unknown): SubmissionState {
  const parsed = contextReviewSubmissionStateSchema.safeParse(value);
  return parsed.success ? parsed.data : invalidSubmission();
}

function invalidSubmission(): never {
  throw new ContextReviewPublisherError(
    403,
    "CONTEXT_REVIEW_RUN_FORBIDDEN",
    "Context Reviewer submission authority metadata is invalid.",
  );
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readPositiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function normalizeCommitOid(value: string | null): string | null {
  return value && /^[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : null;
}

function hashPayload(request: PreparedReviewRequest): string {
  return createHash("sha256")
    .update(JSON.stringify([request.reviewedHead.toLowerCase(), request.event, request.body.trimEnd()]))
    .digest("hex");
}

function runMarker(runId: string): string {
  return `<!-- first-tree-context-review-run:${runId} -->`;
}

function payloadMismatch(): ContextReviewPublisherError {
  return new ContextReviewPublisherError(
    409,
    "CONTEXT_REVIEW_RUN_PAYLOAD_MISMATCH",
    "This run was already claimed with a different immutable review payload.",
  );
}

function alreadySubmitted(): ContextReviewPublisherError {
  return new ContextReviewPublisherError(
    409,
    "CONTEXT_REVIEW_RUN_ALREADY_SUBMITTED",
    "This Context Reviewer run already has an active or terminal outcome. Reconcile it instead of submitting again.",
  );
}

function mapGithubPreflightError(error: unknown): ContextReviewPublisherError {
  if (error instanceof GithubAppApiError) {
    if (error.status === 401 || error.status === 403) {
      return new ContextReviewPublisherError(
        422,
        "CONTEXT_REVIEW_APP_PERMISSION_REQUIRED",
        "The GitHub App cannot read the target pull request with its scoped installation token.",
      );
    }
    if (error.status === 404) {
      return new ContextReviewPublisherError(
        422,
        "CONTEXT_REVIEW_REPO_NOT_ACCESSIBLE",
        "The GitHub App installation does not cover the bound Context Tree repository or pull request.",
      );
    }
  }
  return new ContextReviewPublisherError(503, "CONTEXT_REVIEW_GITHUB_REJECTED", "GitHub preflight failed.");
}

function mapGithubMutationError(error: unknown): ContextReviewPublisherError {
  if (error instanceof GithubAppApiError) {
    if (error.status === 401 || error.status === 403) {
      return new ContextReviewPublisherError(
        422,
        "CONTEXT_REVIEW_APP_PERMISSION_REQUIRED",
        "GitHub rejected the App review permission.",
      );
    }
    if (error.status === 404) {
      return new ContextReviewPublisherError(
        422,
        "CONTEXT_REVIEW_REPO_NOT_ACCESSIBLE",
        "GitHub no longer exposes the pull request to this App installation.",
      );
    }
    if (error.status === 422) {
      return new ContextReviewPublisherError(
        422,
        "CONTEXT_REVIEW_GITHUB_REJECTED",
        "GitHub rejected the commit-bound pull request review.",
      );
    }
  }
  return new ContextReviewPublisherError(502, "CONTEXT_REVIEW_GITHUB_REJECTED", "GitHub review submission failed.");
}

function isUnknownGithubWrite(error: unknown): boolean {
  return !(error instanceof GithubAppApiError) || error.status >= 500;
}
