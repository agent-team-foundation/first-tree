import { updateAdapterConfigSchema } from "@first-tree/shared";
import type { FastifyInstance } from "fastify";
import { BadRequestError } from "../errors.js";
import { assertAgentManageableByUser } from "../scope/require-resource.js";
import { requireUser } from "../scope/require-user.js";
import * as adapterService from "../services/adapter.js";

function parseId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new BadRequestError(`Invalid adapter ID: "${raw}"`);
  }
  return id;
}

/** Class C — `/api/v1/adapters/:id`. */
export async function adapterRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>("/:id", async (request) => {
    const { userId } = requireUser(request);
    const id = parseId(request.params.id);
    const config = await adapterService.getAdapterConfig(app.db, id);
    await assertAgentManageableByUser(app.db, userId, config.agentId);
    return {
      ...config,
      createdAt: config.createdAt.toISOString(),
      updatedAt: config.updatedAt.toISOString(),
    };
  });

  app.patch<{ Params: { id: string } }>("/:id", { config: { otelRecordBody: true } }, async (request) => {
    const { userId } = requireUser(request);
    const id = parseId(request.params.id);
    const body = updateAdapterConfigSchema.parse(request.body);
    const existing = await adapterService.getAdapterConfig(app.db, id);
    await assertAgentManageableByUser(app.db, userId, existing.agentId);
    const config = await adapterService.updateAdapterConfig(app.db, id, body, app.config.secrets.encryptionKey);
    app.notifier.notifyConfigChange("adapter_configs").catch(() => {});
    return {
      ...config,
      createdAt: config.createdAt.toISOString(),
      updatedAt: config.updatedAt.toISOString(),
    };
  });

  app.delete<{ Params: { id: string } }>("/:id", async (request, reply) => {
    const { userId } = requireUser(request);
    const id = parseId(request.params.id);
    const existing = await adapterService.getAdapterConfig(app.db, id);
    await assertAgentManageableByUser(app.db, userId, existing.agentId);
    await adapterService.deleteAdapterConfig(app.db, id);
    app.notifier.notifyConfigChange("adapter_configs").catch(() => {});
    return reply.status(204).send();
  });
}
