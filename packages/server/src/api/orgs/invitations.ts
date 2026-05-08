import type { FastifyInstance } from "fastify";
import { requireOrgAdmin } from "../../scope/require-org.js";
import { buildInviteUrl, ensureActiveInvitation, rotateInvitation } from "../../services/invitation.js";
import { resolvePublicUrl } from "../../utils/public-url.js";

/** Class B — `/api/v1/orgs/:orgId/invitations`. Admin-only. */
export async function orgInvitationRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { orgId: string } }>("/", async (request) => {
    const scope = await requireOrgAdmin(request, app.db);
    const inv = await ensureActiveInvitation(app.db, scope.organizationId, scope.userId);
    return {
      id: inv.id,
      organizationId: inv.organizationId,
      token: inv.token,
      inviteUrl: buildInviteUrl(resolvePublicUrl(app, request), inv.token),
      role: inv.role,
      createdAt: inv.createdAt.toISOString(),
      expiresAt: inv.expiresAt ? inv.expiresAt.toISOString() : null,
    };
  });

  app.post<{ Params: { orgId: string } }>("/rotate", async (request) => {
    const scope = await requireOrgAdmin(request, app.db);
    const inv = await rotateInvitation(app.db, scope.organizationId, scope.userId);
    return {
      id: inv.id,
      organizationId: inv.organizationId,
      token: inv.token,
      inviteUrl: buildInviteUrl(resolvePublicUrl(app, request), inv.token),
      role: inv.role,
      createdAt: inv.createdAt.toISOString(),
      expiresAt: inv.expiresAt ? inv.expiresAt.toISOString() : null,
    };
  });
}
