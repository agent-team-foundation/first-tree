import type { FastifyInstance } from "fastify";
import { resolveOrganization } from "../../services/organization.js";
import * as statsService from "../../services/stats.js";

export async function adminStatsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async (request) => {
    const orgParam = (request.query as Record<string, string>).org;
    let orgId: string | undefined;
    if (orgParam) {
      const resolved = await resolveOrganization(app.db, orgParam);
      orgId = resolved.id;
    }
    return statsService.getStats(app.db, orgId);
  });
}
