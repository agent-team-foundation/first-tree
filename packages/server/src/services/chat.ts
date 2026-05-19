import { randomUUID } from "node:crypto";
import { type AddParticipant, AGENT_VISIBILITY, type CreateChat } from "@agent-team-foundation/first-tree-hub-shared";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chats } from "../db/schema/chats.js";
import { messages } from "../db/schema/messages.js";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../errors.js";
import { agentAvatarImageUrl } from "./agent.js";
import { invalidateChatAudience } from "./chat-audience-cache.js";
import { backfillSilentContextForNewParticipants } from "./inbox.js";
import { resolveChatTitle } from "./me-chat.js";
import { addChatParticipants, changeChatType, wouldUpgradeToGroup } from "./participant-mode.js";
import { extractSummary } from "./session.js";
import { leaveAsParticipant, recomputeChatWatchers } from "./watcher.js";

export async function createChat(db: Database, creatorId: string, data: CreateChat) {
  const chatId = randomUUID();

  // Ensure creator is included in participants
  const allParticipantIds = new Set([creatorId, ...data.participantIds]);

  // Verify all participants exist and belong to the same organization
  const existingAgents = await db
    .select({
      id: agents.uuid,
      organizationId: agents.organizationId,
      type: agents.type,
      visibility: agents.visibility,
      managerId: agents.managerId,
    })
    .from(agents)
    .where(inArray(agents.uuid, [...allParticipantIds]));

  if (existingAgents.length !== allParticipantIds.size) {
    const found = new Set(existingAgents.map((a) => a.id));
    const missing = [...allParticipantIds].filter((id) => !found.has(id));
    throw new BadRequestError(`Agents not found: ${missing.join(", ")}`);
  }

  const creator = existingAgents.find((a) => a.id === creatorId);
  if (!creator) throw new Error("Unexpected: creator not in existingAgents");
  const orgId = creator.organizationId;

  const crossOrg = existingAgents.filter((a) => a.organizationId !== orgId);
  if (crossOrg.length > 0) {
    throw new BadRequestError(`Cross-organization chat not allowed: ${crossOrg.map((a) => a.id).join(", ")}`);
  }

  // Owner-exclusive rule: a private agent can only be brought into a
  // chat by another agent owned by the same member (i.e. the creator
  // and the target share `managerId`). `creator.managerId` is the
  // caller's effective owner identity — for a human agent this is the
  // member's own id; for an autonomous agent this is whichever member
  // owns it. RFC §4.4.2 / §4.5 — keeping the gate at the service layer
  // closes the agent-SDK bypass path, not only the user-facing /me API.
  const privateNotOwned = existingAgents.filter(
    (a) => a.id !== creatorId && a.visibility === AGENT_VISIBILITY.PRIVATE && a.managerId !== creator.managerId,
  );
  if (privateNotOwned.length > 0) {
    throw new ForbiddenError(
      `Only the owner can add a private agent to a chat: ${privateNotOwned.map((a) => a.id).join(", ")}`,
    );
  }

  return db.transaction(async (tx) => {
    const [chat] = await tx
      .insert(chats)
      .values({
        id: chatId,
        organizationId: orgId,
        type: data.type,
        topic: data.topic ?? null,
        metadata: data.metadata ?? {},
      })
      .returning();

    // Mode is derived per-row by `addChatParticipants` from
    // `(chats.type, agents.type)` — `services/participant-mode.ts` is the
    // single authoritative encoder of the rule (group / non-human →
    // `mention_only`; direct + agent-only → `mention_only` for the
    // anti-echo invariant from migration 0029). Do NOT pass `mode` here.
    await addChatParticipants(
      tx,
      chatId,
      [...allParticipantIds].map((agentId) => ({
        agentId,
        role: agentId === creatorId ? "owner" : "member",
      })),
    );

    // Watcher rows: every active manager whose managed non-human agent
    // is now in the chat (and who isn't already a speaker) should see
    // this chat under "Watching". Without this call, watchers were
    // only created on the `/me/chats` path — agent-to-agent / webhook /
    // adapter / admin chats silently broke design AC #8.
    await recomputeChatWatchers(tx, chatId);

    const participants = await tx
      .select()
      .from(chatMembership)
      .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.accessMode, "speaker")));

    if (!chat) throw new Error("Unexpected: INSERT RETURNING produced no row");
    return { ...chat, participants };
  });
}

