import type {
  Attention,
  AttentionMetadata,
  AttentionState,
  ListAttentionsQuery,
  RaiseAttentionInput,
  RespondAttentionInput,
} from "@first-tree/shared";
import { AGENT_TYPES } from "@first-tree/shared";
import { and, desc, eq, inArray, or, type SQL } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { attentions } from "../db/schema/attentions.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chats } from "../db/schema/chats.js";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../errors.js";
import { createLogger } from "../observability/index.js";
import { uuidv7 } from "../uuid.js";

/**
 * NHA M1 末 (Need Human Attention) — service layer.
 *
 * Hosts the attention primitive's invariants (chat-membership, target-is-
 * human, single-target, only-target-responds, only-origin-cancels,
 * closed-is-immutable) per the design comments in
 * `packages/shared/src/schemas/attention.ts`. The DDL is FK-free per the
 * "integrity in service layer" convention; every constraint we care about
 * lives here.
 */

const log = createLogger("attention");

type AttentionRow = typeof attentions.$inferSelect;

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

function isAttentionState(s: string): s is AttentionState {
  return s === "open" || s === "closed";
}

/**
 * Row → wire record. Timestamps become ISO strings; the metadata JSONB is
 * already an `AttentionMetadata`-shaped record (writes go through the
 * service so the shape is service-controlled).
 */
function toWireRecord(row: AttentionRow): Attention {
  const state: AttentionState = isAttentionState(row.state) ? row.state : "open";
  return {
    id: row.id,
    originAgentId: row.originAgentId,
    originChatId: row.originChatId,
    targetHumanId: row.targetHumanId,
    subject: row.subject,
    body: row.body,
    requiresResponse: row.requiresResponse,
    state,
    response: row.response,
    respondedBy: row.respondedBy,
    respondedAt: row.respondedAt ? row.respondedAt.toISOString() : null,
    cancelled: row.cancelled,
    cancelledReason: row.cancelledReason,
    metadata: row.metadata,
    createdAt: row.createdAt.toISOString(),
    closedAt: row.closedAt ? row.closedAt.toISOString() : null,
  };
}

async function loadAttentionOrThrow(db: Database, id: string): Promise<AttentionRow> {
  const [row] = await db.select().from(attentions).where(eq(attentions.id, id)).limit(1);
  if (!row) throw new NotFoundError(`Attention "${id}" not found`);
  return row;
}

/**
 * Check whether `agentId` is a speaker of `chatId`. Speaker is the
 * authoritative membership signal used everywhere else in the chat
 * stack (watchers do not "see" the chat for write-side gates). See
 * `services/chat.ts::isParticipant` for the canonical predicate.
 */
