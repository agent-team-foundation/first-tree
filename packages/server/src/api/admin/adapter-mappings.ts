import { createAdapterMappingSchema } from "@first-tree-core/shared";
import { desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { adapterAgentMappings } from "../../db/schema/adapter-agent-mappings.js";
import { agents } from "../../db/schema/agents.js";
import { BadRequestError, NotFoundError } from "../../errors.js";
import { createAgentMapping } from "../../services/adapter-mapping.js";

function parseId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new BadRequestError(`Invalid mapping ID: "${raw}"`);
  }
  return id;
}

export async function adminAdapterMappingRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async () => {
    const rows = await app.db.select().from(adapterAgentMappings).orderBy(desc(adapterAgentMappings.createdAt));
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

    // Validate agent exists and is human type
    const [agent] = await app.db
      .select({ id: agents.id, type: agents.type, status: agents.status })
      .from(agents)
      .where(eq(agents.id, body.agentId))
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
    const [row] = await app.db.delete(adapterAgentMappings).where(eq(adapterAgentMappings.id, id)).returning();
    if (!row) throw new NotFoundError(`Adapter mapping "${id}" not found`);
    return reply.status(204).send();
  });
}
