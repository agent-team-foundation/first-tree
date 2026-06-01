import type { GithubEventCard, NormalizedEvent } from "@first-tree/shared";
import type { FastifyInstance } from "fastify";
import type { GithubEntity } from "../api/webhooks/github-entity.js";
import { createLogger } from "../observability/index.js";
import type { AudienceTarget } from "./github-audience.js";
import { refreshGithubChatTopic, resolveTargetChat } from "./github-entity-chat.js";
import { sendMessage } from "./message.js";
import { notifyRecipients } from "./notifier.js";

const log = createLogger("GithubDelivery");

export type DeliveryStats = {
  /** Number of audience targets that received a card. */
  delivered: number;
  /** Number of fresh chats created (involved-new path). */
  newChats: number;
  /**
   * Number of audience targets whose delivery threw and was caught by the
   * per-target guard. These targets did NOT receive a card; the webhook
   * has already been claimed in `processed_events`, so GitHub will not
   * retry. Surfaced in the response + metric so a regression in single-
   * target reliability becomes observable instead of silent.
   */
  failed: number;
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
  const stats: DeliveryStats = { delivered: 0, newChats: 0, failed: 0 };

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

      // Existing github-sourced chats: refresh the topic so PR / issue
      // title edits on GitHub propagate into the workspace chat list. The
      // helper only touches a chat whose own `direct` anchor entity matches
      // this event (never a linked fixes_link entity), preserves the original
      // prefix, and no-ops when the payload carries no title — keeping the
      // refresh scoped to chats First Tree originally minted from this entity.
      if (!resolved.created) {
        const entity: GithubEntity = {
          type: event.entity.type,
          key: event.entity.key,
          title: event.entity.title,
          url: event.entity.url,
        };
        await refreshGithubChatTopic(app.db, resolved.chatId, entity);
      }

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
            // Tells the web UI to render this card with a synthetic
            // "GitHub" sender (icon + name) in place of the human-agent
            // row whose id we still store as `senderId`. Keeping the DB
            // senderId as the human agent preserves multi-speaker
            // fan-out / read-receipts / mention-resolution; only the
            // visual attribution shifts. Scoped to GitHub cards so an
            // arbitrary client cannot impersonate other sources.
            systemSender: "github",
            ...(mentionedUser ? { mentionedUser } : {}),
          },
        },
        {
          addressedToAgentIds: [target.delegateAgentId],
          // Opt in to writing `metadata.systemSender` — the message service
          // strips that key from every other caller (web / agent SDK POST)
          // so HTTP boundaries cannot impersonate the GitHub sender in the
          // chat UI. This is the one trusted-internal path.
          allowSystemSender: true,
        },
      );
      notifyRecipients(app.notifier, recipients, message.id);
      stats.delivered += 1;
    } catch (err) {
      stats.failed += 1;
      // Per-target failures are isolated so one bad target doesn't poison
      // the audience, but the webhook is already claimed in
      // `processed_events` — GitHub will not retry. Emit a structured
      // metric line so a regression in single-target reliability is
      // observable in logs (and dashboardable by the operator) instead
      // of being silently swallowed by `continue`. See #507.
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
