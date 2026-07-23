import { cronJobRevisionHeaderSchema, cronPreviewRequestSchema, updateCronJobRequestSchema } from "@first-tree/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Database } from "../db/connection.js";
import { chats } from "../db/schema/chats.js";
import type { CronJobRow } from "../db/schema/cron-jobs.js";
import { NotFoundError } from "../errors.js";
import { requireChatAccess } from "../scope/require-resource.js";
import type { OrgScope } from "../scope/types.js";
import {
  CronJobAppError,
  deleteCronJob,
  getCronJobRow,
  listCronJobsForChat,
  previewCronSchedule,
  projectCronJob,
  updateCronJob,
} from "../services/cron-job.js";
import { cronConfig, notifyCronChatUpdated, sendCronError } from "./cron-http.js";

/**
 * Load a cron job by UUID and verify the caller can see its control Chat.
 * Invisible / missing → 404. Mutation additionally requires ownerMemberId.
 */
export async function requireCronJobAccess(
  request: FastifyRequest<{ Params: { id: string } }>,
  db: Database,
  kind: "read" | "mutate",
): Promise<{ job: CronJobRow; scope: OrgScope }> {
  const job = await getCronJobRow(db, request.params.id);
  if (!job) throw new CronJobAppError(404, "CRON_JOB_NOT_FOUND", "Cron job not found");

  const [chat] = await db.select().from(chats).where(eq(chats.id, job.controlChatId)).limit(1);
  if (!chat) throw new CronJobAppError(404, "CRON_JOB_NOT_FOUND", "Cron job not found");

  const chatRequest = Object.assign(request, { params: { ...request.params, chatId: job.controlChatId } });
  const { scope } = await requireChatAccess(chatRequest as FastifyRequest<{ Params: { chatId: string } }>, db);

  if (kind === "mutate" && scope.memberId !== job.ownerMemberId) {
    throw new CronJobAppError(403, "CRON_JOB_FORBIDDEN", "Only the schedule owner may modify this job");
  }

  return { job, scope };
}

/** Class C — chat-scoped human list + preview. */
export async function chatCronJobRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { chatId: string } }>("/:chatId/cron-jobs/preview", async (request, reply) => {
    try {
      await requireChatAccess(request, app.db);
      const body = cronPreviewRequestSchema.parse(request.body);
      return await previewCronSchedule(body.schedule, body.timezone);
    } catch (err) {
      return sendCronError(reply, err);
    }
  });

  app.get<{ Params: { chatId: string } }>("/:chatId/cron-jobs", async (request, reply) => {
    try {
      await requireChatAccess(request, app.db);
      return { items: await listCronJobsForChat(app.db, request.params.chatId) };
    } catch (err) {
      return sendCronError(reply, err);
    }
  });
}

/** Class C — global job UUID mutate surface. */
export async function cronJobRoutes(app: FastifyInstance): Promise<void> {
  app.patch<{ Params: { id: string } }>("/:id", async (request, reply) => {
    try {
      const { job, scope } = await requireCronJobAccess(request, app.db, "mutate");
      const body = updateCronJobRequestSchema.parse(request.body);
      const revisionHeader = request.headers["if-match"];
      const expectedRevision = cronJobRevisionHeaderSchema.parse(
        Array.isArray(revisionHeader) ? revisionHeader[0] : revisionHeader,
      );
      const updated = await updateCronJob(app.db, {
        jobId: request.params.id,
        expectedRevision,
        body,
        config: cronConfig(app),
        ownerMemberId: scope.memberId,
      });
      notifyCronChatUpdated(app, job.controlChatId);
      return updated;
    } catch (err) {
      if (err instanceof NotFoundError) {
        return reply.status(404).send({ error: err.message, code: "CRON_JOB_NOT_FOUND" });
      }
      return sendCronError(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>("/:id", async (request, reply) => {
    try {
      const { job, scope } = await requireCronJobAccess(request, app.db, "mutate");
      const revisionHeader = request.headers["if-match"];
      const expectedRevision = cronJobRevisionHeaderSchema.parse(
        Array.isArray(revisionHeader) ? revisionHeader[0] : revisionHeader,
      );
      const result = await deleteCronJob(app.db, {
        jobId: request.params.id,
        expectedRevision,
        ownerMemberId: scope.memberId,
      });
      notifyCronChatUpdated(app, job.controlChatId);
      return result;
    } catch (err) {
      if (err instanceof NotFoundError) {
        return reply.status(404).send({ error: err.message, code: "CRON_JOB_NOT_FOUND" });
      }
      return sendCronError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>("/:id", async (request, reply) => {
    try {
      const { job } = await requireCronJobAccess(request, app.db, "read");
      return await projectCronJob(app.db, job);
    } catch (err) {
      if (err instanceof NotFoundError) {
        return reply.status(404).send({ error: err.message, code: "CRON_JOB_NOT_FOUND" });
      }
      return sendCronError(reply, err);
    }
  });
}