export async function getChat(db: Database, chatId: string) {
  const [chat] = await db.select().from(chats).where(eq(chats.id, chatId)).limit(1);
  if (!chat) {
    throw new NotFoundError(`Chat "${chatId}" not found`);
  }
  return chat;
}

/**
 * Read a chat row + speaker participants + server-resolved display
 * metadata (`title`, `firstMessagePreview`) so the agent route can return
 * a payload that matches the wire `chatDetailSchema` contract.
 *
 * `selfAgentId` only affects the participant-join fallback in
 * `resolveChatTitle` (e.g. `"alice, bob"` excluding self when topic + first
 * message are both empty). Callers that don't have a self agent (admin
 * paths) can pass `null` — the fallback degrades to "all displayNames".
 */
export async function getChatDetail(db: Database, chatId: string, selfAgentId: string | null = null) {
  const chat = await getChat(db, chatId);
  // Participants JOIN `agents` so each row carries `name / displayName /
  // type` — needed by the wire chatDetailSchema (PR #402 identity-
  // rendering fix) and by `resolveChatTitle`'s participant-join fallback
  // (PR #393 v1.7 server-resolved title). Identity rendering inside a
  // chat is membership-derived; we do NOT apply `agentVisibilityCondition`
  // here — see `docs/agent-space-and-mention-visibility-design.zh-CN.md`
  // §4.3.3.
  const participantRows = await db
    .select({
      agentId: chatMembership.agentId,
      role: chatMembership.role,
      mode: chatMembership.mode,
      joinedAt: chatMembership.joinedAt,
      name: agents.name,
      displayName: agents.displayName,
      type: agents.type,
      avatarColorToken: agents.avatarColorToken,
      avatarImageUpdatedAt: agents.avatarImageUpdatedAt,
    })
    .from(chatMembership)
    .innerJoin(agents, eq(chatMembership.agentId, agents.uuid))
    .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.accessMode, "speaker")));

  // Compute server-resolved `title` + `firstMessagePreview` so the agent
  // route returns a payload that matches the wire contract. Without this,
  // the client's chat-context injection cannot render a chat label when
  // the creator never set an explicit topic — see PR #393 dogfood report.
  const [firstMessageRow] = await db
    .select({ content: messages.content })
    .from(messages)
    .where(eq(messages.chatId, chatId))
    .orderBy(messages.createdAt, messages.id)
    .limit(1);
  const firstMessagePreview = firstMessageRow ? extractSummary(firstMessageRow.content) : null;
  const title = resolveChatTitle(chat.topic, firstMessagePreview, participantRows, selfAgentId ?? "");

  // Preserve the resolved name / displayName / type / avatar fields on
  // the wire (PR #402 identity-rendering contract; avatar fields added
  // so the chat-detail surface renders manager-configured hue + image
  // — see `meChatParticipantSchema` for the matching field on the rail).
  const participants = participantRows.map((p) => ({
    chatId,
    agentId: p.agentId,
    role: p.role,
    mode: p.mode,
    joinedAt: p.joinedAt,
    name: p.name,
    displayName: p.displayName,
    type: p.type,
    avatarColorToken: p.avatarColorToken ?? null,
    avatarImageUrl: agentAvatarImageUrl(p.agentId, p.avatarImageUpdatedAt ?? null),
  }));

  // Match the chatDetailSchema wire contract — the chat-first workspace
  // reads this field instead of round-tripping `/orgs/:orgId/chats` just to
  // distinguish speaker vs watcher view. Agent-SDK callers always reach
  // this code with their own uuid as `selfAgentId`, and the SDK only sees
  // chats it is a speaker in, so the lookup is cheap and almost always
  // resolves to `"participant"`; the admin / supervisor `null` shape still
  // matters for the alternate route (`api/chats.ts`).
  const viewerMembershipKind = await resolveViewerMembershipKind(db, chatId, selfAgentId);

  return { ...chat, participants, title, firstMessagePreview, viewerMembershipKind };
}

