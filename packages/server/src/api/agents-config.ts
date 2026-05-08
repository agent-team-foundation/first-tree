import {
  dryRunAgentRuntimeConfigSchema,
  updateAgentRuntimeConfigSchema,
} from "@agent-team-foundation/first-tree-hub-shared";
import type { FastifyInstance } from "fastify";
import { requireAgentAccess } from "../scope/require-resource.js";

/**
 * Class C — `/api/v1/agents/:uuid/config`. Runtime config (system prompt,
 * tools, env) is behavior-sensitive — gated on `manage`, not `visible`.
 */
export async function agentConfigRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { uuid: string } }>("/:uuid/config", async (request) => {
    await requireAgentAccess(request, app.db, "manage");
    return app.configService.get(request.params.uuid);
  });

  app.patch<{ Params: { uuid: string } }>("/:uuid/config", { config: { otelRecordBody: true } }, async (request) => {
    const { scope } = await requireAgentAccess(request, app.db, "manage");
    const body = updateAgentRuntimeConfigSchema.parse(request.body);
    return app.configService.update(request.params.uuid, body, scope.memberId);
  });

  app.post<{ Params: { uuid: string } }>(
    "/:uuid/config/dry-run",
    { config: { otelRecordBody: true } },
    async (request) => {
      await requireAgentAccess(request, app.db, "manage");
      const body = dryRunAgentRuntimeConfigSchema.parse(request.body);
      return app.configService.dryRun(request.params.uuid, body.payload);
    },
  );

  app.get<{ Params: { uuid: string } }>("/:uuid/client-status", async (request) => {
    const { agent } = await requireAgentAccess(request, app.db, "visible");
    const { eq } = await import("drizzle-orm");
    const { agentPresence } = await import("../db/schema/agent-presence.js");

    const [presence] = await app.db
      .select({ status: agentPresence.status, lastSeenAt: agentPresence.lastSeenAt })
      .from(agentPresence)
      .where(eq(agentPresence.agentId, agent.uuid))
      .limit(1);

    const online = presence?.status === "online";
    return {
      online,
      clientId: agent.clientId ?? null,
      offlineSince: !online && presence?.lastSeenAt ? presence.lastSeenAt.toISOString() : null,
    };
  });
}
