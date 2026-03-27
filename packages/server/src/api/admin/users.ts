import { createAdminUserSchema, updateAdminUserSchema } from "@first-tree-hub/shared";
import type { FastifyInstance } from "fastify";
import { ForbiddenError } from "../../errors.js";
import * as adminUserService from "../../services/admin-user.js";

function serializeDate(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

function requireSuperAdmin(request: { admin?: { role: string } }): void {
  if (request.admin?.role !== "super_admin") {
    throw new ForbiddenError("Only super_admin can manage admin users");
  }
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
    requireSuperAdmin(request);
    const body = createAdminUserSchema.parse(request.body);
    const user = await adminUserService.createAdminUser(app.db, body);
    return reply.status(201).send({
      ...user,
      createdAt: user.createdAt.toISOString(),
      lastLoginAt: serializeDate(user.lastLoginAt),
    });
  });

  app.patch<{ Params: { id: string } }>("/:id", async (request) => {
    requireSuperAdmin(request);
    const body = updateAdminUserSchema.parse(request.body);
    const user = await adminUserService.updateAdminUser(app.db, request.params.id, body);
    return {
      ...user,
      createdAt: user.createdAt.toISOString(),
      lastLoginAt: serializeDate(user.lastLoginAt),
    };
  });

  app.delete<{ Params: { id: string } }>("/:id", async (request, reply) => {
    requireSuperAdmin(request);
    await adminUserService.deleteAdminUser(app.db, request.params.id);
    return reply.status(204).send();
  });
}
