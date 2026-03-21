import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { agents } from "../../db/schema/agents.js";
import { chats } from "../../db/schema/chats.js";
import * as presenceService from "../../services/presence.js";

export async function adminOverviewRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async () => {
    const [agentCount] = await app.db.select({ count: sql<number>`count(*)::int` }).from(agents);

    const [chatCount] = await app.db.select({ count: sql<number>`count(*)::int` }).from(chats);

    const onlineCount = await presenceService.getOnlineCount(app.db);

    return {
      agents: agentCount?.count ?? 0,
      onlineAgents: onlineCount,
      chats: chatCount?.count ?? 0,
    };
  });
}
