import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { canonicalGitRepoUrl, chatMetadataSchema } from "@first-tree/shared";
import { eq } from "drizzle-orm";
import type * as ejs from "ejs";
import type { Database } from "../db/connection.js";
import { chats } from "../db/schema/chats.js";
import { createLogger } from "../observability/index.js";
import { uuidv7 } from "../uuid.js";
import { createChat } from "./chat.js";
import {
  contextReviewerChatReservationKey,
  findExistingContextReviewerChat,
  loadValidContextReviewerAgent,
} from "./context-reviewer-common.js";
import type { NormalizedGitlabWebhook } from "./gitlab-webhook.js";
import { type DeferredSendMessagePostCommitEffects, sendMessage } from "./message.js";
import { getOrgContextReviewRuntime } from "./org-settings.js";
import { applyMembershipWrite } from "./participant-mode.js";
import { formatContextReviewTopic } from "./scm-entity-chat-topic.js";

const log = createLogger("ContextReviewerMr");
const require = createRequire(import.meta.url);
const ejsRuntime: typeof ejs = require("ejs");
const TEMPLATE_CANDIDATE_URLS = [
  new URL("./prompts/context-reviewer-mr.ejs", import.meta.url),
  new URL("../prompts/context-reviewer-mr.ejs", import.meta.url),
] as const;

export type ContextReviewerMrSkipReason =
  | "unsupported_event"
  | "context_tree_repo_unset"
  | "provider_mismatch"
  | "repo_mismatch"
  | "connection_mismatch"
  | "feature_disabled"
  | "reviewer_agent_missing"
  | "reviewer_agent_invalid";

export type ContextReviewerMrResult =
  | { handled: false; reason: ContextReviewerMrSkipReason }
  | {
      handled: true;
      chatId: string;
      messageId: string;
      reused: boolean;
      recipients: Awaited<ReturnType<typeof sendMessage>>["recipients"];
      deferredPostCommitEffects: DeferredSendMessagePostCommitEffects;
    };

type ContextReviewerMrTemplateInput = {
  connectionId: string;
  instanceOrigin: string;
  projectPath: string;
  mrIid: number;
  title: string;
  entityUrl: string;
  triggerEvent: string;
  isDraft: boolean;
  organizationId: string;
  contextReviewRunId: string;
};

let templateCache: Promise<string> | null = null;

async function renderContextReviewerMrPrompt(input: ContextReviewerMrTemplateInput): Promise<string> {
  templateCache ??= resolveTemplateUrl().then((url) => readFile(url, "utf8"));
  const template = await templateCache;
  return ejsRuntime.render(template, input, { filename: fileURLToPath(await resolveTemplateUrl()) }).trim();
}

