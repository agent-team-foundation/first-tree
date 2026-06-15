import { type InvolveReason, isDeclaredBoundVia, type NormalizedEvent } from "@first-tree/shared";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { githubEntityChatMappings } from "../db/schema/github-entity-chat-mappings.js";
import { githubEntityKeyCandidates } from "./github-entity-key.js";

/**
 * Why a delegate-target lookup did or didn't qualify. Hoisted to a discrete
 * union so the audience resolver and the operations log share one vocabulary
 * for the four outcomes — "ok" feeds the audience list, the other three
 * surface as structured warnings.
 */
export type DelegateTargetVerdict = "ok" | "not_found" | "cross_org" | "inactive";

export const DELEGATE_VERDICT_MESSAGES: Record<DelegateTargetVerdict, string> = {
  ok: "delegate_mention target eligible",
  not_found: "delegate_mention target not found, skipping",
  cross_org: "delegate_mention target belongs to another org, skipping",
  inactive: "delegate_mention target not active, skipping",
};

export function evaluateDelegateTarget(
  target: { organizationId: string; status: string } | undefined,
  sourceOrgId: string,
): DelegateTargetVerdict {
  if (!target) return "not_found";
  if (target.organizationId !== sourceOrgId) return "cross_org";
  if (target.status !== "active") return "inactive";
  return "ok";
}

/**
 * Identity classification for the actor (the GitHub user who triggered the
 * event). Three buckets:
 *
 *   - `agent`         — actor.login maps to one of this org's agents. Used
 *                       for echo suppression at the notification layer: the
 *                       card still lands in every mapped chat (the public
 *                       record of what happened), but the actor is excluded
 *                       from the notify/addressing fan-out so agents aren't
 *                       woken by their own actions. See #942.
 *   - `our-app-bot`   — actor is `<app-slug>[bot]`. The event is a downstream
 *                       effect of First Tree's own outbound write. `kind: "existing"`
 *                       targets are kept (so PRs the agent opens via First Tree's
 *                       installation token still surface their comments / CI
 *                       back to the agent's chat via the subscription path);
 *                       `kind: "new"` mention rows are dropped — minting a
 *                       fresh chat for our own write is never useful.
 *   - `external`      — anyone else (other humans, third-party bots like
 *                       dependabot, …). No echo filter applied.
 */
export type ActorIdentity = { kind: "agent"; agentId: string } | { kind: "our-app-bot" } | { kind: "external" };

export async function identifyActor(
  db: Database,
  organizationId: string,
  actor: { githubLogin: string; isBot: boolean },
  appSlug: string | null,
): Promise<ActorIdentity> {
  if (actor.isBot && appSlug && actor.githubLogin.toLowerCase() === `${appSlug.toLowerCase()}[bot]`) {
    return { kind: "our-app-bot" };
  }
  const [agentRow] = await db
    .select({ uuid: agents.uuid })
    .from(agents)
    .where(
      and(eq(agents.organizationId, organizationId), eq(sql`lower(${agents.name})`, actor.githubLogin.toLowerCase())),
    )
    .limit(1);
  if (agentRow) return { kind: "agent", agentId: agentRow.uuid };
  return { kind: "external" };
}

/**
 * One row in the Stage 2 audience output. `existing` carries the persistent
 * subscription's chat id (Stage 3 sends directly); `new` carries the
 * involvement reason (Stage 3 creates the chat + writes the mapping row, then
 * picks the card `reason` from `subscribed` vs `involveReason`).
 */
export type AudienceTarget = {
  humanAgentId: string;
  delegateAgentId: string;
  kind: "existing" | "new";
  /** Set only when `kind === "existing"`. */
  chatId: string | null;
  /** Set only when `kind === "new"`. */
  involveReason: InvolveReason | null;
  /**
   * Lower-cased GitHub login that caused this fresh involvement (the human
   * agent's name, matched against `event.involves[i].githubLogin`). Set only
   * when `kind === "new"`. Stage 3 reads it to fill the card's
   * `mentionedUser` field so a chat targeted at user X never displays "Y was
   * mentioned" because two involves shared the same reason.
   */
  involveLogin: string | null;
  /**
   * Set when the event's actor resolves to an org agent (`identifyActor`
   * returned `kind: "agent"`). Stage 3 excludes this id from the card's
   * notification addressing (`addressedToAgentIds`) so the actor is never
   * woken / red-dotted by their own action, while the card itself still
   * lands in the chat as the public record (#942). `null` for our-app-bot
   * and external actors.
   */
  actorAgentId: string | null;
};

