import {
  type ClientMessage,
  type Message,
  messageSourceSchema,
  type ParticipantMode,
  type PrecedingMessage,
} from "@agent-team-foundation/first-tree-hub-shared";
import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { agentConfigs } from "../db/schema/agent-configs.js";
import { agents } from "../db/schema/agents.js";

/**
 * Use a structurally-typed DB so both `Database` and `PgTransaction` from
 * `db.transaction(...)` callbacks are accepted.
 */
type DbLike = Pick<PostgresJsDatabase<Record<string, never>>, "select">;

/**
 * Loose shape for inbound message rows. `source` is plain text in DB and may
 * be NULL on rows that pre-date migration 0047 (where the column was made
 * NOT NULL); we still normalise defensively below in case an older replica
 * lags or a test fixture seeds an unbounded row.
 */
type RawMessageRow = Omit<Message, "source" | "configVersion" | "recipientMode"> & {
  source: string | null;
};

function normaliseSource(source: string | null): Message["source"] {
  if (source === null) return null;
  const parsed = messageSourceSchema.safeParse(source);
  return parsed.success ? parsed.data : null;
}

/**
 * v2: chat_membership.mode is decision-inert. The wire field `recipientMode`
 * (and the parallel `mode` field on chat-detail / participant payloads) is
 * retained on the protocol for backwards compatibility with already-deployed
 * client runtimes — server writes the constant `"mention_only"` and every
 * consumer ignores it. Drop together with the DB column once all clients are
 * on a post-v2 release (see proposals/hub-chat-message-v2-simplify-mode.20260520.md §七).
 *
 * Exported so chat-detail / participant-list wire-payload builders in
 * `services/chat.ts` + `api/chats.ts` use the same constant and the v3
 * cleanup is one grep away.
 */
export const WIRE_RECIPIENT_MODE: ParticipantMode = "mention_only";

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
 * — typically equal to `message.chatId`. v2 made `recipientMode` a constant
 * wire value (decision-inert), so the parameter is currently unused but
 * retained on the signature for downstream parity / future re-use.
 *
 * Production code should prefer `buildClientMessagePayloadsForInbox` — the
 * single-message variant is kept only because it simplifies the dispatcher
 * unit tests. Each call here issues one independent query (agent-config),
 * so batching still matters for any fan-out sized path; v2 retired the
 * separate chat_membership.mode lookup that used to be the second query.
 */
export type ClientMessagePayloadSource = { kind: "inboxId"; inboxId: string } | { kind: "agentId"; agentId: string };

export async function buildClientMessagePayload(
  db: DbLike,
  source: ClientMessagePayloadSource,
  message: RawMessageRow,
  _entryChatId?: string | null,
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
    recipientMode: WIRE_RECIPIENT_MODE,
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
 * Batch variant — builds all payloads with a single DB lookup per agent.
 * v2 dropped the chat_membership.mode batched lookup; every payload's
 * `recipientMode` is the constant wire value.
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

  return items.map(({ message: m, precedingMessages = [] }) => ({
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
    recipientMode: WIRE_RECIPIENT_MODE,
    precedingMessages,
  }));
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