async function resolveViewerMembershipKind(
  db: Database,
  chatId: string,
  viewerAgentId: string | null,
): Promise<"participant" | "watching" | null> {
  if (!viewerAgentId) return null;
  const [row] = await db
    .select({ accessMode: chatMembership.accessMode })
    .from(chatMembership)
    .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.agentId, viewerAgentId)))
    .limit(1);
  if (!row) return null;
  return row.accessMode === "speaker" ? "participant" : "watching";
}

export async function listChats(db: Database, agentId: string, limit: number, cursor?: string) {
  // Find all chat IDs where agent is a speaker (watcher rows excluded
  // by access_mode filter — admin agent-scoped chats list shows only
  // chats the agent actually speaks in, matching pre-refactor behaviour).
  const participantRows = await db
    .select({ chatId: chatMembership.chatId })
    .from(chatMembership)
    .where(and(eq(chatMembership.agentId, agentId), eq(chatMembership.accessMode, "speaker")));

  const chatIds = participantRows.map((r) => r.chatId);
  if (chatIds.length === 0) {
    return { items: [], nextCursor: null };
  }

  const where = cursor
    ? and(inArray(chats.id, chatIds), lt(chats.updatedAt, new Date(cursor)))
    : inArray(chats.id, chatIds);

  const query = db
    .select()
    .from(chats)
    .where(where)
    .orderBy(desc(chats.updatedAt))
    .limit(limit + 1);

  const rows = await query;
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? last.updatedAt.toISOString() : null;

  return { items, nextCursor };
}

/**
 * List participants of a chat with their agent names — used by the client
 * runtime to resolve `@<name>` mentions against the authoritative participant
 * set (see proposals/hub-agent-messaging-reply-and-mentions §4).
 */
export async function listChatParticipantsWithNames(db: Database, chatId: string) {
  const rows = await db
    .select({
      agentId: chatMembership.agentId,
      role: chatMembership.role,
      mode: chatMembership.mode,
      joinedAt: chatMembership.joinedAt,
      name: agents.name,
      displayName: agents.displayName,
      type: agents.type,
      avatarColorToken: agents.avatarColorToken,
      avatarImageUpdatedAt: agents.avatarImageUpdatedAt,
    })
    .from(chatMembership)
    .innerJoin(agents, eq(chatMembership.agentId, agents.uuid))
    .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.accessMode, "speaker")));
  return rows;
}

export async function assertParticipant(db: Database, chatId: string, agentId: string): Promise<void> {
  const [row] = await db
    .select({ chatId: chatMembership.chatId })
    .from(chatMembership)
    .where(
      and(
        eq(chatMembership.chatId, chatId),
        eq(chatMembership.agentId, agentId),
        eq(chatMembership.accessMode, "speaker"),
      ),
    )
    .limit(1);

  if (!row) {
    throw new ForbiddenError("Not a participant of this chat");
  }
}

/**
 * Non-throwing membership check. Used by routing logic that needs to fall
 * back to a different chat when the candidate target isn't a member of the
 * caller's current chat (see `sendToAgent`'s current-chat routing branch).
 */
