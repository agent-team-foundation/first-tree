import {
  type CronJob,
  type CronJobErrorCode,
  type CronJobPauseReason,
  type CronOutstanding,
  type CronPreviewResponse,
  type CreateCronJobRequest,
  type DeleteCronJobResponse,
  type UpdateCronJobRequest,
} from "@first-tree/shared";
import { and, asc, eq, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chatUserState } from "../db/schema/chat-user-state.js";
import { chats } from "../db/schema/chats.js";
import { cronJobs, type CronJobRow } from "../db/schema/cron-jobs.js";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { members } from "../db/schema/members.js";
import { messages } from "../db/schema/messages.js";
import { AppError } from "../errors.js";
import { createLogger } from "../observability/index.js";
import { uuidv7 } from "../uuid.js";
import { assertSchedulable, InvalidCronScheduleError, previewOccurrences } from "./cron-schedule.js";

const log = createLogger("CronJob");

export class CronJobAppError extends AppError {
  readonly code: CronJobErrorCode;
  constructor(statusCode: number, code: CronJobErrorCode, message: string) {
    super(statusCode, message, { code });
    this.name = "CronJobAppError";
    this.code = code;
  }
}

export type CronJobsRuntimeConfig = {
  enabled: boolean;
  pollingIntervalSeconds: number;
};

function assertMutationsAvailable(config: CronJobsRuntimeConfig): void {
  if (!config.enabled) {
    throw new CronJobAppError(503, "CRON_JOBS_DISABLED", "Scheduled jobs are disabled on this deployment");
  }
  const interval = config.pollingIntervalSeconds;
  if (interval < 1 || interval > 10) {
    throw new CronJobAppError(
      503,
      "CRON_JOBS_UNAVAILABLE",
      "Scheduled jobs require runtime.pollingIntervalSeconds in 1..10 when enabled",
    );
  }
}

export function isCronWorkerRunnable(config: CronJobsRuntimeConfig): boolean {
  return config.enabled && config.pollingIntervalSeconds >= 1 && config.pollingIntervalSeconds <= 10;
}

export async function databaseNow(db: Database): Promise<Date> {
  const rows = (await db.execute(sql`SELECT clock_timestamp() AS now`)) as unknown as Array<{
    now: Date | string;
  }>;
  const raw = rows[0]?.now;
  if (!raw) throw new Error("failed to read database clock");
  return raw instanceof Date ? raw : new Date(raw);
}

export async function loadOutstanding(
  db: Database,
  job: Pick<CronJobRow, "agentId" | "controlChatId" | "lastTriggerMessageId">,
): Promise<CronOutstanding | null | "missing"> {
  if (!job.lastTriggerMessageId) return null;

  const [agent] = await db
    .select({ inboxId: agents.inboxId })
    .from(agents)
    .where(eq(agents.uuid, job.agentId))
    .limit(1);
  if (!agent) return "missing";

  const [message] = await db
    .select({ id: messages.id, chatId: messages.chatId })
    .from(messages)
    .where(eq(messages.id, job.lastTriggerMessageId))
    .limit(1);
  if (!message || message.chatId !== job.controlChatId) return "missing";

  const [entry] = await db
    .select({ status: inboxEntries.status })
    .from(inboxEntries)
    .where(
      and(
        eq(inboxEntries.inboxId, agent.inboxId),
        eq(inboxEntries.messageId, job.lastTriggerMessageId),
        eq(inboxEntries.chatId, job.controlChatId),
        eq(inboxEntries.notify, true),
      ),
    )
    .limit(1);
  if (!entry) return "missing";
  if (entry.status === "acked") return null;
  if (entry.status === "pending" || entry.status === "delivered") {
    return { messageId: job.lastTriggerMessageId, status: entry.status };
  }
  return "missing";
}

export async function projectCronJob(db: Database, job: CronJobRow): Promise<CronJob> {
  const outstanding = await loadOutstanding(db, job);
  return {
    id: job.id,
    ownerMemberId: job.ownerMemberId,
    controlChatId: job.controlChatId,
    agentId: job.agentId,
    name: job.name,
    chatMode: "reuse_control_chat",
    schedule: job.cronExpression,
    timezone: job.timezone,
    prompt: job.prompt,
    state: job.state as "active" | "paused",
    stateReason: job.stateReason,
    revision: job.revision,
    nextRunAt: job.nextRunAt ? job.nextRunAt.toISOString() : null,
    outstanding: outstanding === "missing" ? null : outstanding,
    createdAt: job.createdAt.toISOString(),
  };
}

