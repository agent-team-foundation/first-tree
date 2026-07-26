import type { FastifyInstance } from "fastify";
import { requireGitlabIdentityLinkAccess } from "../scope/require-resource.js";
import { reconfirmGitlabIdentityLink, removeGitlabIdentityLink } from "../services/gitlab-identities.js";

/** Class C — lifecycle transitions for one GitLab identity link. */
export async function gitlabIdentityLinkRoutes(app: FastifyInstance): Promise<void> {
  app.delete<{ Params: { linkId: string } }>("/:linkId", async (request, reply) => {
    const { link } = await requireGitlabIdentityLinkAccess(request, app.db);
    await removeGitlabIdentityLink(app.db, {
      organizationId: link.organizationId,
      linkId: link.id,
    });
    return reply.status(204).send();
  });

  app.post<{ Params: { linkId: string } }>("/:linkId/reconfirm", async (request) => {
    const { link } = await requireGitlabIdentityLinkAccess(request, app.db);
    return reconfirmGitlabIdentityLink(app.db, {
      organizationId: link.organizationId,
      linkId: link.id,
    });
  });
}
