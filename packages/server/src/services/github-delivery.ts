import type { GithubEventCard, InvolveReason, NormalizedScmEvent } from "@first-tree/shared";
import type { FastifyInstance } from "fastify";
import type { GithubEntity } from "../api/webhooks/github-entity.js";
import { createLogger } from "../observability/index.js";
import type { AudienceTarget } from "./github-audience.js";
import { findReuseChatForInvolved, refreshGithubChatTopic, resolveTargetChat } from "./github-entity-chat.js";
import { type EntityStateSeed, setEntityTitle } from "./github-entity-state.js";
import { sendScmSystemCard } from "./scm-card-delivery.js";
import {
  compareScmDeliveryEntries,
  planScmChatDeliveries,
  type ScmAudienceTarget,
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
 * one) and accumulates the per-chat entries. Self-echo pruning happens before
 * fresh-chat resolution, so an actor's own target does not create an empty
 * chat. Phase 2 delivers one card per chat, waking the union of surviving
 * wake agents via native `metadata.mentions`.
 * Each chat is delivered independently so a single failure doesn't poison the
 * rest — the loop logs and continues.
 */
export async function deliverGithubEvent(
  app: FastifyInstance,
  event: NormalizedScmEvent,
  audience: AudienceTarget[],
  options: DeliveryOptions = {},
): Promise<DeliveryStats> {
  const stats: DeliveryStats = { delivered: 0, newChats: 0, failed: 0 };
  const actorHumanId = options.actorHumanId ?? null;
  const existingMappedChatIds = existingMappedChatIdsForProjection(audience);
  const entity = entityFromEvent(event);

  // Phase 1 — shared SCM planner owns echo pruning and one-delivery-per-chat.
  const planned = await planScmChatDeliveries({
    targets: audience.map((target) => ({
      senderAgentId: target.humanAgentId,
      humanAgentId: target.humanAgentId,
      wakeAgentId: target.delegateAgentId,
      kind: target.kind,
      chatId: target.chatId,
      involveReason: target.involveReason,
      involveLogin: target.involveLogin,
    })),
    actorHumanId,
    resolveChat: (target) => resolveChatFor(app, event, target, options),
    onTargetError: (target, err) => {
      log.error(
        {
          err,
          metric: "github_delivery_failed_total",
          errorClass: err instanceof Error ? err.name : "Unknown",
          humanAgent: target.humanAgentId,
          delegateAgent: target.wakeAgentId,
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
          humanAgent: target.humanAgentId,
          delegateAgent: target.wakeAgentId,
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
  // from card delivery. A self-only event can prune every delivery entry, but
  // it still proves the entity has an existing local mapping whose title/topic
  // projection must stay fresh.
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
      const card = buildCard(event, cardContext.involveReason, cardContext.involveLogin);
      const mentionedUser = card.mentionedUser ?? undefined;
      // Native wake-set (S8): the delegates are passed as `metadata.mentions`,
      // so the generic fan-out wakes them — no GitHub-specific addressing
      // override. A mention that is not a live speaker of the chat is filtered
      // out by the message service (the card still lands as a silent row via
      // `allowRecipientlessSend`). The unread-mention red dot stays off because
      // delegates are non-human mention targets.
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
        },
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

function existingMappedChatIdsForProjection(audience: AudienceTarget[]): string[] {
  return [
    ...new Set(
      audience.filter((target) => target.kind === "existing" && target.chatId).map((target) => target.chatId as string),
    ),
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

type ResolvedChat = { chatId: string; created: boolean };

async function resolveChatFor(
  app: FastifyInstance,
  event: NormalizedScmEvent,
  target: ScmAudienceTarget,
  options: DeliveryOptions,
): Promise<ResolvedChat | null> {
  if (target.kind === "existing") {
    if (!target.chatId) {
      throw new Error("audience target kind=existing must carry chatId");
    }
    return { chatId: target.chatId, created: false };
  }
  if (!target.humanAgentId || !target.wakeAgentId) {
    throw new Error("new GitHub audience target must carry human and delegate agents");
  }
  const entity: GithubEntity = {
    type: event.entity.type,
    key: event.entity.key,
    title: event.entity.title,
    url: event.entity.url,
  };
  // Reviewer-reuse (S9, deliver-once-per-chat) — scoped to `review_requested`
  // ONLY. When the entity already has exactly one reusable bound chat (the
  // reviewer's human + delegate both already speak there), route there instead
  // of minting a sibling chat, writing NO mapping row; the pair sees the
  // entity's events through chat membership and Phase 2 dedups to one card.
  // `mentioned` / `assigned` involves are deliberately NOT reused: a mention is
  // a directed call that must mint a fresh chat (S5 — mentions pierce into a
  // new chat, never back into an existing/unfollowed one).
  if (target.involveReason === "review_requested") {
    const reuseChatId = await findReuseChatForInvolved(
      app.db,
      event.source.organizationId,
      entity,
      target.humanAgentId,
      target.wakeAgentId,
    );
    if (reuseChatId) return { chatId: reuseChatId, created: false };
  }

  const relatedEntities: GithubEntity[] = event.relatedRefs.map((ref) => ({
    type: "issue",
    key: ref.key,
  }));
  const resolved = await resolveTargetChat(app.db, {
    organizationId: event.source.organizationId,
    humanAgentId: target.humanAgentId,
    delegateAgentId: target.wakeAgentId,
    entity,
    relatedEntities,
    eventType: event.eventType,
    action: event.action ?? "",
    entityStateSeed: options.entityStateSeed ?? null,
    // `kind: "new"` audience targets come from explicit mentions / involves in
    // the event payload — the only path allowed to mint a fresh chat for an
    // opened creation event. Subscription targets short-circuit above; the
    // guard is still wired so any future caller is safe by default.
    isMentionMatched: true,
  });
  if (!resolved) return null;
  return { chatId: resolved.chatId, created: resolved.created };
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
      url: event.entity.url ?? null,
    },
  };
  if (involveLogin) card.mentionedUser = involveLogin;
  return card;
}
