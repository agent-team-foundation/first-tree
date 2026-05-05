import { notificationQuerySchema } from "@agent-team-foundation/first-tree-hub-shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { NotFoundError } from "../../errors.js";
import { memberScope, resolveAdminScope } from "../../services/access-control.js";
import * as notificationService from "../../services/notification.js";

const orgQuerySchema = z.object({ organizationId: z.string().min(1).optional() });

export async function adminNotificationRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /admin/notifications — list notifications visible to the caller in
   * the **selected** organization. The web client passes
   * `?organizationId=<selectedOrgId>` so a non-default org doesn't reuse
   * the JWT default org's bell feed (codex P1 #2). Defaults to JWT org
   * when omitted.
   *
   * Per-agent visibility filter: the member only sees notifications whose
   * agentId is visible to them in that org (organization-visible agents or
   * agents they manage), plus org-wide system notifications with no
   * agentId. This mirrors the admin-WS push gate so REST and WS stay in sync.
   */
  app.get("/", async (request) => {
    const scope = memberScope(request);
    const { organizationId } = orgQuerySchema.parse(request.query);
    const effective = await resolveAdminScope(app.db, request, scope, organizationId);
    const query = notificationQuerySchema.parse(request.query);
    return notificationService.listNotifications(app.db, effective.organizationId, effective.memberId, query);
  });

  /** POST /admin/notifications/:id/read — mark a single notification as read */
  app.post<{ Params: { id: string } }>("/:id/read", async (request) => {
    const scope = memberScope(request);
    const { organizationId } = orgQuerySchema.parse(request.query);
    const effective = await resolveAdminScope(app.db, request, scope, organizationId);
    const result = await notificationService.markRead(
      app.db,
      request.params.id,
      effective.organizationId,
      effective.memberId,
    );
    if (!result) throw new NotFoundError(`Notification "${request.params.id}" not found`);
    return { ...result, createdAt: result.createdAt.toISOString() };
  });

  /** POST /admin/notifications/read-all — mark all visible notifications as read */
  app.post("/read-all", async (request) => {
    const scope = memberScope(request);
    const { organizationId } = orgQuerySchema.parse(request.query);
    const effective = await resolveAdminScope(app.db, request, scope, organizationId);
    await notificationService.markAllRead(app.db, effective.organizationId, effective.memberId);
    return { status: "ok" };
  });
}
