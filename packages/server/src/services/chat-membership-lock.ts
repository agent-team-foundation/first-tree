import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chats } from "../db/schema/chats.js";

// biome-ignore lint/suspicious/noExplicitAny: accepts both the root database and transaction clients
type DbLike = PgDatabase<PgQueryResultHKT, any, any>;

export type LockedChatSpeaker = {
  chatId: string;
  agentId: string;
  organizationId: string;
  type: string;
  status: string;
  managerId: string;
  delegateMention: string | null;
};

export type LockedChatSpeakerSnapshot = {
  chats: Array<{ id: string; organizationId: string }>;
  speakers: LockedChatSpeaker[];
};

export type LockedChatSpeakerAndAgentSnapshot = LockedChatSpeakerSnapshot & {
  agents: Omit<LockedChatSpeaker, "chatId">[];
};

/**
 * Serialize every speaker insert, delete, downgrade, and routing snapshot for
 * one chat. The transaction advisory lock also covers a not-yet-existing
 * membership row, which a row-level lock alone cannot protect.
 */
export async function lockChatMembershipMutation(db: DbLike, chatIds: ReadonlyArray<string>): Promise<void> {
  const stableChatIds = [...new Set(chatIds)].sort();
  for (const chatId of stableChatIds) {
    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext('chat_speaker_membership'), hashtext(${chatId}))`);
  }
}

/**
 * Lock a stable speaker/owner snapshot after taking the shared membership
 * mutation fence. Agent rows are locked separately so manager transfers and
 * status/delegate changes cannot invalidate owner or wake authority before
 * the enclosing transaction commits.
 */
export async function lockChatSpeakerSnapshot(
  db: DbLike,
  chatIds: ReadonlyArray<string>,
): Promise<LockedChatSpeakerSnapshot> {
  const snapshot = await lockChatSpeakerAndAgentSnapshot(db, chatIds, []);
  return { chats: snapshot.chats, speakers: snapshot.speakers };
}

/**
 * Lock candidate speakers and additional authority agents as one UUID-sorted
 * set. Callers that already hold required member rows can use this to avoid
 * taking a pair lock first and expanding it later to overlapping chat
 * speakers, which would permit cross-chat deadlocks.
 */
export async function lockChatSpeakerAndAgentSnapshot(
  db: DbLike,
  chatIds: ReadonlyArray<string>,
  additionalAgentIds: ReadonlyArray<string>,
): Promise<LockedChatSpeakerAndAgentSnapshot> {
  const stableChatIds = [...new Set(chatIds)].sort();
  if (stableChatIds.length > 0) await lockChatMembershipMutation(db, stableChatIds);

  const chatRows =
    stableChatIds.length === 0
      ? []
      : await db
          .select({ id: chats.id, organizationId: chats.organizationId })
          .from(chats)
          .where(inArray(chats.id, stableChatIds))
          .orderBy(asc(chats.id))
          .for("update");
  const membershipRows =
    stableChatIds.length === 0
      ? []
      : await db
          .select({ chatId: chatMembership.chatId, agentId: chatMembership.agentId })
          .from(chatMembership)
          .where(and(inArray(chatMembership.chatId, stableChatIds), eq(chatMembership.accessMode, "speaker")))
          .orderBy(asc(chatMembership.chatId), asc(chatMembership.agentId))
          .for("update");
  const agentIds = [...new Set([...membershipRows.map((row) => row.agentId), ...additionalAgentIds])].sort();
  if (agentIds.length === 0) return { chats: chatRows, speakers: [], agents: [] };
  const agentRows = await db
    .select({
      agentId: agents.uuid,
      organizationId: agents.organizationId,
      type: agents.type,
      status: agents.status,
      managerId: agents.managerId,
      delegateMention: agents.delegateMention,
    })
    .from(agents)
    .where(inArray(agents.uuid, agentIds))
    .orderBy(asc(agents.uuid))
    .for("update");
  const agentById = new Map(agentRows.map((row) => [row.agentId, row]));
  const speakers = membershipRows.flatMap((membership) => {
    const agent = agentById.get(membership.agentId);
    return agent ? [{ chatId: membership.chatId, ...agent }] : [];
  });
  return { chats: chatRows, speakers, agents: agentRows };
}
