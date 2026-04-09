import type { FastifyInstance } from "fastify";
import * as statsService from "../../services/stats.js";

export async function adminStatsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async (request) => {
    const org = (request.query as Record<string, string>).org;
    return statsService.getStats(app.db, org);
  });
}
