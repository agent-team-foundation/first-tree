import type { GithubEventCard, InvolveReason, NormalizedEvent } from "@first-tree/shared";
import type { FastifyInstance } from "fastify";
import type { GithubEntity } from "../api/webhooks/github-entity.js";
import { createLogger } from "../observability/index.js";
import type { AudienceTarget } from "./github-audience.js";
import { findReuseChatForInvolved, refreshGithubChatTopic, resolveTargetChat } from "./github-entity-chat.js";
import type { EntityStateSeed } from "./github-entity-state.js";
import { sendMessage } from "./message.js";
import { notifyRecipients } from "./notifier.js";

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
};

/**
 * Per-chat delivery accumulator. "Deliver once per chat" (S7/S9): multiple
 * audience targets (subscribed and/or involved) that resolve to the same chat
 * collapse into a single card whose wake-set is the union of their delegates.
 */
type ChatDelivery = {
  chatId: string;
  created: boolean;
  /** Native mention / wake-set — the delegates to notify in this chat. */
  delegateIds: Set<string>;
  /** Echo suppress-set — actor agents excluded from notify (still get a silent row). */
  actorIds: Set<string>;
  /** Card framing: an involved target's reason/login wins over plain subscribed. */
  involveReason: InvolveReason | null;
  involveLogin: string | null;
  /** Chat-local representative human used as `senderId` (rendered as the GitHub system sender). */
  humanAgentId: string;
};

/**
 * Stage 3 — emit exactly one card per chat.
 *
 * Two phases. Phase 1 resolves every audience target to a chat (subscribed
 * targets short-circuit; involved targets reuse the entity's existing chat
 * when the involved human+delegate are already speakers, else mint a fresh
 * one) and accumulates the per-chat wake-set / suppress-set / card framing.
 * Phase 2 delivers one card per chat, waking the union of delegates via native
 * `metadata.mentions` and suppressing the actor via `suppressNotifyAgentIds`.
 * Each chat is delivered independently so a single failure doesn't poison the
 * rest — the loop logs and continues.
 */
