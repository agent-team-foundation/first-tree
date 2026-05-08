import { createAdapterConfigSchema } from "@agent-team-foundation/first-tree-hub-shared";
import type { FastifyInstance } from "fastify";
import { createLogger } from "../../observability/index.js";
import { requireOrgMembership } from "../../scope/require-org.js";
import { assertAgentManageableByUser } from "../../scope/require-resource.js";
import * as adapterService from "../../services/adapter.js";

const log = createLogger("OrgAdapters");

/** Class B — `/api/v1/orgs/:orgId/adapters`. */
export async function orgAdapterRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { orgId: string } }>("/", async (request) => {
    const scope = await requireOrgMembership(request, app.db);
    const configs = await adapterService.listAdapterConfigsForMember(app.db, scope);
    return configs.map((c) => ({
      ...c,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    }));
  });

  app.post<{ Params: { orgId: string } }>("/", { config: { otelRecordBody: true } }, async (request, reply) => {
    const scope = await requireOrgMembership(request, app.db);
    const body = createAdapterConfigSchema.parse(request.body);
    await assertAgentManageableByUser(app.db, scope.userId, body.agentId);
    const config = await adapterService.createAdapterConfig(app.db, body, app.config.secrets.encryptionKey);
    app.adapterManager.reload().catch((err) => log.error({ err }, "adapter reload failed after create"));
    app.notifier.notifyConfigChange("adapter_configs").catch(() => {});
    return reply.status(201).send({
      ...config,
      createdAt: config.createdAt.toISOString(),
      updatedAt: config.updatedAt.toISOString(),
    });
  });
}
