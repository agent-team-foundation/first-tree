import {
  AGENT_STATUSES,
  AGENT_TYPES,
  type InvolveReason,
  isDeclaredBoundVia,
  type NormalizedScmEvent,
} from "@first-tree/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
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
 * Resolve the GitHub actor to the represented First Tree human when possible.
 *
 * GitHub tells us which login triggered the event; it does not tell us which
 * local agent, if any, performed the action. Echo pruning is therefore
 * human-scoped: if the actor login maps to an org-local human agent, delivery
 * can remove entries that belong to that same human. Unknown humans, external
 * users, and bot/app senders return null and are delivered without self
 * pruning.
 */
export async function resolveGithubActorHumanId(
  db: Database,
  organizationId: string,
  actor: { externalUsername: string },
): Promise<string | null> {
  const [agentRow] = await db
    .select({ uuid: agents.uuid })
    .from(agents)
    .where(
      and(
        eq(agents.organizationId, organizationId),
        eq(agents.type, AGENT_TYPES.HUMAN),
        eq(sql`lower(${agents.name})`, actor.externalUsername.toLowerCase()),
      ),
    )
    .limit(1);
  return agentRow?.uuid ?? null;
}

/** One candidate delivery entry from Stage 2. */
export type AudienceTarget = {
  humanAgentId: string;
  delegateAgentId: string;
  kind: "existing" | "new";
  /** Set only when `kind === "existing"`. */
  chatId: string | null;
  /** Set when this delivery is also a target-human route. */
  involveReason: InvolveReason | null;
  /**
   * Lower-cased GitHub login that caused this target route. Stage 3 reads it
   * to fill the card's `mentionedUser` field so a chat targeted at user X
   * never displays "Y was mentioned" because two involves shared the same
   * reason.
   */
  involveLogin: string | null;
  provenance?: "explicit" | "identity_target" | "related_entity";
};

export type AudienceResolution = {
  targets: AudienceTarget[];
  actorHumanId: string | null;
};

/**
 * Compute the Stage 2 audience for a normalized event.
 *
 *   audience = follow mappings ∪ target deliveries
 *
 * `subscribed` reads every `(human, delegate)` row already bound to
 * `(org, entity)` in `github_entity_chat_mappings`. `involved` walks
 * `event.targets` as target-human candidates. A target human first reuses
 * their existing mapping(s) on the entity; only humans without a mapping fall
 * back to their default delegate and produce a `kind: "new"` row.
 *
 * Echo pruning happens in delivery, before fresh-chat resolution, so self-only
 * events do not write cards and mixed events keep the other humans' entries.
 */
export async function resolveGithubAudience(db: Database, event: NormalizedScmEvent): Promise<AudienceResolution> {
  const organizationId = event.source.organizationId;
  const entityKeys = githubEntityKeyCandidates(event.entity.type, event.entity.key);
  const actorHumanId = await resolveGithubActorHumanId(db, organizationId, event.actor);

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

  // Dedup subscribed rows by `(humanAgentId, delegateAgentId, chatId)` (keep
  // earliest `bound_at`). Alias entity keys can leave duplicate rows for the
  // same logical attention line, but distinct delegates are distinct wake
  // lines even when they share one human carrier and chat. The per-chat
  // delivery planner collapses those lines into one card and unions every
  // wake agent.
  //
  // The key MUST include `chatId`. Deduping by `humanAgentId` alone assumed
  // every row for a human shared one chat — false once the same human is
  // bound to the entity from more than one chat (e.g. a webhook
  // `human_fallback` row in one chat plus an explicit `follow` row in
  // another, each under a different delegate). Collapsing across chats kept
  // only the earliest chat's row and silently dropped every *other* followed
  // chat from the audience — that chat never received the entity's events at
  // all. The key also includes `delegateAgentId`: two agent-issued follows can
  // share the same fallback human and chat while carrying distinct wake
  // agents. "The chat follows, not the person", so the surviving unit is one
  // row per (human, delegate, chat).
  const earliestByAttentionLine = new Map<string, (typeof subscribedRows)[number]>();
  for (const row of subscribedRows) {
    const key = `${row.humanAgentId}:${row.delegateAgentId}:${row.chatId}`;
    const current = earliestByAttentionLine.get(key);
    if (!current || row.boundAt < current.boundAt) {
      earliestByAttentionLine.set(key, row);
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
  const isPullRequestOpened = event.eventType === "pull_request" && event.action === "opened";
  const involvedLogins = new Set(event.targets.map((target) => target.externalUsername.toLowerCase()));
  const keepSubscribedOpened = (row: (typeof subscribedRows)[number]): boolean => {
    if (!isPullRequestOpened) return true;
    if (isDeclaredBoundVia(row.boundVia)) return true;
    return row.humanAgentName !== null && involvedLogins.has(row.humanAgentName.toLowerCase());
  };

  const subscribed: AudienceTarget[] = [...earliestByAttentionLine.values()]
    .filter(keepSubscribedOpened)
    .map((row) => ({
      humanAgentId: row.humanAgentId,
      delegateAgentId: row.delegateAgentId,
      kind: "existing",
      chatId: row.chatId,
      involveReason: null,
      involveLogin: null,
      provenance: isDeclaredBoundVia(row.boundVia)
        ? "explicit"
        : row.boundVia === "fixes_link"
          ? "related_entity"
          : "identity_target",
    }));

  const subscribedByHuman = new Map<string, AudienceTarget[]>();
  for (const target of subscribed) {
    const rows = subscribedByHuman.get(target.humanAgentId);
    if (rows) rows.push(target);
    else subscribedByHuman.set(target.humanAgentId, [target]);
  }

  const involved: AudienceTarget[] = [];
  if (event.targets.length > 0) {
    const candidateLogins = event.targets.map((target) => target.externalUsername.toLowerCase());
    const reasonByLogin = new Map<string, InvolveReason>();
    for (const target of event.targets) reasonByLogin.set(target.externalUsername.toLowerCase(), target.reason);

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
          eq(agents.type, AGENT_TYPES.HUMAN),
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
      if (c.status !== AGENT_STATUSES.ACTIVE || !c.name) continue;
      const candidateLogin = c.name.toLowerCase();
      const reason = reasonByLogin.get(candidateLogin);
      if (!reason) continue;

      const existingForHuman = subscribedByHuman.get(c.id);
      if (existingForHuman) {
        for (const target of existingForHuman) {
          target.involveReason = reason;
          target.involveLogin = candidateLogin;
        }
        continue;
      }

      if (!c.delegateMention) continue;
      const verdict = evaluateDelegateTarget(delegateById.get(c.delegateMention), organizationId);
      if (verdict !== "ok") continue;
      involved.push({
        humanAgentId: c.id,
        delegateAgentId: c.delegateMention,
        kind: "new",
        chatId: null,
        involveReason: reason,
        involveLogin: candidateLogin,
      });
    }
  }

  const audience = [...subscribed, ...involved];
  return { targets: audience, actorHumanId };
}
