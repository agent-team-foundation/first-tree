import type { FastifyInstance } from "fastify";
import { requireOrgAdmin } from "../../scope/require-org.js";
import { expiryToSeconds } from "../../services/auth.js";
import * as clientService from "../../services/client.js";
import { serializeDate } from "../../utils.js";

/**
 * Class B — `/api/v1/orgs/:orgId/clients`. Lists clients belonging to
 * users who have a membership in this org (an admin's audit view).
 * Personal client management is at `/api/v1/clients/:clientId`.
 */
export async function orgClientRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { orgId: string } }>("/", async (request) => {
    // Listing this collection requires admin in the target org.
    const scope = await requireOrgAdmin(request, app.db);
    const clients = await clientService.listClientsForOrgAdmin(app.db, scope.organizationId);
    const refreshExpirySeconds = expiryToSeconds(app.config.auth.refreshTokenExpiry);
    return clients.map((c) => ({
      id: c.id,
      userId: c.userId,
      status: c.status,
      authState: clientService.deriveAuthState(c, refreshExpirySeconds),
      sdkVersion: c.sdkVersion,
      hostname: c.hostname,
      os: c.os,
      agentCount: c.agentCount,
      connectedAt: serializeDate(c.connectedAt),
      lastSeenAt: c.lastSeenAt.toISOString(),
    }));
  });
}
