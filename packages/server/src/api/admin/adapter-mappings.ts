import { createAdapterMappingSchema } from "@agent-team-foundation/first-tree-hub-shared";
import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { adapterAgentMappings } from "../../db/schema/adapter-agent-mappings.js";
import { agents } from "../../db/schema/agents.js";
import { BadRequestError, NotFoundError } from "../../errors.js";
import { assertCanManage, memberScope } from "../../services/access-control.js";
import { createAgentMapping } from "../../services/adapter-mapping.js";

function parseId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new BadRequestError(`Invalid mapping ID: "${raw}"`);
  }
  return id;
}

export async function adminAdapterMappingRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async (request) => {
    // M2 org scope: adapter_agent_mappings has no organization_id column,
    // so we JOIN agents to filter by the caller's org. Without this JOIN,
    // a cross-tenant admin could list every other org's mappings.
    //
    // Post hub-ui-polish: non-admin callers see only mappings for agents
    // they manage; admins see every mapping in the org. The backend has to
    // enforce this even when the UI hides the edit button — admin-only
    // has been removed from the route hook.
    const scope = memberScope(request);
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
    return rows.map((r) => ({
      id: r.id,
      platform: r.platform,
      externalUserId: r.externalUserId,
      agentId: r.agentId,
      boundVia: r.boundVia,
      displayName: r.displayName,
      createdAt: r.createdAt.toISOString(),
    }));
  });

  app.post("/", async (request, reply) => {
    const body = createAdapterMappingSchema.parse(request.body);
    const scope = memberScope(request);
    await assertCanManage(app.db, scope, body.agentId);

    // Validate agent exists and is human type
    const [agent] = await app.db
      .select({ id: agents.uuid, type: agents.type, status: agents.status })
      .from(agents)
      .where(eq(agents.uuid, body.agentId))
      .limit(1);
    if (!agent || agent.status === "deleted") {
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

    return reply.status(201).send({
      id: row.id,
      platform: row.platform,
      externalUserId: row.externalUserId,
      agentId: row.agentId,
      boundVia: row.boundVia,
      displayName: row.displayName,
      createdAt: row.createdAt.toISOString(),
    });
  });

  app.delete<{ Params: { id: string } }>("/:id", async (request, reply) => {
    const id = parseId(request.params.id);
    // Look up the mapping to find its agentId for authorization
    const [existing] = await app.db.select().from(adapterAgentMappings).where(eq(adapterAgentMappings.id, id)).limit(1);
    if (!existing) throw new NotFoundError(`Adapter mapping "${id}" not found`);
    const scope = memberScope(request);
    await assertCanManage(app.db, scope, existing.agentId);
    await app.db.delete(adapterAgentMappings).where(eq(adapterAgentMappings.id, id));
    return reply.status(204).send();
  });
}