export async function previewCronSchedule(
  schedule: string,
  timezone: string,
  after?: Date,
): Promise<CronPreviewResponse> {
  try {
    return previewOccurrences(schedule, timezone, after ?? new Date());
  } catch (err) {
    if (err instanceof InvalidCronScheduleError) {
      throw new CronJobAppError(400, "CRON_JOB_INVALID_SCHEDULE", err.message);
    }
    throw err;
  }
}

type AuthorizationSnapshot = {
  ownerMemberId: string;
  ownerHumanAgentId: string;
  agentInboxId: string;
  organizationId: string;
  agentName: string | null;
  agentDisplayName: string;
};

type PermanentFail = { ok: false; reason: CronJobPauseReason };
type PermanentOk = { ok: true } & AuthorizationSnapshot;
type PermanentResult = PermanentFail | PermanentOk;

export async function revalidateOwnerChatAgent(
  db: Database,
  job: Pick<CronJobRow, "ownerMemberId" | "controlChatId" | "agentId" | "chatMode">,
): Promise<PermanentResult> {
  if (job.chatMode !== "reuse_control_chat") {
    return { ok: false, reason: "unsupported_chat_mode" };
  }

  const [chat] = await db.select().from(chats).where(eq(chats.id, job.controlChatId)).limit(1);
  if (!chat) return { ok: false, reason: "chat_invalid" };

  const [owner] = await db.select().from(members).where(eq(members.id, job.ownerMemberId)).limit(1);
  if (!owner || owner.status !== "active" || owner.organizationId !== chat.organizationId) {
    return { ok: false, reason: "owner_inactive" };
  }

  const [agent] = await db.select().from(agents).where(eq(agents.uuid, job.agentId)).limit(1);
  if (!agent || agent.status !== "active" || agent.organizationId !== chat.organizationId) {
    return { ok: false, reason: "agent_inactive" };
  }
  if (agent.managerId !== job.ownerMemberId) {
    return { ok: false, reason: "agent_manager_changed" };
  }

  const [ownerSpeaker] = await db
    .select({ agentId: chatMembership.agentId })
    .from(chatMembership)
    .where(
      and(
        eq(chatMembership.chatId, job.controlChatId),
        eq(chatMembership.agentId, owner.agentId),
        eq(chatMembership.accessMode, "speaker"),
      ),
    )
    .limit(1);
  if (!ownerSpeaker) return { ok: false, reason: "owner_not_speaker" };

  const [agentSpeaker] = await db
    .select({ agentId: chatMembership.agentId })
    .from(chatMembership)
    .where(
      and(
        eq(chatMembership.chatId, job.controlChatId),
        eq(chatMembership.agentId, job.agentId),
        eq(chatMembership.accessMode, "speaker"),
      ),
    )
    .limit(1);
  if (!agentSpeaker) return { ok: false, reason: "agent_not_speaker" };

  const [engagement] = await db
    .select({ status: chatUserState.engagementStatus })
    .from(chatUserState)
    .where(and(eq(chatUserState.chatId, job.controlChatId), eq(chatUserState.agentId, owner.agentId)))
    .limit(1);
  if (engagement?.status === "deleted") {
    return { ok: false, reason: "owner_chat_deleted" };
  }

  return {
    ok: true,
    ownerMemberId: owner.id,
    ownerHumanAgentId: owner.agentId,
    agentInboxId: agent.inboxId,
    organizationId: chat.organizationId,
    agentName: agent.name,
    agentDisplayName: agent.displayName,
  };
}

export async function listCronJobsForChat(db: Database, controlChatId: string): Promise<CronJob[]> {
  const rows = await db
    .select()
    .from(cronJobs)
    .where(eq(cronJobs.controlChatId, controlChatId))
    .orderBy(asc(cronJobs.createdAt), asc(cronJobs.id));
  return Promise.all(rows.map((row) => projectCronJob(db, row)));
}

export async function getCronJobRow(db: Database, id: string): Promise<CronJobRow | null> {
  const [row] = await db.select().from(cronJobs).where(eq(cronJobs.id, id)).limit(1);
  return row ?? null;
}

export async function getCronJobForAgent(
  db: Database,
  chatId: string,
  agentId: string,
  jobId: string,
): Promise<CronJob> {
  const [row] = await db
    .select()
    .from(cronJobs)
    .where(and(eq(cronJobs.id, jobId), eq(cronJobs.controlChatId, chatId), eq(cronJobs.agentId, agentId)))
    .limit(1);
  if (!row) throw new CronJobAppError(404, "CRON_JOB_NOT_FOUND", "Cron job not found");
  return projectCronJob(db, row);
}

