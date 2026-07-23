import type { FastifyInstance } from "fastify";
import { requireAgent } from "../../middleware/require-identity.js";
import { getTeamSafeOrgContextReviewRuntime } from "../../services/org-settings.js";

export async function agentContextTreeInfoRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Class D — `/api/v1/agent/context-tree/info`. Returns the Context Tree
   * binding and Team-safe Reviewer assignment for the authenticated runtime
   * agent's organization.
   */
  app.get("/context-tree/info", async (request) => {
    const identity = requireAgent(request);
    const runtime = await getTeamSafeOrgContextReviewRuntime(app.db, identity.organizationId);
    return {
      provider: runtime.provider,
      repo: runtime.repo,
      branch: runtime.branch,
      providerMatchesRepository: runtime.providerMatchesRepository,
      gitlabConnection:
        runtime.provider === "gitlab" && runtime.gitlabConnection
          ? {
              id: runtime.gitlabConnection.id,
              instanceOrigin: runtime.gitlabConnection.instanceOrigin,
            }
          : null,
      contextReviewer: runtime.contextReviewer,
    };
  });
}
