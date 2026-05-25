import { inboxPollQuerySchema } from "@first-tree/shared";
import type { FastifyInstance } from "fastify";
import { requireAgent } from "../../middleware/require-identity.js";
import * as inboxService from "../../services/inbox.js";

// GET /inbox is retained for admin / curl debugging only — the client runtime
// drains entries via the WS `inbox:deliver` data plane and acks them with the
// `inbox:ack` frame, so the HTTP write endpoints (`/ack`, `/renew`) have been
// removed. See proposal hub-inbox-ws-data-plane §六.1.
export async function agentInboxRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async (request) => {
    const identity = requireAgent(request);
    const query = inboxPollQuerySchema.parse(request.query);
    const entries = await inboxService.pollInbox(app.db, identity.inboxId, query.limit);
    return entries;
  });
}
