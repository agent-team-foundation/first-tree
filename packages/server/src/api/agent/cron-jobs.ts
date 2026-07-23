import {
  createCronJobRequestSchema,
  cronJobRevisionHeaderSchema,
  cronPreviewRequestSchema,
  updateCronJobRequestSchema,
} from "@first-tree/shared";
import type { FastifyInstance } from "fastify";
import { requireAgent } from "../../middleware/require-identity.js";
import * as chatService from "../../services/chat.js";
import {
  CronJobAppError,
  createCronJob,
  deleteCronJob,
  getCronJobForAgent,
  listCronJobsForChat,
  previewCronSchedule,
  updateCronJob,
} from "../../services/cron-job.js";

function cronConfig(app: FastifyInstance) {
  return {
    enabled: app.config.cronJobs.enabled,
    pollingIntervalSeconds: app.config.runtime.pollingIntervalSeconds,
  };
}

function sendCronError(reply: { status: (code: number) => { send: (body: unknown) => unknown } }, err: unknown) {
  if (err instanceof CronJobAppError) {
    return reply.status(err.statusCode).send({ error: err.message, code: err.code });
  }
  throw err;
}

/**
 * Class D — agent self surface for scheduled jobs under the current chat.
 */
export async function agentCronJobRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { chatId: string } }>("/:chatId/cron-jobs/preview", async (request, reply) => {
    try {
      const identity = requireAgent(request);
      await chatService.assertParticipant(app.db, request.params.chatId, identity.uuid);
      const body = cronPreviewRequestSchema.parse(request.body);
      return await previewCronSchedule(body.schedule, body.timezone);
    } catch (err) {
      return sendCronError(reply, err);
    }
  });

  app.get<{ Params: { chatId: string } }>("/:chatId/cron-jobs", async (request, reply) => {
    try {
      const identity = requireAgent(request);
      await chatService.assertParticipant(app.db, request.params.chatId, identity.uuid);
      const items = await listCronJobsForChat(app.db, request.params.chatId);
      return { items: items.filter((job) => job.agentId === identity.uuid) };
    } catch (err) {
      return sendCronError(reply, err);
    }
  });

  app.post<{ Params: { chatId: string } }>("/:chatId/cron-jobs", async (request, reply) => {
    try {
      const identity = requireAgent(request);
      await chatService.assertParticipant(app.db, request.params.chatId, identity.uuid);
      const body = createCronJobRequestSchema.parse(request.body);
      const job = await createCronJob(app.db, {
        controlChatId: request.params.chatId,
        agentId: identity.uuid,
        body,
        config: cronConfig(app),
      });
      return reply.code(201).send(job);
    } catch (err) {
      return sendCronError(reply, err);
    }
  });

  app.get<{ Params: { chatId: string; id: string } }>("/:chatId/cron-jobs/:id", async (request, reply) => {
    try {
      const identity = requireAgent(request);
      await chatService.assertParticipant(app.db, request.params.chatId, identity.uuid);
      return await getCronJobForAgent(app.db, request.params.chatId, identity.uuid, request.params.id);
    } catch (err) {
      return sendCronError(reply, err);
    }
  });

  app.patch<{ Params: { chatId: string; id: string } }>("/:chatId/cron-jobs/:id", async (request, reply) => {
    try {
      const identity = requireAgent(request);
      await chatService.assertParticipant(app.db, request.params.chatId, identity.uuid);
      const body = updateCronJobRequestSchema.parse(request.body);
      const revisionHeader = request.headers["if-match"];
      const expectedRevision = cronJobRevisionHeaderSchema.parse(
        Array.isArray(revisionHeader) ? revisionHeader[0] : revisionHeader,
      );
      return await updateCronJob(app.db, {
        jobId: request.params.id,
        expectedRevision,
        body,
        config: cronConfig(app),
        agentScope: { agentId: identity.uuid, controlChatId: request.params.chatId },
      });
    } catch (err) {
      return sendCronError(reply, err);
    }
  });

  app.delete<{ Params: { chatId: string; id: string } }>("/:chatId/cron-jobs/:id", async (request, reply) => {
    try {
      const identity = requireAgent(request);
      await chatService.assertParticipant(app.db, request.params.chatId, identity.uuid);
      const revisionHeader = request.headers["if-match"];
      const expectedRevision = cronJobRevisionHeaderSchema.parse(
        Array.isArray(revisionHeader) ? revisionHeader[0] : revisionHeader,
      );
      return await deleteCronJob(app.db, {
        jobId: request.params.id,
        expectedRevision,
        agentScope: { agentId: identity.uuid, controlChatId: request.params.chatId },
      });
    } catch (err) {
      return sendCronError(reply, err);
    }
  });
}
