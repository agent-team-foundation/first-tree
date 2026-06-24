import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { chatMetadataSchema } from "@first-tree/shared";
import { and, desc, eq, sql } from "drizzle-orm";
import type * as ejs from "ejs";
import type { FastifyInstance } from "fastify";
import { isRecord, readNumber, readString } from "../api/webhooks/github-entity.js";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { chats } from "../db/schema/chats.js";
import { members } from "../db/schema/members.js";
import { messages } from "../db/schema/messages.js";
import { createLogger } from "../observability/index.js";
import { createChat } from "./chat.js";
import { sendMessage } from "./message.js";
import { notifyRecipients } from "./notifier.js";
import { getOrgContextTree, getOrgSetting } from "./org-settings.js";
import { applyMembershipWrite } from "./participant-mode.js";

const log = createLogger("ContextReviewerPr");
const require = createRequire(import.meta.url);
const FOLLOW_UP_NOTICE = "A new GitHub event was received. I'll check the current PR state.";
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
  senderLogin: string;
  triggerEvent: string;
  commentUrl: string | null;
  commentAuthorLogin: string | null;
  organizationId: string;
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

type PullRequestPayloadInfo = ContextReviewerPrTemplateInput & {
  eventType: "pull_request" | "issue_comment" | "pull_request_review_comment";
  action: "opened" | "synchronize" | "created" | "edited";
  entityKey: string;
};

type ContextReviewerPrTrigger =
  | { eventType: "pull_request"; action: "opened" | "synchronize"; triggerEvent: string }
  | { eventType: "issue_comment"; action: "created"; triggerEvent: string }
  | { eventType: "pull_request_review_comment"; action: "created" | "edited"; triggerEvent: string };

