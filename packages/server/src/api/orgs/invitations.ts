import type { FastifyInstance } from "fastify";
import { requireOrgAdmin, requireOrgMembership } from "../../scope/require-org.js";
import { buildInviteUrl, ensureActiveInvitation, rotateInvitation } from "../../services/invitation.js";
import { resolvePublicUrl } from "../../utils/public-url.js";

/**
 * Class B — `/api/v1/orgs/:orgId/invitations`.
 *
 * Reading/sharing the invite link is a member-level capability — inviting
 * more people into a team is core to every member's job (issue 836). Rotation
 * (revoke + replace) stays admin-only because it is a destructive lifecycle
 * act that invalidates the link everyone else may already be sharing.
 */
export async function orgInvitationRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { orgId: string } }>("/", async (request) => {
    const scope = await requireOrgMembership(request, app.db);
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
