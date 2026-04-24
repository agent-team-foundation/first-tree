import {
  type ClientMessage,
  type InReplyToSnapshot,
  type Message,
  messageSourceSchema,
  type ParticipantMode,
} from "@agent-team-foundation/first-tree-hub-shared";
import { and, eq, inArray } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { agentConfigs } from "../db/schema/agent-configs.js";
import { agents } from "../db/schema/agents.js";
import { chatParticipants } from "../db/schema/chats.js";
import { messages as messagesTable } from "../db/schema/messages.js";

/**
 * Use a structurally-typed DB so both `Database` and `PgTransaction` from
 * `db.transaction(...)` callbacks are accepted.
 */
type DbLike = Pick<PostgresJsDatabase<Record<string, never>>, "select">;

/** Loose shape for inbound message rows — `source` is plain text in DB. */
type RawMessageRow = Omit<Message, "source" | "configVersion" | "recipientMode" | "inReplyToSnapshot"> & {
  source: string | null;
};

function normaliseSource(source: string | null): Message["source"] {
  if (source === null) return null;
  const parsed = messageSourceSchema.safeParse(source);
  return parsed.success ? parsed.data : null;
}

function normaliseMode(mode: string | null | undefined): ParticipantMode {
  return mode === "mention_only" ? "mention_only" : "full";
}

/**
 * Single entry point for "DB message row → wire payload sent to client runtime".
 *
 * Step 3 (M1 §10 risk 3): every code path that puts a message on the wire to
 * a client must funnel through here so `configVersion` is always present and
 * always reflects the current `agent_configs.version`.
 *
 * Inputs may be either an `inboxId` (HTTP poll path) or an `agentId`
 * (direct-send paths). Both resolve to the same agent-config lookup.
 *
 * `entryChatId` is the chat this payload is routed to on the receiver side
 * — often equal to `message.chatId`, but in `replyTo` routing the original
 * sender may be notified in a *different* chat (see services/message.ts).
 * It drives `recipientMode` lookup from `chat_participants`.
 *
 * Production code should prefer `buildClientMessagePayloadsForInbox` — the
 * single-message variant is kept only because it simplifies the dispatcher
 * unit tests. Each call here issues up to three independent queries
 * (agent-config, participant mode, inReplyTo snapshot), so batching matters
 * for any fan-out sized path.
 */
export type ClientMessagePayloadSource = { kind: "inboxId"; inboxId: string } | { kind: "agentId"; agentId: string };

export async function buildClientMessagePayload(
  db: DbLike,
  source: ClientMessagePayloadSource,
  message: RawMessageRow,
  entryChatId?: string | null,
): Promise<ClientMessage> {
  const agentId = await resolveAgentId(db, source);
  const [cfg] = await db
    .select({ version: agentConfigs.version })
    .from(agentConfigs)
    .where(eq(agentConfigs.agentId, agentId))
    .limit(1);
  // Step 1's seeding guarantees every non-deleted agent has a row; if a
  // bind happens for a deleted agent we still degrade to v=1 rather than
  // throwing — the auth layer would reject the agent first.
  const version = cfg?.version ?? 1;

  const chatForMode = entryChatId ?? message.chatId;
  const recipientMode = await resolveRecipientMode(db, agentId, chatForMode);
  const inReplyToSnapshot = await resolveInReplyToSnapshot(db, message.inReplyTo);

  return {
    id: message.id,
    chatId: message.chatId,
    senderId: message.senderId,
    format: message.format,
    content: message.content,
    metadata: message.metadata,
    replyToInbox: message.replyToInbox,
    replyToChat: message.replyToChat,
    inReplyTo: message.inReplyTo,
    source: normaliseSource(message.source),
    createdAt: message.createdAt,
    configVersion: version,
    recipientMode,
    inReplyToSnapshot,
  };
}

export type MessageForInbox = { entryChatId: string | null; message: RawMessageRow };

/**
 * Batch variant — builds all payloads with a single DB lookup per agent plus
 * batched lookups for participant modes and inReplyTo snapshots.
 */
