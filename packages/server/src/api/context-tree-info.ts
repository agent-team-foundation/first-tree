import type { FastifyInstance } from "fastify";
import { requireUser } from "../scope/require-user.js";
import { getOrgContextTreeBinding, resolveUserPrimaryOrgId } from "../services/org-settings.js";

export async function contextTreeInfoRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Class A — `/api/v1/context-tree/info`. Returns the caller's
   * organization-scoped Context Tree binding for CLI auto-discovery.
   * Responds with `{ repo: null, branch: null }` when the user is not in
   * any org or the org hasn't configured a tree yet.
   */
  app.get("/info", async (request) => {
    const { userId } = requireUser(request);
    const orgId = await resolveUserPrimaryOrgId(app.db, userId);
    if (!orgId) {
      return { repo: null, branch: null };
    }
    const tree = await getOrgContextTreeBinding(app.db, orgId);
    return { repo: tree?.repo ?? null, branch: tree?.branch ?? null };
  });
}
