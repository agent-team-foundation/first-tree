import { createAdapterConfigSchema, updateAdapterConfigSchema } from "@agent-hub/shared";
import type { FastifyInstance } from "fastify";
import { BadRequestError } from "../../errors.js";
import * as adapterService from "../../services/adapter.js";

function parseId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new BadRequestError(`Invalid adapter ID: "${raw}"`);
  }
  return id;
}

export async function adminAdapterRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async () => {
    const configs = await adapterService.listAdapterConfigs(app.db);
    return configs.map((c) => ({
      ...c,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    }));
  });

  app.post("/", async (request, reply) => {
    const body = createAdapterConfigSchema.parse(request.body);
    const config = await adapterService.createAdapterConfig(app.db, body, app.config.adapterEncryptionKey);
    // Fire-and-forget: reload must not block the API response or turn a DB success into 500
    app.adapterManager.reload().catch((err) => app.log.error(err, "Adapter reload failed after create"));
    return reply.status(201).send({
      ...config,
      createdAt: config.createdAt.toISOString(),
      updatedAt: config.updatedAt.toISOString(),
    });
  });

  app.get<{ Params: { id: string } }>("/:id", async (request) => {
    const id = parseId(request.params.id);
    const config = await adapterService.getAdapterConfig(app.db, id);
    return {
      ...config,
      createdAt: config.createdAt.toISOString(),
      updatedAt: config.updatedAt.toISOString(),
    };
  });

  app.patch<{ Params: { id: string } }>("/:id", async (request) => {
    const body = updateAdapterConfigSchema.parse(request.body);
    const id = parseId(request.params.id);
    const config = await adapterService.updateAdapterConfig(app.db, id, body, app.config.adapterEncryptionKey);
    app.adapterManager.reload().catch((err) => app.log.error(err, "Adapter reload failed after update"));
    return {
      ...config,
      createdAt: config.createdAt.toISOString(),
      updatedAt: config.updatedAt.toISOString(),
    };
  });

  app.delete<{ Params: { id: string } }>("/:id", async (request, reply) => {
    const id = parseId(request.params.id);
    await adapterService.deleteAdapterConfig(app.db, id);
    app.adapterManager.reload().catch((err) => app.log.error(err, "Adapter reload failed after delete"));
    return reply.status(204).send();
  });
}
