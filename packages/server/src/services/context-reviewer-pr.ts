import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { CONTEXT_REVIEW_MANAGED_MARKER, chatMetadataSchema } from "@first-tree/shared";
import { and, desc, eq, sql } from "drizzle-orm";
import type * as ejs from "ejs";
import type { FastifyInstance } from "fastify";
import { isRecord, readNumber, readString } from "../api/webhooks/github-entity.js";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { authIdentities } from "../db/schema/auth-identities.js";
import { chats } from "../db/schema/chats.js";
import { members } from "../db/schema/members.js";
import { messages } from "../db/schema/messages.js";
import { AppError, ServiceUnavailableError } from "../errors.js";
import { createLogger } from "../observability/index.js";
import { uuidv7 } from "../uuid.js";
import {
  dispatchManagedContextReviewWebhookEvent,
  inspectManagedContextReviewTask,
  type ManagedContextReviewLivePullRequestState,
  type ManagedContextReviewWebhookEvent,
} from "./context-review-task.js";
import { GithubAppApiError, getPullRequestForReview } from "./github-app.js";
import { findInstallationByOrg } from "./github-app-installations.js";
import { mintContextTreeInstallationToken } from "./github-app-token.js";
import { sendMessage } from "./message.js";
import { notifyRecipients } from "./notifier.js";
import { getOrgContextTreeBinding, getOrgSetting } from "./org-settings.js";
import { applyMembershipWrite } from "./participant-mode.js";

const log = createLogger("ContextReviewerPr");
const require = createRequire(import.meta.url);
const REVIEWER_OPENED_ECHO_SUPPRESSION_WINDOW_SECONDS = 60 * 60;
// EJS is published as CommonJS at runtime even though its types expose named
// exports, so native ESM cannot import `render` directly.
const ejsRuntime: typeof ejs = require("ejs");
const TEMPLATE_CANDIDATE_URLS = [
  // Built tsdown chunks live directly under `dist/`; copied assets live in
  // `dist/prompts/`.
  new URL("./prompts/context-reviewer-pr.ejs", import.meta.url),
  // Dev tsx execution keeps this file under `src/services/`; assets live in
  // `src/prompts/`.
  new URL("../prompts/context-reviewer-pr.ejs", import.meta.url),
] as const;

export type ContextReviewerPrTemplateInput = {
  repoFullName: string;
  prNumber: number;
  title: string;
  htmlUrl: string;
  baseRef: string | null;
  headRef: string | null;
  authorLogin: string;
  senderLogin: string;
  triggerEvent: string;
  isDraft: boolean | null;
  commentUrl: string | null;
  commentAuthorLogin: string | null;
  organizationId: string;
  contextReviewRunId: string;
  reviewerManagerGithubLogin: string | null;
};

export type ContextReviewRoutingDecision =
  | "managed_handled"
  | "managed_missing"
  | "managed_unavailable"
  | "legacy_existing"
  | "not_applicable";

export function isManagedContextReviewRoutingDecision(decision: ContextReviewRoutingDecision): boolean {
  return decision === "managed_handled" || decision === "managed_missing" || decision === "managed_unavailable";
}

export type ContextReviewerPrResult =
  | {
      handled: false;
      reason: ContextReviewerPrSkipReason;
      routingDecision: "managed_missing" | "managed_unavailable" | "not_applicable";
    }
  | {
      handled: true;
      chatId: string;
      messageId: string;
      reused: boolean;
      suppressed?: boolean;
      routingDecision: "managed_handled" | "legacy_existing";
    };

export type ContextReviewerPrSkipReason =
  | "unsupported_event"
  | "malformed_payload"
  | "context_tree_repo_unset"
  | "repo_mismatch"
  | "managed_agent_review"
  | "managed_task_missing"
  | "managed_task_unavailable"
  | "feature_disabled"
  | "reviewer_agent_missing"
  | "reviewer_agent_invalid"
  | "legacy_creation_disabled";

type ContextReviewerPrPayloadInput = Omit<
  ContextReviewerPrTemplateInput,
  "contextReviewRunId" | "reviewerManagerGithubLogin"
>;

type PullRequestPayloadInfo = ContextReviewerPrPayloadInput & {
  eventType: "pull_request" | "issue_comment" | "pull_request_review_comment";
  action:
    | "opened"
    | "synchronize"
    | "ready_for_review"
    | "reopened"
    | "closed"
    | "review_requested"
    | "assigned"
    | "created"
    | "edited";
  entityKey: string;
  headSha: string | null;
  senderType: string | null;
  commentId: string | null;
  commentAuthorType: string | null;
  commentBody: string | null;
  prBody: string | null;
  previousPrBody: string | null;
  terminalState: "closed" | "merged" | null;
};

type PullRequestIdentity = {
  repoFullName: string;
  prNumber: number;
  entityKey: string;
  prBody: string | null;
  previousPrBody: string | null;
};

