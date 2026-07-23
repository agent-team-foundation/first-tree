import type { FastifyInstance } from "fastify";
import { requireAgent } from "../../middleware/require-identity.js";
import { getOrgContextReviewRuntime } from "../../services/org-settings.js";

export async function agentContextTreeInfoRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Class D — `/api/v1/agent/context-tree/info`. Returns the Context Tree
   * binding and Reviewer assignment for the authenticated runtime agent's
   * organization. The service returns both from one database statement.
   */
  app.get("/context-tree/info", async (request) => {
    const identity = requireAgent(request);
    const runtime = await getOrgContextReviewRuntime(app.db, identity.organizationId);
    return {
      provider: runtime.provider,
      repo: runtime.repo,
      branch: runtime.branch,
      contextReviewer: runtime.contextReviewer,
    };
  });
}
