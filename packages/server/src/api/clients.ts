import { updateClientCapabilitiesSchema } from "@first-tree/shared";
import { getChannelConfig } from "@first-tree/shared/channel";
import type { FastifyInstance } from "fastify";
import { requireUser } from "../scope/require-user.js";
import { expiryToSeconds } from "../services/auth.js";
import * as clientService from "../services/client.js";
import { forceDisconnectClient } from "../services/connection-manager.js";
import { serializeDate } from "../utils.js";
import { clientCommandVersionHint } from "./client-command-version.js";

/**
 * Class C — `/api/v1/clients/:id` and member-self utilities. A client is
 * owned by exactly one user (cross-org under one user is allowed); the
 * org doesn't appear in this URL because it doesn't gate access.
 */
export async function clientRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { clientId: string } }>("/:clientId", async (request) => {
    const { userId } = requireUser(request);
    await clientService.assertClientOwner(app.db, request.params.clientId, { userId });
    const client = await clientService.getClient(app.db, request.params.clientId);
    if (!client) throw new Error("unreachable: client missing after owner check");
    const metadata = (client.metadata ?? {}) as Record<string, unknown>;
    const capabilities =
      metadata.capabilities && typeof metadata.capabilities === "object" ? metadata.capabilities : {};
    const refreshExpirySeconds = expiryToSeconds(app.config.auth.refreshTokenExpiry);
    const binName = getChannelConfig(app.config.channel).binName;
    return {
      id: client.id,
      userId: client.userId,
      status: client.status,
      authState: clientService.deriveAuthState(client, refreshExpirySeconds),
      binName,
      sdkVersion: client.sdkVersion,
      hostname: client.hostname,
      os: client.os,
      connectedAt: serializeDate(client.connectedAt),
      lastSeenAt: client.lastSeenAt.toISOString(),
      capabilities,
      lastUpdateAttempt: clientService.extractLastUpdateAttempt(client.metadata),
      ...clientCommandVersionHint(app, client.sdkVersion),
    };
  });

  app.patch<{ Params: { clientId: string } }>("/:clientId/capabilities", async (request, reply) => {
    const { userId } = requireUser(request);
    await clientService.assertClientOwner(app.db, request.params.clientId, { userId });
    const body = updateClientCapabilitiesSchema.parse(request.body);
    await clientService.updateClientCapabilities(app.db, request.params.clientId, body.capabilities);
    return reply.status(204).send();
  });

  app.post<{ Params: { clientId: string } }>("/:clientId/disconnect", async (request) => {
    const { userId } = requireUser(request);
    const { clientId } = request.params;
    await clientService.assertClientOwner(app.db, clientId, { userId });
    const agentIds = forceDisconnectClient(clientId);
    await clientService.disconnectClient(app.db, clientId);
    return { disconnected: true, agentIds };
  });

  app.delete<{ Params: { clientId: string } }>("/:clientId", async (request, reply) => {
    const { userId } = requireUser(request);
    const { clientId } = request.params;
    await clientService.assertClientOwner(app.db, clientId, { userId });
    await clientService.retireClient(app.db, clientId);
    forceDisconnectClient(clientId);
    await clientService.disconnectClient(app.db, clientId);
    return reply.status(204).send();
  });

  // POST /:clientId/claim (cross-user ownership transfer) was removed: a
  // clientId is org-visible, so with only-JWT auth the route let any
  // authenticated user knock another user's machine offline. Machine handover
  // now goes through `login --override`, which abandons the local client
  // identity and registers a fresh clientId instead (no server-side transfer
  // protocol to secure).
}