type ContextReviewerPrTrigger =
  | {
      eventType: "pull_request";
      action:
        | "opened"
        | "synchronize"
        | "ready_for_review"
        | "reopened"
        | "closed"
        | "review_requested"
        | "assigned"
        | "edited";
      triggerEvent: string;
    }
  | { eventType: "issue_comment"; action: "created" | "edited"; triggerEvent: string }
  | { eventType: "pull_request_review_comment"; action: "created" | "edited"; triggerEvent: string };

type ReviewerAgent = {
  uuid: string;
  managerHumanAgentId: string;
  managerGithubLogin: string | null;
};

let templateCache: Promise<string> | null = null;

export async function renderContextReviewerPrPrompt(input: ContextReviewerPrTemplateInput): Promise<string> {
  const template = await readTemplate();
  return ejsRuntime.render(template, input, { filename: fileURLToPath(await resolveTemplateUrl()) }).trim();
}

async function readTemplate(): Promise<string> {
  templateCache ??= resolveTemplateUrl().then((url) => readFile(url, "utf8"));
  return templateCache;
}

async function resolveTemplateUrl(): Promise<URL> {
  let lastError: unknown;
  for (const url of TEMPLATE_CANDIDATE_URLS) {
    try {
      await access(url);
      return url;
    } catch (err) {
      lastError = err;
      // Try the next runtime layout.
    }
  }
  throw new Error("Context Reviewer PR prompt template is missing from server runtime assets.", { cause: lastError });
}

export function normalizeGithubRepo(value: string | null | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  const withoutGit = stripGitSuffix(raw);

  const bare = parseBareRepo(withoutGit);
  if (bare) return bare;

  const scpLike = parseScpLikeRepo(withoutGit);
  if (scpLike) return scpLike;

  return parseUrlRepo(withoutGit);
}

function stripGitSuffix(value: string): string {
  const withoutTrailingSlash = trimTrailingSlashes(value);
  return withoutTrailingSlash.endsWith(".git") ? withoutTrailingSlash.slice(0, -4) : withoutTrailingSlash;
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") {
    end -= 1;
  }
  return value.slice(0, end);
}

function normalizeOwnerRepo(owner: string, repo: string): string | null {
  if (!owner || !repo) return null;
  if (owner.includes("/") || repo.includes("/")) return null;
  return `${owner}/${repo}`.toLowerCase();
}

function parseBareRepo(value: string): string | null {
  if (value.includes("://") || value.includes(":") || value.startsWith("/")) return null;
  const parts = value.split("/").filter(Boolean);
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (!owner || !repo) return null;
  return normalizeOwnerRepo(owner, repo);
}

function parseScpLikeRepo(value: string): string | null {
  if (value.includes("://")) return null;
  const match = /^(?:[^@\s/]+@)?([^:\s/]+):(.+)$/.exec(value);
  if (!match) return null;
  const host = match[1]?.toLowerCase();
  const path = match[2];
  if (host !== "github.com" || !path) return null;
  const parts = path.split("/").filter(Boolean);
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (!owner || !repo) return null;
  return normalizeOwnerRepo(owner, repo);
}

function parseUrlRepo(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.hostname.toLowerCase() !== "github.com") return null;
  if (url.protocol !== "https:" && url.protocol !== "ssh:") return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (!owner || !repo) return null;
  return normalizeOwnerRepo(owner, repo);
}

