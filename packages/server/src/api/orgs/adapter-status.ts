import { and, eq, ne } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { adapterConfigs } from "../../db/schema/adapter-configs.js";
import { agents } from "../../db/schema/agents.js";
import { requireOrgMembership } from "../../scope/require-org.js";

/** Class B — `/api/v1/orgs/:orgId/adapters/status`. */
export async function orgAdapterStatusRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { orgId: string } }>("/", async (request) => {
    const scope = await requireOrgMembership(request, app.db);
    const conditions = [eq(agents.organizationId, scope.organizationId), ne(agents.status, "deleted")];
    if (scope.role !== "admin") conditions.push(eq(agents.managerId, scope.memberId));
    const visibleRows = await app.db
      .select({ id: adapterConfigs.id })
      .from(adapterConfigs)
      .innerJoin(agents, eq(agents.uuid, adapterConfigs.agentId))
      .where(and(...conditions));
    const visibleIds = new Set(visibleRows.map((r) => r.id));
    if (visibleIds.size === 0) return [];
    const all = app.adapterManager.getBotStatuses();
    return all.filter((s) => visibleIds.has(s.configId));
  });
}
