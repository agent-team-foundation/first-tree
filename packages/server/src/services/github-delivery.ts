import type { GithubEventCard, NormalizedEvent } from "@first-tree/shared";
import type { FastifyInstance } from "fastify";
import type { GithubEntity } from "../api/webhooks/github-entity.js";
import { createLogger } from "../observability/index.js";
import type { AudienceTarget } from "./github-audience.js";
import { resolveTargetChat } from "./github-entity-chat.js";
import { sendMessage } from "./message.js";
import { notifyRecipients } from "./notifier.js";

const log = createLogger("GithubDelivery");

export type DeliveryStats = {
  /** Number of audience targets that received a card. */
  delivered: number;
  /** Number of fresh chats created (involved-new path). */
  newChats: number;
};

/**
 * Stage 3 — actually emit one card per audience target.
 *
 * `existing` targets carry their chatId and short-circuit straight to the
 * send. `new` targets go through `resolveTargetChat` which performs the
 * §4.4 direct / fixes_link / fresh-chat lookup and writes the mapping row.
 * Each target's row is delivered + dispatched independently so a single
 * failure (e.g. cross-org rejection on chat creation) doesn't poison the
 * whole audience — the loop logs and continues.
 *
 * The card `reason` is `subscribed` for existing rows and the new target's
 * `involveReason` for involved rows; the surface event payload is the same
 * either way.
 */
export async function deliverNormalizedEvent(
  app: FastifyInstance,
  event: NormalizedEvent,
  audience: AudienceTarget[],
): Promise<DeliveryStats> {
  const stats: DeliveryStats = { delivered: 0, newChats: 0 };

  for (const target of audience) {
    try {
      const resolved = await resolveChatFor(app, event, target);
      if (!resolved) {
        // Creation-event guard fired: opened webhook had no existing mapping
        // and no explicit mention for this target, so we drop the event for
        // this target rather than inventing a chat. Other targets in the
        // audience may still receive the card.
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
      if (resolved.created) stats.newChats += 1;

      const card = buildCard(event, target);
      const mentionedUser = card.mentionedUser ?? undefined;
      // The audience row resolved a specific (human, delegate) pair as the
      // structural target of this event. Address the delegate explicitly so
      // a bound chat that has been expanded to ≥3 speakers still wakes the
      // agent — without this, card-format messages produce no mentionSet
      // and the multi-speaker fan-out collapses to notify=false for
      // everyone. Same pattern as `question_answer` (see SendMessageOptions
      // `addressedToAgentIds`).
      const { message, recipients } = await sendMessage(
        app.db,
        resolved.chatId,
        target.humanAgentId,
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
            ...(mentionedUser ? { mentionedUser } : {}),
          },
        },
        { addressedToAgentIds: [target.delegateAgentId] },
      );
      notifyRecipients(app.notifier, recipients, message.id);
      stats.delivered += 1;
    } catch (err) {
      log.error(
        {
          err,
          humanAgent: target.humanAgentId,
          delegateAgent: target.delegateAgentId,
          entityType: event.entity.type,
          entityKey: event.entity.key,
        },
        "failed to deliver normalized github event to target",
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
    // `kind: "new"` audience targets come from explicit mentions / involves
    // in the event payload — these are the only path allowed to mint a fresh
    // chat for an opened creation event. Subscription targets never reach
    // resolveTargetChat (`kind: "existing"` short-circuits above), but the
    // guard is still wired so any future caller is safe by default.
    isMentionMatched: true,
  });
  if (!resolved) return null;
  return { chatId: resolved.chatId, created: resolved.created };
}

function buildCard(event: NormalizedEvent, target: AudienceTarget): GithubEventCard {
  const reason: GithubEventCard["reason"] =
    target.kind === "existing" ? "subscribed" : (target.involveReason ?? "mentioned");
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
  if (target.involveLogin) card.mentionedUser = target.involveLogin;
  return card;
}