export async function handleContextReviewerPrEvent(
  app: FastifyInstance,
  input: {
    eventType: string;
    payload: unknown;
    organizationId: string;
    deliveryId?: string | null;
    /** Deterministic test seam; production resolves through the GitHub App. */
    livePullRequestResolver?: () => Promise<ManagedContextReviewLivePullRequestState>;
  },
): Promise<ContextReviewerPrResult> {
  const action = isRecord(input.payload) ? readString(input.payload.action) : null;
  if (!isContextReviewerCandidateEvent(input.eventType, action, input.payload)) {
    const identity = extractPullRequestIdentity(input.payload);
    if (!identity) {
      return { handled: false, reason: "unsupported_event", routingDecision: "not_applicable" };
    }
    const managedClassification = await classifyManagedPullRequestIdentity(app, {
      identity,
      organizationId: input.organizationId,
      triggerEvent: `${input.eventType}.${action ?? "unknown"}`,
    });
    if (managedClassification) return managedClassification;
    return { handled: false, reason: "unsupported_event", routingDecision: "not_applicable" };
  }

  const info = extractPullRequestPayloadInfo(input.eventType, input.payload, input.organizationId);
  if (!info) {
    const identity = extractPullRequestIdentity(input.payload);
    if (identity) {
      const managedClassification = await classifyManagedPullRequestIdentity(app, {
        identity,
        organizationId: input.organizationId,
        triggerEvent: `${input.eventType}.${action ?? "unknown"}`,
      });
      if (managedClassification) return managedClassification;
    }
    return { handled: false, reason: "malformed_payload", routingDecision: "not_applicable" };
  }
  const webhookRepo = normalizeGithubRepo(info.repoFullName);
  if (!webhookRepo) return { handled: false, reason: "malformed_payload", routingDecision: "not_applicable" };

  // Probe the immutable managed task identity before consulting mutable
  // routing configuration. If the binding or Reviewer changed, the task's
  // live authority check must fail closed as managed_unavailable; treating it
  // as ordinary GitHub traffic could create a competing execution line.
  const injectedLiveResolver = input.livePullRequestResolver;
  const prepareLivePullRequestResolver = injectedLiveResolver
    ? async () => injectedLiveResolver
    : () =>
        prepareLiveManagedPullRequestResolver(app, {
          organizationId: input.organizationId,
          repository: webhookRepo,
          pullRequest: info.prNumber,
        });
  let managedResult: Awaited<ReturnType<typeof dispatchManagedContextReviewWebhookEvent>>;
  try {
    managedResult = await dispatchManagedContextReviewWebhookEvent(
      app.db,
      managedContextReviewWebhookEvent(info, webhookRepo, input.deliveryId ?? null, prepareLivePullRequestResolver),
    );
  } catch (error) {
    // A 4xx here means the stable managed task was found but its live
    // authority or stored invariants now fail closed (for example requester
    // removal or ambiguous history). Do not mutate that task and do not let
    // its permanent admission failure starve the independent observation-card
    // surface. The typed routing decision ensures that surface remains silent
    // and cannot create a competing execution Chat. Unexpected/transient
    // failures still propagate so GitHub can retry the whole delivery.
    if (error instanceof AppError && error.statusCode >= 400 && error.statusCode < 500) {
      log.warn(
        {
          organizationId: input.organizationId,
          entityKey: info.entityKey,
          metric: "context_review_routing_total",
          routingDecision: "managed_unavailable",
          errorClass: error.name,
          statusCode: error.statusCode,
        },
        "managed Agent Review task unavailable; preserving card-only observation routing",
      );
      return { handled: false, reason: "managed_task_unavailable", routingDecision: "managed_unavailable" };
    }
    throw error;
  }
  if (managedResult.outcome !== "task_missing") {
    if (managedResult.outcome === "delivered") {
      notifyRecipients(app.notifier, managedResult.recipients, managedResult.messageId);
    }
    log.info(
      {
        organizationId: input.organizationId,
        entityKey: info.entityKey,
        chatId: managedResult.chatId,
        metric: "context_review_routing_total",
        routingDecision: "managed_handled",
        managedOutcome: managedResult.outcome,
        triggerEvent: info.triggerEvent,
        terminalState: info.terminalState,
      },
      "managed Agent Review event resolved on stable task Chat",
    );
    return {
      handled: true,
      chatId: managedResult.chatId,
      messageId: managedResult.messageId,
      reused: true,
      routingDecision: "managed_handled",
      ...(managedResult.outcome === "delivered" ? {} : { suppressed: true }),
    };
  }

  const contextTree = await getOrgContextTreeBinding(app.db, input.organizationId);
  const boundRepo = normalizeGithubRepo(contextTree?.repo);
  if (!boundRepo) {
    log.debug({ organizationId: input.organizationId }, "context reviewer skipped: context tree repo unset");
    return { handled: false, reason: "context_tree_repo_unset", routingDecision: "not_applicable" };
  }
  if (webhookRepo !== boundRepo) {
    log.debug(
      { organizationId: input.organizationId, webhookRepo, boundRepo },
      "context reviewer skipped: webhook repo is not bound context tree repo",
    );
    return { handled: false, reason: "repo_mismatch", routingDecision: "not_applicable" };
  }

  const declaresManagedReview =
    info.prBody?.includes(CONTEXT_REVIEW_MANAGED_MARKER) === true ||
    info.previousPrBody?.includes(CONTEXT_REVIEW_MANAGED_MARKER) === true;
  if (declaresManagedReview) {
    log.warn(
      {
        organizationId: input.organizationId,
        entityKey: info.entityKey,
        metric: "context_review_routing_total",
        routingDecision: "managed_missing",
        reason: "managed_task_missing",
      },
      "managed Agent Review marker has no stable task; refusing legacy takeover",
    );
    return { handled: false, reason: "managed_task_missing", routingDecision: "managed_missing" };
  }
  if (!resolveContextReviewerPrTrigger(input.eventType, action)) {
    return { handled: false, reason: "unsupported_event", routingDecision: "not_applicable" };
  }

  // Legacy compatibility may drain only into a pre-existing reviewer Chat.
  // It never creates a second execution line. Managed admission runs first so
  // a stable task always wins when managed and legacy state coexist.
  const features = await getOrgSetting(app.db, input.organizationId, "context_tree_features");
  if (!features.contextReviewer.enabled) {
    return { handled: false, reason: "feature_disabled", routingDecision: "not_applicable" };
  }
  const reviewerAgentUuid = features.contextReviewer.agentUuid;
  if (!reviewerAgentUuid) {
    return { handled: false, reason: "reviewer_agent_missing", routingDecision: "not_applicable" };
  }

  const reviewer = await loadValidReviewerAgent(app.db, {
    organizationId: input.organizationId,
    reviewerAgentUuid,
  });
  if (!reviewer) {
    log.warn(
      { organizationId: input.organizationId, reviewerAgentUuid },
      "context reviewer skipped: configured reviewer agent is no longer valid",
    );
    return { handled: false, reason: "reviewer_agent_invalid", routingDecision: "not_applicable" };
  }

  const metadata = chatMetadataSchema.parse({
    source: "github",
    entityType: "pull_request",
    entityKey: info.entityKey,
    entityUrl: info.htmlUrl,
    contextTreeReviewer: true,
    reviewerAgentUuid: reviewer.uuid,
  });
  const existingChatId = await findExistingReviewerChat(app.db, {
    organizationId: input.organizationId,
    entityKey: info.entityKey,
  });

  if (existingChatId) {
    log.info(
      {
        organizationId: input.organizationId,
        entityKey: info.entityKey,
        chatId: existingChatId,
        metric: "context_review_routing_total",
        routingDecision: "legacy_existing",
      },
      "draining legacy Context Reviewer event into existing task Chat",
    );
    await app.db.update(chats).set({ metadata }).where(eq(chats.id, existingChatId));
    await applyMembershipWrite(
      app.db,
      existingChatId,
      [{ agentId: reviewer.managerHumanAgentId }, { agentId: reviewer.uuid }],
      { onConflictDoNothing: true, upgradeWatcherToSpeaker: true },
    );
    const suppressedEchoMessageId = await findSuppressibleReviewerEchoMessageId(app.db, {
      chatId: existingChatId,
      info,
      reviewer,
      appSlug: app.config.oauth?.githubApp?.slug ?? null,
    });
    if (suppressedEchoMessageId) {
      log.info(
        {
          organizationId: input.organizationId,
          entityKey: info.entityKey,
          chatId: existingChatId,
          commentAuthorLogin: info.commentAuthorLogin,
        },
        "context reviewer echo comment suppressed",
      );
      return {
        handled: true,
        chatId: existingChatId,
        messageId: suppressedEchoMessageId,
        reused: true,
        suppressed: true,
        routingDecision: "legacy_existing",
      };
    }
    const supersedingSynchronizeMessageId = await findSupersedingSynchronizeMessageId(app.db, {
      chatId: existingChatId,
      info,
      reviewer,
    });
    if (supersedingSynchronizeMessageId) {
      return {
        handled: true,
        chatId: existingChatId,
        messageId: supersedingSynchronizeMessageId,
        reused: true,
        suppressed: true,
        routingDecision: "legacy_existing",
      };
    }

    const contextReviewRunId = uuidv7();
    const prompt = await renderContextReviewerPrPrompt(buildTemplateInput(info, reviewer, contextReviewRunId));
    const { message, recipients } = await sendMessage(
      app.db,
      existingChatId,
      reviewer.managerHumanAgentId,
      {
        source: "github",
        format: "markdown",
        content: prompt,
        metadata: contextReviewerMessageMetadata(info, reviewer, contextReviewRunId),
      },
      { normalizeMentionsInContent: false, allowContextReviewRun: true },
    );
    notifyRecipients(app.notifier, recipients, message.id);
    log.info(
      {
        organizationId: input.organizationId,
        entityKey: info.entityKey,
        chatId: existingChatId,
        triggerEvent: info.triggerEvent,
        isDraft: info.isDraft,
      },
      "context reviewer task sent to existing chat",
    );
    return {
      handled: true,
      chatId: existingChatId,
      messageId: message.id,
      reused: true,
      routingDecision: "legacy_existing",
    };
  }

  log.info(
    {
      organizationId: input.organizationId,
      entityKey: info.entityKey,
      metric: "context_review_routing_total",
      routingDecision: "not_applicable",
      reason: "legacy_creation_disabled",
    },
    "legacy Context Reviewer creation disabled; no existing task to drain",
  );
  return { handled: false, reason: "legacy_creation_disabled", routingDecision: "not_applicable" };
}

