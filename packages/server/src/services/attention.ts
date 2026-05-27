import type {
  Attention,
  AttentionState,
  ListAttentionsQuery,
  RaiseAttentionInput,
  RespondAttentionInput,
} from "@first-tree/shared";
import { AGENT_TYPES } from "@first-tree/shared";
import { and, desc, eq, inArray, lt, or, type SQL } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { attentions } from "../db/schema/attentions.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chats } from "../db/schema/chats.js";
import { members } from "../db/schema/members.js";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../errors.js";
import { createLogger } from "../observability/index.js";
import { uuidv7 } from "../uuid.js";

/**
 * NHA (Need Human Attention) — service layer.
 *
 * Hosts the attention primitive's invariants (chat-membership, target-is-
 * human, single-target, only-target-responds, only-origin-cancels,
 * closed-is-immutable) per the design comments in
 * `packages/shared/src/schemas/attention.ts`. The DDL is FK-free per the
 * "integrity in service layer" convention; every constraint we care about
 * lives here.
 *
 * Decoupling from `messages`: attention is its own content substrate. The
 * row carries `subject` / `body` / `response` directly — it does NOT
 * reference a `messages` row, and a raise does NOT write a chat message.
 * Consequences (intentional, not silent failures):
 *
 *   - `@<name>` tokens inside the body are NOT parsed and do NOT fire the
 *     mention notification path. An attention already has exactly one
 *     `targetHumanId`; "ping someone else" via mention would contradict
 *     the single-target invariant. If you need a second human's eyes,
 *     raise a separate attention or post a normal chat message.
 *   - Attachments (images, files) ride on `metadata` per the proposal
 *     §4 extensible-bag convention. The skill documents the agreed
 *     shape; the service does not enforce it.
 *   - Full-text search over attentions is a separate index, not the
 *     `messages` search pipeline. (Follow-up; not in this PR.)
 *   - chat archive does NOT cascade-delete attentions. Closed attentions
 *     remain as an audit trail; raising new attentions in an archived
 *     chat is refused via the existing `isSpeaker` membership gate.
 *
 * The shared-substrate alternative (attention.body → message FK) was
 * considered and rejected: the @mention / attachment / search gaps that
 * motivate it can be closed point-by-point above without coupling the
 * two state machines (message: edit/delete, append-only audit; attention:
 * cancel + raise-new, structured contract).
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
  const [chat] = await db
    .select({ id: chats.id, organizationId: chats.organizationId })
    .from(chats)
    .where(eq(chats.id, chatId))
    .limit(1);
  if (!chat) throw new NotFoundError(`Chat "${chatId}" not found`);

  // 2. Caller agent must be a speaker of this chat.
  if (!(await isSpeaker(db, chatId, callerAgentId))) {
    throw new ForbiddenError("Caller is not a speaker of this chat");
  }

  // 3. Target agent must exist and be type=human. The `target` input may be
  // either an agent uuid OR an agent name (resolved in the chat's org —
  // names are not globally unique). Mirrors `services/chat.ts::addParticipant`
  // so `attention raise --target yuezengwu` works the same as
  // `chat invite yuezengwu`. Uuid takes priority on collision.
  const targetSelector = or(
    eq(agents.uuid, target),
    and(eq(agents.organizationId, chat.organizationId), eq(agents.name, target)),
  );
  if (!targetSelector) throw new BadRequestError("Empty target");
  const [targetAgent] = await db
    .select({ uuid: agents.uuid, type: agents.type })
    .from(agents)
    .where(targetSelector)
    .limit(1);
  if (!targetAgent) {
    throw new BadRequestError(`Target agent "${target}" not found`);
  }
  if (targetAgent.type !== AGENT_TYPES.HUMAN) {
    throw new BadRequestError(
      `Target agent "${target}" is not a human (type="${targetAgent.type}"); attentions only fire at humans.`,
    );
  }
  const resolvedTargetId = targetAgent.uuid;

  // 4. Target must be a member of origin_chat. 409 + hint matches the
  // shared-schema doc comment.
  if (!(await isSpeaker(db, chatId, resolvedTargetId))) {
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
      targetHumanId: resolvedTargetId,
      subject,
      body,
      requiresResponse,
      state: closed ? "closed" : "open",
      metadata,
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
      targetHumanId: resolvedTargetId,
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

  // Atomic state guard. Two responders racing (or a respond racing a cancel)
  // would both pass the load-check above; the `state='open'` predicate on
  // the UPDATE makes the second one a no-op. The `RETURNING` row is empty
  // in that case so we surface the same Conflict the load-check would.
  const [updated] = await db
    .update(attentions)
    .set({
      response: responseText,
      respondedBy: callerHumanId,
      respondedAt: now,
      state: "closed",
      closedAt: now,
    })
    .where(and(eq(attentions.id, attentionId), eq(attentions.state, "open")))
    .returning();
  if (!updated) {
    throw new ConflictError(`Attention "${attentionId}" was closed concurrently`);
  }

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
  // Atomic state guard — see `respondAttention` for the same pattern.
  const [updated] = await db
    .update(attentions)
    .set({
      state: "closed",
      cancelled: true,
      cancelledReason: reason,
      closedAt: now,
    })
    .where(and(eq(attentions.id, attentionId), eq(attentions.state, "open")))
    .returning();
  if (!updated) {
    throw new ConflictError(`Attention "${attentionId}" was closed concurrently`);
  }

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
 * Caller identity used by `listAttentions`. Strict visibility:
 *
 *   - Human caller: targeted at them, OR raised by an autonomous agent
 *     they manage. Co-speakers in shared chats do NOT see attentions
 *     routed to other humans — every NHA has exactly one target, and
 *     surfacing it to bystanders is just noise.
 *   - Agent caller: only attentions they raised themselves (audit trail).
 */
