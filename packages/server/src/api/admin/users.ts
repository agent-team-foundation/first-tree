import { createAdminUserSchema, updateAdminUserSchema } from "@agent-hub/shared";
import type { FastifyInstance } from "fastify";
import * as adminUserService from "../../services/admin-user.js";

function serializeDate(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

export async function adminUserRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async () => {
    const users = await adminUserService.listAdminUsers(app.db);
    return users.map((u) => ({
      ...u,
      createdAt: u.createdAt.toISOString(),
      lastLoginAt: serializeDate(u.lastLoginAt),
    }));
  });

  app.post("/", async (request, reply) => {
    const body = createAdminUserSchema.parse(request.body);
    const user = await adminUserService.createAdminUser(app.db, body);
    return reply.status(201).send({
      ...user,
      createdAt: user.createdAt.toISOString(),
      lastLoginAt: serializeDate(user.lastLoginAt),
    });
  });

  app.patch<{ Params: { id: string } }>("/:id", async (request) => {
    const body = updateAdminUserSchema.parse(request.body);
    const user = await adminUserService.updateAdminUser(app.db, request.params.id, body);
    return {
      ...user,
      createdAt: user.createdAt.toISOString(),
      lastLoginAt: serializeDate(user.lastLoginAt),
    };
  });

  app.delete<{ Params: { id: string } }>("/:id", async (request, reply) => {
    await adminUserService.deleteAdminUser(app.db, request.params.id);
    return reply.status(204).send();
  });
}
