import { paginationQuerySchema } from "@agent-team-foundation/first-tree-hub-shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireMember } from "../../middleware/require-identity.js";
import { assertAgentVisible, assertCanManage, assertChatAccess, memberScope } from "../../services/access-control.js";
import * as agentService from "../../services/agent.js";
import { sendToAgent } from "../../services/connection-manager.js";
import * as sessionService from "../../services/session.js";
import * as sessionEventService from "../../services/session-event.js";

const sessionFilterSchema = z.object({
  state: z.enum(["active", "suspended", "evicted"]).optional(),
  runtimeState: z.enum(["idle", "working", "blocked", "error"]).optional(),
});

const globalSessionFilterSchema = paginationQuerySchema.extend({
  state: z.enum(["active", "suspended", "evicted"]).optional(),
  agentId: z.string().optional(),
});

// assertAgentInOrg replaced by assertAgentVisible from access-control.ts

export async function adminSessionRoutes(app: FastifyInstance): Promise<void> {
  /** GET /admin/sessions — global session list, scoped to caller's org */
  app.get("/", async (request) => {
    const member = requireMember(request);
    const query = globalSessionFilterSchema.parse(request.query);
    return sessionService.listAllSessions(app.db, query.limit, query.cursor, {
      state: query.state,
      agentId: query.agentId,
      organizationId: member.organizationId,
    });
  });

  /** GET /admin/sessions/agents/:agentId — sessions for a specific agent.
   *  Manager sees all sessions. Non-manager sees only sessions where their human agent is also a participant. */
  app.get<{ Params: { agentId: string } }>("/agents/:agentId", async (request) => {
    const scope = memberScope(request);
    await assertAgentVisible(app.db, scope, request.params.agentId);
    const filters = sessionFilterSchema.parse(request.query);
    const agent = await agentService.getAgent(app.db, request.params.agentId);
    const isManager = agent.managerId === scope.memberId;
    const sessions = await sessionService.listAgentSessions(app.db, request.params.agentId, filters);
    if (isManager) return sessions;
    // Non-manager: filter to sessions where the member's human agent is also a participant in the chat
    return sessionService.filterSessionsByParticipant(app.db, sessions, scope.humanAgentId);
  });

  /** GET /admin/sessions/agents/:agentId/:chatId — single session detail */
  app.get<{ Params: { agentId: string; chatId: string } }>("/agents/:agentId/:chatId", async (request) => {
    const scope = memberScope(request);
    await assertAgentVisible(app.db, scope, request.params.agentId);
    await assertChatAccess(app.db, scope, request.params.chatId);
    return sessionService.getSession(app.db, request.params.agentId, request.params.chatId);
  });

  /**
   * GET /admin/sessions/agents/:agentId/:chatId/events — session event stream,
   * paged by `seq`. `direction=desc` returns newest-first; the chat UI uses
   * this so its turn-grouping filter always sees the latest `turn_end`
   * regardless of total event count.
   */
  app.get<{
    Params: { agentId: string; chatId: string };
    Querystring: { limit?: string; cursor?: string; direction?: string };
  }>("/agents/:agentId/:chatId/events", async (request) => {
    const scope = memberScope(request);
    await assertAgentVisible(app.db, scope, request.params.agentId);
    // Events expose tool args / error text — gate on chat participation, not just agent visibility.
    await assertChatAccess(app.db, scope, request.params.chatId);
    const limit = request.query.limit !== undefined ? Number.parseInt(request.query.limit, 10) : undefined;
    const cursor = request.query.cursor !== undefined ? Number.parseInt(request.query.cursor, 10) : undefined;
    const direction = request.query.direction === "desc" ? "desc" : "asc";
    return sessionEventService.listEvents(app.db, request.params.agentId, request.params.chatId, {
      limit: Number.isFinite(limit) ? limit : undefined,
      cursor: Number.isFinite(cursor) ? cursor : undefined,
      direction,
    });
  });

  /** POST /admin/sessions/agents/:agentId/:chatId/suspend — commit first, WS-send best-effort. */
  app.post<{ Params: { agentId: string; chatId: string } }>(
    "/agents/:agentId/:chatId/suspend",
    async (request, reply) => {
      const { agentId, chatId } = request.params;
      await assertCanManage(app.db, memberScope(request), agentId);
      const member = requireMember(request);
      const result = await sessionService.suspendSession(app.db, agentId, chatId, member.organizationId, app.notifier);
      if (result.transitioned) {
        sendToAgent(agentId, { type: "session:suspend", chatId });
      }
      return reply.status(200).send({ agentId, chatId, state: result.state, transitioned: result.transitioned });
    },
  );

  /** POST /admin/sessions/agents/:agentId/:chatId/terminate — archive; clear events + best-effort WS. */
  app.post<{ Params: { agentId: string; chatId: string } }>(
    "/agents/:agentId/:chatId/terminate",
    async (request, reply) => {
      const { agentId, chatId } = request.params;
      await assertCanManage(app.db, memberScope(request), agentId);
      const member = requireMember(request);
      const result = await sessionService.archiveSession(app.db, agentId, chatId, member.organizationId, app.notifier);
      if (result.transitioned) {
        sessionEventService.clearEvents(app.db, agentId, chatId).catch(() => {});
        sendToAgent(agentId, { type: "session:terminate", chatId });
      }
      return reply.status(200).send({ agentId, chatId, state: result.state, transitioned: result.transitioned });
    },
  );
}
