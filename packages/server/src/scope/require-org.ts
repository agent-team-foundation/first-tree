import { and, eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { Database } from "../db/connection.js";
import { members } from "../db/schema/members.js";
import { organizations } from "../db/schema/organizations.js";
import { ForbiddenError } from "../errors.js";
import { stampOrgScope } from "../observability/request-context.js";
import { requireUser } from "./require-user.js";
import type { OrgScope } from "./types.js";

/**
 * Resolve the caller's active membership in `:orgId` (from the URL) and
 * return the full `OrgScope`. The type signature requires
 * `Params: { orgId: string }`, which is the structural enforcement for
 * Class B routes — calling this on a route without `:orgId` in the URL
 * fails to compile.
 *
 * Authorization is real-time: the membership row is read at every request,
 * so a revoked membership starts returning 403 immediately (no JWT
 * invalidation needed).
 */
export async function requireOrgMembership(
  request: FastifyRequest<{ Params: { orgId: string } }>,
  db: Database,
): Promise<OrgScope> {
  const { userId } = requireUser(request);
  const { orgId } = request.params;

  const [row] = await db
    .select({ id: members.id, role: members.role, agentId: members.agentId })
    .from(members)
    .innerJoin(organizations, eq(members.organizationId, organizations.id))
    .where(
      and(
        eq(members.userId, userId),
        eq(members.organizationId, orgId),
        eq(members.status, "active"),
        eq(organizations.status, "active"),
      ),
    )
    .limit(1);

  if (!row) {
    throw new ForbiddenError("Not an active member of this organization");
  }

  if (row.role !== "admin" && row.role !== "member") {
    // Drizzle column type widens to string; pin the union here so callers
    // can treat OrgScope.role as a literal type.
    throw new ForbiddenError("Membership has unknown role");
  }

  const scope: OrgScope = {
    userId,
    organizationId: orgId,
    memberId: row.id,
    role: row.role,
    humanAgentId: row.agentId,
  };
  stampOrgScope(request, scope);
  return scope;
}

/**
 * Like `requireOrgMembership`, but additionally enforces admin role.
 * Use for org-admin-only routes (invitations, etc.).
 */
export async function requireOrgAdmin(
  request: FastifyRequest<{ Params: { orgId: string } }>,
  db: Database,
): Promise<OrgScope> {
  const scope = await requireOrgMembership(request, db);
  if (scope.role !== "admin") {
    throw new ForbiddenError("Admin role required for this organization");
  }
  return scope;
}