/**
 * Compute the Stage 2 audience for a normalized event.
 *
 *   audience = subscribed ∪ involved
 *
 * `subscribed` reads every `(human, delegate)` row already bound to
 * `(org, entity)` in `github_entity_chat_mappings`. `involved` walks
 * `event.involves` and for each login that resolves to an org-local
 * `delegate_mention`-configured agent whose target is eligible AND isn't
 * already subscribed, appends a `new` row.
 *
 * Echo filtering runs after the union:
 *   - actor = `agent`: no row is dropped — every mapped chat keeps the card
 *     as the public record of what happened. Instead, each row is annotated
 *     with `actorAgentId` so Stage 3 excludes the actor from notification
 *     addressing (the actor isn't woken / red-dotted by their own action,
 *     other recipients are notified normally). Dropping rows here used to
 *     conflate "should this chat get the card" with "should this recipient
 *     be notified" and silently killed delivery to multi-participant chats
 *     whose only routing entry had the actor on one side (#942).
 *   - actor = `our-app-bot`: `kind: "existing"` rows are kept so follow-up
 *     events on entities the agent opened still reach the chat through the
 *     subscription path; `kind: "new"` rows are dropped to avoid forking a
 *     fresh chat just to echo First Tree's own outbound write. See `ActorIdentity`.
 */
