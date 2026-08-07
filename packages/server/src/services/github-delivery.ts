import type { GithubEventCard, InvolveReason, NormalizedScmEvent } from "@first-tree/shared";
import type { FastifyInstance } from "fastify";
import type { GithubEntity } from "../api/webhooks/github-entity.js";
import { createLogger } from "../observability/index.js";
import { uuidv7 } from "../uuid.js";
import type { GithubProviderTaskContext } from "./github-audience.js";
import {
  refreshGithubChatTopic,
  resolveGithubExistingLineChat,
  resolveGithubPersonnelTargetChat,
  resolveTargetChat,
} from "./github-entity-chat.js";
import { type EntityStateSeed, setEntityTitle } from "./github-entity-state.js";
import { applyMembershipWrite } from "./participant-mode.js";
import type { ScmAudienceTarget } from "./scm-audience-composition.js";
import { sendScmSystemCard } from "./scm-card-delivery.js";
import {
  compareScmDeliveryEntries,
  planScmChatDeliveries,
  scmProviderContextEntries,
  scmTargetHumanAgentId,
  scmTargetWakeAgentId,
  scmWakeAgentIds,
  selectScmCardContext,
  selectScmSenderId,
} from "./scm-chat-delivery-plan.js";

const log = createLogger("GithubDelivery");

export type DeliveryStats = {
  /** Number of chats that received a card (one card per chat). */
  delivered: number;
  /** Number of fresh chats created (involved-new path). */
  newChats: number;
  /**
   * Number of chats whose delivery threw and was caught by the per-chat
   * guard. These chats did NOT receive a card; the webhook has already been
   * claimed in `processed_events`, so GitHub will not retry. Surfaced in the
   * response + metric so a regression in single-chat reliability becomes
   * observable instead of silent.
   */
  failed: number;
};

type DeliveryOptions = {
  entityStateSeed?: EntityStateSeed | null;
  actorHumanId?: string | null;
};

/**
 * Per-chat delivery accumulator. "Deliver once per chat" (S7/S9): multiple
 * audience targets (subscribed and/or involved) that resolve to the same chat
 * collapse into a single card whose wake-set is the union of surviving
 * per-human entries.
 */
/**
 * Stage 3 — emit exactly one card per chat.
 *
 * Two phases. Phase 1 resolves every audience target to a chat (subscribed
 * targets short-circuit; involved targets reuse the entity's existing chat
 * when the involved human+delegate are already speakers, else mint a fresh
 * one) and accumulates the per-chat entries. Actor-owned existing lines retain
 * their card routes but become wake-ineligible; fresh directed targets remain
 * eligible to create the work entry. Phase 2 delivers one card per chat,
 * waking the union of eligible agents via native `metadata.mentions`.
 * Each chat is delivered independently so a single failure doesn't poison the
 * rest — the loop logs and continues.
 */
