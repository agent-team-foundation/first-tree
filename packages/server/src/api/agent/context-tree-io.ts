import { agentContextTreeIoQuerySchema } from "@first-tree/shared";
import type { FastifyInstance } from "fastify";
import { BadRequestError } from "../../errors.js";
import { requireAgent } from "../../middleware/require-identity.js";
import { listAgentContextTreeIoEvents } from "../../services/context-tree-io.js";

export async function agentContextTreeIoRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Class D — `GET /api/v1/agent/context-tree/io`.
   *
   * The authenticated runtime agent's own durable Context Tree read/write
   * facts, newest first. `context_tree_io_events` outlives `session_events`
   * (dropped on session terminate / runtime switch), so this stays answerable
   * for historical work whose surrounding decision stream is already gone.
   *
   * Deliberately self-scoped: an agent reads its own IO, never another
   * agent's. Org-wide aggregation stays on the member-authenticated
   * `/orgs/:orgId/context-tree/snapshot` endpoint.
   */
  app.get("/context-tree/io", async (request) => {
    const identity = requireAgent(request);
    const parsed = agentContextTreeIoQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw new BadRequestError(`Invalid Context Tree IO query: ${parsed.error.issues[0]?.message ?? "bad request"}`);
    }
    const query = parsed.data;
    const since = query.since ? new Date(query.since) : undefined;
    const until = query.until ? new Date(query.until) : undefined;
    if (since && until && since > until) {
      throw new BadRequestError("Context Tree IO `since` must not be after `until`");
    }
    return await listAgentContextTreeIoEvents(app.db, {
      organizationId: identity.organizationId,
      agentId: identity.uuid,
      chatId: query.chatId,
      action: query.action,
      since,
      until,
      limit: query.limit,
      cursor: query.cursor,
    });
  });
}
