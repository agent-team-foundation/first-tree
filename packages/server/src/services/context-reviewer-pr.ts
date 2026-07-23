import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { chatMetadataSchema } from "@first-tree/shared";
import { and, desc, eq, sql } from "drizzle-orm";
import type * as ejs from "ejs";
import type { FastifyInstance } from "fastify";
import { isRecord, readNumber, readString } from "../api/webhooks/github-entity.js";
import type { Database } from "../db/connection.js";
import { chats } from "../db/schema/chats.js";
import { messages } from "../db/schema/messages.js";
import { createLogger } from "../observability/index.js";
import { uuidv7 } from "../uuid.js";
import { createChat } from "./chat.js";
import {
  type ContextReviewerAgent,
  contextReviewerChatReservationKey,
  findExistingContextReviewerChat,
  loadValidContextReviewerAgent,
} from "./context-reviewer-common.js";
import { sendMessage } from "./message.js";
import { notifyRecipients } from "./notifier.js";
import { getOrgContextReviewRuntime } from "./org-settings.js";
import { applyMembershipWrite } from "./participant-mode.js";
import { formatContextReviewTopic } from "./scm-entity-chat-topic.js";

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

export type ContextReviewerPrResult =
  | { handled: false; reason: ContextReviewerPrSkipReason }
  | { handled: true; chatId: string; messageId: string; reused: boolean; suppressed?: boolean };

export type ContextReviewerPrSkipReason =
  | "unsupported_event"
  | "malformed_payload"
  | "context_tree_repo_unset"
  | "repo_mismatch"
  | "feature_disabled"
  | "reviewer_agent_missing"
  | "reviewer_agent_invalid";

type ContextReviewerPrPayloadInput = Omit<
  ContextReviewerPrTemplateInput,
  "contextReviewRunId" | "reviewerManagerGithubLogin"
>;

type PullRequestPayloadInfo = ContextReviewerPrPayloadInput & {
  eventType: "pull_request" | "issue_comment" | "pull_request_review_comment";
  action: "opened" | "synchronize" | "ready_for_review" | "reopened" | "created" | "edited";
  entityKey: string;
  senderType: string | null;
  commentAuthorType: string | null;
};

type ContextReviewerPrTrigger =
  | {
      eventType: "pull_request";
      action: "opened" | "synchronize" | "ready_for_review" | "reopened";
      triggerEvent: string;
    }
  | { eventType: "issue_comment"; action: "created"; triggerEvent: string }
  | { eventType: "pull_request_review_comment"; action: "created" | "edited"; triggerEvent: string };

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
  },
): Promise<ContextReviewerPrResult> {
  const action = isRecord(input.payload) ? readString(input.payload.action) : null;
  if (!resolveContextReviewerPrTrigger(input.eventType, action, input.payload)) {
    return { handled: false, reason: "unsupported_event" };
  }

  const info = extractPullRequestPayloadInfo(input.eventType, input.payload, input.organizationId);
  if (!info) {
    return { handled: false, reason: "malformed_payload" };
  }

  return handleContextReviewerPrEventWithInfo(app, input, info);
}

