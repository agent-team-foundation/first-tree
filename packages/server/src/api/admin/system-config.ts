import { updateSystemConfigSchema } from "@agent-team-foundation/first-tree-hub-shared";
import type { FastifyInstance } from "fastify";
import * as systemConfigService from "../../services/system-config.js";

export async function adminSystemConfigRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async () => {
    return systemConfigService.getAllConfigs(app.db);
  });

  app.patch("/", { config: { otelRecordBody: true } }, async (request) => {
    const body = updateSystemConfigSchema.parse(request.body);
    const result = await systemConfigService.updateConfigs(app.db, body);
    app.notifier.notifyConfigChange("system_configs").catch(() => {});
    return result;
  });
}
