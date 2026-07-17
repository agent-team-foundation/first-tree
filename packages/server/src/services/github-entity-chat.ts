import { chatMetadataSchema, type GithubEntityBoundVia, githubEntityBoundViaSchema } from "@first-tree/shared";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { GithubEntity } from "../api/webhooks/github-entity.js";
import { formatEntityTitle, refreshEntityTitle } from "../api/webhooks/github-entity.js";
import type { Database } from "../db/connection.js";
import { chats } from "../db/schema/chats.js";
import { githubEntityChatMappings } from "../db/schema/github-entity-chat-mappings.js";
import { createLogger } from "../observability/index.js";
import { createChat } from "./chat.js";
import {
  canonicalizeGithubEntityKey,
  githubEntityKeyCandidates,
  githubEntityKeysEquivalent,
} from "./github-entity-key.js";
import type { EntityState, EntityStateSeed } from "./github-entity-state.js";
import { resolveAgentScmBindingPair } from "./scm-attention-line.js";
import { decideScmPersonnelTargetChat } from "./scm-target-chat-policy.js";

const log = createLogger("GithubEntityChat");

/**
 * `bound_via` audit values — the value set is owned by the shared
 * `githubEntityBoundViaSchema` (single source of truth; the wire, this
 * service, and the audience carve-out all derive from it):
 *   - "direct"          — first-touch row created in `resolveTargetChat` step (c)
 *   - "fixes_link"      — secondary row written by the `Fixes #N` linker
 *   - "agent_declared"  — written by an explicit `github follow` declared by an
 *                         agent (the only agent-side wiring path — creating a
 *                         PR/Issue never auto-follows). See
 *                         `services/github-entity-follow.ts`. Legacy rows
 *                         written by the retired session-event auto-binder
 *                         (`agent_created`) were backfilled into this value;
 *                         the shared schema also normalises the legacy string
 *                         at read time.
 *   - "human_declared"  — written by an explicit follow issued by a human
 *                         (user-scoped route); the delegate side comes from
 *                         the human's `delegate_mention`.
 *   - "human_fallback"  — sibling row written by step (a.5) when an event arrives
 *                         for a `(human, delegate)` pair that has no mapping yet,
 *                         but another delegate under the same `(human, entity)`
 *                         already does. Reuses the existing chat instead of
 *                         minting a fresh one. Surfaces in telemetry so we can
 *                         observe how often the involves→delegate mismatch path
 *                         actually fires in production.
 *
 * Routing logic ignores the distinction; the column exists for audit and the
 * narrow `pull_request.opened` carve-out in `github-audience.ts`.
 */
export type BoundVia = GithubEntityBoundVia;

function asBoundVia(value: string): BoundVia {
  const parsed = githubEntityBoundViaSchema.safeParse(value);
  // Unknown legacy strings collapse to the first-touch default rather than
  // erroring — the column is audit-only on this path.
  return parsed.success ? parsed.data : "direct";
}

/**
 * `(eventType, action)` pairs that represent the creation of a brand-new
 * GitHub entity. Reserved for the "creation webhooks must not invent new
 * chats" guard — see `resolveTargetChat`.
 */
export function isCreationEvent(eventType: string, action: string): boolean {
  return (eventType === "pull_request" && action === "opened") || (eventType === "issues" && action === "opened");
}

/**
 * Reviewer-reuse routing (S9, deliver-once-per-chat). When an involved
 * `(human, delegate)` pair is NOT yet mapped to this entity but the entity
 * already has a **single** bound chat where BOTH the human and the delegate
 * are already speakers, the event routes into that chat instead of minting a
 * sibling one — and **no mapping row is written**. The pair sees the entity's
 * events through chat membership, and `deliverGithubEvent` dedups so the
 * chat receives one card whose wake-set includes this delegate.
 *
 * Returns the chat id when exactly one such chat exists; null when there is
 * none, or when the candidate is ambiguous (≥2 bound chats both speak in),
 * in which case the caller mints a fresh chat via `resolveTargetChat` (the
 * strict per-`(human, delegate)` path — we never guess). Preserves S1 (the
 * chat follows, not the person) and S7 (no followed chat is dropped).
 */