export async function isParticipant(db: Database, chatId: string, agentId: string): Promise<boolean> {
  const [row] = await db
    .select({ chatId: chatMembership.chatId })
    .from(chatMembership)
    .where(
      and(
        eq(chatMembership.chatId, chatId),
        eq(chatMembership.agentId, agentId),
        eq(chatMembership.accessMode, "speaker"),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** Ensure an agent is a speaker of a chat. Silently adds them if not already. */
export async function ensureParticipant(db: Database, chatId: string, agentId: string): Promise<void> {
  // Short-circuit if already a speaker so we don't spuriously trigger the
  // direct→group upgrade on every admin message in a chat the sender already
  // belongs to. Read outside the transaction — if a race adds this agent
  // concurrently, the UPSERT inside the transaction is the authoritative
  // dedupe.
  const [existing] = await db
    .select({ accessMode: chatMembership.accessMode })
    .from(chatMembership)
    .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.agentId, agentId)))
    .limit(1);
  if (existing?.accessMode === "speaker") return;

  // This is a genuine join — apply the same upgrade rule as joinChat /
  // addParticipant. Web-console "start typing in a chat" funnels through
  // here, so missing this call left the proposal's no-echo invariant
  // silently off for UI-initiated joins. Atomic: upgrade + UPSERT must not
  // interleave with sendMessage's participant read.
  //
  // If a watcher row already exists for this (chat, agent) pair, the
  // ON CONFLICT DO UPDATE upgrades it to speaker in place. chat_user_state
  // is structurally separate so the user's read state survives the
  // promotion untouched — no state-carry needed (proposal §8.4).
  await db.transaction(async (tx) => {
    const current = await tx
      .select({ agentId: chatMembership.agentId })
      .from(chatMembership)
      .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.accessMode, "speaker")));
    if (wouldUpgradeToGroup(current.length, 1)) {
      await changeChatType(tx, chatId, "group");
    }
    // Mode derived server-side via `addChatParticipants`. `upgradeWatcherToSpeaker`
    // promotes a pre-existing watcher row in place so chat_user_state is preserved
    // automatically (the chat_user_state row, if any, lives in a separate table
    // and survives the access_mode flip untouched — proposal §8.4).
    await addChatParticipants(tx, chatId, [{ agentId }], { upgradeWatcherToSpeaker: true });
    // Reconcile watcher rows for managers of any non-human in chat.
    await recomputeChatWatchers(tx, chatId);
  });
  invalidateChatAudience(chatId);
}

