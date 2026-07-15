import { gitlabConnectionCreateSchema } from "@first-tree/shared";
import type { FastifyInstance } from "fastify";
import { BadRequestError } from "../../errors.js";
import { requireOrgAdmin, requireOrgMembership } from "../../scope/require-org.js";
import {
  createGitlabConnection,
  getGitlabConnectionSummary,
  listGitlabConnections,
} from "../../services/gitlab-connections.js";
import { resolvePublicUrl } from "../../utils/public-url.js";

export async function orgGitlabConnectionRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { orgId: string } }>("/", async (request) => {
    const scope = await requireOrgMembership(request, app.db);
    return { connections: await listGitlabConnections(app.db, scope.organizationId) };
  });

  app.post<{ Params: { orgId: string } }>("/", { config: { otelRecordBody: true } }, async (request, reply) => {
    const scope = await requireOrgAdmin(request, app.db);
    const body = gitlabConnectionCreateSchema.parse(request.body);
    let created: Awaited<ReturnType<typeof createGitlabConnection>>;
    try {
      created = await createGitlabConnection(app.db, {
        organizationId: scope.organizationId,
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
    return reply.status(201).send({
      connection: await getGitlabConnectionSummary(app.db, created.connectionId),
      webhookUrl: `${resolvePublicUrl(app, request)}/api/v1/webhooks/gitlab/${created.bearer}`,
    });
  });
}
