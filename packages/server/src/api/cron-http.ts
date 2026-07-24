import type { CronJobErrorCode } from "@first-tree/shared";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { members } from "../db/schema/members.js";
import { ForbiddenError } from "../errors.js";
import { requireAgent } from "../middleware/require-identity.js";
import * as chatService from "../services/chat.js";
import { assertCronAgentRouteAccess, CronJobAppError } from "../services/cron-job.js";

export function sendCronError(reply: { status: (code: number) => { send: (body: unknown) => unknown } }, err: unknown) {
  if (err instanceof CronJobAppError) {
    return reply.status(err.statusCode).send({ error: err.message, code: err.code });
  }
  if (err instanceof ForbiddenError) {
    return reply.status(403).send({ error: err.message, code: "CRON_JOB_FORBIDDEN" as CronJobErrorCode });
  }
  if (err instanceof ZodError) {
    const paths = err.issues.flatMap((issue) => issue.path.map(String));
    let code: CronJobErrorCode = "CRON_JOB_INVALID_REQUEST";
    if (paths.includes("timezone")) code = "CRON_JOB_INVALID_TIMEZONE";
    else if (paths.includes("state")) code = "CRON_JOB_INVALID_STATE";
    else if (paths.includes("schedule")) code = "CRON_JOB_INVALID_SCHEDULE";
    const message = err.issues[0]?.message ?? "Invalid cron job request";
    return reply.status(400).send({ error: message, code });
  }
  throw err;
}

export async function requireCronAgentCaller(
  app: FastifyInstance,
  request: FastifyRequest,
  chatId: string,
): Promise<{ agentId: string; memberId: string; humanAgentId: string }> {
  const identity = requireAgent(request);
  try {
    await chatService.assertParticipant(app.db, chatId, identity.uuid);
  } catch (err) {
    if (err instanceof ForbiddenError) {
      throw new CronJobAppError(403, "CRON_JOB_FORBIDDEN", err.message);
    }
    throw err;
  }

  const user = request.user;
  if (!user) throw new ForbiddenError("User authentication required");

  const [member] = await app.db
    .select({ id: members.id, humanAgentId: members.agentId })
    .from(members)
    .where(
      and(
        eq(members.userId, user.userId),
        eq(members.organizationId, identity.organizationId),
        eq(members.status, "active"),
      ),
    )
    .limit(1);
  if (!member) {
    throw new CronJobAppError(
      403,
      "CRON_JOB_FORBIDDEN",
      "Agent belongs to an organization the caller is not a member of",
    );
  }

  await assertCronAgentRouteAccess(app.db, {
    chatId,
    agentId: identity.uuid,
    callerMemberId: member.id,
    callerHumanAgentId: member.humanAgentId,
  });

  return { agentId: identity.uuid, memberId: member.id, humanAgentId: member.humanAgentId };
}

export function notifyCronChatUpdated(app: FastifyInstance, controlChatId: string): void {
  void app.notifier.notifyChatUpdated(controlChatId);
}
