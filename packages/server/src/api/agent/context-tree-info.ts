import type { FastifyInstance } from "fastify";
import { requireAgent } from "../../middleware/require-identity.js";
import { getOrgContextTreeBinding, getOrgSetting } from "../../services/org-settings.js";

export async function agentContextTreeInfoRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Class D — `/api/v1/agent/context-tree/info`. Returns the Context Tree
   * binding and Review configuration for the authenticated runtime agent's
   * organization.
   */
  app.get("/context-tree/info", async (request) => {
    const identity = requireAgent(request);
    const [tree, features] = await Promise.all([
      getOrgContextTreeBinding(app.db, identity.organizationId),
      getOrgSetting(app.db, identity.organizationId, "context_tree_features"),
    ]);
    return {
      repo: tree?.repo ?? null,
      branch: tree?.branch ?? null,
      contextReviewer: features.contextReviewer,
    };
  });
}