export async function deliverGithubEvent(
  app: FastifyInstance,
  event: NormalizedScmEvent,
  audience: ScmAudienceTarget<GithubProviderTaskContext>[],
  options: DeliveryOptions = {},
): Promise<DeliveryStats> {
  const stats: DeliveryStats = { delivered: 0, newChats: 0, failed: 0 };
  const actorHumanId = options.actorHumanId ?? null;
  const existingMappedChatIds = existingMappedChatIdsForProjection(audience);
  const entity = entityFromEvent(event);
  const executableTargets = expandDirectedGithubTargets(audience);

  // Phase 1 — shared SCM planner owns echo wake policy and one-delivery-per-chat.
  const planned = await planScmChatDeliveries({
    targets: executableTargets,
    actorHumanId,
    resolveChat: (target) => resolveChatFor(app, event, target, options),
    onTargetError: (target, err) => {
      log.error(
        {
          err,
          metric: "github_delivery_failed_total",
          errorClass: err instanceof Error ? err.name : "Unknown",
          humanAgent: scmTargetHumanAgentId(target),
          delegateAgent: scmTargetWakeAgentId(target),
          entityType: event.entity.type,
          entityKey: event.entity.key,
          eventType: event.eventType,
          action: event.action,
        },
        "failed to resolve chat for normalized github target",
      );
    },
    onTargetDropped: (target) => {
      log.info(
        {
          humanAgent: scmTargetHumanAgentId(target),
          delegateAgent: scmTargetWakeAgentId(target),
          entityType: event.entity.type,
          entityKey: event.entity.key,
          eventType: event.eventType,
          action: event.action,
          reason: "creation_event_no_mapping_no_mention",
        },
        "webhook_dropped_creation",
      );
    },
  });
  stats.failed += planned.failed;
  const byChat = planned.deliveries;

  // Phase 1.5 — refresh the local projection for this entity independently
  // from card delivery. Existing local mappings refresh their title/topic
  // projection regardless of whether their wake is actor-echo suppressed.
  const shouldRefreshEntityProjection = byChat.size > 0 || existingMappedChatIds.length > 0;
  if (shouldRefreshEntityProjection && event.entity.title && event.entity.title.length > 0) {
    try {
      await setEntityTitle(app.db, {
        organizationId: event.source.organizationId,
        entityType: event.entity.type,
        entityKey: event.entity.key,
        title: event.entity.title,
      });
    } catch (err) {
      log.warn(
        {
          err,
          entityType: event.entity.type,
          entityKey: event.entity.key,
          errorMessage: err instanceof Error ? err.message : String(err),
        },
        "failed to refresh github entity title — continuing",
      );
    }
  }
  for (const chatId of existingMappedChatIds) {
    await refreshGithubChatTopic(app.db, chatId, entity);
  }

  // Phase 2 — one card per chat.
  for (const delivery of byChat.values()) {
    try {
      if (delivery.created) stats.newChats += 1;
      else {
        // Existing github-sourced chats: refresh the topic so PR / issue title
        // edits propagate into the chat list. The helper only touches a chat
        // whose own `direct` anchor entity matches this event, preserves the
        // original prefix, and no-ops when the payload carries no title.
        await refreshGithubChatTopic(app.db, delivery.chatId, entity);
      }

      const entries = [...delivery.entries.values()].sort(compareScmDeliveryEntries);
      const senderId = selectScmSenderId(entries);
      const cardContext = selectScmCardContext(entries);
      const taskEntry = scmProviderContextEntries(entries)
        .filter(
          (entry) =>
            entry.providerContext.kind === "github_app_task" && entry.providerContext.agentUuid === entry.wakeAgentId,
        )
        .sort(compareScmDeliveryEntries)[0];
      const taskRun = taskEntry?.humanAgentId
        ? createGithubTaskRun(event, taskEntry.providerContext, taskEntry.humanAgentId)
        : null;
      const card = buildCard(
        event,
        cardContext.involveReason,
        cardContext.involveLogin,
        taskRun?.marker ?? taskEntry?.providerContext ?? null,
      );
      const mentionedUser = card.mentionedUser ?? undefined;
      // Native wake-set (S8): the delegates are passed as `metadata.mentions`,
      // so the generic fan-out wakes them — no GitHub-specific addressing
      // override. A mention that is not a live speaker of the chat is filtered
      // out by the message service (the card still lands as a silent row via
      // `allowRecipientlessSend`). The unread-mention red dot stays off because
      // delegates are non-human mention targets.
      // The task marker scopes who may execute an automatically routed event; it
      // does not replace independent subscription / explicit wake lines that
      // survived into this chat delivery.
      const mentions = scmWakeAgentIds(entries);
      await sendScmSystemCard(app, {
        chatId: delivery.chatId,
        senderId,
        provider: "github",
        content: card,
        metadata: {
          event: event.eventType,
          action: event.action,
          entityType: event.entity.type,
          entityKey: event.entity.key,
          reason: card.reason,
          // Native mention wake-set — see above.
          mentions,
          // Render this card with a synthetic "GitHub" sender in place of the
          // chat-local human row stored as `senderId`. Keeping the DB
          // senderId chat-local preserves fan-out / read-receipts; only the
          // visual attribution shifts. Scoped to GitHub cards so an arbitrary
          // client cannot impersonate other sources.
          ...(mentionedUser ? { mentionedUser } : {}),
          ...(card.teamAgentTask ? { teamAgentTask: card.teamAgentTask } : {}),
          ...(taskRun ? taskRun.metadata : {}),
        },
        allowGithubTaskRun: taskRun !== null,
      });
      stats.delivered += 1;
    } catch (err) {
      stats.failed += 1;
      // Per-chat failures are isolated so one bad chat doesn't poison the rest,
      // but the webhook is already claimed in `processed_events` — GitHub will
      // not retry. Emit a structured metric line so a regression in single-chat
      // reliability is observable instead of silently swallowed. See #507.
      log.error(
        {
          err,
          metric: "github_delivery_failed_total",
          errorClass: err instanceof Error ? err.name : "Unknown",
          chatId: delivery.chatId,
          delegateAgents: [...delivery.entries.values()].flatMap((entry) =>
            entry.wakeAgentId ? [entry.wakeAgentId] : [],
          ),
          entityType: event.entity.type,
          entityKey: event.entity.key,
          eventType: event.eventType,
          action: event.action,
        },
        "failed to deliver normalized github event to chat",
      );
    }
  }

  return stats;
}

