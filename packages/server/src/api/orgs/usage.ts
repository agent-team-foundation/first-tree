import type { UsageByAgentResponse } from "@first-tree/shared";
import type { FastifyInstance } from "fastify";
import { requireOrgMembership } from "../../scope/require-org.js";
import * as usageService from "../../services/usage.js";

/**
 * Class B — `/api/v1/orgs/:orgId/usage/*`
 *
 * Org-scoped aggregate views. Aggregate numbers are visible to any org
 * member (sociocurrency principle: work volume is public within the
 * team); chat-name gating happens on the agent-level endpoints where
 * individual turns are exposed.
 */
export async function orgUsageRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { orgId: string }; Querystring: { from?: string; to?: string } }>("/by-agent", async (request) => {
    const scope = await requireOrgMembership(request, app.db);
    const { from, to } = usageService.resolveUsageWindow(request.query, { days: 30 });
    const rows = await usageService.aggregateByAgent(app.db, {
      organizationId: scope.organizationId,
      from,
      to,
    });
    const response: UsageByAgentResponse = {
      from: from.toISOString(),
      to: to.toISOString(),
      rows,
    };
    return response;
  });
}
