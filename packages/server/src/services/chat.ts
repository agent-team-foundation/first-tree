import { randomUUID } from "node:crypto";
import type { AddParticipant, CreateChat } from "@agent-team-foundation/first-tree-hub-shared";
import { and, desc, eq, inArray, lt, ne, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { chatParticipants, chats } from "../db/schema/chats.js";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../errors.js";

/** Structural DB type so both `Database` and transaction clients work. */
type DbLike = Pick<PostgresJsDatabase<Record<string, never>>, "select" | "update">;

/**
 * When a direct chat grows past 2 participants, upgrade it to `group` and
 * flip every existing non-human agent participant to `mention_only` — see
 * proposals/hub-agent-messaging-reply-and-mentions §3.3. The caller is
 * expected to insert the new participant AFTER this runs, so the "existing"
 * set excludes them.
 *
 * Idempotent: if the chat is already a group, no-op.
 */
async function maybeUpgradeDirectToGroup(
  db: DbLike,
  chatId: string,
  existingParticipantIds: string[],
  newParticipantCount: number,
): Promise<void> {
  if (existingParticipantIds.length + newParticipantCount < 3) return;

  const [chat] = await db.select({ type: chats.type }).from(chats).where(eq(chats.id, chatId)).limit(1);
  if (!chat || chat.type !== "direct") return;

  await db.update(chats).set({ type: "group", updatedAt: new Date() }).where(eq(chats.id, chatId));

  if (existingParticipantIds.length === 0) return;
  const nonHumans = await db
    .select({ uuid: agents.uuid })
    .from(agents)
    .where(and(inArray(agents.uuid, existingParticipantIds), ne(agents.type, "human")));
  const ids = nonHumans.map((a) => a.uuid);
  if (ids.length === 0) return;
  await db
    .update(chatParticipants)
    .set({ mode: "mention_only" })
    .where(and(eq(chatParticipants.chatId, chatId), inArray(chatParticipants.agentId, ids)));
}

export async function createChat(db: Database, creatorId: string, data: CreateChat) {
  const chatId = randomUUID();

  // Ensure creator is included in participants
  const allParticipantIds = new Set([creatorId, ...data.participantIds]);

  // Verify all participants exist and belong to the same organization
  const existingAgents = await db
    .select({ id: agents.uuid, organizationId: agents.organizationId })
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

    const participantRows = [...allParticipantIds].map((agentId) => ({
      chatId,
      agentId,
      role: agentId === creatorId ? "owner" : "member",
    }));

    await tx.insert(chatParticipants).values(participantRows);

    const participants = await tx.select().from(chatParticipants).where(eq(chatParticipants.chatId, chatId));

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

export async function getChatDetail(db: Database, chatId: string) {
  const chat = await getChat(db, chatId);
  const participants = await db.select().from(chatParticipants).where(eq(chatParticipants.chatId, chatId));

  return { ...chat, participants };
}

export async function listChats(db: Database, agentId: string, limit: number, cursor?: string) {
  // Find all chat IDs where agent is a participant
  const participantRows = await db
    .select({ chatId: chatParticipants.chatId })
    .from(chatParticipants)
    .where(eq(chatParticipants.agentId, agentId));

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
      agentId: chatParticipants.agentId,
      role: chatParticipants.role,
      mode: chatParticipants.mode,
      joinedAt: chatParticipants.joinedAt,
      name: agents.name,
      displayName: agents.displayName,
      type: agents.type,
    })
    .from(chatParticipants)
    .innerJoin(agents, eq(chatParticipants.agentId, agents.uuid))
    .where(eq(chatParticipants.chatId, chatId));
  return rows;
}

export async function assertParticipant(db: Database, chatId: string, agentId: string): Promise<void> {
  const [row] = await db
    .select({ chatId: chatParticipants.chatId })
    .from(chatParticipants)
    .where(and(eq(chatParticipants.chatId, chatId), eq(chatParticipants.agentId, agentId)))
    .limit(1);

  if (!row) {
    throw new ForbiddenError("Not a participant of this chat");
  }
}

