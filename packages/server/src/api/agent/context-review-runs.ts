import { AGENT_RUNTIME_SESSION_HEADER, contextReviewSubmitRequestSchema } from "@first-tree/shared";
import type { FastifyInstance } from "fastify";
import { requireAgent } from "../../middleware/require-identity.js";
import { validateAgentRuntimeSession } from "../../services/agent-runtime-session.js";
import * as chatService from "../../services/chat.js";
import { ContextReviewPublisherError, submitContextReviewOutcome } from "../../services/context-reviewer-publisher.js";

export async function agentContextReviewRunRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { chatId: string; runId: string } }>(
    "/:chatId/context-review-runs/:runId/submit",
    async (request, reply) => {
      const identity = requireAgent(request);
      const runtimeToken = request.headers[AGENT_RUNTIME_SESSION_HEADER];
      if (
        !identity.clientId ||
        typeof runtimeToken !== "string" ||
        runtimeToken.length === 0 ||
        !(await validateAgentRuntimeSession(app.db, identity.uuid, identity.clientId, runtimeToken))
      ) {
        return reply.status(403).send({
          error: "A valid active agent runtime session is required for Context review publication.",
          code: "CONTEXT_REVIEW_RUNTIME_SESSION_REQUIRED",
        });
      }

      await chatService.assertParticipant(app.db, request.params.chatId, identity.uuid);
      const parsed = contextReviewSubmitRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: parsed.error.issues.map((issue) => issue.message).join("; "),
          code: "CONTEXT_REVIEW_INVALID_REQUEST",
        });
      }

      try {
        return await submitContextReviewOutcome({
          db: app.db,
          chatId: request.params.chatId,
          runId: request.params.runId,
          callerAgentUuid: identity.uuid,
          callerClientId: identity.clientId,
          request: parsed.data,
          appCredentials: app.config.oauth?.githubApp,
        });
      } catch (error) {
        if (error instanceof ContextReviewPublisherError) {
          return reply.status(error.statusCode).send({ error: error.message, code: error.code });
        }
        throw error;
      }
    },
  );
}
