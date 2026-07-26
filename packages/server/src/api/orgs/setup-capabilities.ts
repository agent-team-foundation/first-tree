import { teamSetupCapabilitiesSchema } from "@first-tree/shared";
import type { FastifyInstance } from "fastify";
import { requireOrgMembership } from "../../scope/require-org.js";
import { getTeamSetupCapabilities } from "../../services/setup-capabilities.js";

/** Class B — `/api/v1/orgs/:orgId/setup-capabilities`. */
export async function orgSetupCapabilitiesRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { orgId: string } }>("/", async (request) => {
    const scope = await requireOrgMembership(request, app.db);
    return teamSetupCapabilitiesSchema.parse(
      await getTeamSetupCapabilities(app.db, scope.organizationId, {
        githubAppCredentials: app.config.oauth?.githubApp,
        staleSeconds: app.config.runtime.presenceCleanupSeconds,
      }),
    );
  });
}