export async function addParticipant(db: Database, chatId: string, requesterId: string, data: AddParticipant) {
  // Verify chat exists
  const chat = await getChat(db, chatId);

  // Verify requester is a participant
  await assertParticipant(db, chatId, requesterId);

  // Resolve the target by uuid or by name. Name lookup is scoped to the
  // chat's organization so an agent in another org can never be pulled in
  // by name collision. `inboxId` is needed for the v1.7 silent-context
  // backfill; `visibility` and `managerId` are needed for PR #402's
  // owner-exclusive check.
  const targetSelector = data.agentId
    ? eq(agents.uuid, data.agentId)
    : and(eq(agents.organizationId, chat.organizationId), eq(agents.name, data.agentName ?? ""));
  const [targetAgent] = await db
    .select({
      id: agents.uuid,
      organizationId: agents.organizationId,
      inboxId: agents.inboxId,
      visibility: agents.visibility,
      managerId: agents.managerId,
    })
    .from(agents)
    .where(targetSelector)
    .limit(1);

  if (!targetAgent) {
    const ref = data.agentId ?? data.agentName ?? "(unknown)";
    throw new NotFoundError(`Agent "${ref}" not found`);
  }

  if (targetAgent.organizationId !== chat.organizationId) {
    throw new BadRequestError("Cannot add agent from different organization");
  }

  // Owner-exclusive rule for private targets. The requester is an
  // agent on the SDK side; resolve its owner via `agents.managerId`
  // and compare with the target's owner — only the same member may
  // bring a private agent into a chat. Closes the agent-SDK bypass of
  // the discovery filter (RFC §4.4.2 / §4.5). `targetAgent.id !==
  // requesterId` skips the self-add case so an agent rejoining its own
  // chat via `joinChat` semantics isn't incidentally blocked.
  if (targetAgent.visibility === AGENT_VISIBILITY.PRIVATE && targetAgent.id !== requesterId) {
    const [requester] = await db
      .select({ managerId: agents.managerId })
      .from(agents)
      .where(eq(agents.uuid, requesterId))
      .limit(1);
    if (!requester) {
      // Should be unreachable — `assertParticipant` above proved the
      // requester is in chat_membership, which FK-references agents.
      throw new NotFoundError(`Agent "${requesterId}" not found`);
    }
    if (requester.managerId !== targetAgent.managerId) {
      throw new ForbiddenError(`Only the owner can add a private agent to a chat: ${targetAgent.id}`);
    }
  }

  // Check not already a speaker. A watcher row is allowed — it's the
  // expected source state for the manager's "promote myself to speaker"
  // path (the UPSERT below upgrades it).
  const [existing] = await db
    .select({ accessMode: chatMembership.accessMode })
    .from(chatMembership)
    .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.agentId, targetAgent.id)))
    .limit(1);

  if (existing?.accessMode === "speaker") {
    throw new ConflictError(`Agent "${data.agentName ?? targetAgent.id}" is already a participant`);
  }

  // Direct chats become groups on the third speaker. Flip existing
  // non-human speakers to mention_only so the group doesn't devolve into
  // noise. Atomic: upgrade + UPSERT must not interleave with sendMessage's
  // participant read, or a concurrent send would see chats.type='group'
  // with mode='full'.
  //
  // Watcher → speaker UPSERT preserves chat_user_state (read state) by
  // construction — they live in a different table (proposal §8.4).
  await db.transaction(async (tx) => {
    const currentSpeakers = await tx
      .select({ agentId: chatMembership.agentId })
      .from(chatMembership)
      .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.accessMode, "speaker")));
    if (wouldUpgradeToGroup(currentSpeakers.length, 1)) {
      await changeChatType(tx, chatId, "group");
    }
    // Mode derived server-side from `(chats.type, agents.type)`. Callers no
    // longer pass `mode` (HTTP schema dropped that field; see Phase 1 design
    // §3.2 — `data.mode` is therefore ignored even if a stale TS caller is
    // still constructing it). `upgradeWatcherToSpeaker` promotes any
    // pre-existing watcher row in place — chat_user_state is structurally
    // separate so read state is preserved without a state-carry transaction.
    await addChatParticipants(tx, chatId, [{ agentId: targetAgent.id }], { upgradeWatcherToSpeaker: true });
    await recomputeChatWatchers(tx, chatId);
    // v1 §四 改造 2: backfill the most recent N messages as silent
    // (notify=false) inbox rows for the new participant so a future trigger
    // (mention / chat send / replyTo) can replay them as preceding
    // context. Hook lives in the service layer — caller-agnostic, so
    // human web / dispatcher / future agent-CLI all benefit.
    await backfillSilentContextForNewParticipants(tx, chatId, [{ inboxId: targetAgent.inboxId }]);
  });
  invalidateChatAudience(chatId);

  return db
    .select()
    .from(chatMembership)
    .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.accessMode, "speaker")));
}

export async function removeParticipant(db: Database, chatId: string, requesterId: string, targetAgentId: string) {
  // Verify requester is a participant
  await assertParticipant(db, chatId, requesterId);

  // Cannot remove self (use leave instead, if implemented)
  if (requesterId === targetAgentId) {
    throw new BadRequestError("Cannot remove yourself from a chat");
  }

  // Only target the speaker row — leaving any watcher row to be handled
  // by `recomputeChatWatchers` below (it will be dropped if its anchor
  // condition no longer holds, or kept otherwise).
  const [removed] = await db
    .delete(chatMembership)
    .where(
      and(
        eq(chatMembership.chatId, chatId),
        eq(chatMembership.agentId, targetAgentId),
        eq(chatMembership.accessMode, "speaker"),
      ),
    )
    .returning();

  if (!removed) {
    throw new NotFoundError(`Agent "${targetAgentId}" is not a participant of this chat`);
  }
  // Reconcile watchers: a manager who was previously anchored to the
  // removed agent may need their watcher row dropped (if no other
  // managed agent remains in chat) or re-created (if the removed agent
  // was a speaker but their manager is now eligible to watch).
  await recomputeChatWatchers(db, chatId);
  invalidateChatAudience(chatId);

  return db
    .select()
    .from(chatMembership)
    .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.accessMode, "speaker")));
}

/**
 * List chats visible to a member, grouped by agent.
 * A member sees chats where:
 *   1. Their human agent is a participant, OR
 *   2. Any agent they manage (managerId = memberId) is a participant (supervision)
 */