export async function createCronJob(
  db: Database,
  input: {
    controlChatId: string;
    agentId: string;
    body: CreateCronJobRequest;
    config: CronJobsRuntimeConfig;
  },
): Promise<CronJob> {
  assertMutationsAvailable(input.config);

  const now = await databaseNow(db);
  let scheduled: { schedule: string; timezone: string; nextRunAt: Date };
  try {
    scheduled = assertSchedulable(input.body.schedule, input.body.timezone, now);
  } catch (err) {
    if (err instanceof InvalidCronScheduleError) {
      throw new CronJobAppError(400, "CRON_JOB_INVALID_SCHEDULE", err.message);
    }
    throw err;
  }

  const [agent] = await db.select().from(agents).where(eq(agents.uuid, input.agentId)).limit(1);
  if (!agent || agent.status !== "active") {
    throw new CronJobAppError(403, "CRON_JOB_FORBIDDEN", "Agent is not eligible to create scheduled jobs");
  }

  const validated = await revalidateOwnerChatAgent(db, {
    ownerMemberId: agent.managerId,
    controlChatId: input.controlChatId,
    agentId: input.agentId,
    chatMode: "reuse_control_chat",
  });
  if (!validated.ok) {
    throw new CronJobAppError(403, "CRON_JOB_FORBIDDEN", `Cannot create schedule (${validated.reason})`);
  }

  const [existing] = await db
    .select()
    .from(cronJobs)
    .where(
      and(
        eq(cronJobs.controlChatId, input.controlChatId),
        eq(cronJobs.agentId, input.agentId),
        eq(cronJobs.name, input.body.name),
      ),
    )
    .limit(1);

  if (existing) {
    const identical =
      existing.cronExpression === scheduled.schedule &&
      existing.timezone === scheduled.timezone &&
      existing.prompt === input.body.prompt;
    if (identical) {
      return projectCronJob(db, existing);
    }
    throw new CronJobAppError(409, "CRON_JOB_NAME_CONFLICT", "A cron job with this name already exists");
  }

  const id = uuidv7();
  const [inserted] = await db
    .insert(cronJobs)
    .values({
      id,
      ownerMemberId: validated.ownerMemberId,
      controlChatId: input.controlChatId,
      agentId: input.agentId,
      name: input.body.name,
      chatMode: "reuse_control_chat",
      cronExpression: scheduled.schedule,
      timezone: scheduled.timezone,
      prompt: input.body.prompt,
      state: "active",
      stateReason: null,
      revision: 1,
      nextRunAt: scheduled.nextRunAt,
      lastTriggerMessageId: null,
    })
    .returning();

  if (!inserted) throw new Error("failed to insert cron job");
  log.info(
    {
      jobId: inserted.id,
      organizationId: validated.organizationId,
      controlChatId: inserted.controlChatId,
      agentId: inserted.agentId,
    },
    "cron.job.created",
  );
  return projectCronJob(db, inserted);
}

async function lockJob(db: Database, jobId: string): Promise<CronJobRow> {
  const locked = await db.select().from(cronJobs).where(eq(cronJobs.id, jobId)).for("update").limit(1);
  if (!locked[0]) throw new CronJobAppError(404, "CRON_JOB_NOT_FOUND", "Cron job not found");
  return locked[0];
}

function assertRevision(job: CronJobRow, expected: number): void {
  if (job.revision !== expected) {
    throw new CronJobAppError(409, "CRON_JOB_REVISION_MISMATCH", "Cron job revision mismatch");
  }
}

