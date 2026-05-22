import { createAdapterMappingSchema } from "@first-tree/shared";
import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { adapterAgentMappings } from "../../db/schema/adapter-agent-mappings.js";
import { agents } from "../../db/schema/agents.js";
import { BadRequestError, NotFoundError } from "../../errors.js";
import { requireOrgMembership } from "../../scope/require-org.js";
import { assertAgentManageableByUser } from "../../scope/require-resource.js";
import { createAgentMapping } from "../../services/adapter-mapping.js";

/**
 * Class B — `/api/v1/orgs/:orgId/adapter-mappings`. Non-admins see
 * mappings for agents they manage; admins see every mapping in the org.
 */
export async function orgAdapterMappingRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { orgId: string } }>("/", async (request) => {
    const scope = await requireOrgMembership(request, app.db);
    const conditions = [eq(agents.organizationId, scope.organizationId)];
    if (scope.role !== "admin") {
      conditions.push(eq(agents.managerId, scope.memberId));
    }
    const rows = await app.db
      .select({
        id: adapterAgentMappings.id,
        platform: adapterAgentMappings.platform,
        externalUserId: adapterAgentMappings.externalUserId,
        agentId: adapterAgentMappings.agentId,
        boundVia: adapterAgentMappings.boundVia,
        displayName: adapterAgentMappings.displayName,
        createdAt: adapterAgentMappings.createdAt,
      })
      .from(adapterAgentMappings)
      .innerJoin(agents, eq(agents.uuid, adapterAgentMappings.agentId))
      .where(and(...conditions))
      .orderBy(desc(adapterAgentMappings.createdAt));
    return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
  });

  app.post<{ Params: { orgId: string } }>("/", { config: { otelRecordBody: true } }, async (request, reply) => {
    const scope = await requireOrgMembership(request, app.db);
    const body = createAdapterMappingSchema.parse(request.body);
    await assertAgentManageableByUser(app.db, scope.userId, body.agentId);

    const [agent] = await app.db
      .select({ id: agents.uuid, type: agents.type, status: agents.status, organizationId: agents.organizationId })
      .from(agents)
      .where(eq(agents.uuid, body.agentId))
      .limit(1);
    if (!agent || agent.status === "deleted") throw new NotFoundError(`Agent "${body.agentId}" not found`);
    if (agent.organizationId !== scope.organizationId) {
      throw new NotFoundError(`Agent "${body.agentId}" not found`);
    }
    if (agent.type !== "human") {
      throw new BadRequestError("User bindings can only be created for human agents");
    }

    const row = await createAgentMapping(app.db, {
      platform: body.platform,
      externalUserId: body.externalUserId,
      agentId: body.agentId,
      boundVia: body.boundVia ?? "manual",
      displayName: body.displayName,
    });

    return reply.status(201).send({ ...row, createdAt: row.createdAt.toISOString() });
  });
}