// TODO: consolidate the three sequential queries (managedAgents, participations, chatRows)
// into a single JOIN query for better performance at scale
export async function listChatsForMember(db: Database, memberId: string, humanAgentId: string) {
  // Find all agent UUIDs this member can see chats for:
  // their own human agent + all agents they manage
  const managedAgents = await db
    .select({ uuid: agents.uuid, name: agents.name, type: agents.type, displayName: agents.displayName })
    .from(agents)
    .where(eq(agents.managerId, memberId));

  // Ensure human agent is included (it should be, but be safe)
  // displayName is non-null post-Phase 2 (migration 0024 enforces it).
  const agentMap = new Map<string, { uuid: string; name: string | null; type: string; displayName: string }>();
  for (const a of managedAgents) {
    agentMap.set(a.uuid, a);
  }
  if (!agentMap.has(humanAgentId)) {
    const [ha] = await db
      .select({ uuid: agents.uuid, name: agents.name, type: agents.type, displayName: agents.displayName })
      .from(agents)
      .where(eq(agents.uuid, humanAgentId))
      .limit(1);
    if (ha) agentMap.set(ha.uuid, ha);
  }

  const agentIds = [...agentMap.keys()];
  if (agentIds.length === 0) return [];

  // Find all chat participations (speaker rows) for these agents.
  // Watcher rows are intentionally excluded — this admin endpoint
  // surfaces "who is actively in the chat", not "who is observing".
  const participations = await db
    .select({
      chatId: chatMembership.chatId,
      agentId: chatMembership.agentId,
      role: chatMembership.role,
      mode: chatMembership.mode,
    })
    .from(chatMembership)
    .where(and(inArray(chatMembership.agentId, agentIds), eq(chatMembership.accessMode, "speaker")));

  if (participations.length === 0) return [];

  // Collect unique chat IDs and build agent → chatIds mapping
  const chatIds = [...new Set(participations.map((p) => p.chatId))];
  const agentChatMap = new Map<string, string[]>();
  for (const p of participations) {
    const list = agentChatMap.get(p.agentId) ?? [];
    list.push(p.chatId);
    agentChatMap.set(p.agentId, list);
  }

  // Fetch chat details
  const chatRows = await db
    .select({
      id: chats.id,
      type: chats.type,
      topic: chats.topic,
      metadata: chats.metadata,
      createdAt: chats.createdAt,
      updatedAt: chats.updatedAt,
      participantCount: sql<number>`(SELECT count(*)::int FROM chat_membership WHERE chat_id = ${chats.id} AND access_mode = 'speaker')`,
    })
    .from(chats)
    .where(inArray(chats.id, chatIds))
    .orderBy(desc(chats.updatedAt));

  const chatMap = new Map(chatRows.map((c) => [c.id, c]));

  // Determine which chats the member's human agent is actually a participant in (vs supervise-only)
  const humanParticipantChatIds = new Set(
    participations.filter((p) => p.agentId === humanAgentId).map((p) => p.chatId),
  );

  // Build grouped result: per agent, list of chats
  const result: Array<{
    agent: { uuid: string; name: string | null; type: string; displayName: string };
    chats: Array<{
      id: string;
      type: string | null;
      topic: string | null;
      participantCount: number;
      isSupervisionOnly: boolean;
      createdAt: string;
      updatedAt: string;
    }>;
  }> = [];

  for (const [agentId, agentChatIds] of agentChatMap) {
    const agentInfo = agentMap.get(agentId);
    if (!agentInfo) continue;

    const agentChats = agentChatIds
      .map((chatId) => {
        const chat = chatMap.get(chatId);
        if (!chat) return null;
        // A chat is supervision-only if the member's human agent is NOT a participant
        // AND the chat is visible only because a managed agent is in it
        const isSupervisionOnly = agentId !== humanAgentId && !humanParticipantChatIds.has(chatId);
        return {
          id: chat.id,
          type: chat.type,
          topic: chat.topic,
          participantCount: chat.participantCount,
          isSupervisionOnly,
          createdAt: chat.createdAt.toISOString(),
          updatedAt: chat.updatedAt.toISOString(),
        };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);

    if (agentChats.length > 0) {
      result.push({ agent: agentInfo, chats: agentChats });
    }
  }

  return result;
}

/**
 * Manager joins a chat. Adds their human agent as a participant.
 * Requires the member to have supervision rights (manages at least one existing participant).
 */
// TODO: getChat is called only for organizationId validation; could be merged
// with the participants query to reduce one DB round-trip
export async function joinChat(db: Database, chatId: string, memberId: string, humanAgentId: string) {
  const chat = await getChat(db, chatId);

  // Check supervision rights: member must manage at least one speaker.
  const speakers = await db
    .select()
    .from(chatMembership)
    .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.accessMode, "speaker")));

  const participantAgentIds = speakers.map((p) => p.agentId);
  if (participantAgentIds.length === 0) {
    throw new NotFoundError("Chat has no participants");
  }

  // Check if already a speaker
  if (participantAgentIds.includes(humanAgentId)) {
    throw new ConflictError("Already a participant in this chat");
  }

  // Verify supervision: at least one participant is managed by this member
  const managedParticipants = await db
    .select({ uuid: agents.uuid })
    .from(agents)
    .where(and(inArray(agents.uuid, participantAgentIds), eq(agents.managerId, memberId)));

  if (managedParticipants.length === 0) {
    throw new ForbiddenError("You can only join chats where you manage at least one participant");
  }

  // Verify human agent belongs to same org as chat
  const [humanAgent] = await db
    .select({ organizationId: agents.organizationId })
    .from(agents)
    .where(eq(agents.uuid, humanAgentId))
    .limit(1);

  if (!humanAgent || humanAgent.organizationId !== chat.organizationId) {
    throw new BadRequestError("Agent does not belong to the same organization as the chat");
  }

  // Human joining a direct chat turns it into a group — existing
  // non-human speakers switch to mention_only so they only respond
  // when explicitly addressed. Atomic: upgrade + UPSERT must not
  // interleave with sendMessage's participant read.
  //
  // If a watcher row already exists for the joining manager (the
  // common case — migration 0030's backfill, or a prior recompute
  // pass), the ON CONFLICT DO UPDATE upgrades it to speaker in
  // place. chat_user_state lives in a separate table by design, so
  // the manager's read state survives the promotion automatically —
  // no state-carry transaction needed.
  await db.transaction(async (tx) => {
    if (wouldUpgradeToGroup(participantAgentIds.length, 1)) {
      await changeChatType(tx, chatId, "group");
    }
    // The join contract admits only the manager's human agent —
    // `assertHuman: true` makes a non-human caller surface as a 400 rather
    // than silently inserting with an inappropriate `mode`.
    // `upgradeWatcherToSpeaker` promotes the manager's pre-existing watcher
    // row in place (common case — migration 0030 or prior recompute pass).
    // chat_user_state is structurally separate so read state survives the
    // promotion automatically.
    await addChatParticipants(tx, chatId, [{ agentId: humanAgentId, role: "member" }], {
      assertHuman: true,
      upgradeWatcherToSpeaker: true,
    });
    await recomputeChatWatchers(tx, chatId);
  });
  invalidateChatAudience(chatId);

  return db
    .select()
    .from(chatMembership)
    .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.accessMode, "speaker")));
}

/**
 * Manager leaves a chat. Removes their human agent from participants.
 * Only allowed if the human agent is a participant.
 *
 * Delegates the participant→watcher transition to `leaveAsParticipant`
 * so admin-side and `/me/chats/:id/leave` share one canonical path. The
 * earlier "recompute then UPDATE-back state" variant violated the design
 * rule that recompute is only for set rebuild — never on a transition
 * path (review #228 issue #2). The returned participant list is fetched
 * after the tx commits, matching the admin route's existing contract.
 */
export async function leaveChat(db: Database, chatId: string, humanAgentId: string) {
  await leaveAsParticipant(db, chatId, humanAgentId);
  invalidateChatAudience(chatId);
  return db
    .select()
    .from(chatMembership)
    .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.accessMode, "speaker")));
}
