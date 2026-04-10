import { inboxPollQuerySchema } from "@agent-team-foundation/first-tree-hub-shared";
import type { FastifyInstance } from "fastify";
import { requireAgent } from "../../middleware/require-identity.js";
import * as inboxService from "../../services/inbox.js";

export async function agentInboxRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async (request) => {
    const identity = requireAgent(request);
    const query = inboxPollQuerySchema.parse(request.query);
    const entries = await inboxService.pollInbox(app.db, identity.inboxId, query.limit);
    return entries;
  });

  app.post<{ Params: { entryId: string } }>("/:entryId/ack", async (request, reply) => {
    const identity = requireAgent(request);
    const entryId = Number(request.params.entryId);
    await inboxService.ackEntry(app.db, entryId, identity.inboxId);
    return reply.status(204).send();
  });

  app.post<{ Params: { entryId: string } }>("/:entryId/renew", async (request, reply) => {
    const identity = requireAgent(request);
    const entryId = Number(request.params.entryId);
    await inboxService.renewEntry(app.db, entryId, identity.inboxId);
    return reply.status(204).send();
  });
}
