import { notificationQuerySchema } from "@agent-team-foundation/first-tree-hub-shared";
import type { FastifyInstance } from "fastify";
import { NotFoundError } from "../../errors.js";
import { requireOrgMembership } from "../../scope/require-org.js";
import * as notificationService from "../../services/notification.js";

/** Class B — `/api/v1/orgs/:orgId/notifications`. */
export async function orgNotificationRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { orgId: string } }>("/", async (request) => {
    const scope = await requireOrgMembership(request, app.db);
    const query = notificationQuerySchema.parse(request.query);
    return notificationService.listNotifications(app.db, scope.organizationId, scope.memberId, query);
  });

  app.post<{ Params: { orgId: string; id: string } }>("/:id/read", async (request) => {
    const scope = await requireOrgMembership(request, app.db);
    const result = await notificationService.markRead(app.db, request.params.id, scope.organizationId, scope.memberId);
    if (!result) throw new NotFoundError(`Notification "${request.params.id}" not found`);
    return { ...result, createdAt: result.createdAt.toISOString() };
  });

  app.post<{ Params: { orgId: string } }>("/read-all", async (request) => {
    const scope = await requireOrgMembership(request, app.db);
    await notificationService.markAllRead(app.db, scope.organizationId, scope.memberId);
    return { status: "ok" };
  });
}