export async function findReuseChatForInvolved(
  db: Database,
  organizationId: string,
  entity: GithubEntity,
  humanAgentId: string,
  delegateAgentId: string,
): Promise<string | null> {
  const candidateKeys = githubEntityKeyCandidates(entity.type, entity.key);
  const boundChats = await db
    .selectDistinct({ chatId: githubEntityChatMappings.chatId })
    .from(githubEntityChatMappings)
    .where(
      and(
        eq(githubEntityChatMappings.organizationId, organizationId),
        eq(githubEntityChatMappings.entityType, entity.type),
        inArray(githubEntityChatMappings.entityKey, candidateKeys),
      ),
    );
  if (boundChats.length === 0) return null;

  const decision = await decideScmPersonnelTargetChat(db, {
    reason: "review_requested",
    candidateChatIds: boundChats.map((row) => row.chatId),
    humanAgentId,
    wakeAgentId: delegateAgentId,
  });
  return decision.kind === "reuse" ? decision.chatId : null;
}

/**
 * Resolve which chat a GitHub event for (human, delegate, entity) belongs to.
 *
 * Three-step strategy from docs/webhook-routing-design.md §4.4:
 *   a. Direct hit — entity already bound; reuse that chat.
 *   b. Fixes-link — any related entity (parsed from `Fixes #N` in a PR body)
 *      already bound; write a `fixes_link` row for this entity pointing at
 *      the same chat, return it.
 *   c. Miss — create a fresh chat via the canonical `createChat` entrypoint
 *      and write a `direct` mapping row.
 *
 * Concurrent webhook deliveries for a never-before-seen entity race on (c);
 * the composite primary key + ON CONFLICT DO NOTHING ensures only one row
 * survives. The losing caller falls back to a re-read so the chat stays
 * unique.
 */
export async function resolveTargetChat(
  db: Database,
  params: {
    organizationId: string;
    humanAgentId: string;
    delegateAgentId: string;
    entity: GithubEntity;
    relatedEntities: GithubEntity[];
    /** GitHub event type that triggered this resolution, used only when path
     * (c) creates a fresh chat to pick the title prefix. Existing chats reuse
     * their original title regardless. */
    eventType: string;
    /** GitHub action on `eventType`. Same scope as `eventType`. */
    action: string;
    /**
     * Whether the calling audience target came from an explicit mention /
     * involve in the event payload (vs. a pre-existing subscription). Only
     * mention-driven targets are allowed to create a fresh chat from a
     * creation webhook (`pull_request.opened` / `issues.opened`); subscription
     * fall-through is rejected so opened events can't proliferate chats.
     *
     * Required, not optional: the guard is fail-closed by design so any
     * future caller that forgets to plumb the signal lands in the safer
     * "drop, don't invent" branch instead of silently re-enabling the old
     * chat-proliferation behaviour.
     */
    isMentionMatched: boolean;
    /**
     * State derived from the current webhook payload. Used only when this
     * resolution writes a new mapping for the same entity; existing rows are
     * updated by the pre-delivery state-sync path.
     */
    entityStateSeed?: EntityStateSeed | null;
  },
): Promise<{ chatId: string; created: boolean; boundVia: BoundVia } | null> {
  const {
    organizationId,
    humanAgentId,
    delegateAgentId,
    entity: rawEntity,
    relatedEntities: rawRelatedEntities,
    eventType,
    action,
    isMentionMatched,
  } = params;
  const entity = normalizeGithubEntity(rawEntity);
  const relatedEntities = rawRelatedEntities.map(normalizeGithubEntity);
  const entityState = stateSeedForEntity(params.entityStateSeed ?? null, entity);

  // (a) Direct hit.
  const direct = await lookupMapping(db, organizationId, humanAgentId, delegateAgentId, entity);
  if (direct) {
    return { chatId: direct.chatId, created: false, boundVia: direct.boundVia };
  }

  // (a.5) Human-scoped fallback. The mapping primary key still includes
  // `delegate_agent_id`, but routing treats `(org, human, entity)` as the
  // logical cluster: an entity that is already bound to a chat under this
  // human should never trigger a fresh chat just because a *different*
  // delegate happened to drive this event. Pick the existing chat (open
  // entities first, then earliest `bound_at`) and write a sibling mapping
  // row so the next event hits (a) directly.
  const humanScoped = await lookupMappingByHuman(db, organizationId, humanAgentId, entity);
  if (humanScoped) {
    const inserted = await insertMappingIfAbsent(db, {
      organizationId,
      humanAgentId,
      delegateAgentId,
      entity,
      chatId: humanScoped.chatId,
      boundVia: "human_fallback",
      entityState,
    });
    return { chatId: inserted.chatId, created: false, boundVia: inserted.boundVia };
  }

  // (b) Fixes-link reuse.
  for (const ref of relatedEntities) {
    const linked = await lookupMapping(db, organizationId, humanAgentId, delegateAgentId, ref);
    if (!linked) continue;
    const inserted = await insertMappingIfAbsent(db, {
      organizationId,
      humanAgentId,
      delegateAgentId,
      entity,
      chatId: linked.chatId,
      boundVia: "fixes_link",
      entityState,
    });
    // If the insert lost a race, our re-read returns the winner's row.
    return { chatId: inserted.chatId, created: false, boundVia: inserted.boundVia };
  }

  // (b.5) Creation-event guard. `pull_request.opened` / `issues.opened` must
  // never invent a chat for a target that didn't explicitly @-mention an
  // agent. By the time we get here, (a) miss + (b) miss already proves the
  // entity is brand-new from the mapping's perspective; the only legitimate
  // reason to enter (c) is an explicit mention/involve. Subscription
  // fall-through (or any future caller that forgets to set the flag) gets
  // rejected with `null` so the delivery loop drops the event instead of
  // proliferating chats. See proposals discussion: opened-webhook intercept.
  if (isCreationEvent(eventType, action) && !isMentionMatched) {
    return null;
  }

  // (c) Miss — create a fresh chat. Two concurrent (c)-path callers for the
  // same (org, human, delegate, entity) tuple cause two chats; the second one
  // is unreachable because the primary key on the mapping row points at the
  // first chat. The orphan chat is harmless (no participants beyond the two
  // agents, no messages — we have not yet written one) and the design accepts
  // it as the cost of avoiding a serialisable transaction on every webhook.
  const chat = await createEntityChat(db, humanAgentId, delegateAgentId, entity, eventType, action);
  const inserted = await insertMappingIfAbsent(db, {
    organizationId,
    humanAgentId,
    delegateAgentId,
    entity,
    chatId: chat.id,
    boundVia: "direct",
    entityState,
  });
  return { chatId: inserted.chatId, created: inserted.chatId === chat.id, boundVia: inserted.boundVia };
}