export async function buildClientMessagePayloadsForInbox(
  db: DbLike,
  inboxId: string,
  items: MessageForInbox[],
): Promise<ClientMessage[]> {
  if (items.length === 0) return [];
  const agentId = await resolveAgentId(db, { kind: "inboxId", inboxId });
  const [cfg] = await db
    .select({ version: agentConfigs.version })
    .from(agentConfigs)
    .where(eq(agentConfigs.agentId, agentId))
    .limit(1);
  const version = cfg?.version ?? 1;

  // Batch: participant modes for each unique chatId the recipient is dispatched into.
  const chatIds = [
    ...new Set(items.map((it) => it.entryChatId ?? it.message.chatId).filter((id): id is string => id !== null)),
  ];
  const modeByChat = new Map<string, ParticipantMode>();
  if (chatIds.length > 0) {
    const rows = await db
      .select({ chatId: chatParticipants.chatId, mode: chatParticipants.mode })
      .from(chatParticipants)
      .where(and(eq(chatParticipants.agentId, agentId), inArray(chatParticipants.chatId, chatIds)));
    for (const r of rows) modeByChat.set(r.chatId, normaliseMode(r.mode));
  }

  // Batch: inReplyTo snapshots for all messages that carry one.
  const inReplyToIds = [...new Set(items.map((it) => it.message.inReplyTo).filter((id): id is string => id !== null))];
  const snapshotById = new Map<string, NonNullable<InReplyToSnapshot>>();
  if (inReplyToIds.length > 0) {
    const origs = await db
      .select({
        id: messagesTable.id,
        senderId: messagesTable.senderId,
        chatId: messagesTable.chatId,
        replyToChat: messagesTable.replyToChat,
      })
      .from(messagesTable)
      .where(inArray(messagesTable.id, inReplyToIds));
    for (const o of origs) {
      snapshotById.set(o.id, { senderId: o.senderId, chatId: o.chatId, replyToChat: o.replyToChat });
    }
  }

  return items.map(({ entryChatId, message: m }) => ({
    id: m.id,
    chatId: m.chatId,
    senderId: m.senderId,
    format: m.format,
    content: m.content,
    metadata: m.metadata,
    replyToInbox: m.replyToInbox,
    replyToChat: m.replyToChat,
    inReplyTo: m.inReplyTo,
    source: normaliseSource(m.source),
    createdAt: m.createdAt,
    configVersion: version,
    recipientMode: modeByChat.get(entryChatId ?? m.chatId) ?? "full",
    inReplyToSnapshot: m.inReplyTo ? (snapshotById.get(m.inReplyTo) ?? null) : null,
  }));
}

async function resolveRecipientMode(db: DbLike, agentId: string, chatId: string): Promise<ParticipantMode> {
  const [row] = await db
    .select({ mode: chatParticipants.mode })
    .from(chatParticipants)
    .where(and(eq(chatParticipants.agentId, agentId), eq(chatParticipants.chatId, chatId)))
    .limit(1);
  return normaliseMode(row?.mode);
}

async function resolveInReplyToSnapshot(db: DbLike, inReplyTo: string | null): Promise<InReplyToSnapshot> {
  if (!inReplyTo) return null;
  const [row] = await db
    .select({
      senderId: messagesTable.senderId,
      chatId: messagesTable.chatId,
      replyToChat: messagesTable.replyToChat,
    })
    .from(messagesTable)
    .where(eq(messagesTable.id, inReplyTo))
    .limit(1);
  if (!row) return null;
  return { senderId: row.senderId, chatId: row.chatId, replyToChat: row.replyToChat };
}

async function resolveAgentId(db: DbLike, source: ClientMessagePayloadSource): Promise<string> {
  if (source.kind === "agentId") return source.agentId;
  const [agent] = await db
    .select({ uuid: agents.uuid })
    .from(agents)
    .where(eq(agents.inboxId, source.inboxId))
    .limit(1);
  if (!agent) {
    throw new Error(`No agent owns inbox "${source.inboxId}"`);
  }
  return agent.uuid;
}