/** Ensure an agent is a participant of a chat. Silently adds them if not already. */
export async function ensureParticipant(db: Database, chatId: string, agentId: string): Promise<void> {
  // Short-circuit if already a participant so we don't spuriously trigger the
  // direct→group upgrade on every admin message in a chat the sender already
  // belongs to. Read outside the transaction — if a race adds this agent
  // concurrently, the onConflictDoNothing inside the transaction is the
  // authoritative dedupe.
  const [existing] = await db
    .select({ agentId: chatParticipants.agentId })
    .from(chatParticipants)
    .where(and(eq(chatParticipants.chatId, chatId), eq(chatParticipants.agentId, agentId)))
    .limit(1);
  if (existing) return;

  // This is a genuine join — apply the same upgrade rule as joinChat /
  // addParticipant. Web-console "start typing in a chat" funnels through
  // here, so missing this call left the proposal's no-echo invariant
  // silently off for UI-initiated joins. Atomic: upgrade + insert must not
  // interleave with sendMessage's participant read.
  await db.transaction(async (tx) => {
    const current = await tx
      .select({ agentId: chatParticipants.agentId })
      .from(chatParticipants)
      .where(eq(chatParticipants.chatId, chatId));
    await maybeUpgradeDirectToGroup(
      tx,
      chatId,
      current.map((p) => p.agentId),
      1,
    );
    await tx
      .insert(chatParticipants)
      .values({ chatId, agentId, mode: "full" })
      .onConflictDoNothing({ target: [chatParticipants.chatId, chatParticipants.agentId] });
  });
}

export async function addParticipant(db: Database, chatId: string, requesterId: string, data: AddParticipant) {
  // Verify chat exists
  const chat = await getChat(db, chatId);

  // Verify requester is a participant
  await assertParticipant(db, chatId, requesterId);

  // Verify target agent exists and is in the same org
  const [targetAgent] = await db
    .select({ id: agents.uuid, organizationId: agents.organizationId })
    .from(agents)
    .where(eq(agents.uuid, data.agentId))
    .limit(1);

  if (!targetAgent) {
    throw new NotFoundError(`Agent "${data.agentId}" not found`);
  }

  if (targetAgent.organizationId !== chat.organizationId) {
    throw new BadRequestError("Cannot add agent from different organization");
  }

  // Check not already a participant
  const [existing] = await db
    .select({ chatId: chatParticipants.chatId })
    .from(chatParticipants)
    .where(and(eq(chatParticipants.chatId, chatId), eq(chatParticipants.agentId, data.agentId)))
    .limit(1);

  if (existing) {
    throw new ConflictError(`Agent "${data.agentId}" is already a participant`);
  }

  // Direct chats become groups on the third participant. Flip existing
  // non-human agents to mention_only so the group doesn't devolve into noise.
  // Atomic: upgrade + insert must not interleave with sendMessage's participant
  // read, or a concurrent send would see chats.type='group' with mode='full'.
  await db.transaction(async (tx) => {
    const currentParticipants = await tx
      .select({ agentId: chatParticipants.agentId })
      .from(chatParticipants)
      .where(eq(chatParticipants.chatId, chatId));
    await maybeUpgradeDirectToGroup(
      tx,
      chatId,
      currentParticipants.map((p) => p.agentId),
      1,
    );
    await tx.insert(chatParticipants).values({
      chatId,
      agentId: data.agentId,
      mode: data.mode ?? "full",
    });
  });

  return db.select().from(chatParticipants).where(eq(chatParticipants.chatId, chatId));
}

