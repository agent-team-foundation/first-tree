import type { FastifyInstance } from "fastify";
import { requireAgentAccess } from "../scope/require-resource.js";
import * as usageService from "../services/usage.js";

/**
 * Class C — `/api/v1/agents/:uuid/usage/*`
 *
 * Agent-scoped usage views: KPI summary (with 90d activity grid) and the
 * paginated per-turn list. `requireAgentAccess(visible)` is used because
 * agent usage is *visible* to any org member (sociocurrency); `manage` is
 * reserved for actions that mutate or expose private config.
 *
 * Turn-list rows have their `chatTitle` gated by the caller's
 * `humanAgentId` participation in each chat — aggregate token counts stay
 * visible, but chat names are participant-only.
 */
export async function agentUsageRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { uuid: string }; Querystring: { from?: string; to?: string } }>(
    "/:uuid/usage/summary",
    async (request) => {
      await requireAgentAccess(request, app.db, "visible");
      const { from, to } = usageService.resolveUsageWindow(request.query, { days: 30 });
      return usageService.summarizeAgent(app.db, {
        agentId: request.params.uuid,
        from,
        to,
      });
    },
  );

  app.get<{
    Params: { uuid: string };
    Querystring: { from?: string; to?: string; cursor?: string; limit?: string };
  }>("/:uuid/usage/turns", async (request) => {
    const { scope } = await requireAgentAccess(request, app.db, "visible");
    const { from, to } = usageService.resolveUsageWindow(request.query, { days: 30 });
    const limit = request.query.limit
      ? Number.parseInt(request.query.limit, 10)
      : usageService.DEFAULT_USAGE_TURNS_LIMIT;
    return usageService.listAgentTurns(app.db, {
      agentId: request.params.uuid,
      from,
      to,
      cursor: request.query.cursor ?? null,
      limit: Number.isFinite(limit) ? limit : usageService.DEFAULT_USAGE_TURNS_LIMIT,
      viewer: { humanAgentId: scope.humanAgentId },
    });
  });
}
