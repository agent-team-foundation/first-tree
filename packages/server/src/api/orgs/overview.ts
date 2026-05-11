import { and, eq, ne, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { agents } from "../../db/schema/agents.js";
import { chats } from "../../db/schema/chats.js";
import { requireOrgMembership } from "../../scope/require-org.js";
import * as presenceService from "../../services/presence.js";

/** Class B — `/api/v1/orgs/:orgId/overview`. */
export async function orgOverviewRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { orgId: string } }>("/", async (request) => {
    const scope = await requireOrgMembership(request, app.db);

    const [agentCount] = await app.db
      .select({ count: sql<number>`count(*)::int` })
      .from(agents)
      .where(and(ne(agents.status, "deleted"), eq(agents.organizationId, scope.organizationId)));

    const [chatCount] = await app.db
      .select({ count: sql<number>`count(*)::int` })
      .from(chats)
      .where(eq(chats.organizationId, scope.organizationId));

    // TODO(multi-org): getOnlineCount is global — JOIN agents by org when needed.
    const onlineCount = await presenceService.getOnlineCount(app.db);

    return {
      agents: agentCount?.count ?? 0,
      onlineAgents: onlineCount,
      chats: chatCount?.count ?? 0,
    };
  });
}
