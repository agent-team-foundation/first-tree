import {
  type Attention,
  type AttentionCancelledFrame,
  type AttentionOpenedFrame,
  type AttentionRespondedFrame,
  listAttentionsQuerySchema,
  respondAttentionInputSchema,
} from "@first-tree/shared";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { agents } from "../db/schema/agents.js";
import { chats } from "../db/schema/chats.js";
import { members } from "../db/schema/members.js";
import { NotFoundError } from "../errors.js";
import { requireUser } from "../scope/require-user.js";
import { broadcastToAdmins } from "../services/admin-broadcast.js";
import { getAttention, listAttentions, respondAttention } from "../services/attention.js";

/**
 * User-JWT routes for the NHA M1 末 (Need Human Attention) primitive:
 *
 *   GET  /attention             — list attentions visible to the caller
 *   GET  /attention/:id         — read one (visibility-checked)
 *   POST /attention/:id/respond — answer (target human only)
 *
 * Mounted under the user-scope plugin in `app.ts`, parallel to `/me`.
 * Cross-org by construction: the JWT carries only `userId`; each row
 * locates its own org via `chat → organization`. The visibility scope
 * in `services/attention.ts::listAttentions` derives the caller's human
 * agent id from `members.agentId` for the active org; we collapse the
 * cross-org case here by resolving every human agent the user owns and
 * unioning their visible rows.
 *
 * The agent-token (Class D) routes — `POST /attention` (raise) and
 * `POST /attention/:id/cancel` — live in `api/agent/attention.ts`.
 */

/**
 * Resolve every `agents` row whose manager is one of the user's `members`
 * rows AND whose type is human. This is the "set of identities the user
 * can act as" used by both list and respond.
 */
async function listHumanAgentIdsForUser(app: FastifyInstance, userId: string): Promise<string[]> {
  // `members.agent_id` is the user's 1:1 human agent in each org. Any
  // active membership grants the human agent identity (cross-org users
  // get one human agent per org). The `agents.type='human'` join is a
  // defense-in-depth check that mirrors `AGENT_TYPES.HUMAN`.
  const rows = await app.db
    .select({ agentId: members.agentId })
    .from(members)
    .innerJoin(agents, eq(agents.uuid, members.agentId))
    .where(and(eq(members.userId, userId), eq(members.status, "active"), eq(agents.type, "human")));
  return rows.map((r) => r.agentId);
}

/**
 * Resolve one of the user's human agent ids that owns the Attention row
 * (target_human_id ∈ user's humans). Throws 404 when the user is not the
 * target — 404 (not 403) mirrors `requireChatAccess` so we don't leak
 * attention-id existence to non-targets.
 */
async function requireOwnHumanForAttention(
  app: FastifyInstance,
  request: FastifyRequest,
  attentionId: string,
): Promise<{ humanAgentId: string; attention: Attention }> {
  const { userId } = requireUser(request);
  const attention = await getAttention(app.db, attentionId);
  if (!attention) throw new NotFoundError(`Attention "${attentionId}" not found`);

  const myHumans = await listHumanAgentIdsForUser(app, userId);
  if (!myHumans.includes(attention.targetHumanId)) {
    // Hide existence — same shape as the chat 404.
    throw new NotFoundError(`Attention "${attentionId}" not found`);
  }
  return { humanAgentId: attention.targetHumanId, attention };
}

/**
 * Emit `attention:opened` to the target human's admin sockets. Wraps
 * `broadcastToAdmins`: the admin WS scope filters by `organizationId`,
 * so we resolve the chat's org once and embed it in the payload. Best-
 * effort; failures are swallowed (admin UI's poll re-syncs).
 */
export async function emitAttentionOpened(app: FastifyInstance, attention: Attention): Promise<void> {
  const orgId = await resolveChatOrg(app, attention.originChatId);
  if (!orgId) return;
  const frame: AttentionOpenedFrame & { organizationId: string } = {
    type: "attention:opened",
    attentionId: attention.id,
    chatId: attention.originChatId,
    targetHumanId: attention.targetHumanId,
    requiresResponse: attention.requiresResponse,
    organizationId: orgId,
  };
  broadcastToAdmins(frame);
}

