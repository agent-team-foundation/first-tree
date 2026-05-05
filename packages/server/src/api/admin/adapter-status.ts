import { and, eq, ne } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { adapterConfigs } from "../../db/schema/adapter-configs.js";
import { agents } from "../../db/schema/agents.js";
import { memberScope, requireMemberInOrg } from "../../services/access-control.js";

const orgQuerySchema = z.object({ organizationId: z.string().min(1).optional() });

export async function adminAdapterStatusRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async (request) => {
    // Bot runtime statuses are shared state in the AdapterManager singleton.
    // Mask them to the set of configs the caller has scope for so a
    // non-admin member can't see connection/health info for adapters bound
    // to agents owned by another member.
    const scope = memberScope(request);
    const { organizationId } = orgQuerySchema.parse(request.query);
    const targetOrgId = organizationId ?? scope.organizationId;
    // Realtime role probe — JWT role claim is a hint only
    // (decouple-client-from-identity §4.5). Cross-org via `?organizationId=`
    // (codex P1 #2).
    const probe = await requireMemberInOrg(app.db, request, targetOrgId);
    const conditions = [eq(agents.organizationId, targetOrgId), ne(agents.status, "deleted")];
    if (probe.role !== "admin") {
      conditions.push(eq(agents.managerId, probe.memberId));
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