/**
 * Preserve an existing subscription route independently from fresh directed
 * authority. The personnel half performs its own exact-line re-read and
 * placement in one entity-locked transaction; the subscription half may be
 * dropped if a concurrent unfollow removed it.
 */
function expandDirectedGithubTargets(
  targets: ScmAudienceTarget<GithubProviderTaskContext>[],
): ScmAudienceTarget<GithubProviderTaskContext>[] {
  return targets.flatMap((target) => {
    if (target.entry.kind !== "existing_line" || !target.directedContext) return [target];
    return [
      { entry: target.entry },
      {
        entry: {
          kind: "personnel_target",
          reason: target.directedContext.reason,
          requiresPersistentLine: target.directedContext.requiresPersistentLine,
          humanAgentId: target.entry.line.humanAgentId,
          wakeAgentId: target.entry.line.wakeAgentId,
          externalUsername: target.directedContext.externalUsername,
        },
      },
    ];
  });
}

function existingMappedChatIdsForProjection(audience: ScmAudienceTarget<GithubProviderTaskContext>[]): string[] {
  return [
    ...new Set(audience.flatMap((target) => (target.entry.kind === "existing_line" ? [target.entry.line.chatId] : []))),
  ].sort();
}

function entityFromEvent(event: NormalizedScmEvent): GithubEntity {
  return {
    type: event.entity.type,
    key: event.entity.key,
    title: event.entity.title,
    url: event.entity.url,
  };
}

type ResolvedChat = { chatId: string; created: boolean; personnelLineExisted?: boolean };

