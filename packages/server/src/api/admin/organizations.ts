import { createOrganizationSchema, paginationQuerySchema, updateOrganizationSchema } from "@first-tree-hub/shared";
import type { FastifyInstance } from "fastify";
import * as orgService from "../../services/organization.js";

export async function adminOrganizationRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async (request) => {
    const query = paginationQuerySchema.parse(request.query);
    const result = await orgService.listOrganizations(app.db, query.limit, query.cursor);
    return {
      items: result.items.map((o) => ({
        ...o,
        createdAt: o.createdAt.toISOString(),
        updatedAt: o.updatedAt.toISOString(),
      })),
      nextCursor: result.nextCursor,
    };
  });

  app.post("/", async (request, reply) => {
    const body = createOrganizationSchema.parse(request.body);
    const org = await orgService.createOrganization(app.db, body);
    return reply.status(201).send({
      ...org,
      createdAt: org.createdAt.toISOString(),
      updatedAt: org.updatedAt.toISOString(),
    });
  });

  app.get<{ Params: { id: string } }>("/:id", async (request) => {
    const org = await orgService.getOrganization(app.db, request.params.id);
    return {
      ...org,
      createdAt: org.createdAt.toISOString(),
      updatedAt: org.updatedAt.toISOString(),
    };
  });

  app.patch<{ Params: { id: string } }>("/:id", async (request) => {
    const body = updateOrganizationSchema.parse(request.body);
    const org = await orgService.updateOrganization(app.db, request.params.id, body);
    return {
      ...org,
      createdAt: org.createdAt.toISOString(),
      updatedAt: org.updatedAt.toISOString(),
    };
  });

  app.delete<{ Params: { id: string } }>("/:id", async (request, reply) => {
    await orgService.deleteOrganization(app.db, request.params.id);
    return reply.status(204).send();
  });
}
