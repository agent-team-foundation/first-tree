import {
  type ClientMessage,
  type Message,
  messageSourceSchema,
  type ParticipantMode,
  type PrecedingMessage,
} from "@agent-team-foundation/first-tree-hub-shared";
import { and, eq, inArray } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { agentConfigs } from "../db/schema/agent-configs.js";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";

/**
 * Use a structurally-typed DB so both `Database` and `PgTransaction` from
 * `db.transaction(...)` callbacks are accepted.
 */
type DbLike = Pick<PostgresJsDatabase<Record<string, never>>, "select">;

/** Loose shape for inbound message rows — `source` is plain text in DB. */
type RawMessageRow = Omit<Message, "source" | "configVersion" | "recipientMode"> & {
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
 * Inputs may be either an `inboxId` (inbox claim paths — push and the debug
 * `GET /inbox`) or an `agentId` (direct-send paths). Both resolve to the
 * same agent-config lookup.
 *
 * `entryChatId` is the chat this payload is routed to on the receiver side
 * — typically equal to `message.chatId`. It drives `recipientMode` lookup
 * from `chat_membership` (speaker rows).
 *
 * Production code should prefer `buildClientMessagePayloadsForInbox` — the
 * single-message variant is kept only because it simplifies the dispatcher
 * unit tests. Each call here issues up to two independent queries
 * (agent-config, participant mode), so batching matters for any fan-out
 * sized path.
 */
export type ClientMessagePayloadSource = { kind: "inboxId"; inboxId: string } | { kind: "agentId"; agentId: string };

export async function buildClientMessagePayload(
  db: DbLike,
  source: ClientMessagePayloadSource,
  message: RawMessageRow,
  entryChatId?: string | null,
  precedingMessages: PrecedingMessage[] = [],
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

  return {
    id: message.id,
    chatId: message.chatId,
    senderId: message.senderId,
    format: message.format,
    content: message.content,
    metadata: message.metadata,
    inReplyTo: message.inReplyTo,
    source: normaliseSource(message.source),
    createdAt: message.createdAt,
    configVersion: version,
    recipientMode,
    precedingMessages,
  };
}

export type MessageForInbox = {
  entryChatId: string | null;
  message: RawMessageRow;
  /** Group-chat context the recipient missed (silent inbox). Empty by default. */
  precedingMessages?: PrecedingMessage[];
};

/**
 * Batch variant — builds all payloads with a single DB lookup per agent plus
 * a batched lookup for participant modes.
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
      .select({ chatId: chatMembership.chatId, mode: chatMembership.mode })
      .from(chatMembership)
      .where(
        and(
          eq(chatMembership.agentId, agentId),
          inArray(chatMembership.chatId, chatIds),
          eq(chatMembership.accessMode, "speaker"),
        ),
      );
    for (const r of rows) modeByChat.set(r.chatId, normaliseMode(r.mode));
  }

  return items.map(({ entryChatId, message: m, precedingMessages = [] }) => ({
    id: m.id,
    chatId: m.chatId,
    senderId: m.senderId,
    format: m.format,
    content: m.content,
    metadata: m.metadata,
    inReplyTo: m.inReplyTo,
    source: normaliseSource(m.source),
    createdAt: m.createdAt,
    configVersion: version,
    recipientMode: modeByChat.get(entryChatId ?? m.chatId) ?? "full",
    precedingMessages,
  }));
}

async function resolveRecipientMode(db: DbLike, agentId: string, chatId: string): Promise<ParticipantMode> {
  const [row] = await db
    .select({ mode: chatMembership.mode })
    .from(chatMembership)
    .where(
      and(
        eq(chatMembership.agentId, agentId),
        eq(chatMembership.chatId, chatId),
        eq(chatMembership.accessMode, "speaker"),
      ),
    )
    .limit(1);
  return normaliseMode(row?.mode);
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
