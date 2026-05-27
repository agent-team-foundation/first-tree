import {
  type Attention,
  cancelAttentionInputSchema,
  listAttentionsQuerySchema,
  raiseAttentionInputSchema,
} from "@first-tree/shared";
import type { FastifyInstance } from "fastify";
import { NotFoundError } from "../../errors.js";
import { requireAgent } from "../../middleware/require-identity.js";
import { cancelAttention, getAttention, listAttentions, raiseAttention } from "../../services/attention.js";
import { emitAttentionCancelled, emitAttentionOpened } from "../attention.js";

/**
 * Class D — agent-token routes for the NHA M1 末 primitive. The agent
 * runtime calls these from the client SDK:
 *
 *   POST /agent/attention             — raise (origin == caller agent)
 *   GET  /agent/attention             — list (visibility: rows the caller raised)
 *   GET  /agent/attention/:id         — read (only the origin agent's own rows)
 *   POST /agent/attention/:id/cancel  — withdraw an open Attention
 *
 * The user-JWT (Class A-ish) routes — list/show/respond from a human's
 * web client — live in `api/attention.ts`.
 *
 * `emitAttention*` lives in `api/attention.ts` and is shared between the
 * two surfaces so a `respond` from the user side and a `cancel` from the
 * agent side broadcast the same frame shape.
 */
export async function agentAttentionRoutes(app: FastifyInstance): Promise<void> {
  app.post("/", { config: { otelRecordBody: true } }, async (request, reply) => {
    const identity = requireAgent(request);
    const body = raiseAttentionInputSchema.parse(request.body);
    const created = await raiseAttention(app.db, identity.uuid, body);
    // emitAttention* is best-effort; service-layer success is what we
    // report on the wire. Failure inside the emitter is swallowed by the
    // emitter itself (admin UI's poll re-syncs).
    await emitAttentionOpened(app, created);
    return reply.status(201).send(created);
  });

  app.get("/", async (request) => {
    const identity = requireAgent(request);
    const query = listAttentionsQuerySchema.parse(request.query);
    return listAttentions(app.db, { agentId: identity.uuid, isHuman: false }, query);
  });

  app.get<{ Params: { id: string } }>("/:id", async (request) => {
    const identity = requireAgent(request);
    const attention = await getAttention(app.db, request.params.id);
    if (!attention || attention.originAgentId !== identity.uuid) {
      // 404 (not 403) hides existence from non-origin callers — mirrors
      // the chat-access 404 in `requireChatAccess`.
      throw new NotFoundError(`Attention "${request.params.id}" not found`);
    }
    // `Attention` type is the wire shape; explicit return annotation
    // helps the editor without changing the runtime shape.
    const wire: Attention = attention;
    return wire;
  });

  app.post<{ Params: { id: string } }>("/:id/cancel", { config: { otelRecordBody: true } }, async (request, reply) => {
    const identity = requireAgent(request);
    const body = cancelAttentionInputSchema.parse(request.body ?? {});
    const updated = await cancelAttention(app.db, identity.uuid, request.params.id, body.reason ?? null);
    await emitAttentionCancelled(app, updated);
    return reply.status(200).send(updated);
  });

  // `respond` lives only on the user-JWT surface — the agent never
  // authors a response on behalf of a human. See api/attention.ts.
}