async function classifyManagedPullRequestIdentity(
  app: FastifyInstance,
  input: { identity: PullRequestIdentity; organizationId: string; triggerEvent: string },
): Promise<ContextReviewerPrResult | null> {
  const repository = normalizeGithubRepo(input.identity.repoFullName);
  if (!repository) {
    return { handled: false, reason: "malformed_payload", routingDecision: "not_applicable" };
  }
  try {
    const managedTask = await inspectManagedContextReviewTask(app.db, {
      organizationId: input.organizationId,
      repository,
      pullRequest: input.identity.prNumber,
    });
    if (managedTask.outcome === "task_existing") {
      log.info(
        {
          organizationId: input.organizationId,
          entityKey: input.identity.entityKey,
          chatId: managedTask.chatId,
          metric: "context_review_routing_total",
          routingDecision: "managed_handled",
          managedOutcome: "observation_only",
          triggerEvent: input.triggerEvent,
        },
        "managed Agent Review event reserved for card-only observation",
      );
      return {
        handled: true,
        chatId: managedTask.chatId,
        messageId: managedTask.messageId,
        reused: true,
        suppressed: true,
        routingDecision: "managed_handled",
      };
    }
  } catch (error) {
    if (error instanceof AppError && error.statusCode >= 400 && error.statusCode < 500) {
      log.warn(
        {
          organizationId: input.organizationId,
          entityKey: input.identity.entityKey,
          metric: "context_review_routing_total",
          routingDecision: "managed_unavailable",
          errorClass: error.name,
          statusCode: error.statusCode,
        },
        "managed Agent Review task unavailable; preserving card-only observation routing",
      );
      return { handled: false, reason: "managed_task_unavailable", routingDecision: "managed_unavailable" };
    }
    throw error;
  }

  const contextTree = await getOrgContextTreeBinding(app.db, input.organizationId);
  const boundRepository = normalizeGithubRepo(contextTree?.repo);
  const declaresManagedReview =
    input.identity.prBody?.includes(CONTEXT_REVIEW_MANAGED_MARKER) === true ||
    input.identity.previousPrBody?.includes(CONTEXT_REVIEW_MANAGED_MARKER) === true;
  if (repository === boundRepository && declaresManagedReview) {
    return { handled: false, reason: "managed_task_missing", routingDecision: "managed_missing" };
  }
  return null;
}

