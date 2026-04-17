import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { agentPresence } from "../../db/schema/agent-presence.js";
import { agents } from "../../db/schema/agents.js";
import { assertAgentVisible, memberScope } from "../../services/access-control.js";

/**
 * Step 10: per-agent client connectivity probe.
 *
 * The pinned `clientId` is sourced from `agents.client_id` (the authoritative
 * pin), not from `agent_presence.client_id` — presence is cleared on
 * disconnect, which would otherwise make an offline-but-pinned agent look
 * unclaimed. Presence is consulted only for liveness (`status` + `lastSeenAt`).
 */
export async function adminAgentClientStatusRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { uuid: string } }>("/:uuid/client-status", async (request) => {
    const { uuid } = request.params;
    await assertAgentVisible(app.db, memberScope(request), uuid);

    const [agent] = await app.db
      .select({ clientId: agents.clientId })
      .from(agents)
      .where(eq(agents.uuid, uuid))
      .limit(1);

    const [presence] = await app.db
      .select({ status: agentPresence.status, lastSeenAt: agentPresence.lastSeenAt })
      .from(agentPresence)
      .where(eq(agentPresence.agentId, uuid))
      .limit(1);

    const online = presence?.status === "online";
    return {
      online,
      clientId: agent?.clientId ?? null,
      offlineSince: !online && presence?.lastSeenAt ? presence.lastSeenAt.toISOString() : null,
    };
  });
}
