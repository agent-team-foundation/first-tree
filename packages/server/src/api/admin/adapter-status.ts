import { and, eq, ne } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { adapterConfigs } from "../../db/schema/adapter-configs.js";
import { agents } from "../../db/schema/agents.js";
import { memberScope } from "../../services/access-control.js";

export async function adminAdapterStatusRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async (request) => {
    // Bot runtime statuses are shared state in the AdapterManager singleton.
    // Mask them to the set of configs the caller has scope for so a
    // non-admin member can't see connection/health info for adapters bound
    // to agents owned by another member.
    const scope = memberScope(request);
    const conditions = [eq(agents.organizationId, scope.organizationId), ne(agents.status, "deleted")];
    if (scope.role !== "admin") {
      conditions.push(eq(agents.managerId, scope.memberId));
    }
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
