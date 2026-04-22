import { notificationQuerySchema } from "@agent-team-foundation/first-tree-hub-shared";
import type { FastifyInstance } from "fastify";
import { NotFoundError } from "../../errors.js";
import { requireMember } from "../../middleware/require-identity.js";
import * as notificationService from "../../services/notification.js";

export async function adminNotificationRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /admin/notifications — list notifications visible to the caller.
   *
   * Scoped by (a) organization (via JWT) and (b) per-agent visibility: the
   * member only sees notifications whose agentId is visible to them
   * (organization-visible agents or agents they manage), plus org-wide
   * system notifications with no agentId. This mirrors the rule the admin
   * WebSocket route enforces on live pushes — REST and WS stay in sync.
   */
  app.get("/", async (request) => {
    const member = requireMember(request);
    const query = notificationQuerySchema.parse(request.query);
    return notificationService.listNotifications(app.db, member.organizationId, member.memberId, query);
  });

  /** POST /admin/notifications/:id/read — mark a single notification as read */
  app.post<{ Params: { id: string } }>("/:id/read", async (request) => {
    const member = requireMember(request);
    const result = await notificationService.markRead(
      app.db,
      request.params.id,
      member.organizationId,
      member.memberId,
    );
    if (!result) throw new NotFoundError(`Notification "${request.params.id}" not found`);
    return { ...result, createdAt: result.createdAt.toISOString() };
  });

  /** POST /admin/notifications/read-all — mark all visible notifications as read */
  app.post("/read-all", async (request) => {
    const member = requireMember(request);
    await notificationService.markAllRead(app.db, member.organizationId, member.memberId);
    return { status: "ok" };
  });
}