async function resolveChatFor(
  app: FastifyInstance,
  event: NormalizedScmEvent,
  target: ScmAudienceTarget<GithubProviderTaskContext>,
  options: DeliveryOptions,
): Promise<ResolvedChat | null> {
  if (target.entry.kind === "existing_line") {
    return resolveGithubExistingLineChat(app.db, {
      organizationId: event.source.organizationId,
      humanAgentId: target.entry.line.humanAgentId,
      delegateAgentId: target.entry.line.wakeAgentId,
      entity: entityFromEvent(event),
    });
  }
  if (target.entry.kind === "legacy_route") {
    return { chatId: target.entry.route.chatId, created: false };
  }
  const humanAgentId = target.entry.humanAgentId;
  const wakeAgentId = target.entry.wakeAgentId;
  const entity = entityFromEvent(event);
  const relatedEntities: GithubEntity[] = event.relatedRefs.map((ref) => ({
    type: "issue",
    key: ref.key,
  }));
  const baseParams = {
    organizationId: event.source.organizationId,
    humanAgentId,
    delegateAgentId: wakeAgentId,
    entity,
    relatedEntities,
    eventType: event.eventType,
    action: event.action ?? "",
    entityStateSeed: options.entityStateSeed ?? null,
    // Personnel targets carry explicit directed evidence; provider-task
    // targets carry repository-role authority. Those are the only paths
    // allowed to mint a fresh chat for an opened creation event. Subscription
    // targets short-circuit above; the guard is still wired so any future
    // caller is safe by default. `isMentionMatched` is the historical name for
    // that fresh-chat authority bit.
    isMentionMatched: true,
  };
  if (target.entry.kind === "provider_task_target") {
    const resolved = await resolveTargetChat(app.db, { ...baseParams, intent: { kind: "provider_task_target" } });
    if (!resolved) return null;
    if (
      target.entry.providerContext.kind === "github_app_task" &&
      target.entry.providerContext.agentUuid === wakeAgentId
    ) {
      await applyMembershipWrite(app.db, resolved.chatId, [{ agentId: wakeAgentId }], {
        upgradeWatcherToSpeaker: true,
      });
    }
    return { chatId: resolved.chatId, created: resolved.created };
  }

  const resolved = await resolveGithubPersonnelTargetChat(app.db, {
    ...baseParams,
    requiresPersistentLine: target.entry.requiresPersistentLine,
  });
  if (!resolved) return null;
  return {
    chatId: resolved.chatId,
    created: resolved.created,
    personnelLineExisted: resolved.lineExisted,
  };
}

/**
 * Build the per-chat card. `involveReason`/`involveLogin` come from an involved
 * target routed to this chat (review_requested / mentioned / assigned); when a
 * chat is reached only through subscription they are null and the card reads as
 * `subscribed`.
 */
function buildCard(
  event: NormalizedScmEvent,
  involveReason: InvolveReason | null,
  involveLogin: string | null,
  teamAgentTask: { agentUuid: string; runId?: string } | null,
): GithubEventCard {
  const reason: GithubEventCard["reason"] = involveReason ?? "subscribed";
  const card: GithubEventCard = {
    type: "github_event",
    reason,
    event: event.eventType,
    action: event.action,
    kind: event.kind,
    repository: event.entity.projectKey,
    sender: event.actor.externalUsername,
    title: event.surface.title,
    body: event.surface.body,
    url: event.surface.url,
    entity: {
      type: event.entity.type,
      key: event.entity.key,
      url: event.entity.url ?? event.surface.url,
    },
  };
  if (involveLogin) card.mentionedUser = involveLogin;
  if (teamAgentTask) card.teamAgentTask = teamAgentTask;
  return card;
}

function createGithubTaskRun(
  event: NormalizedScmEvent,
  task: { agentUuid: string },
  managerHumanAgentId: string,
): {
  marker: { agentUuid: string; runId: string };
  metadata: Record<string, unknown>;
} {
  const match = /#([1-9]\d*)$/u.exec(event.entity.key);
  const entityNumber = match?.[1] ? Number(match[1]) : Number.NaN;
  const entityUrl = event.entity.url ?? event.surface.url;
  if (
    (event.entity.type !== "issue" && event.entity.type !== "pull_request") ||
    !Number.isSafeInteger(entityNumber) ||
    entityNumber <= 0 ||
    !entityUrl
  ) {
    throw new Error("Publishable GitHub task delivery is missing a supported immutable entity identity");
  }
  const runId = uuidv7();
  return {
    marker: { agentUuid: task.agentUuid, runId },
    metadata: {
      githubTaskRun: true,
      githubTaskRunId: runId,
      githubTaskOrganizationId: event.source.organizationId,
      githubTaskAgentUuid: task.agentUuid,
      githubTaskManagerHumanAgentId: managerHumanAgentId,
      githubTaskRepository: event.entity.projectKey.toLowerCase(),
      githubTaskEntityType: event.entity.type,
      githubTaskEntityNumber: entityNumber,
      githubTaskEntityUrl: entityUrl,
      githubTaskReplySubmission: { state: "pending" },
    },
  };
}
