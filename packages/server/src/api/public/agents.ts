import { paginationQuerySchema } from "@agent-team-foundation/first-tree-hub-shared";
import { and, desc, eq, lt } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { agents } from "../../db/schema/agents.js";

/** Public agent discovery — returns only agents with public=true. No auth required. */
export async function publicAgentRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async (request) => {
    const query = paginationQuerySchema.parse(request.query);
    const org = (request.query as Record<string, string>).org;

    const conditions = [eq(agents.public, true), eq(agents.status, "active")];
    if (org) conditions.push(eq(agents.organizationId, org));
    if (query.cursor) conditions.push(lt(agents.createdAt, new Date(query.cursor)));
    const where = and(...conditions);

    const rows = await app.db
      .select({
        uuid: agents.uuid,
        name: agents.name,
        organizationId: agents.organizationId,
        type: agents.type,
        displayName: agents.displayName,
        profile: agents.profile,
        createdAt: agents.createdAt,
      })
      .from(agents)
      .where(where)
      .orderBy(desc(agents.createdAt))
      .limit(query.limit + 1);

    const hasMore = rows.length > query.limit;
    const items = hasMore ? rows.slice(0, query.limit) : rows;
    const last = items[items.length - 1];
    const nextCursor = hasMore && last ? last.createdAt.toISOString() : null;

    return { items, nextCursor };
  });
}
