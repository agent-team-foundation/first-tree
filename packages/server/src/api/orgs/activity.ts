import type { FastifyInstance } from "fastify";
import { requireOrgMembership } from "../../scope/require-org.js";
import * as activityService from "../../services/activity.js";

/** Class B — `/api/v1/orgs/:orgId/activity`. */
export async function orgActivityRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { orgId: string } }>("/", async (request) => {
    const scope = await requireOrgMembership(request, app.db);
    const overview = await activityService.getActivityOverview(app.db);
    const runningAgents = await activityService.listAgentsWithRuntime(app.db, scope);

    return {
      ...overview,
      agents: runningAgents.map((a) => ({
        agentId: a.agentId,
        clientId: a.clientId,
        runtimeType: a.runtimeType,
        runtimeState: a.runtimeState,
        activeSessions: a.activeSessions,
        totalSessions: a.totalSessions,
        runtimeUpdatedAt: a.runtimeUpdatedAt?.toISOString() ?? null,
        type: "type" in a ? a.type : null,
        // Whether the caller's member personally manages this agent. Used by
        // the workspace new-chat view to scope the default-seed agent to
        // agents the caller manages (rather than any org-visible agent).
        managedByMe: "managerId" in a ? a.managerId === scope.memberId : false,
      })),
    };
  });
}