export type AttentionCaller = {
  agentId: string;
  isHuman: boolean;
};

/**
 * Resolve the set of (non-human) `agents.uuid` values whose `manager_id`
 * points at one of the caller-human's member rows. Single indexed read
 * via `idx_members_user` + `idx_agents_manager`; empty array on missing
 * memberships (caller has no managed agents). Cross-org callers
 * naturally union across all their member rows.
 */
async function listAgentIdsManagedByCallerHuman(db: Database, callerHumanAgentId: string): Promise<string[]> {
  const rows = await db
    .select({ uuid: agents.uuid })
    .from(agents)
    .innerJoin(members, eq(agents.managerId, members.id))
    .where(and(eq(members.agentId, callerHumanAgentId), eq(members.status, "active")));
  return rows.map((r) => r.uuid);
}

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

  // Build the visibility WHERE. Strict policy:
  //   - Human: target == me OR origin agent is one I manage.
  //   - Agent: origin == me.
  // Co-speaker visibility (the old "chat IN my-chats" arm) is intentionally
  // dropped — every NHA has exactly one target human, and surfacing it to
  // bystanders in shared chats is just noise the proposal §4 single-target
  // invariant explicitly tries to keep out of the UI.
  const conditions: SQL[] = [];
  if (caller.isHuman) {
    const managedAgentIds = await listAgentIdsManagedByCallerHuman(db, caller.agentId);
    const pred =
      managedAgentIds.length > 0
        ? or(eq(attentions.targetHumanId, caller.agentId), inArray(attentions.originAgentId, managedAgentIds))
        : eq(attentions.targetHumanId, caller.agentId);
    if (pred) conditions.push(pred);
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

  // Cursor pagination. The cursor is the previous page's last row's
  // createdAt; we return rows strictly older to avoid duplicating the
  // boundary row. Order is desc(createdAt) so "older" === lt().
  if (filter.cursor) {
    const cursorDate = new Date(filter.cursor);
    if (!Number.isNaN(cursorDate.getTime())) {
      conditions.push(lt(attentions.createdAt, cursorDate));
    }
  }

  const where = conditions.length === 1 ? conditions[0] : and(...conditions);
  const rows = await db.select().from(attentions).where(where).orderBy(desc(attentions.createdAt)).limit(limit);
  return rows.map(toWireRecord);
}
