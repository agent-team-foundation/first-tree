import { randomUUID } from "node:crypto";
import type { AddParticipant, CreateChat } from "@first-tree/shared";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chats } from "../db/schema/chats.js";
import { messages } from "../db/schema/messages.js";
import { BadRequestError, ForbiddenError, NotFoundError } from "../errors.js";
import { agentAvatarImageUrl } from "./agent.js";
import { invalidateChatAudience } from "./chat-audience-cache.js";
import { resolveChatTitle } from "./me-chat.js";
import { WIRE_RECIPIENT_MODE } from "./message-dispatcher.js";
import { inviteParticipantsToChat, rejectedPrivateTargets } from "./participant-invite.js";
import { addChatParticipants, applyMembershipWrite, recomputeChatWatchers } from "./participant-mode.js";
import { extractSummary } from "./session.js";
import { leaveAsParticipant } from "./watcher.js";

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

  // Strict owner-exclusive rule for private targets (RFC §4.5): only
  // the human-agent manager of a private target may bring it into a
  // chat. Even a manager's own public agent / other private agents
  // CANNOT pull a sibling private agent in — that path is the social-
  // engineering hole the strict reading closes. Self-add (`a.id ===
  // creatorId`) is exempt; we filter the creator out of the target
  // set before running the check so a private agent legitimately
  // creating a chat with itself as a participant isn't tripped up.
  //
  // The predicate lives in `participant-invite.ts::rejectedPrivateTargets`
  // alongside the Layer-2 invite gate so the invariant has exactly one
  // source of truth (PR #550 collapsed the duplicate writers; this
  // mirrors the same "one rule, one home" discipline for the create
  // path).
  const targetsForGate = existingAgents
    .filter((a) => a.id !== creatorId)
    .map((a) => ({ uuid: a.id, visibility: a.visibility, managerId: a.managerId }));
  const rejectedTargets = rejectedPrivateTargets(
    { agentId: creator.id, memberId: creator.managerId, type: creator.type },
    targetsForGate,
  );
  if (rejectedTargets.length > 0) {
    throw new ForbiddenError(
      `Only the human owner can add a private agent to a chat: ${rejectedTargets.map((t) => t.uuid).join(", ")}`,
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
    // single authoritative encoder. The helper also encloses the watcher
    // recompute (so every active manager whose managed non-human agent is
    // now in the chat lands in the "Watching" set) and the silent-context
    // backfill (no-op here because the chat has no messages yet). Do NOT
    // pass `mode` and do NOT call `recomputeChatWatchers` again.
    await addChatParticipants(
      tx,
      chatId,
      [...allParticipantIds].map((agentId) => ({
        agentId,
        role: agentId === creatorId ? "owner" : "member",
      })),
    );

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
  // v2: chat_membership.mode is decision-inert; the wire `mode` field is
  // populated below from the WIRE_RECIPIENT_MODE constant (mirrors the
  // strategy in services/message-dispatcher.ts), so we no longer SELECT
  // the column. Drop together with the wire field in v3 — see
  // proposals/hub-chat-message-v2-simplify-mode.20260520.md §七.
  const participantRows = await db
    .select({
      agentId: chatMembership.agentId,
      role: chatMembership.role,
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
    // v2: wire `mode` is reserved for v3 cleanup; write the constant
    // `WIRE_RECIPIENT_MODE` so existing clients that still parse the field
    // see a stable value. No consumer reads this today.
    mode: WIRE_RECIPIENT_MODE,
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
  // v2: chat_membership.mode is decision-inert; we no longer SELECT it. The
  // route layer projects the wire `mode` field from the WIRE_RECIPIENT_MODE
  // constant — see api/agent/chats.ts. Drop together with the wire field
  // in v3 (proposals/hub-chat-message-v2-simplify-mode.20260520.md §七).
  const rows = await db
    .select({
      agentId: chatMembership.agentId,
      role: chatMembership.role,
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
 * Non-throwing membership check. Used by callers that need a boolean
 * "is this agent a speaker of this chat?" answer without raising.
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

/**
 * Idempotent "ensure this agent is a speaker of this chat" admit.
 *
 * **Caller-responsibility contract — read before using.** This helper does
 * NO authorisation. It is a Layer-1.5 wrapper for `applyMembershipWrite`
 * whose only job is the short-circuit "already a speaker → return without
 * opening a tx". Use it only when the caller has already verified that the
 * given agent has a legitimate reason to be in the chat. The two legitimate
 * callers today are:
 *
 *   1. `adapter-mapping.ts` (Feishu/Slack bridge) — IM platform has already
 *      authenticated the sender / bot. The hub side has no separate notion
 *      of "did this user choose to enter the chat" — joining is implicit by
 *      sending a message on the platform.
 *   2. `api/chats.ts` HTTP message + question-answer routes — the `scope`
 *      middleware has already gated the request through `requireChatAccess`
 *      before reaching the handler that calls this.
 *
 * Do NOT call this from new code paths to "lightly join" an agent — for
 * speaker-invokes-invite use `inviteParticipantsToChat`; for manager
 * self-join use `joinAsParticipant`. Adding a new legitimate caller? Append
 * it to the list above and document the external authorisation step in your
 * PR — reviewers should see it.
 *
 * Behaviour:
 *   - If already a speaker → 1-SELECT short-circuit, no tx opened. This is
 *     the hot path for the IM bridge (every inbound message hits this).
 *   - Otherwise → `applyMembershipWrite`, which encloses backfill, watcher
 *     recompute, and post-commit audience invalidation.
 */
export async function ensureParticipant(db: Database, chatId: string, agentId: string): Promise<void> {
  // Short-circuit if already a speaker. Read outside the tx — if a race
  // adds this agent concurrently, the UPSERT inside `applyMembershipWrite`
  // is the authoritative dedupe.
  const [existing] = await db
    .select({ accessMode: chatMembership.accessMode })
    .from(chatMembership)
    .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.agentId, agentId)))
    .limit(1);
  if (existing?.accessMode === "speaker") return;

  await applyMembershipWrite(db, chatId, [{ agentId }], { upgradeWatcherToSpeaker: true });
}

/**
 * Agent-JWT entrypoint: `POST /agent/.../chats/:id/participants`.
 *
 * Thin shell over `inviteParticipantsToChat`:
 *   1. Resolve the wire target (by uuid OR by name) to a uuid — name lookup
 *      is the only Layer-3 surface specific to this entrypoint.
 *   2. Delegate to the invite service with `errorOnAlreadySpeaker: true`
 *      (agent-SDK contract: already-in is a 409, not a silent skip).
 *   3. Return the resulting speaker list (the wire shape this entrypoint
 *      has always returned).
 */
export async function addParticipant(db: Database, chatId: string, requesterId: string, data: AddParticipant) {
  // Resolve the wire target. Name lookup is scoped to the chat's
  // organization so an agent in another org can never be pulled in by name
  // collision. Resolving in the shell (vs. inside the invite service) keeps
  // the Layer-2 contract uniform on uuid inputs.
  const chat = await getChat(db, chatId);
  const targetSelector = data.agentId
    ? eq(agents.uuid, data.agentId)
    : and(eq(agents.organizationId, chat.organizationId), eq(agents.name, data.agentName ?? ""));
  const [targetAgent] = await db.select({ id: agents.uuid }).from(agents).where(targetSelector).limit(1);
  if (!targetAgent) {
    const ref = data.agentId ?? data.agentName ?? "(unknown)";
    throw new NotFoundError(`Agent "${ref}" not found`);
  }

  await inviteParticipantsToChat(db, {
    chatId,
    callerAgentId: requesterId,
    targetAgentIds: [targetAgent.id],
    errorOnAlreadySpeaker: true,
  });

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
 * Manager leaves a chat. Removes their human agent from participants.
 * Only allowed if the human agent is a participant.
 *
 * Delegates the participant→watcher transition to `leaveAsParticipant`
 * so admin-side and `/me/chats/:id/leave` share one canonical path. The
 * earlier "recompute then UPDATE-back state" variant violated the design
 * rule that recompute is only for set rebuild — never on a transition
 * path (review #228 issue #2). The returned participant list is fetched
 * after the tx commits, matching the admin route's existing contract.
 *
 * `leaveAsParticipant` itself runs the post-commit `invalidateChatAudience`,
 * so this shell doesn't need to.
 */
export async function leaveChat(db: Database, chatId: string, humanAgentId: string) {
  await leaveAsParticipant(db, chatId, humanAgentId);
  return db
    .select()
    .from(chatMembership)
    .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.accessMode, "speaker")));
}
