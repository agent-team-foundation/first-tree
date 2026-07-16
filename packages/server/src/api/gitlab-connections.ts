import {
  gitlabAssigneeModeConfirmationSchema,
  gitlabAutomaticActionsUpdateSchema,
  gitlabConnectionCreateSchema,
} from "@first-tree/shared";
import type { FastifyInstance } from "fastify";
import { BadRequestError } from "../errors.js";
import { requireGitlabConnectionAccess } from "../scope/require-resource.js";
import {
  confirmGitlabAssigneeMode,
  deleteGitlabConnection,
  getGitlabConnectionSummary,
  regenerateGitlabConnectionBearer,
  replaceGitlabConnection,
  setGitlabAutomaticActions,
} from "../services/gitlab-connections.js";
import { resolvePublicUrl } from "../utils/public-url.js";

export async function gitlabConnectionRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { connectionId: string } }>("/:connectionId", async (request) => {
    const { connection } = await requireGitlabConnectionAccess(request, app.db, "read");
    return getGitlabConnectionSummary(app.db, connection.id);
  });

  app.post<{ Params: { connectionId: string } }>("/:connectionId/regenerate", async (request) => {
    const { connection, scope } = await requireGitlabConnectionAccess(request, app.db, "admin");
    const { bearer } = await regenerateGitlabConnectionBearer(app.db, connection.id, scope.memberId);
    return {
      connection: await getGitlabConnectionSummary(app.db, connection.id),
      webhookUrl: `${resolvePublicUrl(app, request)}/api/v1/webhooks/gitlab/${bearer}`,
    };
  });

  app.post<{ Params: { connectionId: string } }>("/:connectionId/automatic-actions", async (request) => {
    const { connection, scope } = await requireGitlabConnectionAccess(request, app.db, "admin");
    const body = gitlabAutomaticActionsUpdateSchema.parse(request.body);
    return setGitlabAutomaticActions(app.db, {
      connectionId: connection.id,
      organizationId: connection.organizationId,
      actorMemberId: scope.memberId,
      enabled: body.enabled,
      acceptTeamWideForgeryRisk: body.acceptTeamWideForgeryRisk,
      reason: body.reason,
    });
  });

  app.post<{ Params: { connectionId: string } }>("/:connectionId/reviewer-mode/assignee", async (request) => {
    const { connection, scope } = await requireGitlabConnectionAccess(request, app.db, "admin");
    gitlabAssigneeModeConfirmationSchema.parse(request.body);
    return confirmGitlabAssigneeMode(app.db, {
      connectionId: connection.id,
      organizationId: connection.organizationId,
      actorMemberId: scope.memberId,
    });
  });

  app.post<{ Params: { connectionId: string } }>(
    "/:connectionId/replace",
    { config: { otelRecordBody: true } },
    async (request) => {
      const { connection, scope } = await requireGitlabConnectionAccess(request, app.db, "admin");
      const body = gitlabConnectionCreateSchema.parse(request.body);
      let replaced: Awaited<ReturnType<typeof replaceGitlabConnection>>;
      try {
        replaced = await replaceGitlabConnection(app.db, {
          expectedConnectionId: connection.id,
          organizationId: connection.organizationId,
          memberId: scope.memberId,
          displayName: body.displayName,
          instanceOrigin: body.instanceOrigin,
        });
      } catch (err) {
        if (err instanceof TypeError || (err instanceof Error && err.message.startsWith("GitLab origin"))) {
          throw new BadRequestError(err.message);
        }
        throw err;
      }
      return {
        connection: await getGitlabConnectionSummary(app.db, replaced.connectionId),
        webhookUrl: `${resolvePublicUrl(app, request)}/api/v1/webhooks/gitlab/${replaced.bearer}`,
      };
    },
  );

  app.delete<{ Params: { connectionId: string } }>("/:connectionId", async (request, reply) => {
    const { connection, scope } = await requireGitlabConnectionAccess(request, app.db, "admin");
    await deleteGitlabConnection(app.db, connection.id, scope.memberId);
    return reply.status(204).send();
  });
}