type ReviewerAgent = {
  uuid: string;
  name: string | null;
  managerHumanAgentId: string;
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
  },
): Promise<ContextReviewerPrResult> {
  if (
    !resolveContextReviewerPrTrigger(input.eventType, isRecord(input.payload) ? readString(input.payload.action) : null)
  ) {
    return { handled: false, reason: "unsupported_event" };
  }

  const info = extractPullRequestPayloadInfo(input.eventType, input.payload, input.organizationId);
  if (!info) {
    return { handled: false, reason: "malformed_payload" };
  }

  const contextTree = await getOrgContextTree(app.db, input.organizationId);
  const boundRepo = normalizeGithubRepo(contextTree.repo);
  if (!boundRepo) {
    log.debug({ organizationId: input.organizationId }, "context reviewer skipped: context tree repo unset");
    return { handled: false, reason: "context_tree_repo_unset" };
  }
  const webhookRepo = normalizeGithubRepo(info.repoFullName);
  if (!webhookRepo || webhookRepo !== boundRepo) {
    log.debug(
      { organizationId: input.organizationId, webhookRepo, boundRepo },
      "context reviewer skipped: webhook repo is not bound context tree repo",
    );
    return { handled: false, reason: "repo_mismatch" };
  }

  const features = await getOrgSetting(app.db, input.organizationId, "context_tree_features");
  if (!features.contextReviewer.enabled) {
    return { handled: false, reason: "feature_disabled" };
  }
  const reviewerAgentUuid = features.contextReviewer.agentUuid;
  if (!reviewerAgentUuid) {
    return { handled: false, reason: "reviewer_agent_missing" };
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
    return { handled: false, reason: "reviewer_agent_invalid" };
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

    const { message, recipients } = await sendMessage(
      app.db,
      existingChatId,
      reviewer.managerHumanAgentId,
      {
        source: "github",
        format: "markdown",
        content: FOLLOW_UP_NOTICE,
        metadata: contextReviewerMessageMetadata(info, reviewer),
      },
      { normalizeMentionsInContent: false },
    );
    notifyRecipients(app.notifier, recipients, message.id);
    log.info(
      { organizationId: input.organizationId, entityKey: info.entityKey, chatId: existingChatId },
      "context reviewer task sent to existing chat",
    );
    return { handled: true, chatId: existingChatId, messageId: message.id, reused: true };
  }

  const prompt = await renderContextReviewerPrPrompt(info);
  const created = await createChat(app.db, {
    mode: "task",
    initiatorAgentId: reviewer.managerHumanAgentId,
    organizationId: input.organizationId,
    initialRecipientAgentIds: [reviewer.uuid],
    contextParticipantAgentIds: [],
    topic: `Context Review PR #${info.prNumber}: ${info.title}`,
    initialMessage: {
      source: "github",
      format: "markdown",
      content: prompt,
      metadata: contextReviewerMessageMetadata(info, reviewer),
    },
    source: "manual",
  });
  await app.db.update(chats).set({ metadata }).where(eq(chats.id, created.chat.id));
  notifyRecipients(app.notifier, created.recipients, created.message.id);
  log.info(
    { organizationId: input.organizationId, entityKey: info.entityKey, chatId: created.chat.id },
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

function resolveContextReviewerPrTrigger(eventType: string, action: string | null): ContextReviewerPrTrigger | null {
  if (eventType === "pull_request" && (action === "opened" || action === "synchronize")) {
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

function extractPullRequestPayloadInfo(
  eventType: string,
  payload: unknown,
  organizationId: string,
): PullRequestPayloadInfo | null {
  if (!isRecord(payload)) return null;
  const action = readString(payload.action);
  const trigger = resolveContextReviewerPrTrigger(eventType, action);
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
      baseRef: readString(isRecord(pr?.base) ? pr.base.ref : null),
      headRef: readString(isRecord(pr?.head) ? pr.head.ref : null),
      commentUrl: null,
      commentAuthorLogin: null,
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
    if (!prInfo || prNumber === null || !title || !htmlUrl) return null;
    return {
      ...common,
      prNumber,
      title,
      htmlUrl,
      baseRef: null,
      headRef: null,
      commentUrl: readString(comment?.html_url),
      commentAuthorLogin: readCommentAuthorLogin(comment) ?? senderLogin,
      entityKey: `${normalizedRepoFullName}#${prNumber}`,
    };
  }

  if (trigger.eventType === "pull_request_review_comment") {
    const pr = isRecord(payload.pull_request) ? payload.pull_request : null;
    const prNumber = readNumber(pr?.number);
    const title = readString(pr?.title);
    const htmlUrl = readString(pr?.html_url);
    const comment = isRecord(payload.comment) ? payload.comment : null;
    if (prNumber === null || !title || !htmlUrl) return null;
    return {
      ...common,
      prNumber,
      title,
      htmlUrl,
      baseRef: readString(isRecord(pr?.base) ? pr.base.ref : null),
      headRef: readString(isRecord(pr?.head) ? pr.head.ref : null),
      commentUrl: readString(comment?.html_url),
      commentAuthorLogin: readCommentAuthorLogin(comment) ?? senderLogin,
      entityKey: `${normalizedRepoFullName}#${prNumber}`,
    };
  }

  return null;
}

function readCommentAuthorLogin(comment: Record<string, unknown> | null): string | null {
  const user = isRecord(comment?.user) ? comment.user : null;
  return readString(user?.login);
}

function contextReviewerMessageMetadata(
  info: PullRequestPayloadInfo,
  reviewer: ReviewerAgent,
): Record<string, unknown> {
  return {
    source: "github",
    event: info.eventType,
    action: info.action,
    triggerEvent: info.triggerEvent,
    entityType: "pull_request",
    entityKey: info.entityKey,
    contextTreeReviewer: true,
    mentions: [reviewer.uuid],
  };
}

async function loadValidReviewerAgent(
  db: Database,
  input: { organizationId: string; reviewerAgentUuid: string },
): Promise<ReviewerAgent | null> {
  const [agent] = await db
    .select({
      uuid: agents.uuid,
      name: agents.name,
      managerHumanAgentId: members.agentId,
    })
    .from(agents)
    .innerJoin(members, eq(members.id, agents.managerId))
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

async function findSuppressibleReviewerEchoMessageId(
  db: Database,
  input: { chatId: string; info: PullRequestPayloadInfo; reviewer: ReviewerAgent },
): Promise<string | null> {
  if (input.info.eventType !== "issue_comment" || input.info.action !== "created") return null;

  const commentAuthorLogin = input.info.commentAuthorLogin?.trim().toLowerCase();
  if (!commentAuthorLogin) return null;

  const reviewerGithubLogin = input.reviewer.name?.trim().toLowerCase();
  if (!reviewerGithubLogin) {
    log.debug(
      { reviewerAgentUuid: input.reviewer.uuid, entityKey: input.info.entityKey },
      "context reviewer echo comment not suppressed: reviewer github login is unavailable",
    );
    return null;
  }
  if (commentAuthorLogin !== reviewerGithubLogin) return null;

  const [latestReviewerTask] = await db
    .select({
      id: messages.id,
      event: sql<string>`${messages.metadata}->>'event'`,
      action: sql<string>`${messages.metadata}->>'action'`,
      triggerEvent: sql<string>`${messages.metadata}->>'triggerEvent'`,
    })
    .from(messages)
    .where(
      and(
        eq(messages.chatId, input.chatId),
        sql`${messages.metadata}->>'entityKey' = ${input.info.entityKey}`,
        sql`${messages.metadata}->>'contextTreeReviewer' = 'true'`,
        sql`${messages.createdAt} >= NOW() - make_interval(secs => ${REVIEWER_OPENED_ECHO_SUPPRESSION_WINDOW_SECONDS})`,
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(1);

  const isInitialOpenedTask =
    latestReviewerTask?.event === "pull_request" &&
    latestReviewerTask.action === "opened" &&
    latestReviewerTask.triggerEvent === "pull_request.opened";
  return isInitialOpenedTask ? latestReviewerTask.id : null;
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