async function handleContextReviewerPrEventWithInfo(
  app: FastifyInstance,
  input: {
    eventType: string;
    payload: unknown;
    organizationId: string;
  },
  info: PullRequestPayloadInfo,
): Promise<ContextReviewerPrResult> {
  const runtime = await getOrgContextReviewRuntime(app.db, input.organizationId);
  const boundRepo = normalizeGithubRepo(runtime.repo);
  if (runtime.bindingState !== "bound" || !runtime.repo) {
    log.debug({ organizationId: input.organizationId }, "context reviewer skipped: context tree repo unset");
    return { handled: false, reason: "context_tree_repo_unset" };
  }
  if (runtime.provider !== "github" || !runtime.providerMatchesRepository || !boundRepo) {
    log.debug(
      {
        organizationId: input.organizationId,
        provider: runtime.provider,
        providerMatchesRepository: runtime.providerMatchesRepository,
      },
      "context reviewer skipped: context tree is not an executable GitHub binding",
    );
    return { handled: false, reason: "repo_mismatch" };
  }
  const webhookRepo = normalizeGithubRepo(info.repoFullName);
  if (!webhookRepo || webhookRepo !== boundRepo) {
    log.debug(
      { organizationId: input.organizationId, webhookRepo, boundRepo },
      "context reviewer skipped: webhook repo is not bound context tree repo",
    );
    return { handled: false, reason: "repo_mismatch" };
  }

  if (!runtime.contextReviewer.enabled) {
    return { handled: false, reason: "feature_disabled" };
  }
  const reviewerAgentUuid = runtime.contextReviewer.agentUuid;
  if (!reviewerAgentUuid) {
    return { handled: false, reason: "reviewer_agent_missing" };
  }

  const reviewer = await loadValidContextReviewerAgent(app.db, {
    organizationId: input.organizationId,
    reviewerAgentUuid,
  });
  if (!reviewer) {
    log.warn(
      { organizationId: input.organizationId, reviewerAgentUuid },
      "context reviewer skipped: configured reviewer agent is no longer valid",
    );
    return { handled: false, reason: "reviewer_agent_invalid" };
  }

  const existingChatId = await findExistingContextReviewerChat(app.db, {
    organizationId: input.organizationId,
    entityKey: info.entityKey,
  });

  const metadata = chatMetadataSchema.parse({
    source: "github",
    entityType: "pull_request",
    entityKey: info.entityKey,
    entityUrl: info.htmlUrl,
    contextTreeReviewer: true,
    reviewerAgentUuid: reviewer.uuid,
  });
  if (existingChatId) {
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
    return { handled: true, chatId: existingChatId, messageId: message.id, reused: true };
  }

  const contextReviewRunId = uuidv7();
  const prompt = await renderContextReviewerPrPrompt(buildTemplateInput(info, reviewer, contextReviewRunId));
  const created = await createChat(app.db, {
    mode: "task",
    initiatorAgentId: reviewer.managerHumanAgentId,
    organizationId: input.organizationId,
    initialRecipientAgentIds: [reviewer.uuid],
    contextParticipantAgentIds: [],
    topic: formatContextReviewTopic({
      provider: "github",
      repositoryPath: info.repoFullName,
      changeNumber: info.prNumber,
    }),
    onboardingKickoffKey: contextReviewerChatReservationKey(input.organizationId, info.entityKey),
    initialMessage: {
      source: "github",
      format: "markdown",
      content: prompt,
      metadata: contextReviewerMessageMetadata(info, reviewer, contextReviewRunId),
    },
    allowContextReviewRun: true,
    source: "manual",
  });
  await app.db.update(chats).set({ metadata }).where(eq(chats.id, created.chat.id));
  if (!created.initialMessageCreated) {
    await applyMembershipWrite(
      app.db,
      created.chat.id,
      [{ agentId: reviewer.managerHumanAgentId }, { agentId: reviewer.uuid }],
      { onConflictDoNothing: true, upgradeWatcherToSpeaker: true },
    );
    const { message, recipients } = await sendMessage(
      app.db,
      created.chat.id,
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
    return { handled: true, chatId: created.chat.id, messageId: message.id, reused: true };
  }
  notifyRecipients(app.notifier, created.recipients, created.message.id);
  log.info(
    {
      organizationId: input.organizationId,
      entityKey: info.entityKey,
      chatId: created.chat.id,
      triggerEvent: info.triggerEvent,
      isDraft: info.isDraft,
    },
    "context reviewer task chat created",
  );
  return { handled: true, chatId: created.chat.id, messageId: created.message.id, reused: false };
}

export async function handleContextReviewerPullRequest(
  app: FastifyInstance,
  input: {
    eventType: string;
    payload: unknown;
    organizationId: string;
  },
): Promise<ContextReviewerPrResult> {
  return handleContextReviewerPrEvent(app, input);
}

function isSupportedContextReviewerPrEvent(eventType: string, action: string | null): boolean {
  return resolveContextReviewerPrTrigger(eventType, action) !== null;
}

function resolveContextReviewerPrTrigger(
  eventType: string,
  action: string | null,
  _payload?: unknown,
): ContextReviewerPrTrigger | null {
  if (
    eventType === "pull_request" &&
    (action === "opened" || action === "reopened" || action === "synchronize" || action === "ready_for_review")
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

export function isContextReviewerCandidateEvent(eventType: string, action: string | null, payload?: unknown): boolean {
  return resolveContextReviewerPrTrigger(eventType, action, payload) !== null;
}

function extractPullRequestPayloadInfo(
  eventType: string,
  payload: unknown,
  organizationId: string,
): PullRequestPayloadInfo | null {
  if (!isRecord(payload)) return null;
  const action = readString(payload.action);
  const trigger = resolveContextReviewerPrTrigger(eventType, action, payload);
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
    if (prNumber === null || !title || !htmlUrl) return null;
    return {
      ...common,
      prNumber,
      title,
      htmlUrl,
      authorLogin: readUserLogin(pr) ?? senderLogin,
      baseRef: readString(isRecord(pr?.base) ? pr.base.ref : null),
      headRef: readString(isRecord(pr?.head) ? pr.head.ref : null),
      isDraft: readDraftStatus(pr),
      commentUrl: null,
      commentAuthorLogin: null,
      commentAuthorType: null,
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
      isDraft: null,
      commentUrl: readString(comment?.html_url),
      commentAuthorLogin: commentAuthor.login ?? senderLogin,
      commentAuthorType: commentAuthor.type ?? common.senderType,
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
      isDraft: readDraftStatus(pr),
      commentUrl: readString(comment?.html_url),
      commentAuthorLogin: commentAuthor.login ?? senderLogin,
      commentAuthorType: commentAuthor.type ?? common.senderType,
      entityKey: `${normalizedRepoFullName}#${prNumber}`,
    };
  }

  return null;
}

function readDraftStatus(pr: Record<string, unknown> | null): boolean | null {
  if (!pr || typeof pr.draft !== "boolean") return null;
  return pr.draft;
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
  reviewer: ContextReviewerAgent,
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
  reviewer: ContextReviewerAgent,
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
  return metadata;
}

async function findSuppressibleReviewerEchoMessageId(
  db: Database,
  input: { chatId: string; info: PullRequestPayloadInfo; reviewer: ContextReviewerAgent; appSlug: string | null },
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
  findExistingReviewerChat: findExistingContextReviewerChat,
  isSupportedContextReviewerPrEvent,
  loadValidReviewerAgent: loadValidContextReviewerAgent,
  parseBareRepo,
  parseScpLikeRepo,
  parseUrlRepo,
  findSuppressibleReviewerEchoMessageId,
};