export async function updateCronJob(
  db: Database,
  input: {
    jobId: string;
    expectedRevision: number;
    body: UpdateCronJobRequest;
    config: CronJobsRuntimeConfig;
    /** When set, require job.agentId === agentId and controlChatId match. */
    agentScope?: { agentId: string; controlChatId: string };
    /** When set, require job.ownerMemberId === memberId for mutations. */
    ownerMemberId?: string;
  },
): Promise<CronJob> {
  return db.transaction(async (tx) => {
    const job = await lockJob(tx as unknown as Database, input.jobId);
    if (input.agentScope) {
      if (job.agentId !== input.agentScope.agentId || job.controlChatId !== input.agentScope.controlChatId) {
        throw new CronJobAppError(404, "CRON_JOB_NOT_FOUND", "Cron job not found");
      }
    }
    if (input.ownerMemberId && job.ownerMemberId !== input.ownerMemberId) {
      throw new CronJobAppError(403, "CRON_JOB_FORBIDDEN", "Only the schedule owner may modify this job");
    }
    assertRevision(job, input.expectedRevision);

    const body = input.body;
    if (body.state === "paused") {
      if (job.state === "paused" && job.stateReason === "user_paused") {
        return projectCronJob(tx as unknown as Database, job);
      }
      const [updated] = await tx
        .update(cronJobs)
        .set({
          state: "paused",
          stateReason: "user_paused",
          nextRunAt: null,
          revision: job.revision + 1,
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.prompt !== undefined ? { prompt: body.prompt } : {}),
          ...(body.schedule !== undefined || body.timezone !== undefined
            ? {
                cronExpression: body.schedule ?? job.cronExpression,
                timezone: body.timezone ?? job.timezone,
              }
            : {}),
        })
        .where(eq(cronJobs.id, job.id))
        .returning();
      if (!updated) throw new Error("failed to pause cron job");
      log.info({ jobId: job.id, decisionReason: "user_paused" }, "cron.job.paused");
      return projectCronJob(tx as unknown as Database, updated);
    }

    if (body.state === "active") {
      assertMutationsAvailable(input.config);
      const auth = await revalidateOwnerChatAgent(tx as unknown as Database, job);
      if (!auth.ok) {
        throw new CronJobAppError(403, "CRON_JOB_FORBIDDEN", `Cannot resume schedule (${auth.reason})`);
      }
      const schedule = body.schedule ?? job.cronExpression;
      const timezone = body.timezone ?? job.timezone;
      const now = await databaseNow(tx as unknown as Database);
      let nextRunAt: Date;
      try {
        nextRunAt = assertSchedulable(schedule, timezone, now).nextRunAt;
      } catch (err) {
        if (err instanceof InvalidCronScheduleError) {
          throw new CronJobAppError(400, "CRON_JOB_INVALID_SCHEDULE", err.message);
        }
        throw err;
      }
      const [updated] = await tx
        .update(cronJobs)
        .set({
          state: "active",
          stateReason: null,
          nextRunAt,
          revision: job.revision + 1,
          cronExpression: schedule,
          timezone,
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.prompt !== undefined ? { prompt: body.prompt } : {}),
        })
        .where(eq(cronJobs.id, job.id))
        .returning();
      if (!updated) throw new Error("failed to resume cron job");
      log.info({ jobId: job.id }, "cron.job.resumed");
      return projectCronJob(tx as unknown as Database, updated);
    }

    // Config-only update
    let schedule = job.cronExpression;
    let timezone = job.timezone;
    let nextRunAt = job.nextRunAt;
    let changed = false;

    if (body.name !== undefined && body.name !== job.name) changed = true;
    if (body.prompt !== undefined && body.prompt !== job.prompt) changed = true;
    if (body.schedule !== undefined && body.schedule !== job.cronExpression) {
      schedule = body.schedule;
      changed = true;
    }
    if (body.timezone !== undefined && body.timezone !== job.timezone) {
      timezone = body.timezone;
      changed = true;
    }

    if (!changed) {
      return projectCronJob(tx as unknown as Database, job);
    }

    const scheduleChanged = body.schedule !== undefined || body.timezone !== undefined;
    if (scheduleChanged) {
      try {
        const normalized = assertSchedulable(schedule, timezone, await databaseNow(tx as unknown as Database));
        schedule = normalized.schedule;
        timezone = normalized.timezone;
        if (job.state === "active") {
          nextRunAt = normalized.nextRunAt;
        }
      } catch (err) {
        if (err instanceof InvalidCronScheduleError) {
          throw new CronJobAppError(400, "CRON_JOB_INVALID_SCHEDULE", err.message);
        }
        throw err;
      }
    }

    try {
      const [updated] = await tx
        .update(cronJobs)
        .set({
          name: body.name ?? job.name,
          prompt: body.prompt ?? job.prompt,
          cronExpression: schedule,
          timezone,
          nextRunAt: job.state === "active" ? nextRunAt : null,
          revision: job.revision + 1,
        })
        .where(eq(cronJobs.id, job.id))
        .returning();
      if (!updated) throw new Error("failed to update cron job");
      log.info({ jobId: job.id }, "cron.job.updated");
      return projectCronJob(tx as unknown as Database, updated);
    } catch (err) {
      if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "23505") {
        throw new CronJobAppError(409, "CRON_JOB_NAME_CONFLICT", "A cron job with this name already exists");
      }
      throw err;
    }
  });
}

