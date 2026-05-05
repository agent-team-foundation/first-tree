import type { FastifyInstance } from "fastify";
import { requireMember } from "../middleware/require-identity.js";
import * as clientService from "../services/client.js";
import { forceDisconnectClient } from "../services/connection-manager.js";

/**
 * Member-scoped client routes.
 *
 * Mounted at `/me/clients` to keep them off the admin surface (the legacy
 * admin clients router lives at `/clients`). The only operation here is
 * `POST /:clientId/claim`: ownership transfer driven by the operator running
 * `first-tree-hub client claim --confirm` after a 4403 handshake mismatch
 * (decouple-client-from-identity §4.4).
 */
export async function memberClientRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { clientId: string } }>("/:clientId/claim", async (request, reply) => {
    const m = requireMember(request);
    const { clientId } = request.params;
    const result = await clientService.claimClient(app.db, clientId, m.userId);

    // After the ownership transaction commits, sever the previous owner's
    // live WebSocket if any. Without this, that socket keeps its in-memory
    // `boundAgents` map and would still receive inbox NOTIFY pushes for the
    // unpinned agents until its process exits — even though the DB rows
    // already say those agents are unpinned. The SDK reconnects and is then
    // refused at `client:register` with `CLIENT_USER_MISMATCH`, which sets
    // `closing = true` and stops the loop (decouple-client-from-identity
    // §4.4). Idempotent: returns [] if no socket is registered locally.
    const droppedAgentIds = forceDisconnectClient(clientId);

    request.log.info(
      {
        event: "client.owner_transfer",
        clientId,
        fromUserId: result.previousUserId,
        toUserId: m.userId,
        unpinnedAgentCount: result.unpinnedAgentIds.length,
        droppedSocketAgentCount: droppedAgentIds.length,
      },
      "client ownership transferred via /me/clients/:clientId/claim",
    );
    return reply.status(200).send({
      clientId,
      previousUserId: result.previousUserId,
      unpinnedAgentCount: result.unpinnedAgentIds.length,
    });
  });
}
