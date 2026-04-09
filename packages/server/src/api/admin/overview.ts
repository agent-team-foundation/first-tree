import { and, eq, ne, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { agents } from "../../db/schema/agents.js";
import { chats } from "../../db/schema/chats.js";
import * as presenceService from "../../services/presence.js";

export async function adminOverviewRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async (request) => {
    const org = ((request.query ?? {}) as Record<string, string>).org ?? "default";

    const [agentCount] = await app.db
      .select({ count: sql<number>`count(*)::int` })
      .from(agents)
      .where(and(ne(agents.status, "deleted"), eq(agents.organizationId, org)));

    const [chatCount] = await app.db
      .select({ count: sql<number>`count(*)::int` })
      .from(chats)
      .where(eq(chats.organizationId, org));

    // TODO(multi-org): getOnlineCount is global — JOIN agents to filter by org when MULTI_ORG is implemented
    const onlineCount = await presenceService.getOnlineCount(app.db);

    return {
      agents: agentCount?.count ?? 0,
      onlineAgents: onlineCount,
      chats: chatCount?.count ?? 0,
    };
  });
}
