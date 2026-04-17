import { type ClientMessage, type Message, messageSourceSchema } from "@agent-team-foundation/first-tree-hub-shared";
import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { agentConfigs } from "../db/schema/agent-configs.js";
import { agents } from "../db/schema/agents.js";

/**
 * Use a structurally-typed DB so both `Database` and `PgTransaction` from
 * `db.transaction(...)` callbacks are accepted.
 */
type DbLike = Pick<PostgresJsDatabase<Record<string, never>>, "select">;

/** Loose shape for inbound message rows — `source` is plain text in DB. */
type RawMessageRow = Omit<Message, "source" | "configVersion"> & { source: string | null };

function normaliseSource(source: string | null): Message["source"] {
  if (source === null) return null;
  const parsed = messageSourceSchema.safeParse(source);
  return parsed.success ? parsed.data : null;
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
 */
export type ClientMessagePayloadSource = { kind: "inboxId"; inboxId: string } | { kind: "agentId"; agentId: string };

export async function buildClientMessagePayload(
  db: DbLike,
  source: ClientMessagePayloadSource,
  message: RawMessageRow,
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
    replyToInbox: message.replyToInbox,
    replyToChat: message.replyToChat,
    inReplyTo: message.inReplyTo,
    source: normaliseSource(message.source),
    createdAt: message.createdAt,
    configVersion: version,
  };
}

/**
 * Batch variant — builds all payloads with a single DB lookup per agent.
 * Use this from `pollInbox` to avoid an N+1 against `agent_configs`.
 */
export async function buildClientMessagePayloadsForInbox(
  db: DbLike,
  inboxId: string,
  messages: RawMessageRow[],
): Promise<ClientMessage[]> {
  if (messages.length === 0) return [];
  const agentId = await resolveAgentId(db, { kind: "inboxId", inboxId });
  const [cfg] = await db
    .select({ version: agentConfigs.version })
    .from(agentConfigs)
    .where(eq(agentConfigs.agentId, agentId))
    .limit(1);
  const version = cfg?.version ?? 1;
  return messages.map((m) => ({
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
