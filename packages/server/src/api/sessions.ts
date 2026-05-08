import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAgentAccess, requireChatAccess } from "../scope/require-resource.js";
import * as agentService from "../services/agent.js";
import { sendToAgent } from "../services/connection-manager.js";
import * as sessionService from "../services/session.js";
import * as sessionEventService from "../services/session-event.js";

const sessionFilterSchema = z.object({
  state: z.enum(["active", "suspended", "evicted"]).optional(),
  runtimeState: z.enum(["idle", "working", "blocked", "error"]).optional(),
});

/** Class C — per-resource session routes (`/api/v1/agents/:uuid/sessions/...`). */
export async function sessionRoutes(app: FastifyInstance): Promise<void> {
  /** GET /agents/:uuid/sessions — sessions for one agent. */
  app.get<{ Params: { uuid: string } }>("/:uuid/sessions", async (request) => {
    const { agent, scope } = await requireAgentAccess(request, app.db, "visible");
    const filters = sessionFilterSchema.parse(request.query);
    const isManager = agent.managerId === scope.memberId;
    const sessions = await sessionService.listAgentSessions(app.db, agent.uuid, filters);
    if (isManager || scope.role === "admin") return sessions;
    return sessionService.filterSessionsByParticipant(app.db, sessions, scope.humanAgentId);
  });

  /** GET /agents/:uuid/sessions/:chatId — session detail (gated on both agent visibility AND chat access). */
  app.get<{ Params: { uuid: string; chatId: string } }>("/:uuid/sessions/:chatId", async (request) => {
    const { agent } = await requireAgentAccess(request, app.db, "visible");
    // Bind chatId for the chat-access helper.
    await requireChatAccess(request as unknown as Parameters<typeof requireChatAccess>[0], app.db);
    return sessionService.getSession(app.db, agent.uuid, request.params.chatId);
  });

  /** Session events stream. */
  app.get<{
    Params: { uuid: string; chatId: string };
    Querystring: { limit?: string; cursor?: string; direction?: string };
  }>("/:uuid/sessions/:chatId/events", async (request) => {
    const { agent } = await requireAgentAccess(request, app.db, "visible");
    await requireChatAccess(request as unknown as Parameters<typeof requireChatAccess>[0], app.db);
    const limit = request.query.limit !== undefined ? Number.parseInt(request.query.limit, 10) : undefined;
    const cursor = request.query.cursor !== undefined ? Number.parseInt(request.query.cursor, 10) : undefined;
    const direction = request.query.direction === "desc" ? "desc" : "asc";
    return sessionEventService.listEvents(app.db, agent.uuid, request.params.chatId, {
      limit: Number.isFinite(limit) ? limit : undefined,
      cursor: Number.isFinite(cursor) ? cursor : undefined,
      direction,
    });
  });

  app.post<{ Params: { uuid: string; chatId: string } }>("/:uuid/sessions/:chatId/suspend", async (request, reply) => {
    const { agent, scope } = await requireAgentAccess(request, app.db, "manage");
    const result = await sessionService.suspendSession(
      app.db,
      agent.uuid,
      request.params.chatId,
      scope.organizationId,
      app.notifier,
    );
    if (result.transitioned) sendToAgent(agent.uuid, { type: "session:suspend", chatId: request.params.chatId });
    return reply.status(200).send({
      agentId: agent.uuid,
      chatId: request.params.chatId,
      state: result.state,
      transitioned: result.transitioned,
    });
  });

  app.post<{ Params: { uuid: string; chatId: string } }>(
    "/:uuid/sessions/:chatId/terminate",
    async (request, reply) => {
      const { agent, scope } = await requireAgentAccess(request, app.db, "manage");
      const result = await sessionService.archiveSession(
        app.db,
        agent.uuid,
        request.params.chatId,
        scope.organizationId,
        app.notifier,
      );
      if (result.transitioned) {
        sessionEventService.clearEvents(app.db, agent.uuid, request.params.chatId).catch(() => {});
        sendToAgent(agent.uuid, { type: "session:terminate", chatId: request.params.chatId });
      }
      return reply.status(200).send({
        agentId: agent.uuid,
        chatId: request.params.chatId,
        state: result.state,
        transitioned: result.transitioned,
      });
    },
  );

  // Service helper to keep the orgs/sessions.ts list endpoint flexible:
  // unused here but keeps a friendly export for the agent service module.
  void agentService;
}
