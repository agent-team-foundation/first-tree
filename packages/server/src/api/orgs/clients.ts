import { getChannelConfig } from "@first-tree/shared/channel";
import type { FastifyInstance } from "fastify";
import { requireOrgAdmin } from "../../scope/require-org.js";
import { expiryToSeconds } from "../../services/auth.js";
import * as clientService from "../../services/client.js";
import { isLandingCampaignServiceMembership } from "../../services/landing-campaigns/guards.js";
import { serializeDate } from "../../utils.js";
import { clientCommandVersionHint } from "../client-command-version.js";

/**
 * Class B — `/api/v1/orgs/:orgId/clients`. Lists clients belonging to
 * users who have a membership in this org (an admin's audit view).
 * Personal client management is at `/api/v1/clients/:clientId`.
 */
export async function orgClientRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { orgId: string } }>("/", async (request) => {
    // Listing this collection requires admin in the target org.
    const scope = await requireOrgAdmin(request, app.db);
    const clients = (await clientService.listClientsForOrgAdmin(app.db, scope.organizationId)).filter(
      (client) =>
        !isLandingCampaignServiceMembership(app.config, {
          userId: client.userId,
          organizationId: scope.organizationId,
        }),
    );
    const refreshExpirySeconds = expiryToSeconds(app.config.auth.refreshTokenExpiry);
    const binName = getChannelConfig(app.config.channel).binName;
    return clients.map((c) => ({
      id: c.id,
      userId: c.userId,
      status: clientService.clientStatusForApi(c),
      authState: clientService.deriveAuthState(c, refreshExpirySeconds),
      binName,
      sdkVersion: c.sdkVersion,
      hostname: c.hostname,
      os: c.os,
      agentCount: c.agentCount,
      connectedAt: serializeDate(c.connectedAt),
      lastSeenAt: c.lastSeenAt.toISOString(),
      capabilities: clientService.extractCapabilities(c.metadata),
      lastUpdateAttempt: clientService.extractLastUpdateAttempt(c.metadata),
      ...clientCommandVersionHint(app, c.sdkVersion),
    }));
  });
}
