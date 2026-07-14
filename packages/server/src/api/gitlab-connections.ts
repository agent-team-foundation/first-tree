import { gitlabAutomaticActionsUpdateSchema, gitlabConnectionDisableSchema } from "@first-tree/shared";
import type { FastifyInstance } from "fastify";
import { requireGitlabConnectionAccess } from "../scope/require-resource.js";
import {
  completeGitlabConnectionRecovery,
  completeGitlabConnectionRotation,
  disableGitlabConnection,
  getGitlabConnectionSummary,
  rearmGitlabConnection,
  rotateGitlabConnection,
  setGitlabAutomaticActions,
} from "../services/gitlab-connections.js";
import { resolvePublicUrl } from "../utils/public-url.js";

export async function gitlabConnectionRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { connectionId: string } }>("/:connectionId", async (request) => {
    const { connection } = await requireGitlabConnectionAccess(request, app.db, "read");
    return getGitlabConnectionSummary(app.db, connection.id);
  });

  app.post<{ Params: { connectionId: string } }>("/:connectionId/rotate", async (request) => {
    const { connection, scope } = await requireGitlabConnectionAccess(request, app.db, "admin");
    const { bearer } = await rotateGitlabConnection(app.db, connection.id, scope.memberId);
    return {
      connection: await getGitlabConnectionSummary(app.db, connection.id),
      webhookUrl: `${resolvePublicUrl(app, request)}/api/v1/webhooks/gitlab/${bearer}`,
    };
  });

  app.post<{ Params: { connectionId: string } }>("/:connectionId/complete-rotation", async (request) => {
    const { connection, scope } = await requireGitlabConnectionAccess(request, app.db, "admin");
    await completeGitlabConnectionRotation(app.db, connection.id, scope.memberId);
    return getGitlabConnectionSummary(app.db, connection.id);
  });

  app.post<{ Params: { connectionId: string } }>(
    "/:connectionId/disable",
    { config: { otelRecordBody: true } },
    async (request) => {
      const { connection, scope } = await requireGitlabConnectionAccess(request, app.db, "admin");
      const body = gitlabConnectionDisableSchema.parse(request.body);
      await disableGitlabConnection(app.db, connection.id, body.mode, scope.memberId);
      return getGitlabConnectionSummary(app.db, connection.id);
    },
  );

  app.post<{ Params: { connectionId: string } }>("/:connectionId/rearm", async (request) => {
    const { connection, scope } = await requireGitlabConnectionAccess(request, app.db, "admin");
    const { bearer } = await rearmGitlabConnection(app.db, connection.id, scope.memberId);
    return {
      connection: await getGitlabConnectionSummary(app.db, connection.id),
      webhookUrl: `${resolvePublicUrl(app, request)}/api/v1/webhooks/gitlab/${bearer}`,
    };
  });

  app.post<{ Params: { connectionId: string } }>("/:connectionId/complete-recovery", async (request) => {
    const { connection, scope } = await requireGitlabConnectionAccess(request, app.db, "admin");
    await completeGitlabConnectionRecovery(app.db, connection.id, scope.memberId);
    return getGitlabConnectionSummary(app.db, connection.id);
  });

  app.put<{ Params: { connectionId: string } }>(
    "/:connectionId/automatic-actions",
    { config: { otelRecordBody: true } },
    async (request) => {
      const { connection, scope } = await requireGitlabConnectionAccess(request, app.db, "admin");
      const body = gitlabAutomaticActionsUpdateSchema.parse(request.body);
      await setGitlabAutomaticActions(app.db, connection.id, scope.memberId, body.enabled);
      return getGitlabConnectionSummary(app.db, connection.id);
    },
  );
}
