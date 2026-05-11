import { paginationQuerySchema } from "@agent-team-foundation/first-tree-hub-shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireOrgMembership } from "../../scope/require-org.js";
import * as sessionService from "../../services/session.js";

const sessionListFilter = paginationQuerySchema.extend({
  state: z.enum(["active", "suspended", "evicted"]).optional(),
  agentId: z.string().optional(),
});

/** Class B — `/api/v1/orgs/:orgId/sessions`. */
export async function orgSessionRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { orgId: string } }>("/", async (request) => {
    const scope = await requireOrgMembership(request, app.db);
    const query = sessionListFilter.parse(request.query);
    return sessionService.listAllSessions(app.db, query.limit, query.cursor, {
      state: query.state,
      agentId: query.agentId,
      organizationId: scope.organizationId,
    });
  });
}