export async function deleteCronJob(
  db: Database,
  input: {
    jobId: string;
    expectedRevision: number;
    agentScope?: { agentId: string; controlChatId: string };
    ownerMemberId?: string;
  },
): Promise<DeleteCronJobResponse> {
  return db.transaction(async (tx) => {
    const job = await lockJob(tx as unknown as Database, input.jobId);
    if (input.agentScope) {
      if (job.agentId !== input.agentScope.agentId || job.controlChatId !== input.agentScope.controlChatId) {
        throw new CronJobAppError(404, "CRON_JOB_NOT_FOUND", "Cron job not found");
      }
    }
    if (input.ownerMemberId && job.ownerMemberId !== input.ownerMemberId) {
      throw new CronJobAppError(403, "CRON_JOB_FORBIDDEN", "Only the schedule owner may delete this job");
    }
    assertRevision(job, input.expectedRevision);
    await tx.delete(cronJobs).where(eq(cronJobs.id, job.id));
    log.info({ jobId: job.id }, "cron.job.deleted");
    return {
      id: job.id,
      deleted: true as const,
      acceptedWorkPreserved: job.lastTriggerMessageId !== null,
      lastTriggerMessageId: job.lastTriggerMessageId,
    };
  });
}

/**
 * Pause all active jobs for an owner on a control chat. Caller must hold or
 * be about to take the chat_user_state write; we lock jobs first ORDER BY id.
 */
export async function pauseActiveJobsForOwnerChatDelete(
  db: Database,
  input: { controlChatId: string; ownerMemberId: string },
): Promise<number> {
  const locked = await db
    .select({ id: cronJobs.id })
    .from(cronJobs)
    .where(
      and(
        eq(cronJobs.controlChatId, input.controlChatId),
        eq(cronJobs.ownerMemberId, input.ownerMemberId),
        eq(cronJobs.state, "active"),
      ),
    )
    .orderBy(asc(cronJobs.id))
    .for("update");

  if (locked.length === 0) return 0;

  await db
    .update(cronJobs)
    .set({
      state: "paused",
      stateReason: "owner_chat_deleted",
      nextRunAt: null,
      revision: sql`${cronJobs.revision} + 1`,
    })
    .where(
      and(
        eq(cronJobs.controlChatId, input.controlChatId),
        eq(cronJobs.ownerMemberId, input.ownerMemberId),
        eq(cronJobs.state, "active"),
      ),
    );

  for (const row of locked) {
    log.info({ jobId: row.id, decisionReason: "owner_chat_deleted" }, "cron.job.auto_paused");
  }
  return locked.length;
}

export async function assertCronAgentRouteAccess(
  db: Database,
  input: { chatId: string; agentId: string; callerMemberId: string; callerHumanAgentId: string },
): Promise<void> {
  const [agent] = await db
    .select({ managerId: agents.managerId })
    .from(agents)
    .where(eq(agents.uuid, input.agentId))
    .limit(1);
  if (!agent || agent.managerId !== input.callerMemberId) {
    throw new CronJobAppError(
      403,
      "CRON_JOB_FORBIDDEN",
      "Only the managing human may manage scheduled jobs for this agent",
    );
  }

  const [humanSpeaker] = await db
    .select({ agentId: chatMembership.agentId })
    .from(chatMembership)
    .where(
      and(
        eq(chatMembership.chatId, input.chatId),
        eq(chatMembership.agentId, input.callerHumanAgentId),
        eq(chatMembership.accessMode, "speaker"),
      ),
    )
    .limit(1);
  if (!humanSpeaker) {
    throw new CronJobAppError(403, "CRON_JOB_FORBIDDEN", "Managing human must be a speaker in this chat");
  }

  const [agentSpeaker] = await db
    .select({ agentId: chatMembership.agentId })
    .from(chatMembership)
    .where(
      and(
        eq(chatMembership.chatId, input.chatId),
        eq(chatMembership.agentId, input.agentId),
        eq(chatMembership.accessMode, "speaker"),
      ),
    )
    .limit(1);
  if (!agentSpeaker) {
    throw new CronJobAppError(403, "CRON_JOB_FORBIDDEN", "Agent must be a speaker in this chat");
  }

  const [engagement] = await db
    .select({ status: chatUserState.engagementStatus })
    .from(chatUserState)
    .where(and(eq(chatUserState.chatId, input.chatId), eq(chatUserState.agentId, input.callerHumanAgentId)))
    .limit(1);
  if (engagement?.status === "deleted") {
    throw new CronJobAppError(403, "CRON_JOB_FORBIDDEN", "Control chat is deleted for the schedule owner");
  }
}

export type { AuthorizationSnapshot, PermanentResult };