function extractPullRequestIdentity(payload: unknown): PullRequestIdentity | null {
  if (!isRecord(payload)) return null;
  const repository = isRecord(payload.repository) ? payload.repository : null;
  const repoFullName = readString(repository?.full_name);
  if (!repoFullName) return null;
  const normalizedRepo = normalizeGithubRepo(repoFullName) ?? repoFullName;

  const pullRequest = isRecord(payload.pull_request) ? payload.pull_request : null;
  if (pullRequest) {
    const prNumber = readNumber(pullRequest.number);
    if (prNumber === null) return null;
    const changes = isRecord(payload.changes) ? payload.changes : null;
    const bodyChange = isRecord(changes?.body) ? changes.body : null;
    return {
      repoFullName,
      prNumber,
      entityKey: `${normalizedRepo}#${prNumber}`,
      prBody: readString(pullRequest.body),
      previousPrBody: readString(bodyChange?.from),
    };
  }

  const issue = isRecord(payload.issue) ? payload.issue : null;
  if (!isRecord(issue?.pull_request)) return null;
  const prNumber = readNumber(issue?.number);
  if (prNumber === null) return null;
  return {
    repoFullName,
    prNumber,
    entityKey: `${normalizedRepo}#${prNumber}`,
    prBody: readString(issue?.body),
    previousPrBody: null,
  };
}

export async function handleContextReviewerPullRequest(
  app: FastifyInstance,
  input: {
    eventType: string;
    payload: unknown;
    organizationId: string;
    deliveryId?: string | null;
  },
): Promise<ContextReviewerPrResult> {
  return handleContextReviewerPrEvent(app, input);
}

function isSupportedContextReviewerPrEvent(eventType: string, action: string | null): boolean {
  return resolveContextReviewerPrTrigger(eventType, action) !== null;
}

function resolveContextReviewerPrTrigger(eventType: string, action: string | null): ContextReviewerPrTrigger | null {
  if (
    eventType === "pull_request" &&
    (action === "opened" || action === "synchronize" || action === "ready_for_review")
  ) {
    return { eventType, action, triggerEvent: `${eventType}.${action}` };
  }
  if (eventType === "issue_comment" && action === "created") {
    return { eventType, action, triggerEvent: `${eventType}.${action}` };
  }
  if (eventType === "pull_request_review_comment" && (action === "created" || action === "edited")) {
    return { eventType, action, triggerEvent: `${eventType}.${action}` };
  }
  return null;
}

function resolveManagedContextReviewerPrTrigger(
  eventType: string,
  action: string | null,
  payload: unknown,
): ContextReviewerPrTrigger | null {
  if (eventType === "pull_request") {
    if (action === "edited") {
      const changes = isRecord(payload) && isRecord(payload.changes) ? payload.changes : null;
      if (!changes || !Object.hasOwn(changes, "body")) return null;
      return { eventType, action, triggerEvent: `${eventType}.${action}` };
    }
    if (
      action === "opened" ||
      action === "synchronize" ||
      action === "ready_for_review" ||
      action === "reopened" ||
      action === "closed" ||
      action === "review_requested" ||
      action === "assigned"
    ) {
      return { eventType, action, triggerEvent: `${eventType}.${action}` };
    }
    return null;
  }
  if (eventType === "issue_comment" && (action === "created" || action === "edited")) {
    return { eventType, action, triggerEvent: `${eventType}.${action}` };
  }
  if (eventType === "pull_request_review_comment" && (action === "created" || action === "edited")) {
    return { eventType, action, triggerEvent: `${eventType}.${action}` };
  }
  return null;
}

export function isContextReviewerCandidateEvent(eventType: string, action: string | null, payload: unknown): boolean {
  return resolveManagedContextReviewerPrTrigger(eventType, action, payload) !== null;
}

