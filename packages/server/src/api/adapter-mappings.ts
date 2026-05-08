import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { adapterAgentMappings } from "../db/schema/adapter-agent-mappings.js";
import { BadRequestError, NotFoundError } from "../errors.js";
import { assertAgentManageableByUser } from "../scope/require-resource.js";
import { requireUser } from "../scope/require-user.js";

/** Class C — `/api/v1/adapter-mappings/:id`. Mapping id resolves the bound
 * agent, which locates the org. */
export async function adapterMappingRoutes(app: FastifyInstance): Promise<void> {
  app.delete<{ Params: { id: string } }>("/:id", async (request, reply) => {
    const { userId } = requireUser(request);
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      throw new BadRequestError(`Invalid mapping ID: "${request.params.id}"`);
    }
    const [existing] = await app.db.select().from(adapterAgentMappings).where(eq(adapterAgentMappings.id, id)).limit(1);
    if (!existing) throw new NotFoundError(`Adapter mapping "${id}" not found`);
    await assertAgentManageableByUser(app.db, userId, existing.agentId);
    await app.db.delete(adapterAgentMappings).where(eq(adapterAgentMappings.id, id));
    return reply.status(204).send();
  });
}
