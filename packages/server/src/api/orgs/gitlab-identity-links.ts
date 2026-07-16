import { gitlabIdentityLinkCreateSchema } from "@first-tree/shared";
import type { FastifyInstance } from "fastify";
import { requireOrgAdmin } from "../../scope/require-org.js";
import { createGitlabIdentityLink, listGitlabIdentityLinks } from "../../services/gitlab-identities.js";

/** Class B — admin-only GitLab username bindings for one organization. */
export async function orgGitlabIdentityLinkRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { orgId: string } }>("/", async (request) => {
    const scope = await requireOrgAdmin(request, app.db);
    return { links: await listGitlabIdentityLinks(app.db, scope.organizationId) };
  });

  app.post<{ Params: { orgId: string } }>("/", async (request, reply) => {
    const scope = await requireOrgAdmin(request, app.db);
    const body = gitlabIdentityLinkCreateSchema.parse(request.body);
    const link = await createGitlabIdentityLink(app.db, {
      organizationId: scope.organizationId,
      connectionId: body.connectionId,
      membershipId: body.membershipId,
      username: body.username,
    });
    return reply.status(201).send(link);
  });
}