function extractPullRequestPayloadInfo(
  eventType: string,
  payload: unknown,
  organizationId: string,
): PullRequestPayloadInfo | null {
  if (!isRecord(payload)) return null;
  const action = readString(payload.action);
  const trigger = resolveManagedContextReviewerPrTrigger(eventType, action, payload);
  if (!trigger) return null;

  const repo = isRecord(payload.repository) ? payload.repository : null;
  const repoFullName = readString(repo?.full_name);
  const sender = isRecord(payload.sender) ? payload.sender : null;
  const senderLogin = readString(sender?.login);
  if (!repoFullName || !senderLogin) return null;
  const normalizedRepoFullName = normalizeGithubRepo(repoFullName) ?? repoFullName;

  const common = {
    ...trigger,
    repoFullName,
    senderLogin,
    senderType: readString(sender?.type),
    organizationId,
  };

  if (trigger.eventType === "pull_request") {
    const pr = isRecord(payload.pull_request) ? payload.pull_request : null;
    const prNumber = readNumber(pr?.number);
    const title = readString(pr?.title);
    const htmlUrl = readString(pr?.html_url);
    const changes = isRecord(payload.changes) ? payload.changes : null;
    const bodyChange = isRecord(changes?.body) ? changes.body : null;
    if (prNumber === null || !title || !htmlUrl) return null;
    return {
      ...common,
      prNumber,
      title,
      htmlUrl,
      authorLogin: readUserLogin(pr) ?? senderLogin,
      baseRef: readString(isRecord(pr?.base) ? pr.base.ref : null),
      headRef: readString(isRecord(pr?.head) ? pr.head.ref : null),
      headSha: normalizeCommitOid(readString(isRecord(pr?.head) ? pr.head.sha : null)),
      isDraft: readDraftStatus(pr),
      commentId: null,
      commentUrl: null,
      commentAuthorLogin: null,
      commentAuthorType: null,
      commentBody: null,
      prBody: readString(pr?.body),
      previousPrBody: readString(bodyChange?.from),
      terminalState: trigger.action === "closed" ? (pr?.merged === true ? "merged" : "closed") : null,
      entityKey: `${normalizedRepoFullName}#${prNumber}`,
    };
  }

  if (trigger.eventType === "issue_comment") {
    const issue = isRecord(payload.issue) ? payload.issue : null;
    const prInfo = isRecord(issue?.pull_request) ? issue.pull_request : null;
    const prNumber = readNumber(issue?.number);
    const title = readString(issue?.title);
    const htmlUrl = readString(prInfo?.html_url) ?? readString(issue?.html_url);
    const comment = isRecord(payload.comment) ? payload.comment : null;
    const commentAuthor = readCommentAuthor(comment);
    if (!prInfo || prNumber === null || !title || !htmlUrl) return null;
    return {
      ...common,
      prNumber,
      title,
      htmlUrl,
      authorLogin: readUserLogin(issue) ?? senderLogin,
      baseRef: null,
      headRef: null,
      headSha: null,
      isDraft: null,
      commentId: readGithubCommentId(comment?.id),
      commentUrl: readString(comment?.html_url),
      commentAuthorLogin: commentAuthor.login ?? senderLogin,
      commentAuthorType: commentAuthor.type ?? common.senderType,
      commentBody: readString(comment?.body),
      prBody: readString(issue?.body),
      previousPrBody: null,
      terminalState: null,
      entityKey: `${normalizedRepoFullName}#${prNumber}`,
    };
  }

  if (trigger.eventType === "pull_request_review_comment") {
    const pr = isRecord(payload.pull_request) ? payload.pull_request : null;
    const prNumber = readNumber(pr?.number);
    const title = readString(pr?.title);
    const htmlUrl = readString(pr?.html_url);
    const comment = isRecord(payload.comment) ? payload.comment : null;
    const commentAuthor = readCommentAuthor(comment);
    if (prNumber === null || !title || !htmlUrl) return null;
    return {
      ...common,
      prNumber,
      title,
      htmlUrl,
      authorLogin: readUserLogin(pr) ?? senderLogin,
      baseRef: readString(isRecord(pr?.base) ? pr.base.ref : null),
      headRef: readString(isRecord(pr?.head) ? pr.head.ref : null),
      headSha: normalizeCommitOid(readString(isRecord(pr?.head) ? pr.head.sha : null)),
      isDraft: readDraftStatus(pr),
      commentId: readGithubCommentId(comment?.id),
      commentUrl: readString(comment?.html_url),
      commentAuthorLogin: commentAuthor.login ?? senderLogin,
      commentAuthorType: commentAuthor.type ?? common.senderType,
      commentBody: readString(comment?.body),
      prBody: readString(pr?.body),
      previousPrBody: null,
      terminalState: null,
      entityKey: `${normalizedRepoFullName}#${prNumber}`,
    };
  }

  return null;
}