async function lookupMapping(
  db: Database,
  organizationId: string,
  humanAgentId: string,
  delegateAgentId: string,
  entity: GithubEntity,
): Promise<{ chatId: string; boundVia: BoundVia } | null> {
  const candidateKeys = githubEntityKeyCandidates(entity.type, entity.key);
  const canonicalKey = canonicalizeGithubEntityKey(entity.type, entity.key);
  const [row] = await db
    .select({ chatId: githubEntityChatMappings.chatId, boundVia: githubEntityChatMappings.boundVia })
    .from(githubEntityChatMappings)
    .where(
      and(
        eq(githubEntityChatMappings.organizationId, organizationId),
        eq(githubEntityChatMappings.humanAgentId, humanAgentId),
        eq(githubEntityChatMappings.delegateAgentId, delegateAgentId),
        eq(githubEntityChatMappings.entityType, entity.type),
        inArray(githubEntityChatMappings.entityKey, candidateKeys),
      ),
    )
    .orderBy(desc(sql`${githubEntityChatMappings.entityKey} = ${canonicalKey}`))
    .limit(1);
  if (!row) return null;
  return { chatId: row.chatId, boundVia: asBoundVia(row.boundVia) };
}

/**
 * Find any chat already bound to `(org, human, entity)` regardless of delegate.
 *
 * Multiple rows can legitimately exist when the same human created the entity
 * via one delegate and later got fanned out via another delegate's
 * `delegateMention` configuration. Pick deterministically:
 *   1. `entity_state IN ('open', 'draft')` rows first (active conversation).
 *   2. Then earliest `bound_at` — the original chat is the canonical thread.
 */
async function lookupMappingByHuman(
  db: Database,
  organizationId: string,
  humanAgentId: string,
  entity: GithubEntity,
): Promise<{ chatId: string } | null> {
  const candidateKeys = githubEntityKeyCandidates(entity.type, entity.key);
  const canonicalKey = canonicalizeGithubEntityKey(entity.type, entity.key);
  const [row] = await db
    .select({ chatId: githubEntityChatMappings.chatId })
    .from(githubEntityChatMappings)
    .where(
      and(
        eq(githubEntityChatMappings.organizationId, organizationId),
        eq(githubEntityChatMappings.humanAgentId, humanAgentId),
        eq(githubEntityChatMappings.entityType, entity.type),
        inArray(githubEntityChatMappings.entityKey, candidateKeys),
      ),
    )
    .orderBy(
      desc(sql`${githubEntityChatMappings.entityKey} = ${canonicalKey}`),
      desc(sql`${githubEntityChatMappings.entityState} IN ('open', 'draft')`),
      asc(githubEntityChatMappings.boundAt),
    )
    .limit(1);
  if (!row) return null;
  return { chatId: row.chatId };
}