async function isSpeaker(db: Database, chatId: string, agentId: string): Promise<boolean> {
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
 * `POST /attention` — raise a new Attention. Validates every invariant
 * before INSERT: origin must be a speaker of `chatId`, target must be a
 * `human`-typed agent and a member of `chatId`. Notifications
 * (`requiresResponse=false`) land in the closed state immediately so they
 * never occupy the "needs your reply" queue.
 */
export async function raiseAttention(
  db: Database,
  callerAgentId: string,
  input: RaiseAttentionInput,
): Promise<Attention> {
  const { chatId, target, subject, body, requiresResponse, metadata } = input;

  // 1. Chat must exist.
  const [chat] = await db.select({ id: chats.id }).from(chats).where(eq(chats.id, chatId)).limit(1);
  if (!chat) throw new NotFoundError(`Chat "${chatId}" not found`);

  // 2. Caller agent must be a speaker of this chat.
  if (!(await isSpeaker(db, chatId, callerAgentId))) {
    throw new ForbiddenError("Caller is not a speaker of this chat");
  }

  // 3. Target agent must exist and be type=human.
  const [targetAgent] = await db
    .select({ uuid: agents.uuid, type: agents.type })
    .from(agents)
    .where(eq(agents.uuid, target))
    .limit(1);
  if (!targetAgent) {
    throw new BadRequestError(`Target agent "${target}" not found`);
  }
  if (targetAgent.type !== AGENT_TYPES.HUMAN) {
    throw new BadRequestError(
      `Target agent "${target}" is not a human (type="${targetAgent.type}"); attentions only fire at humans.`,
    );
  }

  // 4. Target must be a member of origin_chat. 409 + hint matches the
  // shared-schema doc comment.
  if (!(await isSpeaker(db, chatId, target))) {
    throw new ConflictError(
      `Target human "${target}" is not a member of chat "${chatId}". ` +
        "Add them first:\n" +
        "  first-tree chat invite <name>\n" +
        "Then re-raise the attention.",
    );
  }

  const now = new Date();
  const closed = !requiresResponse;
  const id = uuidv7();

  const [inserted] = await db
    .insert(attentions)
    .values({
      id,
      originAgentId: callerAgentId,
      originChatId: chatId,
      targetHumanId: target,
      subject,
      body,
      requiresResponse,
      state: closed ? "closed" : "open",
      metadata: metadata as AttentionMetadata,
      createdAt: now,
      closedAt: closed ? now : null,
    })
    .returning();

  if (!inserted) throw new Error("Unexpected: INSERT RETURNING produced no row");
  log.info(
    {
      attentionId: id,
      chatId,
      originAgentId: callerAgentId,
      targetHumanId: target,
      requiresResponse,
    },
    "attention raised",
  );
  return toWireRecord(inserted);
}

/**
 * `POST /attention/:id/respond` — human answers an open Attention. Only
 * the named target can respond; closed records are immutable. When `text`
 * is absent we stringify `answers` into the stored response so the column
 * stays a single text field (the structured payload is preserved verbatim
 * — the wire schema deliberately does not enforce its shape).
 */
export async function respondAttention(
  db: Database,
  callerHumanId: string,
  attentionId: string,
  input: RespondAttentionInput,
): Promise<Attention> {
  const row = await loadAttentionOrThrow(db, attentionId);

  if (row.targetHumanId !== callerHumanId) {
    throw new ForbiddenError("Only the target human may respond to this attention");
  }
  if (row.state === "closed") {
    throw new ConflictError(`Attention "${attentionId}" is already closed`);
  }

  const responseText =
    typeof input.text === "string" && input.text.length > 0 ? input.text : JSON.stringify(input.answers ?? {});
  const now = new Date();

  const [updated] = await db
    .update(attentions)
    .set({
      response: responseText,
      respondedBy: callerHumanId,
      respondedAt: now,
      state: "closed",
      closedAt: now,
    })
    .where(eq(attentions.id, attentionId))
    .returning();
  if (!updated) throw new Error("Unexpected: UPDATE RETURNING produced no row");

  log.info(
    {
      attentionId,
      respondedBy: callerHumanId,
      originAgentId: row.originAgentId,
      chatId: row.originChatId,
    },
    "attention responded",
  );
  return toWireRecord(updated);
}

/**
 * `POST /attention/:id/cancel` — origin agent withdraws an open
 * Attention. Only the origin can cancel; closed records are immutable.
 * Modification flow per the design comment is cancel + raise — there is
 * no in-place edit.
 */
export async function cancelAttention(
  db: Database,
  callerAgentId: string,
  attentionId: string,
  reason: string | null,
): Promise<Attention> {
  const row = await loadAttentionOrThrow(db, attentionId);

  if (row.originAgentId !== callerAgentId) {
    throw new ForbiddenError("Only the origin agent may cancel this attention");
  }
  if (row.state === "closed") {
    throw new ConflictError(`Attention "${attentionId}" is already closed`);
  }

  const now = new Date();
  const [updated] = await db
    .update(attentions)
    .set({
      state: "closed",
      cancelled: true,
      cancelledReason: reason,
      closedAt: now,
    })
    .where(eq(attentions.id, attentionId))
    .returning();
  if (!updated) throw new Error("Unexpected: UPDATE RETURNING produced no row");

  log.info(
    {
      attentionId,
      originAgentId: callerAgentId,
      chatId: row.originChatId,
      reason,
    },
    "attention cancelled",
  );
  return toWireRecord(updated);
}

/** Show a single Attention by id. Visibility is enforced by the caller. */
export async function getAttention(db: Database, id: string): Promise<Attention | null> {
  const [row] = await db.select().from(attentions).where(eq(attentions.id, id)).limit(1);
  return row ? toWireRecord(row) : null;
}

/**
 * Caller identity used by `listAttentions`. Humans see attentions
 * targeted at them OR raised in any chat they're a speaker of. Agents
 * see only attentions they raised themselves (their own audit trail).
 */
export type AttentionCaller = {
  agentId: string;
  isHuman: boolean;
};

/**
 * `GET /attention?filter…` — visibility-scoped list. Default state
 * filter is "open"; "all" disables the state filter. Order is newest
 * first; limit clamped to [1, 200] (default 50).
 *
 * Filters (target/chat/agent) intersect with the scoping: a caller can
 * narrow the result set with a filter, but cannot widen it past their
 * scope.
 */
export async function listAttentions(
  db: Database,
  caller: AttentionCaller,
  filter: ListAttentionsQuery,
): Promise<Attention[]> {
  const limit = Math.min(Math.max(filter.limit ?? DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);

  // Visibility scope. The two branches produce disjoint id-sets; we
  // resolve them up-front so the SQL WHERE stays expressible as
  // straightforward equality / inArray clauses.
  let scopedChatIds: string[] | null = null;
  if (caller.isHuman) {
    const memberRows = await db
      .select({ chatId: chatMembership.chatId })
      .from(chatMembership)
      .where(and(eq(chatMembership.agentId, caller.agentId), eq(chatMembership.accessMode, "speaker")));
    scopedChatIds = memberRows.map((r) => r.chatId);
  }

  // Build the visibility WHERE in a single pass. Humans: target == me
  // OR chat IN scopedChatIds (drizzle's `or` short-circuits to undefined
  // on a single arm, so we guard the empty-chat case explicitly).
  // Agents: origin == me.
  const conditions: SQL[] = [];
  if (caller.isHuman) {
    const hasScopedChats = scopedChatIds !== null && scopedChatIds.length > 0;
    if (hasScopedChats && scopedChatIds) {
      const pred = or(eq(attentions.targetHumanId, caller.agentId), inArray(attentions.originChatId, scopedChatIds));
      if (pred) conditions.push(pred);
    } else {
      conditions.push(eq(attentions.targetHumanId, caller.agentId));
    }
  } else {
    conditions.push(eq(attentions.originAgentId, caller.agentId));
  }

  // State filter. "all" disables the filter; "open" / "closed" narrow.
  if (filter.state !== "all") {
    conditions.push(eq(attentions.state, filter.state));
  }

  // Optional caller-supplied narrowing.
  if (filter.target) conditions.push(eq(attentions.targetHumanId, filter.target));
  if (filter.chat) conditions.push(eq(attentions.originChatId, filter.chat));
  if (filter.agent) conditions.push(eq(attentions.originAgentId, filter.agent));

  const where = conditions.length === 1 ? conditions[0] : and(...conditions);
  const rows = await db.select().from(attentions).where(where).orderBy(desc(attentions.createdAt)).limit(limit);
  return rows.map(toWireRecord);
}
