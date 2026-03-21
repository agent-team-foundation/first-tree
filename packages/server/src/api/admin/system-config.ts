import { updateSystemConfigSchema } from "@agent-hub/shared";
import type { FastifyInstance } from "fastify";
import * as systemConfigService from "../../services/system-config.js";

export async function adminSystemConfigRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async () => {
    return systemConfigService.getAllConfigs(app.db);
  });

  app.patch("/", async (request) => {
    const body = updateSystemConfigSchema.parse(request.body);
    return systemConfigService.updateConfigs(app.db, body);
  });
}
