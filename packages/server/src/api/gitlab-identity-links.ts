import { gitlabIdentityLinkTransitionSchema } from "@first-tree/shared";
import type { FastifyInstance } from "fastify";
import { requireGitlabIdentityLinkAccess } from "../scope/require-resource.js";
import {
  reconfirmGitlabIdentityLink,
  revokeGitlabIdentityLink,
  suspendGitlabIdentityLink,
} from "../services/gitlab-identities.js";

/** Class C — lifecycle transitions for one GitLab identity link. */
export async function gitlabIdentityLinkRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { linkId: string } }>("/:linkId/suspend", async (request) => {
    const { link, scope } = await requireGitlabIdentityLinkAccess(request, app.db);
    const body = gitlabIdentityLinkTransitionSchema.parse(request.body ?? {});
    return suspendGitlabIdentityLink(app.db, {
      organizationId: link.organizationId,
      linkId: link.id,
      actorMemberId: scope.memberId,
      reason: body.reason,
    });
  });

  app.post<{ Params: { linkId: string } }>("/:linkId/revoke", async (request) => {
    const { link, scope } = await requireGitlabIdentityLinkAccess(request, app.db);
    const body = gitlabIdentityLinkTransitionSchema.parse(request.body ?? {});
    return revokeGitlabIdentityLink(app.db, {
      organizationId: link.organizationId,
      linkId: link.id,
      actorMemberId: scope.memberId,
      reason: body.reason,
    });
  });

  app.post<{ Params: { linkId: string } }>("/:linkId/reconfirm", async (request) => {
    const { link, scope } = await requireGitlabIdentityLinkAccess(request, app.db);
    const body = gitlabIdentityLinkTransitionSchema.parse(request.body ?? {});
    return reconfirmGitlabIdentityLink(app.db, {
      organizationId: link.organizationId,
      linkId: link.id,
      actorMemberId: scope.memberId,
      reason: body.reason,
    });
  });
}
