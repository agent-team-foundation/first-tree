import { and, eq, ne, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { agents } from "../../db/schema/agents.js";
import { chats } from "../../db/schema/chats.js";
import { resolveDefaultOrgId, resolveOrganization } from "../../services/organization.js";
import * as presenceService from "../../services/presence.js";

export async function adminOverviewRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async (request) => {
    // Both `?org=` (legacy) and `?organizationId=` (web's PR-D query — codex
    // P1 #2 fix). Falls back to JWT default org when neither is supplied.
    const q = (request.query ?? {}) as Record<string, string>;
    const orgParam = q.organizationId ?? q.org;
    let orgId: string;
    if (orgParam) {
      const resolved = await resolveOrganization(app.db, orgParam);
      orgId = resolved.id;
    } else {
      orgId = await resolveDefaultOrgId(app.db);
    }

    const [agentCount] = await app.db
      .select({ count: sql<number>`count(*)::int` })
      .from(agents)
      .where(and(ne(agents.status, "deleted"), eq(agents.organizationId, orgId)));

    const [chatCount] = await app.db
      .select({ count: sql<number>`count(*)::int` })
      .from(chats)
      .where(eq(chats.organizationId, orgId));

    // TODO(multi-org): getOnlineCount is global — JOIN agents to filter by org when MULTI_ORG is implemented
    const onlineCount = await presenceService.getOnlineCount(app.db);

    return {
      agents: agentCount?.count ?? 0,
      onlineAgents: onlineCount,
      chats: chatCount?.count ?? 0,
    };
  });
}