function managedContextReviewWebhookEvent(
  info: PullRequestPayloadInfo,
  repository: string,
  deliveryId: string | null,
  prepareLivePullRequestResolver: () => Promise<() => Promise<ManagedContextReviewLivePullRequestState>>,
): ManagedContextReviewWebhookEvent {
  return {
    organizationId: info.organizationId,
    repository,
    pullRequest: info.prNumber,
    title: info.title,
    htmlUrl: info.htmlUrl,
    eventType: info.eventType,
    action: info.action,
    triggerEvent: info.triggerEvent,
    deliveryId,
    senderLogin: info.senderLogin,
    senderType: info.senderType,
    headSha: info.headSha,
    isDraft: info.isDraft,
    commentId: info.commentId,
    commentUrl: info.commentUrl,
    commentAuthorLogin: info.commentAuthorLogin,
    commentAuthorType: info.commentAuthorType,
    commentBody: info.commentBody,
    terminalState: info.terminalState,
    prepareLivePullRequestResolver,
  };
}

const MANAGED_REVIEW_GITHUB_TIMEOUT_MS = 10_000;

const managedReviewGithubFetch: typeof fetch = (resource, init) =>
  fetch(resource, { ...init, signal: AbortSignal.timeout(MANAGED_REVIEW_GITHUB_TIMEOUT_MS) });

async function prepareLiveManagedPullRequestResolver(
  app: FastifyInstance,
  input: { organizationId: string; repository: string; pullRequest: number },
): Promise<() => Promise<ManagedContextReviewLivePullRequestState>> {
  const installation = await findInstallationByOrg(app.db, input.organizationId);
  const mint = await mintContextTreeInstallationToken(installation, app.config.oauth?.githubApp, {
    fetcher: managedReviewGithubFetch,
  });
  if (!mint.ok) {
    throw new ServiceUnavailableError(
      `Managed Context Review could not obtain live GitHub state (${mint.reason}); GitHub should retry the webhook.`,
    );
  }
  const [owner, repo] = input.repository.split("/");
  if (!owner || !repo) throw new ServiceUnavailableError("Managed Context Review repository identity is invalid");
  return async () => {
    try {
      const pullRequest = await getPullRequestForReview(mint.token, owner, repo, input.pullRequest, {
        fetcher: managedReviewGithubFetch,
      });
      return pullRequest.merged ? "merged" : pullRequest.state;
    } catch (error) {
      const detail = error instanceof GithubAppApiError ? ` (${error.status})` : "";
      throw new ServiceUnavailableError(
        `Managed Context Review could not re-read live GitHub pull request state${detail}; GitHub should retry the webhook.`,
      );
    }
  };
}

function readDraftStatus(pr: Record<string, unknown> | null): boolean | null {
  if (!pr || typeof pr.draft !== "boolean") return null;
  return pr.draft;
}

function readGithubCommentId(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) return value;
  return null;
}

function normalizeCommitOid(value: string | null): string | null {
  return value && /^[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : null;
}

function readUserLogin(record: Record<string, unknown> | null): string | null {
  const user = isRecord(record?.user) ? record.user : null;
  return readString(user?.login);
}

function readCommentAuthor(comment: Record<string, unknown> | null): { login: string | null; type: string | null } {
  const user = isRecord(comment?.user) ? comment.user : null;
  return { login: readString(user?.login), type: readString(user?.type) };
}

function buildTemplateInput(
  info: PullRequestPayloadInfo,
  reviewer: ReviewerAgent,
  contextReviewRunId: string,
): ContextReviewerPrTemplateInput {
  return {
    ...info,
    contextReviewRunId,
    reviewerManagerGithubLogin: reviewer.managerGithubLogin,
  };
}

function contextReviewerMessageMetadata(
  info: PullRequestPayloadInfo,
  reviewer: ReviewerAgent,
  contextReviewRunId: string,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    source: "github",
    event: info.eventType,
    action: info.action,
    triggerEvent: info.triggerEvent,
    entityType: "pull_request",
    entityKey: info.entityKey,
    contextTreeReviewer: true,
    contextReviewRunId,
    contextReviewRepository: normalizeGithubRepo(info.repoFullName),
    contextReviewPrNumber: info.prNumber,
    contextReviewOrganizationId: info.organizationId,
    contextReviewReviewerAgentUuid: reviewer.uuid,
    contextReviewReviewerManagerHumanAgentId: reviewer.managerHumanAgentId,
    contextReviewSubmission: { state: "pending" },
    mentions: [reviewer.uuid],
    pullRequestAuthorLogin: info.authorLogin,
  };
  if (reviewer.managerGithubLogin) {
    metadata.reviewerManagerGithubLogin = reviewer.managerGithubLogin;
  }
  if (info.commentAuthorLogin) {
    metadata.commentAuthorLogin = info.commentAuthorLogin;
  }
  if (info.commentUrl) {
    metadata.commentUrl = info.commentUrl;
  }
  if (info.isDraft !== null) {
    metadata.pullRequestDraft = info.isDraft;
  }
  if (info.headSha) {
    metadata.contextReviewHeadSha = info.headSha;
  }
  return metadata;
}

