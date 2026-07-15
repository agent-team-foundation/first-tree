import { createHash } from "node:crypto";
import type { ContextReviewEvent, ContextReviewSubmitRequest, ContextReviewSubmitResponse } from "@first-tree/shared";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { chats } from "../db/schema/chats.js";
import { messages } from "../db/schema/messages.js";
import { uuidv7 } from "../uuid.js";
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
import { findInstallationByOrg } from "./github-app-installations.js";
import { getOrgContextTreeBinding, getOrgSetting } from "./org-settings.js";

type SubmissionState =
  | { state: "pending" }
  | {
      state: "submitting";
      payloadHash: string;
      attemptId: string;
      reviewedHead: string;
      event: ContextReviewEvent;
      claimedAt: string;
      reviewerClientId: string;
    }
  | {
      state: "unknown";
      payloadHash: string;
      attemptId: string;
      reviewedHead: string;
      event: ContextReviewEvent;
      failedAt: string;
      reviewerClientId: string;
    }
  | {
      state: "submitted";
      payloadHash: string;
      reviewedHead: string;
      event: ContextReviewEvent;
      reviewId: number;
      reviewUrl: string;
      appActor: string;
      submittedAt: string;
      reviewerAgentUuid: string;
      reviewerManagerHumanAgentId: string;
      reviewerClientId: string;
      reviewerManagerGithubLogin: string | null;
    }
  | { state: "failed"; payloadHash: string; code: string; failedAt: string };

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
  blockedByRunId: string | null;
  submission: SubmissionState;
};

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
  request: ContextReviewSubmitRequest;
  appCredentials: (GithubAppCredentials & { slug?: string }) | undefined;
  fetcher?: typeof fetch;
}): Promise<ContextReviewSubmitResponse> {
  const payloadHash = hashPayload(input.request);
  const inspection = await input.db.transaction(async (tx) => {
    const db = tx as unknown as Database;
    await lockReviewChat(db, input.chatId);
    const run = await loadRunFacts(db, input.chatId, input.runId);
    authorizeRun(run, input.callerAgentUuid);
    await assertCurrentRun(db, run);

    if (run.submission.state === "submitted") {
      if (run.submission.payloadHash !== payloadHash) throw payloadMismatch();
      return { kind: "submitted" as const, response: submittedResponse(run.submission) };
    }
    if (run.submission.state === "failed") {
      if (run.submission.payloadHash !== payloadHash) throw payloadMismatch();
      throw alreadySubmitted();
    }

    const current = await assertCurrentAuthority(db, run, input.callerAgentUuid);
    if (run.submission.state === "submitting" || run.submission.state === "unknown") {
      if (run.submission.payloadHash !== payloadHash) throw payloadMismatch();
      return {
        kind: "reconcile" as const,
        run,
        current,
        reviewerClientId: run.submission.reviewerClientId,
      };
    }
    return { kind: "pending" as const, run, current };
  });
  if (inspection.kind === "submitted") return inspection.response;
  const github = await prepareGithubPublisher({
    db: input.db,
    organizationId: inspection.run.organizationId,
    repository: inspection.run.repository,
    appCredentials: input.appCredentials,
    fetcher: input.fetcher,
  });
  const pullRequest = await getPullRequestForReview(
    github.token,
    inspection.current.owner,
    inspection.current.repo,
    inspection.run.prNumber,
    { fetcher: input.fetcher },
  ).catch((error: unknown) => {
    throw mapGithubPreflightError(error);
  });
  assertPullRequestReviewable(pullRequest, input.request);

  if (inspection.kind === "pending" && inspection.run.blockedByRunId) {
    await reconcileBlockingSubmission({
      db: input.db,
      currentRun: inspection.run,
      github,
      fetcher: input.fetcher,
    });
  }

  if (inspection.kind === "reconcile") {
    return reconcileUnknownSubmission({
      db: input.db,
      run: inspection.run,
      runId: input.runId,
      request: input.request,
      github,
      payloadHash,
      reviewerClientId: inspection.reviewerClientId,
      fetcher: input.fetcher,
    });
  }

  const claim = await input.db.transaction(async (tx) => {
    const db = tx as unknown as Database;
    await lockReviewChat(db, input.chatId);
    const run = await loadRunFacts(db, input.chatId, input.runId);
    authorizeRun(run, input.callerAgentUuid);
    await assertCurrentRun(db, run);
    await assertCurrentAuthority(db, run, input.callerAgentUuid);

    if (run.submission.state === "submitted") {
      if (run.submission.payloadHash !== payloadHash) throw payloadMismatch();
      return { kind: "submitted" as const, response: submittedResponse(run.submission) };
    }
    if (run.submission.state === "failed") {
      if (run.submission.payloadHash !== payloadHash) throw payloadMismatch();
      throw alreadySubmitted();
    }
    if (run.submission.state === "submitting" || run.submission.state === "unknown") {
      if (run.submission.payloadHash !== payloadHash) throw payloadMismatch();
      return {
        kind: "reconcile" as const,
        run,
        reviewerClientId: run.submission.reviewerClientId,
      };
    }

    const attemptId = uuidv7();
    const claimed = await setSubmissionIf(db, run.messageId, "pending", {
      state: "submitting",
      payloadHash,
      attemptId,
      reviewedHead: input.request.reviewedHead,
      event: input.request.event,
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
      request: input.request,
      github,
      payloadHash,
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
        commitId: input.request.reviewedHead,
        event: input.request.event,
        body: `${input.request.body.trimEnd()}\n\n${marker}`,
      },
      { fetcher: input.fetcher },
    );
  } catch (error) {
    if (isUnknownGithubWrite(error)) {
      await setSubmissionForAttempt(input.db, claim.run.messageId, claim.attemptId, {
        state: "unknown",
        payloadHash,
        attemptId: claim.attemptId,
        reviewedHead: input.request.reviewedHead,
        event: input.request.event,
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
    reviewedHead: input.request.reviewedHead,
    event: input.request.event,
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

async function assertCurrentRun(db: Database, run: RunFacts): Promise<void> {
  const [latest] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.chatId, run.chatId),
        eq(messages.source, "github"),
        sql`${messages.metadata}->>'contextTreeReviewer' = 'true'`,
        sql`${messages.metadata}->>'contextReviewRepository' = ${run.repository}`,
        sql`${messages.metadata}->>'contextReviewPrNumber' = ${String(run.prNumber)}`,
        sql`${messages.metadata}->>'contextReviewRunId' IS NOT NULL`,
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(1);
  if (latest?.id !== run.messageId) {
    throw new ContextReviewPublisherError(
      409,
      "CONTEXT_REVIEW_RUN_SUPERSEDED",
      "A newer Context Reviewer run superseded this run. Only the current run may publish a GitHub review.",
    );
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
    blockedByRunId: readNonEmptyString(metadata.contextReviewBlockedByRunId),
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

async function assertCurrentAuthority(db: Database, run: RunFacts, callerAgentUuid: string) {
  const features = await getOrgSetting(db, run.organizationId, "context_tree_features");
  if (!features.contextReviewer.enabled || features.contextReviewer.agentUuid !== callerAgentUuid) {
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
  return { owner, repo };
}

async function prepareGithubPublisher(input: {
  db: Database;
  organizationId: string;
  repository: string;
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
  const installation = await findInstallationByOrg(input.db, input.organizationId);
  if (!installation) {
    throw new ContextReviewPublisherError(
      422,
      "CONTEXT_REVIEW_APP_NOT_INSTALLED",
      "Connect the GitHub App installation for this team before publishing Context reviews.",
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
  const [, repo] = input.repository.split("/");
  if (!repo) throw new ContextReviewPublisherError(403, "CONTEXT_REVIEW_RUN_FORBIDDEN", "Invalid repo.");
  try {
    const appJwt = await createAppJwt(input.appCredentials);
    const minted = await mintInstallationToken(appJwt, installation.installationId, {
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

async function reconcileBlockingSubmission(input: {
  db: Database;
  currentRun: RunFacts;
  github: { token: string; appSlug: string };
  fetcher?: typeof fetch;
}): Promise<void> {
  const blocker = await input.db.transaction(async (tx) => {
    const db = tx as unknown as Database;
    await lockReviewChat(db, input.currentRun.chatId);
    const current = await loadRunFacts(db, input.currentRun.chatId, input.currentRun.runId);
    await assertCurrentRun(db, current);
    const blocking = await loadBlockingRun(db, current);
    if (blocking.submission.state === "submitted" || blocking.submission.state === "failed") return null;
    if (blocking.submission.state === "pending") throw invalidBlockingRun();
    return blocking;
  });
  if (!blocker) return;

  const [owner, repo] = blocker.repository.split("/");
  if (!owner || !repo) throw new ContextReviewPublisherError(403, "CONTEXT_REVIEW_RUN_FORBIDDEN", "Invalid repo.");
  const reviews = await listPullRequestReviewsForRun(
    input.github.token,
    { owner, repo, prNumber: blocker.prNumber, marker: runMarker(blocker.runId), appSlug: input.github.appSlug },
    { fetcher: input.fetcher },
  ).catch(() => {
    throw new ContextReviewPublisherError(
      502,
      "CONTEXT_REVIEW_GITHUB_UNKNOWN",
      "Unable to reconcile the preceding GitHub review delivery before publishing the new head.",
    );
  });
  const submission = blocker.submission;
  if (submission.state !== "submitting" && submission.state !== "unknown") throw invalidBlockingRun();
  const matching = reviews.filter((review) => review.commitId?.toLowerCase() === submission.reviewedHead.toLowerCase());
  if (matching.length !== 1) {
    throw new ContextReviewPublisherError(
      502,
      "CONTEXT_REVIEW_GITHUB_UNKNOWN",
      "The preceding old-head review delivery remains unresolved. The new-head verdict is withheld so it cannot be overwritten by a late App review.",
    );
  }
  const review = matching[0];
  if (!review) throw invalidBlockingRun();
  if (!reviewStateMatchesEvent(review.state, submission.event)) {
    throw new ContextReviewPublisherError(
      502,
      "CONTEXT_REVIEW_GITHUB_UNKNOWN",
      "The preceding App review marker does not match its durable verdict claim.",
    );
  }
  const submitted = submissionFromReview({
    reviewedHead: submission.reviewedHead,
    event: submission.event,
    payloadHash: submission.payloadHash,
    review,
    run: blocker,
    callerClientId: submission.reviewerClientId,
  });

  await input.db.transaction(async (tx) => {
    const db = tx as unknown as Database;
    await lockReviewChat(db, input.currentRun.chatId);
    const current = await loadRunFacts(db, input.currentRun.chatId, input.currentRun.runId);
    await assertCurrentRun(db, current);
    const refreshed = await loadBlockingRun(db, current);
    if (refreshed.submission.state === "submitted" || refreshed.submission.state === "failed") return;
    if (
      (refreshed.submission.state !== "submitting" && refreshed.submission.state !== "unknown") ||
      refreshed.submission.payloadHash !== submission.payloadHash ||
      refreshed.submission.reviewedHead.toLowerCase() !== submission.reviewedHead.toLowerCase()
    ) {
      throw invalidBlockingRun();
    }
    const recorded = await setSubmissionForPayload(db, refreshed.messageId, submission.payloadHash, submitted);
    if (!recorded) throw invalidBlockingRun();
  });
}

async function loadBlockingRun(db: Database, current: RunFacts): Promise<RunFacts> {
  if (!current.blockedByRunId || current.blockedByRunId === current.runId) throw invalidBlockingRun();
  const blocking = await loadRunFacts(db, current.chatId, current.blockedByRunId);
  if (
    blocking.chatId !== current.chatId ||
    blocking.organizationId !== current.organizationId ||
    blocking.repository !== current.repository ||
    blocking.prNumber !== current.prNumber ||
    blocking.reviewerAgentUuid !== current.reviewerAgentUuid
  ) {
    throw invalidBlockingRun();
  }
  return blocking;
}

function reviewStateMatchesEvent(state: string | null, event: ContextReviewEvent): boolean {
  if (state === "DISMISSED") return true;
  if (event === "APPROVE") return state === "APPROVED";
  if (event === "REQUEST_CHANGES") return state === "CHANGES_REQUESTED";
  return state === "COMMENTED";
}

function invalidBlockingRun(): ContextReviewPublisherError {
  return new ContextReviewPublisherError(
    403,
    "CONTEXT_REVIEW_RUN_FORBIDDEN",
    "The Context Reviewer predecessor authority metadata is invalid.",
  );
}

async function reconcileUnknownSubmission(input: {
  db: Database;
  run: RunFacts;
  runId: string;
  request: ContextReviewSubmitRequest;
  github: { token: string; appSlug: string };
  payloadHash: string;
  reviewerClientId: string;
  fetcher?: typeof fetch;
}): Promise<ContextReviewSubmitResponse> {
  const [owner, repo] = input.run.repository.split("/");
  if (!owner || !repo) throw new ContextReviewPublisherError(403, "CONTEXT_REVIEW_RUN_FORBIDDEN", "Invalid repo.");
  const pullRequest = await getPullRequestForReview(input.github.token, owner, repo, input.run.prNumber, {
    fetcher: input.fetcher,
  }).catch((error: unknown) => {
    throw mapGithubPreflightError(error);
  });
  assertPullRequestReviewable(pullRequest, input.request);
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
  pullRequest: { state: string; merged: boolean; draft: boolean; headSha: string },
  request: ContextReviewSubmitRequest,
): void {
  if (pullRequest.state !== "open" || pullRequest.merged || (request.event === "APPROVE" && pullRequest.draft)) {
    throw new ContextReviewPublisherError(
      422,
      "CONTEXT_REVIEW_PR_NOT_REVIEWABLE",
      "The pull request is closed, merged, or draft for an APPROVE outcome.",
    );
  }
  if (pullRequest.headSha.toLowerCase() !== request.reviewedHead.toLowerCase()) {
    throw new ContextReviewPublisherError(
      409,
      "CONTEXT_REVIEW_STALE_HEAD",
      "The pull request head changed after review. Wait for the synchronize-triggered run.",
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
  if (!value || typeof value !== "object") return invalidSubmission();
  const candidate = value as Record<string, unknown>;
  if (candidate.state === "pending") return { state: "pending" };
  if (
    candidate.state === "submitting" &&
    hasStrings(candidate, ["payloadHash", "attemptId", "reviewedHead", "event", "claimedAt", "reviewerClientId"]) &&
    isContextReviewEvent(candidate.event)
  ) {
    return candidate as SubmissionState;
  }
  if (
    candidate.state === "unknown" &&
    hasStrings(candidate, ["payloadHash", "attemptId", "reviewedHead", "event", "failedAt", "reviewerClientId"]) &&
    isContextReviewEvent(candidate.event)
  ) {
    return candidate as SubmissionState;
  }
  if (candidate.state === "failed" && hasStrings(candidate, ["payloadHash", "code", "failedAt"])) {
    return candidate as SubmissionState;
  }
  if (
    candidate.state === "submitted" &&
    hasStrings(candidate, [
      "payloadHash",
      "reviewedHead",
      "event",
      "reviewUrl",
      "appActor",
      "submittedAt",
      "reviewerAgentUuid",
      "reviewerManagerHumanAgentId",
      "reviewerClientId",
    ]) &&
    typeof candidate.reviewId === "number" &&
    Number.isInteger(candidate.reviewId)
  ) {
    return candidate as SubmissionState;
  }
  return invalidSubmission();
}

function hasStrings(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => typeof value[key] === "string" && value[key].length > 0);
}

function isContextReviewEvent(value: unknown): value is ContextReviewEvent {
  return value === "APPROVE" || value === "REQUEST_CHANGES" || value === "COMMENT";
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

function hashPayload(request: ContextReviewSubmitRequest): string {
  return createHash("sha256")
    .update(JSON.stringify([request.reviewedHead.toLowerCase(), request.event, request.body]))
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