export async function insertMappingIfAbsent(
  db: Database,
  params: {
    organizationId: string;
    humanAgentId: string;
    delegateAgentId: string;
    entity: GithubEntity;
    chatId: string;
    boundVia: BoundVia;
    /** Upstream lifecycle state to seed the row with; defaults to "open". */
    entityState?: EntityState;
  },
): Promise<{ chatId: string; boundVia: BoundVia; inserted: boolean }> {
  const entity = normalizeGithubEntity(params.entity);
  const existing = await lookupMapping(db, params.organizationId, params.humanAgentId, params.delegateAgentId, entity);
  if (existing) {
    return { ...existing, inserted: false };
  }

  const [inserted] = await db
    .insert(githubEntityChatMappings)
    .values({
      organizationId: params.organizationId,
      humanAgentId: params.humanAgentId,
      delegateAgentId: params.delegateAgentId,
      entityType: entity.type,
      entityKey: entity.key,
      chatId: params.chatId,
      boundVia: params.boundVia,
      ...(params.entityState ? { entityState: params.entityState } : {}),
      // Seed the human label from whatever the caller carried (webhook payload
      // or follow-time GitHub fetch). Null degrades to the entityKey link; the
      // webhook handler later backfills/refreshes it via `setEntityTitle`.
      ...(entity.title && entity.title.length > 0 ? { title: entity.title } : {}),
    })
    .onConflictDoNothing({
      target: [
        githubEntityChatMappings.organizationId,
        githubEntityChatMappings.humanAgentId,
        githubEntityChatMappings.delegateAgentId,
        githubEntityChatMappings.entityType,
        githubEntityChatMappings.entityKey,
      ],
    })
    .returning({
      chatId: githubEntityChatMappings.chatId,
      boundVia: githubEntityChatMappings.boundVia,
    });
  if (inserted) {
    return { chatId: inserted.chatId, boundVia: asBoundVia(inserted.boundVia), inserted: true };
  }
  // Lost the race — read the winning row.
  const winner = await lookupMapping(db, params.organizationId, params.humanAgentId, params.delegateAgentId, entity);
  if (!winner) {
    throw new Error("Unexpected: mapping insert conflicted but row not visible on re-read");
  }
  return { ...winner, inserted: false };
}

/**
 * Create a fresh chat for a (human, delegate, entity) tuple. Goes through the
 * canonical `createChat` so:
 *   - cross-org participants are rejected (BadRequestError)
 *   - the new chat is written as `type='group'` (first-tree-context PR #281
 *     locked the single-group-chat model in; v2 made `chat_membership.mode`
 *     decision-inert — every speaker row is written as the constant
 *     `'mention_only'` regardless of peer shape).
 *   - watcher rows are recomputed
 */
async function createEntityChat(
  db: Database,
  humanAgentId: string,
  delegateAgentId: string,
  entity: GithubEntity,
  eventType: string,
  action: string,
): Promise<{ id: string }> {
  // Parse the metadata via the shared discriminated union BEFORE handing
  // it to `createChat`. TS narrowing already catches a malformed literal at
  // compile time, so the runtime cost here is the defensive bound against
  // a future refactor accidentally widening the inferred type back to
  // `Record<string, unknown>` and letting a colliding key slip through.
  const metadata = chatMetadataSchema.parse({
    source: "github",
    entityType: entity.type,
    entityKey: entity.key,
    ...(entity.url ? { entityUrl: entity.url } : {}),
  });
  const chat = await createChat(db, humanAgentId, {
    type: "group",
    participantIds: [delegateAgentId],
    topic: formatEntityTitle(entity, eventType, action),
    metadata,
  });
  return { id: chat.id };
}

/**
 * Pick the (org, human, delegate) tuple an agent-driven binding should be
 * written under. Entry-point agnostic: today's sole caller is the explicit
 * `github follow` service (`github-entity-follow.ts`); any future agent-side
 * wiring path reuses the same pairing rules.
 *
 * The calling agent is the delegate side. The human side is the
 * representative human member of the chat — exactly one row is written so
 * group chats don't fan out into N duplicate cards on the next webhook.
 *
 * Selection order (deterministic across concurrent calls):
 *   1. Active humans whose `delegateMention` already points at the caller
 *      —— these humans are the natural "owner" of the caller's work; any
 *      downstream code that reads `mapping.humanAgentId` (notification
 *      recipient, card signatures, audit) sees a meaningful pairing.
 *   2. Fallback: id-sorted-first among the remaining active humans.
 *
 * Returns null when:
 *   - the caller isn't a member of the chat
 *   - the caller is itself a human agent (use the user-scoped route instead)
 *   - the chat has no active human member
 */
