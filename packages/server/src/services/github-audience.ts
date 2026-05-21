import type { InvolveReason, NormalizedEvent } from "@first-tree/shared";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { githubEntityChatMappings } from "../db/schema/github-entity-chat-mappings.js";

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
 *                       for echo suppression: the agent's own actions don't
 *                       fan back into their own chat.
 *   - `our-app-bot`   — actor is `<app-slug>[bot]`. The event is a downstream
 *                       effect of Hub's own outbound write. `kind: "existing"`
 *                       targets are kept (so PRs the agent opens via Hub's
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
 *   - actor = `agent`: rows where the actor sits on either the human or
 *     delegate side of an `existing` mapping are dropped. `kind: "new"`
 *     mention rows are kept (explicit involves are intentional routing).
 *   - actor = `our-app-bot`: `kind: "existing"` rows are kept so follow-up
 *     events on entities the agent opened still reach the chat through the
 *     subscription path; `kind: "new"` rows are dropped to avoid forking a
 *     fresh chat just to echo Hub's own outbound write. See `ActorIdentity`.
 */
export async function resolveAudience(
  db: Database,
  event: NormalizedEvent,
  appSlug: string | null,
): Promise<AudienceTarget[]> {
  const organizationId = event.source.organizationId;

  const subscribedRows = await db
    .select({
      humanAgentId: githubEntityChatMappings.humanAgentId,
      delegateAgentId: githubEntityChatMappings.delegateAgentId,
      chatId: githubEntityChatMappings.chatId,
    })
    .from(githubEntityChatMappings)
    .where(
      and(
        eq(githubEntityChatMappings.organizationId, organizationId),
        eq(githubEntityChatMappings.entityType, event.entity.type),
        eq(githubEntityChatMappings.entityKey, event.entity.key),
      ),
    );

  const subscribed: AudienceTarget[] = subscribedRows.map((row) => ({
    humanAgentId: row.humanAgentId,
    delegateAgentId: row.delegateAgentId,
    kind: "existing",
    chatId: row.chatId,
    involveReason: null,
    involveLogin: null,
  }));

  const subscribedKeys = new Set(subscribed.map((s) => `${s.humanAgentId} ${s.delegateAgentId}`));

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
      const key = `${c.id} ${c.delegateMention}`;
      if (subscribedKeys.has(key)) continue;
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
      });
    }
  }

  const audience = [...subscribed, ...involved];
  if (audience.length === 0) return audience;

  const actor = await identifyActor(db, organizationId, event.actor, appSlug);
  if (actor.kind === "our-app-bot") {
    // The App bot is on the wire because Hub itself wrote to GitHub — the
    // user already saw their own action client-side. We still need to fan
    // out to *existing* subscriptions so PR comments / CI changes reach
    // the chat the agent worked in; mention-driven `kind: "new"` rows are
    // dropped because creating a fresh chat just to echo our own write is
    // never useful.
    return audience.filter((a) => a.kind === "existing");
  }
  if (actor.kind === "agent") {
    // Echo suppression applies to subscribed rows only: a row where the
    // actor is on either side of an existing mapping shouldn't fan back
    // into their chat (they already know about the action they just took).
    // `kind: "new"` rows come from explicit involves in the event payload
    // (mention / review_request / assign) — the actor deliberately named
    // that login, so even a self-target is intentional routing, not echo.
    // Dropping them would regress the human-self-mention pattern that used
    // to work under the pre-#345 mention-driven webhook.
    return audience.filter(
      (a) => a.kind === "new" || (a.humanAgentId !== actor.agentId && a.delegateAgentId !== actor.agentId),
    );
  }
  return audience;
}