async function resolveTemplateUrl(): Promise<URL> {
  let lastError: unknown;
  for (const url of TEMPLATE_CANDIDATE_URLS) {
    try {
      await access(url);
      return url;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error("Context Reviewer MR prompt template is missing from server runtime assets.", { cause: lastError });
}

export function isContextReviewerMrCandidate(normalized: NormalizedGitlabWebhook): boolean {
  return (
    normalized.entityIdentity?.entityType === "pull_request" &&
    normalized.event?.eventType === "merge_request" &&
    (normalized.event.kind === "opened" ||
      normalized.event.kind === "reopened" ||
      normalized.event.kind === "synchronized" ||
      normalized.event.kind === "review_requested")
  );
}

export async function handleContextReviewerMrEvent(input: {
  database: Database;
  normalized: NormalizedGitlabWebhook;
  connection: { id: string; organizationId: string; instanceOrigin: string };
}): Promise<ContextReviewerMrResult> {
  if (!isContextReviewerMrCandidate(input.normalized)) {
    return { handled: false, reason: "unsupported_event" };
  }
  const entity = input.normalized.entityIdentity;
  const event = input.normalized.event;
  if (!entity || !event) return { handled: false, reason: "unsupported_event" };

  const runtime = await getOrgContextReviewRuntime(input.database, input.connection.organizationId);
  if (!runtime.repo || !runtime.branch) return { handled: false, reason: "context_tree_repo_unset" };
  if (runtime.provider !== "gitlab" || !runtime.providerMatchesRepository) {
    return { handled: false, reason: "provider_mismatch" };
  }
  if (
    runtime.gitlabConnection?.id !== input.connection.id ||
    runtime.gitlabConnection.instanceOrigin !== input.connection.instanceOrigin
  ) {
    return { handled: false, reason: "connection_mismatch" };
  }

  const webhookRepo = canonicalGitRepoUrl(
    `${input.connection.instanceOrigin.replace(/\/$/u, "")}/${entity.projectPath}`,
  );
  if (!webhookRepo || webhookRepo !== canonicalGitRepoUrl(runtime.repo)) {
    return { handled: false, reason: "repo_mismatch" };
  }
  if (!runtime.contextReviewer.enabled) return { handled: false, reason: "feature_disabled" };
  if (!runtime.contextReviewer.agentUuid) return { handled: false, reason: "reviewer_agent_missing" };

  const reviewer = await loadValidContextReviewerAgent(input.database, {
    organizationId: input.connection.organizationId,
    reviewerAgentUuid: runtime.contextReviewer.agentUuid,
  });
  if (!reviewer) return { handled: false, reason: "reviewer_agent_invalid" };

  const entityKey = `gitlab:${input.connection.id}:${entity.projectId}:pull_request:${entity.entityIid}`;
  const contextReviewRunId = uuidv7();
  const templateInput: ContextReviewerMrTemplateInput = {
    connectionId: input.connection.id,
    instanceOrigin: input.connection.instanceOrigin,
    projectPath: entity.projectPath,
    mrIid: entity.entityIid,
    title: entity.title ?? event.surface.title ?? `MR !${entity.entityIid}`,
    entityUrl: entity.entityUrl,
    triggerEvent: `${event.eventType}.${event.action ?? event.kind}`,
    isDraft: entity.entityState === "draft",
    organizationId: input.connection.organizationId,
    contextReviewRunId,
  };
  const prompt = await renderContextReviewerMrPrompt(templateInput);
  const metadata = chatMetadataSchema.parse({
    source: "gitlab",
    entityType: "pull_request",
    entityKey,
    entityUrl: entity.entityUrl,
    contextTreeReviewer: true,
    reviewerAgentUuid: reviewer.uuid,
  });
  const messageMetadata = {
    source: "gitlab",
    event: event.eventType,
    action: event.action,
    triggerEvent: templateInput.triggerEvent,
    entityType: "pull_request",
    entityKey,
    contextTreeReviewer: true,
    contextReviewRunId,
    contextReviewRepository: webhookRepo,
    contextReviewConnectionId: input.connection.id,
    contextReviewInstanceOrigin: input.connection.instanceOrigin,
    contextReviewProjectId: entity.projectId,
    contextReviewMrIid: entity.entityIid,
    contextReviewEntityUrl: entity.entityUrl,
    contextReviewOrganizationId: input.connection.organizationId,
    contextReviewReviewerAgentUuid: reviewer.uuid,
    contextReviewReviewerManagerHumanAgentId: reviewer.managerHumanAgentId,
    mentions: [reviewer.uuid],
    mergeRequestDraft: entity.entityState === "draft",
  };

  const existingChatId = await findExistingContextReviewerChat(input.database, {
    organizationId: input.connection.organizationId,
    entityKey,
  });
  if (existingChatId) {
    await input.database.update(chats).set({ metadata }).where(eq(chats.id, existingChatId));
    await applyMembershipWrite(
      input.database,
      existingChatId,
      [{ agentId: reviewer.managerHumanAgentId }, { agentId: reviewer.uuid }],
      { onConflictDoNothing: true, upgradeWatcherToSpeaker: true },
    );
    const sent = await sendMessage(
      input.database,
      existingChatId,
      reviewer.managerHumanAgentId,
      { source: "gitlab", format: "markdown", content: prompt, metadata: messageMetadata },
      { normalizeMentionsInContent: false, allowContextReviewRun: true, deferPostCommitEffects: true },
    );
    if (!sent.deferredPostCommitEffects) {
      throw new Error("Context Reviewer MR message did not return deferred post-commit effects");
    }
    return {
      handled: true,
      chatId: existingChatId,
      messageId: sent.message.id,
      reused: true,
      recipients: sent.recipients,
      deferredPostCommitEffects: sent.deferredPostCommitEffects,
    };
  }

  const created = await createChat(input.database, {
    mode: "task",
    initiatorAgentId: reviewer.managerHumanAgentId,
    organizationId: input.connection.organizationId,
    initialRecipientAgentIds: [reviewer.uuid],
    contextParticipantAgentIds: [],
    topic: formatContextReviewTopic({
      provider: "gitlab",
      repositoryPath: entity.projectPath,
      changeNumber: entity.entityIid,
    }),
    onboardingKickoffKey: contextReviewerChatReservationKey(input.connection.organizationId, entityKey),
    initialMessage: {
      source: "gitlab",
      format: "markdown",
      content: prompt,
      metadata: messageMetadata,
    },
    allowContextReviewRun: true,
    deferPostCommitEffects: true,
    source: "manual",
  });
  await input.database.update(chats).set({ metadata }).where(eq(chats.id, created.chat.id));
  if (!created.initialMessageCreated) {
    await applyMembershipWrite(
      input.database,
      created.chat.id,
      [{ agentId: reviewer.managerHumanAgentId }, { agentId: reviewer.uuid }],
      { onConflictDoNothing: true, upgradeWatcherToSpeaker: true },
    );
    const sent = await sendMessage(
      input.database,
      created.chat.id,
      reviewer.managerHumanAgentId,
      { source: "gitlab", format: "markdown", content: prompt, metadata: messageMetadata },
      { normalizeMentionsInContent: false, allowContextReviewRun: true, deferPostCommitEffects: true },
    );
    if (!sent.deferredPostCommitEffects) {
      throw new Error("Context Reviewer MR message did not return deferred post-commit effects");
    }
    return {
      handled: true,
      chatId: created.chat.id,
      messageId: sent.message.id,
      reused: true,
      recipients: sent.recipients,
      deferredPostCommitEffects: sent.deferredPostCommitEffects,
    };
  }
  log.info(
    {
      organizationId: input.connection.organizationId,
      connectionId: input.connection.id,
      entityKey,
      chatId: created.chat.id,
      triggerEvent: templateInput.triggerEvent,
    },
    "context reviewer MR task chat created",
  );
  return {
    handled: true,
    chatId: created.chat.id,
    messageId: created.message.id,
    reused: false,
    recipients: created.recipients,
    deferredPostCommitEffects:
      created.deferredPostCommitEffects ??
      (() => {
        throw new Error("Context Reviewer MR chat did not return deferred post-commit effects");
      })(),
  };
}