export async function resolveBindingPair(
  db: Database,
  chatId: string,
  reporterAgentId: string,
): Promise<{
  organizationId: string;
  humanAgentId: string;
  delegateAgentId: string;
} | null> {
  const pair = await resolveAgentScmBindingPair(db, chatId, reporterAgentId);
  if (!pair) return null;
  return {
    organizationId: pair.organizationId,
    humanAgentId: pair.humanAgentId,
    delegateAgentId: pair.wakeAgentId,
  };
}

/**
 * Refresh a GitHub-sourced chat's `topic` to match the current entity title.
 *
 * The chat's topic was first written at creation time by `createEntityChat`
 * using `formatEntityTitle(entity, eventType, action)`. If the upstream PR /
 * issue title later changes on GitHub, that webhook arrives with the new
 * `entity.title` — we swap the title portion in and leave the prefix/anchor
 * head intact.
 *
 * Scope rules (all three matter — see PR #657 review):
 *   - **Owning anchor only.** A chat can carry several mapping rows: the
 *     `direct` first-touch row the chat was minted for, plus `fixes_link` /
 *     `human_fallback` siblings that point *related* entities at the same
 *     chat. We refresh only when the incoming event is for the chat's own
 *     `direct` anchor entity; an event for a linked entity must never
 *     overwrite the topic with a different entity's title. (A chat with no
 *     `direct` row — e.g. one whose entity was wired in by an explicit
 *     `github follow`, bound via a declared value — is not github-minted
 *     and is left alone.)
 *   - **Prefix preserved.** `refreshEntityTitle` reuses the prefix already
 *     baked into the stored topic, so a later `review_requested` /
 *     `*_review_comment` event can't drift a `PR …` head into `PR Review …`
 *     (or vice-versa). It also returns null — leaving the topic untouched —
 *     when the stored topic isn't a recognised github head (agent rename) or
 *     the payload carries no title (would downgrade to a bare \`PR repo#307\`).
 *   - No-op when the recomputed topic equals the stored topic.
 *
 * Failures are swallowed: the caller is the github delivery loop, and a
 * topic-refresh hiccup must not block message delivery.
 */
export async function refreshGithubChatTopic(db: Database, chatId: string, entity: GithubEntity): Promise<void> {
  if (!entity.title || entity.title.length === 0) return;
  const normalizedEntity = normalizeGithubEntity(entity);

  try {
    const [anchor] = await db
      .select({
        entityType: githubEntityChatMappings.entityType,
        entityKey: githubEntityChatMappings.entityKey,
      })
      .from(githubEntityChatMappings)
      .where(and(eq(githubEntityChatMappings.chatId, chatId), eq(githubEntityChatMappings.boundVia, "direct")))
      .limit(1);
    if (!anchor) return;
    if (
      anchor.entityType !== normalizedEntity.type ||
      !githubEntityKeysEquivalent(normalizedEntity.type, anchor.entityKey, normalizedEntity.key)
    ) {
      return;
    }

    const [row] = await db.select({ topic: chats.topic }).from(chats).where(eq(chats.id, chatId)).limit(1);
    if (!row || !row.topic) return;

    const nextTopic = refreshEntityTitle(row.topic, normalizedEntity);
    if (!nextTopic || nextTopic === row.topic) return;

    await db.update(chats).set({ topic: nextTopic, updatedAt: new Date() }).where(eq(chats.id, chatId));
    log.info({ chatId, entityType: entity.type, entityKey: entity.key, nextTopic }, "refreshed github chat topic");
  } catch (err) {
    log.warn(
      {
        chatId,
        entityType: normalizedEntity.type,
        entityKey: normalizedEntity.key,
        errorMessage: err instanceof Error ? err.message : String(err),
      },
      "failed to refresh github chat topic — continuing",
    );
  }
}

function normalizeGithubEntity(entity: GithubEntity): GithubEntity {
  const key = canonicalizeGithubEntityKey(entity.type, entity.key);
  return key === entity.key ? entity : { ...entity, key };
}

function stateSeedForEntity(seed: EntityStateSeed | null, entity: GithubEntity): EntityState | undefined {
  if (!seed) return undefined;
  if (seed.entityType !== entity.type) return undefined;
  if (!githubEntityKeysEquivalent(entity.type, seed.entityKey, entity.key)) return undefined;
  return seed.state;
}