export async function removeParticipant(db: Database, chatId: string, requesterId: string, targetAgentId: string) {
  // Verify requester is a participant
  await assertParticipant(db, chatId, requesterId);

  // Cannot remove self (use leave instead, if implemented)
  if (requesterId === targetAgentId) {
    throw new BadRequestError("Cannot remove yourself from a chat");
  }

  const [removed] = await db
    .delete(chatParticipants)
    .where(and(eq(chatParticipants.chatId, chatId), eq(chatParticipants.agentId, targetAgentId)))
    .returning();

  if (!removed) {
    throw new NotFoundError(`Agent "${targetAgentId}" is not a participant of this chat`);
  }

  return db.select().from(chatParticipants).where(eq(chatParticipants.chatId, chatId));
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
  const agentMap = new Map<string, { uuid: string; name: string | null; type: string; displayName: string | null }>();
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

  // Find all chat participations for these agents
  const participations = await db
    .select({
      chatId: chatParticipants.chatId,
      agentId: chatParticipants.agentId,
      role: chatParticipants.role,
      mode: chatParticipants.mode,
    })
    .from(chatParticipants)
    .where(inArray(chatParticipants.agentId, agentIds));

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
      participantCount: sql<number>`(SELECT count(*)::int FROM chat_participants WHERE chat_id = ${chats.id})`,
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
    agent: { uuid: string; name: string | null; type: string; displayName: string | null };
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

  // Check supervision rights: member must manage at least one participant
  const participants = await db.select().from(chatParticipants).where(eq(chatParticipants.chatId, chatId));

  const participantAgentIds = participants.map((p) => p.agentId);
  if (participantAgentIds.length === 0) {
    throw new NotFoundError("Chat has no participants");
  }

  // Check if already a participant
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

  // Human joining a direct chat turns it into a group — existing agent
  // participants (non-human) switch to mention_only so they only respond when
  // explicitly addressed. Atomic: upgrade + insert must not interleave with
  // sendMessage's participant read (mode is part of the mention-filter rule).
  await db.transaction(async (tx) => {
    await maybeUpgradeDirectToGroup(tx, chatId, participantAgentIds, 1);
    await tx.insert(chatParticipants).values({
      chatId,
      agentId: humanAgentId,
      role: "member",
      mode: "full",
    });
  });

  return db.select().from(chatParticipants).where(eq(chatParticipants.chatId, chatId));
}

/**
 * Manager leaves a chat. Removes their human agent from participants.
 * Only allowed if the human agent is a participant.
 */
export async function leaveChat(db: Database, chatId: string, humanAgentId: string) {
  const [removed] = await db
    .delete(chatParticipants)
    .where(and(eq(chatParticipants.chatId, chatId), eq(chatParticipants.agentId, humanAgentId)))
    .returning();

  if (!removed) {
    throw new NotFoundError("Not a participant of this chat");
  }

  return db.select().from(chatParticipants).where(eq(chatParticipants.chatId, chatId));
}

export async function findOrCreateDirectChat(db: Database, agentAId: string, agentBId: string) {
  // Find existing direct chat between the two agents
  const aChats = await db
    .select({ chatId: chatParticipants.chatId })
    .from(chatParticipants)
    .where(eq(chatParticipants.agentId, agentAId));

  const bChats = await db
    .select({ chatId: chatParticipants.chatId })
    .from(chatParticipants)
    .where(eq(chatParticipants.agentId, agentBId));

  const bChatIds = new Set(bChats.map((r) => r.chatId));
  const commonChatIds = aChats.map((r) => r.chatId).filter((id) => bChatIds.has(id));

  if (commonChatIds.length > 0) {
    // Check if any common chat is a direct chat
    const directChats = await db
      .select()
      .from(chats)
      .where(and(inArray(chats.id, commonChatIds), eq(chats.type, "direct")));

    if (directChats.length > 0 && directChats[0]) {
      return directChats[0];
    }
  }

  // Create new direct chat
  const [agentA] = await db
    .select({ organizationId: agents.organizationId })
    .from(agents)
    .where(eq(agents.uuid, agentAId))
    .limit(1);

  if (!agentA) throw new NotFoundError(`Agent "${agentAId}" not found`);

  const chatId = randomUUID();
  return db.transaction(async (tx) => {
    const [chat] = await tx
      .insert(chats)
      .values({
        id: chatId,
        organizationId: agentA.organizationId,
        type: "direct",
      })
      .returning();

    await tx.insert(chatParticipants).values([
      { chatId, agentId: agentAId, role: "member" },
      { chatId, agentId: agentBId, role: "member" },
    ]);

    if (!chat) throw new Error("Unexpected: INSERT RETURNING produced no row");
    return chat;
  });
}
