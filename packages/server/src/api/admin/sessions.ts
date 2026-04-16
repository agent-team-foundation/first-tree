import { paginationQuerySchema } from "@agent-team-foundation/first-tree-hub-shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ConflictError, ForbiddenError } from "../../errors.js";
import { requireMember } from "../../middleware/require-identity.js";
import * as agentService from "../../services/agent.js";
import { sendToAgent } from "../../services/connection-manager.js";
import * as sessionService from "../../services/session.js";
import * as sessionOutputService from "../../services/session-output.js";

const sessionFilterSchema = z.object({
  state: z.enum(["active", "suspended", "evicted"]).optional(),
  runtimeState: z.enum(["idle", "working", "blocked", "error"]).optional(),
});

const globalSessionFilterSchema = paginationQuerySchema.extend({
  state: z.enum(["active", "suspended", "evicted"]).optional(),
  agentId: z.string().optional(),
});

/** Verify the agent belongs to the caller's organization. */
async function assertAgentInOrg(
  app: FastifyInstance,
  request: { member?: { organizationId: string } },
  agentId: string,
): Promise<void> {
  const member = requireMember(request as Parameters<typeof requireMember>[0]);
  const agent = await agentService.getAgent(app.db, agentId);
  if (agent.organizationId !== member.organizationId) {
    throw new ForbiddenError("Agent does not belong to your organization");
  }
}

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

  /** GET /admin/sessions/agents/:agentId — sessions for a specific agent */
  app.get<{ Params: { agentId: string } }>("/agents/:agentId", async (request) => {
    await assertAgentInOrg(app, request, request.params.agentId);
    const filters = sessionFilterSchema.parse(request.query);
    return sessionService.listAgentSessions(app.db, request.params.agentId, filters);
  });

  /** GET /admin/sessions/agents/:agentId/:chatId — single session detail */
  app.get<{ Params: { agentId: string; chatId: string } }>("/agents/:agentId/:chatId", async (request) => {
    await assertAgentInOrg(app, request, request.params.agentId);
    return sessionService.getSession(app.db, request.params.agentId, request.params.chatId);
  });

  /** GET /admin/sessions/agents/:agentId/:chatId/output — session output text */
  app.get<{ Params: { agentId: string; chatId: string } }>("/agents/:agentId/:chatId/output", async (request) => {
    await assertAgentInOrg(app, request, request.params.agentId);
    const output = await sessionOutputService.getOutput(app.db, request.params.agentId, request.params.chatId);
    return output ?? { content: "", updatedAt: null };
  });

  /** POST /admin/sessions/agents/:agentId/:chatId/suspend — suspend a session */
  app.post<{ Params: { agentId: string; chatId: string } }>(
    "/agents/:agentId/:chatId/suspend",
    async (request, reply) => {
      const { agentId, chatId } = request.params;
      await assertAgentInOrg(app, request, agentId);
      const sent = sendToAgent(agentId, { type: "session:suspend", chatId });
      if (!sent) {
        throw new ConflictError("Agent is not connected — session command requires a live connection");
      }
      return reply.status(202).send({ status: "sent", command: "suspend", agentId, chatId });
    },
  );

  /** POST /admin/sessions/agents/:agentId/:chatId/resume — resume a session */
  app.post<{ Params: { agentId: string; chatId: string } }>(
    "/agents/:agentId/:chatId/resume",
    async (request, reply) => {
      const { agentId, chatId } = request.params;
      await assertAgentInOrg(app, request, agentId);
      const sent = sendToAgent(agentId, { type: "session:resume", chatId });
      if (!sent) {
        throw new ConflictError("Agent is not connected — session command requires a live connection");
      }
      return reply.status(202).send({ status: "sent", command: "resume", agentId, chatId });
    },
  );

  /** POST /admin/sessions/agents/:agentId/:chatId/terminate — terminate a session */
  app.post<{ Params: { agentId: string; chatId: string } }>(
    "/agents/:agentId/:chatId/terminate",
    async (request, reply) => {
      const { agentId, chatId } = request.params;
      await assertAgentInOrg(app, request, agentId);
      const sent = sendToAgent(agentId, { type: "session:terminate", chatId });
      if (!sent) {
        throw new ConflictError("Agent is not connected — session command requires a live connection");
      }
      return reply.status(202).send({ status: "sent", command: "terminate", agentId, chatId });
    },
  );
}