export async function deliverNormalizedEvent(
  app: FastifyInstance,
  event: NormalizedEvent,
  audience: AudienceTarget[],
  options: DeliveryOptions = {},
): Promise<DeliveryStats> {
  const stats: DeliveryStats = { delivered: 0, newChats: 0, failed: 0 };

  // Phase 1 — resolve each target to a chat and merge into per-chat deliveries.
  const byChat = new Map<string, ChatDelivery>();
  for (const target of audience) {
    let resolved: ResolvedChat | null;
    try {
      resolved = await resolveChatFor(app, event, target, options);
    } catch (err) {
      // A single target's chat resolution failing (e.g. cross-org rejection
      // on mint, or a malformed audience row) must not abort the rest. Count
      // it and move on — the webhook is already claimed, so GitHub won't
      // retry; the metric makes the drop observable. See #507.
      stats.failed += 1;
      log.error(
        {
          err,
          metric: "github_delivery_failed_total",
          errorClass: err instanceof Error ? err.name : "Unknown",
          humanAgent: target.humanAgentId,
          delegateAgent: target.delegateAgentId,
          entityType: event.entity.type,
          entityKey: event.entity.key,
          eventType: event.rawEventType,
          action: event.rawAction,
        },
        "failed to resolve chat for normalized github target",
      );
      continue;
    }
    if (!resolved) {
      // Creation-event guard fired: opened webhook had no existing mapping
      // and no explicit mention for this target, so we drop it rather than
      // inventing a chat. Other targets may still resolve to a chat.
      log.info(
        {
          humanAgent: target.humanAgentId,
          delegateAgent: target.delegateAgentId,
          entityType: event.entity.type,
          entityKey: event.entity.key,
          eventType: event.rawEventType,
          action: event.rawAction,
          reason: "creation_event_no_mapping_no_mention",
        },
        "webhook_dropped_creation",
      );
      continue;
    }
    let delivery = byChat.get(resolved.chatId);
    if (!delivery) {
      delivery = {
        chatId: resolved.chatId,
        created: resolved.created,
        delegateIds: new Set(),
        actorIds: new Set(),
        involveReason: null,
        involveLogin: null,
        humanAgentId: target.humanAgentId,
      };
      byChat.set(resolved.chatId, delivery);
    } else if (resolved.created) {
      delivery.created = true;
    }
    delivery.delegateIds.add(target.delegateAgentId);
    if (target.actorAgentId) delivery.actorIds.add(target.actorAgentId);
    // Prefer an involved target's reason/login for the (single) card framing.
    if (target.kind === "new" && target.involveReason && !delivery.involveReason) {
      delivery.involveReason = target.involveReason;
      delivery.involveLogin = target.involveLogin;
    }
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
        const entity: GithubEntity = {
          type: event.entity.type,
          key: event.entity.key,
          title: event.entity.title,
          url: event.entity.url,
        };
        await refreshGithubChatTopic(app.db, delivery.chatId, entity);
      }

      const card = buildCard(event, delivery.involveReason, delivery.involveLogin);
      const mentionedUser = card.mentionedUser ?? undefined;
      // Native wake-set (S8): the delegates are passed as `metadata.mentions`,
      // so the generic fan-out wakes them — no GitHub-specific addressing
      // override. A mention that is not a live speaker of the chat is filtered
      // out by the message service (the card still lands as a silent row via
      // `allowRecipientlessSend`). The unread-mention red dot stays off because
      // delegates are non-human mention targets.
      const mentions = [...delivery.delegateIds].sort();
      // Echo suppression (S2 / D1): the event's actor agent(s), decoupled from
      // `senderId` and from the wake-set. A suppressed agent still gets a
      // silent (notify=false) inbox row — the card lands, it just doesn't wake.
      const suppressNotifyAgentIds = [...delivery.actorIds];
      const { message, recipients } = await sendMessage(
        app.db,
        delivery.chatId,
        delivery.humanAgentId,
        {
          format: "card",
          content: card,
          source: "github",
          metadata: {
            source: "github",
            event: event.rawEventType,
            action: event.rawAction,
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
            systemSender: "github",
            ...(mentionedUser ? { mentionedUser } : {}),
          },
        },
        {
          suppressNotifyAgentIds,
          // Opt in to writing `metadata.systemSender` — the message service
          // strips that key from every untrusted caller (web / agent SDK POST)
          // so HTTP boundaries cannot impersonate the GitHub sender. This is
          // the one trusted-internal path.
          allowSystemSender: true,
          // Opt out of the default explicit-recipient guard. This trusted
          // system delivery owns its own routing, but on some events the
          // wake-set resolves to no live speaker (every delegate is a
          // non-speaker, or the only addressable agent is the suppressed
          // actor). Such a card is still a valid history/context row for human
          // observers; without this opt-out the default guard would make this
          // trusted path start throwing.
          allowRecipientlessSend: true,
        },
      );
      notifyRecipients(app.notifier, recipients, message.id);
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
          delegateAgents: [...delivery.delegateIds],
          entityType: event.entity.type,
          entityKey: event.entity.key,
          eventType: event.rawEventType,
          action: event.rawAction,
        },
        "failed to deliver normalized github event to chat",
      );
    }
  }

  return stats;
}

type ResolvedChat = { chatId: string; created: boolean };

async function resolveChatFor(
  app: FastifyInstance,
  event: NormalizedEvent,
  target: AudienceTarget,
  options: DeliveryOptions,
): Promise<ResolvedChat | null> {
  if (target.kind === "existing") {
    if (!target.chatId) {
      throw new Error("audience target kind=existing must carry chatId");
    }
    return { chatId: target.chatId, created: false };
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
      target.delegateAgentId,
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
    delegateAgentId: target.delegateAgentId,
    entity,
    relatedEntities,
    eventType: event.rawEventType,
    action: event.rawAction ?? "",
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
  event: NormalizedEvent,
  involveReason: InvolveReason | null,
  involveLogin: string | null,
): GithubEventCard {
  const reason: GithubEventCard["reason"] = involveReason ?? "subscribed";
  const card: GithubEventCard = {
    type: "github_event",
    reason,
    event: event.rawEventType,
    action: event.rawAction,
    kind: event.kind,
    repository: event.entity.repo,
    sender: event.actor.githubLogin,
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