export async function resolveAudience(
  db: Database,
  event: NormalizedEvent,
  appSlug: string | null,
): Promise<AudienceTarget[]> {
  const organizationId = event.source.organizationId;
  const entityKeys = githubEntityKeyCandidates(event.entity.type, event.entity.key);

  const subscribedRows = await db
    .select({
      humanAgentId: githubEntityChatMappings.humanAgentId,
      humanAgentName: agents.name,
      delegateAgentId: githubEntityChatMappings.delegateAgentId,
      chatId: githubEntityChatMappings.chatId,
      boundAt: githubEntityChatMappings.boundAt,
      boundVia: githubEntityChatMappings.boundVia,
    })
    .from(githubEntityChatMappings)
    .innerJoin(agents, eq(agents.uuid, githubEntityChatMappings.humanAgentId))
    .where(
      and(
        eq(githubEntityChatMappings.organizationId, organizationId),
        eq(githubEntityChatMappings.entityType, event.entity.type),
        inArray(githubEntityChatMappings.entityKey, entityKeys),
      ),
    );

  // Dedup subscribed rows by `(humanAgentId, chatId)` (keep earliest
  // `bound_at`). A single `(human, entity)` pair can carry multiple mapping
  // rows pointing at the *same* chat (one per delegate that ever drove an
  // event for this entity under this human); collapsing those to one row is
  // loss-free and stops `deliverNormalizedEvent` posting N identical cards
  // to that chat.
  //
  // The key MUST include `chatId`. Deduping by `humanAgentId` alone assumed
  // every row for a human shared one chat — false once the same human is
  // bound to the entity from more than one chat (e.g. a webhook
  // `human_fallback` row in one chat plus an explicit `follow` row in
  // another, each under a different delegate). Collapsing across chats kept
  // only the earliest chat's row and silently dropped every *other* followed
  // chat from the audience — that chat never received the entity's events at
  // all. "The chat follows, not the person", so the surviving unit is one
  // row per (human, chat), never one per human.
  const earliestByHumanChat = new Map<string, (typeof subscribedRows)[number]>();
  for (const row of subscribedRows) {
    const key = `${row.humanAgentId}:${row.chatId}`;
    const current = earliestByHumanChat.get(key);
    if (!current || row.boundAt < current.boundAt) {
      earliestByHumanChat.set(key, row);
    }
  }
  // #766: A `pull_request.opened` delivery reaching a reviewer purely through
  // the subscribed path renders a redundant "opened this" card right next to
  // the actionable "requested your review" one. This happens during PR
  // creation: GitHub fires `opened` and `review_requested` near-simultaneously,
  // and when `review_requested` is processed first it mints the mapping, so the
  // racing `opened` then sees that mapping and fans out as a subscribed card.
  // Drop those subscribed `opened` targets. Two carve-outs preserve genuinely
  // useful `opened` delivery:
  //   - declared bindings (`agent_declared` / `human_declared`): the mapping
  //     was explicitly followed BEFORE the `opened` webhook arrived — the
  //     canonical case is an agent that just created the PR and followed it
  //     in the same breath (see `services/github-entity-follow.ts`). The
  //     "opened this" card is the deliberate creation confirmation / first
  //     signal of the declared watch, not a review-routing echo.
  //   - the target is explicitly named (mention / assignee) in the `opened`
  //     payload: an intentional, directed signal worth keeping.
  // Scope is intentionally narrow: `pull_request` + `opened` only. `issues`
  // has no `review_requested`, and every other event (synchronize, review,
  // comment, …) is a legitimately distinct subscribed signal.
  const isPullRequestOpened = event.rawEventType === "pull_request" && event.rawAction === "opened";
  const involvedLogins = new Set(event.involves.map((i) => i.githubLogin.toLowerCase()));
  const keepSubscribedOpened = (row: (typeof subscribedRows)[number]): boolean => {
    if (!isPullRequestOpened) return true;
    if (isDeclaredBoundVia(row.boundVia)) return true;
    return row.humanAgentName !== null && involvedLogins.has(row.humanAgentName.toLowerCase());
  };

  const subscribed: AudienceTarget[] = [...earliestByHumanChat.values()].filter(keepSubscribedOpened).map((row) => ({
    humanAgentId: row.humanAgentId,
    delegateAgentId: row.delegateAgentId,
    kind: "existing",
    chatId: row.chatId,
    involveReason: null,
    involveLogin: null,
    actorAgentId: null,
  }));

  // Dedup involved candidates by `humanAgentId` only — once any (human, *,
  // entity) mapping exists, the entity is already routed to that human's
  // chat and the involves-driven path must NOT fork a sibling chat just
  // because the candidate's `delegateMention` differs from the delegate
  // recorded on the existing mapping. The downstream resolver still applies
  // a human-scoped fallback (see `resolveTargetChat` step a.5), so even if
  // a race lets a `kind: "new"` row through with a different delegate, the
  // chat is reused — this dedup is the first line of defence.
  const subscribedHumanIds = new Set(subscribed.map((s) => s.humanAgentId));

  const involved: AudienceTarget[] = [];
  if (event.involves.length > 0) {
    const candidateLogins = event.involves.map((i) => i.githubLogin.toLowerCase());
    const reasonByLogin = new Map<string, InvolveReason>();
    for (const i of event.involves) reasonByLogin.set(i.githubLogin.toLowerCase(), i.reason);

    const candidates = await db
      .select({
        id: agents.uuid,
        name: agents.name,
        delegateMention: agents.delegateMention,
        status: agents.status,
      })
      .from(agents)
      .where(
        and(
          eq(agents.organizationId, organizationId),
          isNotNull(agents.delegateMention),
          inArray(sql`lower(${agents.name})`, candidateLogins),
        ),
      );

    const delegateIds = new Set<string>();
    for (const c of candidates) {
      if (c.delegateMention) delegateIds.add(c.delegateMention);
    }
    const delegateRows =
      delegateIds.size > 0
        ? await db
            .select({
              id: agents.uuid,
              organizationId: agents.organizationId,
              status: agents.status,
            })
            .from(agents)
            .where(inArray(agents.uuid, [...delegateIds]))
        : [];
    const delegateById = new Map<string, { organizationId: string; status: string }>();
    for (const row of delegateRows)
      delegateById.set(row.id, { organizationId: row.organizationId, status: row.status });

    for (const c of candidates) {
      if (c.status !== "active" || !c.delegateMention || !c.name) continue;
      const verdict = evaluateDelegateTarget(delegateById.get(c.delegateMention), organizationId);
      if (verdict !== "ok") continue;
      if (subscribedHumanIds.has(c.id)) continue;
      const candidateLogin = c.name.toLowerCase();
      const reason = reasonByLogin.get(candidateLogin);
      if (!reason) continue;
      involved.push({
        humanAgentId: c.id,
        delegateAgentId: c.delegateMention,
        kind: "new",
        chatId: null,
        involveReason: reason,
        involveLogin: candidateLogin,
        actorAgentId: null,
      });
    }
  }

  const audience = [...subscribed, ...involved];
  if (audience.length === 0) return audience;

  const actor = await identifyActor(db, organizationId, event.actor, appSlug);
  if (actor.kind === "our-app-bot") {
    // The App bot is on the wire because First Tree itself wrote to GitHub — the
    // user already saw their own action client-side. We still need to fan
    // out to *existing* subscriptions so PR comments / CI changes reach
    // the chat the agent worked in; mention-driven `kind: "new"` rows are
    // dropped because creating a fresh chat just to echo our own write is
    // never useful.
    return audience.filter((a) => a.kind === "existing");
  }
  if (actor.kind === "agent") {
    // Echo suppression is a *notification* concern, not a delivery one
    // (#942). Every mapped chat keeps its card — the chat row is the public
    // record of what happened, and other participants of a multi-member
    // chat legitimately want to see it. The actor's id is annotated onto
    // every target so Stage 3 (`deliverNormalizedEvent`) excludes it from
    // `addressedToAgentIds`: the actor is never woken / red-dotted by their
    // own action, while everyone else is notified normally. A 1:1 chat where
    // the actor is the sole addressable recipient reduces naturally to "card
    // visible, nobody woken" via the existing `allowRecipientlessSend`
    // trusted opt-out.
    //
    // The previous implementation dropped `kind: "existing"` rows whose
    // human or delegate side matched the actor. When such a row was the
    // chat's only routing entry, that silently killed delivery to the entire
    // chat — multi-participant chats lost the event altogether. It also
    // assumed `actor.login` identifies a single acting agent, which is
    // unsound: agents act on GitHub under a human's GitHub identity, so
    // identity-based echo cannot reliably tell an agent's own write from a
    // human's. Notification-layer exclusion is best-effort — at worst it
    // re-wakes the actor once; it never drops an event.
    return audience.map((a) => ({ ...a, actorAgentId: actor.agentId }));
  }
  return audience;
}
