import { AGENT_STATUSES, AGENT_VISIBILITY } from "@first-tree/shared";
import { and, eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { members } from "../db/schema/members.js";
import { resources } from "../db/schema/resources.js";
import { NotFoundError } from "../errors.js";
import { requireUser } from "./require-user.js";
import type { OrgScope } from "./types.js";

type ResourceAccessRow = typeof resources.$inferSelect;

async function resolveCallerInOrg(
  db: Database,
  userId: string,
  orgId: string,
): Promise<{ memberId: string; role: "admin" | "member"; humanAgentId: string }> {
  const [row] = await db
    .select({ id: members.id, role: members.role, agentId: members.agentId })
    .from(members)
    .where(and(eq(members.userId, userId), eq(members.organizationId, orgId), eq(members.status, "active")))
    .limit(1);
  if (!row || (row.role !== "admin" && row.role !== "member")) throw new NotFoundError("Resource not found");
  return { memberId: row.id, role: row.role, humanAgentId: row.agentId };
}

export async function requireResourceAccess(
  request: FastifyRequest<{ Params: { resourceId: string } }>,
  db: Database,
  kind: "read" | "write",
): Promise<{ resource: ResourceAccessRow; scope: OrgScope }> {
  const { userId } = requireUser(request);
  const [resource] = await db.select().from(resources).where(eq(resources.id, request.params.resourceId)).limit(1);
  if (!resource || resource.status === "retired") throw new NotFoundError("Resource not found");

  const caller = await resolveCallerInOrg(db, userId, resource.organizationId);
  const scope: OrgScope = {
    userId,
    organizationId: resource.organizationId,
    memberId: caller.memberId,
    role: caller.role,
    humanAgentId: caller.humanAgentId,
  };

  if (resource.scope === "team") {
    if (kind === "write" && caller.role !== "admin") throw new NotFoundError("Resource not found");
    return { resource, scope };
  }

  if (resource.scope !== "agent" || resource.type !== "repo" || !resource.ownerAgentId) {
    throw new NotFoundError("Resource not found");
  }

  const [agent] = await db
    .select({
      uuid: agents.uuid,
      organizationId: agents.organizationId,
      managerId: agents.managerId,
      status: agents.status,
      visibility: agents.visibility,
    })
    .from(agents)
    .where(eq(agents.uuid, resource.ownerAgentId))
    .limit(1);
  if (!agent || agent.status === AGENT_STATUSES.DELETED || agent.organizationId !== resource.organizationId) {
    throw new NotFoundError("Resource not found");
  }

  const isAdmin = caller.role === "admin";
  const isManager = agent.managerId === caller.memberId;
  if (kind === "write") {
    if (!isAdmin && !isManager) throw new NotFoundError("Resource not found");
    return { resource, scope };
  }

  const orgVisible = agent.visibility === AGENT_VISIBILITY.ORGANIZATION;
  if (!orgVisible && !isManager && !isAdmin) throw new NotFoundError("Resource not found");
  return { resource, scope };
}
