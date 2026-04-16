import { randomUUID } from "node:crypto";
import type { AddParticipant, CreateChat } from "@agent-team-foundation/first-tree-hub-shared";
import { and, desc, eq, inArray, lt } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { chatParticipants, chats } from "../db/schema/chats.js";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../errors.js";

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
  await db
    .insert(chatParticipants)
    .values({ chatId, agentId, mode: "full" })
    .onConflictDoNothing({ target: [chatParticipants.chatId, chatParticipants.agentId] });
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

  await db.insert(chatParticipants).values({
    chatId,
    agentId: data.agentId,
    mode: data.mode ?? "full",
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
