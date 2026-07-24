import {
  createCronJobRequestSchema,
  cronJobRevisionHeaderSchema,
  cronPreviewRequestSchema,
  updateCronJobRequestSchema,
} from "@first-tree/shared";
import type { FastifyInstance } from "fastify";
import {
  createCronJob,
  deleteCronJob,
  getCronJobForAgent,
  listCronJobsForChat,
  previewCronSchedule,
  updateCronJob,
} from "../../services/cron-job.js";
import { notifyCronChatUpdated, requireCronAgentCaller, sendCronError } from "../cron-http.js";

/**
 * Class D — agent self surface for scheduled jobs under the current chat.
 * Every handler runs `assertCronAgentRouteAccess` via `requireCronAgentCaller`.
 */
export async function agentCronJobRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { chatId: string } }>("/:chatId/cron-jobs/preview", async (request, reply) => {
    try {
      await requireCronAgentCaller(app, request, request.params.chatId);
      const body = cronPreviewRequestSchema.parse(request.body);
      return await previewCronSchedule(body.schedule, body.timezone);
    } catch (err) {
      return sendCronError(reply, err);
    }
  });

  app.get<{ Params: { chatId: string } }>("/:chatId/cron-jobs", async (request, reply) => {
    try {
      const { agentId } = await requireCronAgentCaller(app, request, request.params.chatId);
      const items = await listCronJobsForChat(app.db, request.params.chatId);
      return { items: items.filter((job) => job.agentId === agentId) };
    } catch (err) {
      return sendCronError(reply, err);
    }
  });

  app.post<{ Params: { chatId: string } }>("/:chatId/cron-jobs", async (request, reply) => {
    try {
      const { agentId, memberId, humanAgentId } = await requireCronAgentCaller(app, request, request.params.chatId);
      const body = createCronJobRequestSchema.parse(request.body);
      const job = await createCronJob(app.db, {
        controlChatId: request.params.chatId,
        agentId,
        body,
        callerMemberId: memberId,
        callerHumanAgentId: humanAgentId,
      });
      notifyCronChatUpdated(app, request.params.chatId);
      return reply.code(201).send(job);
    } catch (err) {
      return sendCronError(reply, err);
    }
  });

  app.get<{ Params: { chatId: string; id: string } }>("/:chatId/cron-jobs/:id", async (request, reply) => {
    try {
      const { agentId } = await requireCronAgentCaller(app, request, request.params.chatId);
      return await getCronJobForAgent(app.db, request.params.chatId, agentId, request.params.id);
    } catch (err) {
      return sendCronError(reply, err);
    }
  });

  app.patch<{ Params: { chatId: string; id: string } }>("/:chatId/cron-jobs/:id", async (request, reply) => {
    try {
      const { agentId, memberId, humanAgentId } = await requireCronAgentCaller(app, request, request.params.chatId);
      const body = updateCronJobRequestSchema.parse(request.body);
      const revisionHeader = request.headers["if-match"];
      const expectedRevision = cronJobRevisionHeaderSchema.parse(
        Array.isArray(revisionHeader) ? revisionHeader[0] : revisionHeader,
      );
      const job = await updateCronJob(app.db, {
        jobId: request.params.id,
        expectedRevision,
        body,
        agentScope: { agentId, controlChatId: request.params.chatId },
        callerMemberId: memberId,
        callerHumanAgentId: humanAgentId,
      });
      notifyCronChatUpdated(app, request.params.chatId);
      return job;
    } catch (err) {
      return sendCronError(reply, err);
    }
  });

  app.delete<{ Params: { chatId: string; id: string } }>("/:chatId/cron-jobs/:id", async (request, reply) => {
    try {
      const { agentId, memberId, humanAgentId } = await requireCronAgentCaller(app, request, request.params.chatId);
      const revisionHeader = request.headers["if-match"];
      const expectedRevision = cronJobRevisionHeaderSchema.parse(
        Array.isArray(revisionHeader) ? revisionHeader[0] : revisionHeader,
      );
      const result = await deleteCronJob(app.db, {
        jobId: request.params.id,
        expectedRevision,
        agentScope: { agentId, controlChatId: request.params.chatId },
        callerMemberId: memberId,
        callerHumanAgentId: humanAgentId,
      });
      notifyCronChatUpdated(app, request.params.chatId);
      return result;
    } catch (err) {
      return sendCronError(reply, err);
    }
  });
}