/**
 * Emit `attention:responded` to admin sockets in the chat's org. The
 * origin agent's manager UI consumes this to clear the "waiting on
 * human" indicator.
 */
export async function emitAttentionResponded(app: FastifyInstance, attention: Attention): Promise<void> {
  const orgId = await resolveChatOrg(app, attention.originChatId);
  if (!orgId) return;
  const frame: AttentionRespondedFrame & { organizationId: string } = {
    type: "attention:responded",
    attentionId: attention.id,
    originAgentId: attention.originAgentId,
    organizationId: orgId,
  };
  broadcastToAdmins(frame);
  // Also push to the origin agent's inbox so the client runtime can
  // resolve any local `await respond` wait without a refetch.
  await pushFrameToOriginAgent(app, attention, JSON.stringify(frame));
}

/**
 * Emit `attention:cancelled` to admin sockets so the target human's UI
 * removes the "needs you" indicator without waiting for a poll.
 */
export async function emitAttentionCancelled(app: FastifyInstance, attention: Attention): Promise<void> {
  const orgId = await resolveChatOrg(app, attention.originChatId);
  if (!orgId) return;
  const frame: AttentionCancelledFrame & { organizationId: string } = {
    type: "attention:cancelled",
    attentionId: attention.id,
    targetHumanId: attention.targetHumanId,
    reason: attention.cancelledReason,
    organizationId: orgId,
  };
  broadcastToAdmins(frame);
}

async function resolveChatOrg(app: FastifyInstance, chatId: string): Promise<string | null> {
  // Inline select rather than `services/chat.ts::getChat` to avoid the
  // throw-on-missing semantics — we want a silent no-op when the chat is
  // gone (race between cancel and chat hard-delete).
  const [row] = await app.db
    .select({ organizationId: chats.organizationId })
    .from(chats)
    .where(eq(chats.id, chatId))
    .limit(1);
  return row?.organizationId ?? null;
}

async function pushFrameToOriginAgent(app: FastifyInstance, attention: Attention, frame: string): Promise<void> {
  const [agentRow] = await app.db
    .select({ inboxId: agents.inboxId })
    .from(agents)
    .where(eq(agents.uuid, attention.originAgentId))
    .limit(1);
  if (!agentRow?.inboxId) return;
  app.notifier.pushFrameToInbox(agentRow.inboxId, frame).catch(() => {
    // Best-effort — origin agent may not have a live socket; the next
    // poll picks it up.
  });
}

export async function attentionRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async (request) => {
    const { userId } = requireUser(request);
    const query = listAttentionsQuerySchema.parse(request.query);

    const myHumans = await listHumanAgentIdsForUser(app, userId);
    if (myHumans.length === 0) {
      return { rows: [] as Attention[] };
    }

    // Multi-agent collapse: list once per human and merge by id. Each
    // call is bounded by `query.limit`; the merged result is re-sorted
    // newest-first and trimmed back to the requested limit. In the
    // typical single-org user this is one call; the union exists for
    // cross-org users.
    const perAgent = await Promise.all(
      myHumans.map((agentId) => listAttentions(app.db, { agentId, isHuman: true }, query)),
    );
    const byId = new Map<string, Attention>();
    for (const list of perAgent) {
      for (const row of list) byId.set(row.id, row);
    }
    const merged = Array.from(byId.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { rows: merged.slice(0, query.limit) };
  });

  app.get<{ Params: { id: string } }>("/:id", async (request) => {
    const { attention } = await requireOwnHumanForAttention(app, request, request.params.id);
    return attention;
  });

  app.post<{ Params: { id: string } }>("/:id/respond", { config: { otelRecordBody: true } }, async (request, reply) => {
    const { humanAgentId } = await requireOwnHumanForAttention(app, request, request.params.id);
    const body = respondAttentionInputSchema.parse(request.body);
    const updated = await respondAttention(app.db, humanAgentId, request.params.id, body);
    await emitAttentionResponded(app, updated);
    return reply.status(200).send(updated);
  });

  // raise (POST /attention) and cancel (POST /attention/:id/cancel)
  // live only on the agent-token surface — see api/agent/attention.ts.
  // Humans never author either operation; we deliberately don't mount
  // 405 stubs here so the wire surface stays minimal.
}
