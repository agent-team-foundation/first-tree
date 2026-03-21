import { inboxPollQuerySchema } from "@agent-hub/shared";
import type { FastifyInstance } from "fastify";
import { requireAgent } from "../../middleware/require-identity.js";
import * as inboxService from "../../services/inbox.js";

export async function agentInboxRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async (request) => {
    const identity = requireAgent(request);
    const query = inboxPollQuerySchema.parse(request.query);
    const entries = await inboxService.pollInbox(app.db, identity.inboxId, query.limit);
    return { items: entries };
  });

  app.post<{ Params: { entryId: string } }>("/:entryId/ack", async (request, reply) => {
    const identity = requireAgent(request);
    const entryId = Number(request.params.entryId);
    await inboxService.ackEntry(app.db, entryId, identity.inboxId);
    return reply.status(204).send();
  });
}