async function loadValidReviewerAgent(
  db: Database,
  input: { organizationId: string; reviewerAgentUuid: string },
): Promise<ReviewerAgent | null> {
  const [agent] = await db
    .select({
      uuid: agents.uuid,
      managerHumanAgentId: members.agentId,
      managerGithubLogin: sql<string | null>`${authIdentities.metadata}->>'login'`,
    })
    .from(agents)
    .innerJoin(members, eq(members.id, agents.managerId))
    .leftJoin(authIdentities, and(eq(authIdentities.userId, members.userId), eq(authIdentities.provider, "github")))
    .where(
      and(
        eq(agents.uuid, input.reviewerAgentUuid),
        eq(agents.organizationId, input.organizationId),
        eq(agents.type, "agent"),
        eq(agents.status, "active"),
        eq(members.organizationId, input.organizationId),
        eq(members.status, "active"),
      ),
    )
    .limit(1);
  return agent ?? null;
}

async function findExistingReviewerChat(
  db: Database,
  input: { organizationId: string; entityKey: string },
): Promise<string | null> {
  const [row] = await db
    .select({ id: chats.id })
    .from(chats)
    .where(
      and(
        eq(chats.organizationId, input.organizationId),
        sql`${chats.metadata}->>'source' = 'github'`,
        sql`${chats.metadata}->>'entityType' = 'pull_request'`,
        sql`${chats.metadata}->>'entityKey' = ${input.entityKey}`,
        sql`${chats.metadata}->>'contextTreeReviewer' = 'true'`,
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

async function findSupersedingSynchronizeMessageId(
  db: Database,
  input: { chatId: string; info: PullRequestPayloadInfo; reviewer: ReviewerAgent },
): Promise<string | null> {
  if (input.info.triggerEvent !== "pull_request.opened") return null;
  const [row] = await db
    .select({ id: messages.id, headSha: sql<string | null>`${messages.metadata}->>'contextReviewHeadSha'` })
    .from(messages)
    .where(
      and(
        eq(messages.chatId, input.chatId),
        eq(messages.source, "github"),
        sql`${messages.metadata}->>'contextTreeReviewer' = 'true'`,
        sql`${messages.metadata}->>'triggerEvent' = 'pull_request.synchronize'`,
        sql`${messages.metadata}->>'contextReviewReviewerAgentUuid' = ${input.reviewer.uuid}`,
        sql`${messages.metadata}->>'contextReviewReviewerManagerHumanAgentId' = ${input.reviewer.managerHumanAgentId}`,
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(1);
  if (!row) return null;
  return input.info.headSha && row.headSha === input.info.headSha ? null : row.id;
}

async function findSuppressibleReviewerEchoMessageId(
  db: Database,
  input: { chatId: string; info: PullRequestPayloadInfo; reviewer: ReviewerAgent; appSlug: string | null },
): Promise<string | null> {
  if (input.info.eventType !== "issue_comment" || input.info.action !== "created") return null;

  const commentAuthorLogin = input.info.commentAuthorLogin?.trim().toLowerCase();
  if (!commentAuthorLogin) return null;

  const appBotLogin = input.appSlug ? `${input.appSlug.toLowerCase()}[bot]` : null;
  const commentAuthorIsAppBot =
    appBotLogin !== null && commentAuthorLogin === appBotLogin && isCommentAuthorBot(input.info);
  if (!commentAuthorIsAppBot) {
    log.debug(
      {
        reviewerAgentUuid: input.reviewer.uuid,
        entityKey: input.info.entityKey,
        commentAuthorLogin: input.info.commentAuthorLogin,
        appBotLogin,
        commentAuthorType: input.info.commentAuthorType,
        senderType: input.info.senderType,
      },
      "context reviewer echo comment not suppressed: comment author is not the configured app bot",
    );
    return null;
  }

  const [initialOpenedTask] = await db
    .select({
      id: messages.id,
    })
    .from(messages)
    .where(
      and(
        eq(messages.chatId, input.chatId),
        sql`${messages.metadata}->>'entityKey' = ${input.info.entityKey}`,
        sql`${messages.metadata}->>'contextTreeReviewer' = 'true'`,
        sql`${messages.metadata}->>'event' = 'pull_request'`,
        sql`${messages.metadata}->>'action' = 'opened'`,
        sql`${messages.metadata}->>'triggerEvent' = 'pull_request.opened'`,
        sql`${messages.createdAt} >= NOW() - make_interval(secs => ${REVIEWER_OPENED_ECHO_SUPPRESSION_WINDOW_SECONDS})`,
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(1);

  return initialOpenedTask?.id ?? null;
}

function isCommentAuthorBot(info: PullRequestPayloadInfo): boolean {
  return info.commentAuthorType?.trim().toLowerCase() === "bot";
}

export const contextReviewerPrTestInternals = {
  extractPullRequestPayloadInfo,
  findExistingReviewerChat,
  isSupportedContextReviewerPrEvent,
  loadValidReviewerAgent,
  parseBareRepo,
  parseScpLikeRepo,
  parseUrlRepo,
  findSuppressibleReviewerEchoMessageId,
};
