import {
  buildCronRunKey,
  CRON_DISPATCH_GRACE_MS,
  CRON_TRIGGER_METADATA_KEY,
  type CronJobPauseReason,
  type CronOccurrenceSkipReason,
} from "@first-tree/shared";
import { and, asc, eq, lte, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Database } from "../db/connection.js";
import { agentPresence } from "../db/schema/agent-presence.js";
import { agents } from "../db/schema/agents.js";
import { clients } from "../db/schema/clients.js";
import { type CronJobRow, cronJobs } from "../db/schema/cron-jobs.js";
import { serverInstances } from "../db/schema/server-instances.js";
import { createLogger } from "../observability/index.js";
import {
  type CronJobsRuntimeConfig,
  databaseNow,
  isCronWorkerRunnable,
  loadOutstanding,
  revalidateOwnerChatAgent,
} from "./cron-job.js";
import { firstOccurrenceStrictlyAfter, InvalidCronScheduleError } from "./cron-schedule.js";
import {
  type DeferredSendMessagePostCommitEffects,
  runDeferredSendMessagePostCommitEffects,
  sendMessage,
} from "./message.js";
import { type Notifier, notifyRecipients } from "./notifier.js";

const log = createLogger("CronScheduler");

const MAX_JOBS_PER_SWEEP = 100;

export type CronScheduler = {
  start(): void;
  stop(): Promise<void>;
  /** Test/ops hook: run one sweep immediately. */
  sweepOnce(): Promise<void>;
};

type DispatchOk = { ok: true };
type DispatchFail = {
  ok: false;
  reason: Extract<CronOccurrenceSkipReason, "agent_offline" | "client_paused" | "route_stale">;
};
type DispatchResult = DispatchOk | DispatchFail;

async function readCurrentDispatchability(
  db: Database,
  agentId: string,
  now: Date,
  staleSeconds: number,
): Promise<DispatchResult> {
  const [agent] = await db.select().from(agents).where(eq(agents.uuid, agentId)).limit(1);
  if (!agent || agent.status !== "active" || !agent.clientId) {
    return { ok: false, reason: "agent_offline" };
  }

  const [presence] = await db.select().from(agentPresence).where(eq(agentPresence.agentId, agentId)).limit(1);
  if (!presence || presence.status !== "online" || !presence.clientId || !presence.instanceId) {
    return { ok: false, reason: "agent_offline" };
  }
  if (presence.clientId !== agent.clientId) {
    return { ok: false, reason: "route_stale" };
  }

  const [client] = await db.select().from(clients).where(eq(clients.id, agent.clientId)).limit(1);
  if (!client || client.retiredAt || client.status !== "connected" || !client.instanceId) {
    return { ok: false, reason: "agent_offline" };
  }
  if (client.instanceId !== presence.instanceId) {
    return { ok: false, reason: "route_stale" };
  }
  if (client.pausedReason) {
    return { ok: false, reason: "client_paused" };
  }

  const staleMs = staleSeconds * 1000;
  if (now.getTime() - client.lastSeenAt.getTime() > staleMs) {
    return { ok: false, reason: "route_stale" };
  }
  if (now.getTime() - presence.lastSeenAt.getTime() > staleMs) {
    return { ok: false, reason: "route_stale" };
  }

  const [instance] = await db
    .select()
    .from(serverInstances)
    .where(eq(serverInstances.instanceId, client.instanceId))
    .limit(1);
  if (!instance || now.getTime() - instance.lastHeartbeat.getTime() > staleMs) {
    return { ok: false, reason: "route_stale" };
  }

  return { ok: true };
}

function buildTriggerContent(input: {
  agentName: string | null;
  agentDisplayName: string;
  jobName: string;
  scheduledFor: Date;
  timezone: string;
  runKey: string;
  prompt: string;
}): string {
  const mention = input.agentName ? `@${input.agentName}` : `@${input.agentDisplayName}`;
  return [
    mention,
    "",
    `[Scheduled job: ${input.jobName}]`,
    `Scheduled for: ${input.scheduledFor.toISOString()} (${input.timezone})`,
    `Run key: ${input.runKey}`,
    "",
    "---",
    "",
    input.prompt,
  ].join("\n");
}

type SweepDecision =
  | { kind: "none" }
  | {
      kind: "accepted";
      jobId: string;
      organizationId: string;
      controlChatId: string;
      agentId: string;
      scheduledFor: Date;
      latenessMs: number;
      messageId: string;
      recipients: string[];
      deferred: DeferredSendMessagePostCommitEffects;
    }
  | {
      kind: "skipped";
      jobId: string;
      reason: string;
      organizationId: string;
      controlChatId: string;
      agentId: string;
      scheduledFor: Date;
      latenessMs: number;
    }
  | {
      kind: "auto_paused";
      jobId: string;
      reason: string;
      controlChatId: string;
      agentId: string;
      scheduledFor: Date;
    };

function emitSweepDecisionTelemetry(decision: Exclude<SweepDecision, { kind: "none" }>, sweepStartedAt: number): void {
  const dueToCommitMs = Date.now() - sweepStartedAt;
  if (decision.kind === "accepted") {
    log.info(
      {
        jobId: decision.jobId,
        organizationId: decision.organizationId,
        controlChatId: decision.controlChatId,
        deliveryChatId: decision.controlChatId,
        agentId: decision.agentId,
        scheduledFor: decision.scheduledFor.toISOString(),
        latenessMs: decision.latenessMs,
        dueToCommitMs,
        decisionReason: "accepted",
        metric: "cron_occurrence_accepted_total",
      },
      "cron.occurrence.accepted",
    );
    return;
  }
  if (decision.kind === "skipped") {
    log.info(
      {
        jobId: decision.jobId,
        organizationId: decision.organizationId,
        controlChatId: decision.controlChatId,
        deliveryChatId: decision.controlChatId,
        agentId: decision.agentId,
        scheduledFor: decision.scheduledFor.toISOString(),
        latenessMs: decision.latenessMs,
        dueToCommitMs,
        decisionReason: decision.reason,
        metric: "cron_occurrence_skipped_total",
      },
      "cron.occurrence.skipped",
    );
    return;
  }
  log.info(
    {
      jobId: decision.jobId,
      controlChatId: decision.controlChatId,
      agentId: decision.agentId,
      scheduledFor: decision.scheduledFor.toISOString(),
      dueToCommitMs,
      decisionReason: decision.reason,
      metric: "cron_job_auto_paused_total",
    },
    "cron.job.auto_paused",
  );
}

async function claimAndProcessOne(db: Database, staleSeconds: number): Promise<SweepDecision> {
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Database;
    const claimed = await txDb
      .select()
      .from(cronJobs)
      .where(and(eq(cronJobs.state, "active"), lte(cronJobs.nextRunAt, sql`clock_timestamp()`)))
      .orderBy(asc(cronJobs.nextRunAt), asc(cronJobs.id))
      .limit(1)
      .for("update", { skipLocked: true });

    const job = claimed[0] as CronJobRow | undefined;
    if (!job || !job.nextRunAt) return { kind: "none" as const };

    const now = await databaseNow(txDb);
    const scheduledFor = job.nextRunAt;
    const latenessMs = now.getTime() - scheduledFor.getTime();

    const pause = async (reason: CronJobPauseReason): Promise<SweepDecision> => {
      await tx
        .update(cronJobs)
        .set({
          state: "paused",
          stateReason: reason,
          nextRunAt: null,
          revision: sql`${cronJobs.revision} + 1`,
        })
        .where(eq(cronJobs.id, job.id));
      return {
        kind: "auto_paused",
        jobId: job.id,
        reason,
        controlChatId: job.controlChatId,
        agentId: job.agentId,
        scheduledFor,
      };
    };

    // Parser failures must pause inside the claim transaction. Throwing here
    // rolls back the SKIP LOCKED claim and re-selects the same poison row on
    // every replica, starving the rest of the due queue.
    let nextRunAt: Date | null;
    try {
      nextRunAt = firstOccurrenceStrictlyAfter(job.cronExpression, job.timezone, now);
    } catch (err) {
      if (err instanceof InvalidCronScheduleError) {
        return pause("invalid_schedule");
      }
      throw err;
    }
    if (!nextRunAt) return pause("invalid_schedule");

    const permanent = await revalidateOwnerChatAgent(txDb, job);
    if (!permanent.ok) return pause(permanent.reason);

    const outstanding = await loadOutstanding(txDb, job);
    if (outstanding === "missing") return pause("inbox_state_missing");

    const skip = async (reason: CronOccurrenceSkipReason): Promise<SweepDecision> => {
      await tx.update(cronJobs).set({ nextRunAt }).where(eq(cronJobs.id, job.id));
      return {
        kind: "skipped",
        jobId: job.id,
        reason,
        organizationId: permanent.organizationId,
        controlChatId: job.controlChatId,
        agentId: job.agentId,
        scheduledFor,
        latenessMs,
      };
    };

    if (now.getTime() > scheduledFor.getTime() + CRON_DISPATCH_GRACE_MS) {
      return skip("late");
    }

    if (outstanding && typeof outstanding === "object") {
      return skip("previous_trigger_unacked");
    }

    const route = await readCurrentDispatchability(txDb, job.agentId, now, staleSeconds);
    if (!route.ok) return skip(route.reason);

    const runKey = buildCronRunKey(job.id, scheduledFor);
    const content = buildTriggerContent({
      agentName: permanent.agentName,
      agentDisplayName: permanent.agentDisplayName,
      jobName: job.name,
      scheduledFor,
      timezone: job.timezone,
      runKey,
      prompt: job.prompt,
    });

    const sent = await sendMessage(
      txDb,
      job.controlChatId,
      permanent.ownerHumanAgentId,
      {
        format: "markdown",
        content,
        source: "api",
        metadata: {
          mentions: [job.agentId],
          [CRON_TRIGGER_METADATA_KEY]: {
            jobId: job.id,
            scheduledFor: scheduledFor.toISOString(),
            runKey,
          },
        },
      },
      {
        addressedToAgentIds: [job.agentId],
        allowCronTrigger: true,
        deferPostCommitEffects: true,
      },
    );

    if (!sent.recipients.includes(permanent.agentInboxId)) {
      throw new Error("cron target notify recipient missing");
    }
    if (!sent.deferredPostCommitEffects) {
      throw new Error("cron accept missing deferred post-commit effects");
    }

    await tx
      .update(cronJobs)
      .set({
        nextRunAt,
        lastTriggerMessageId: sent.message.id,
      })
      .where(eq(cronJobs.id, job.id));

    return {
      kind: "accepted" as const,
      jobId: job.id,
      organizationId: permanent.organizationId,
      controlChatId: job.controlChatId,
      agentId: job.agentId,
      scheduledFor,
      latenessMs,
      messageId: sent.message.id,
      recipients: sent.recipients,
      deferred: sent.deferredPostCommitEffects,
    };
  });
}

export async function sweepCronJobs(db: Database, notifier: Notifier, opts: { staleSeconds: number }): Promise<void> {
  const sweepStartedAt = Date.now();
  let processed = 0;
  try {
    for (let i = 0; i < MAX_JOBS_PER_SWEEP; i++) {
      let decision: SweepDecision;
      try {
        decision = await claimAndProcessOne(db, opts.staleSeconds);
      } catch (err) {
        log.error({ err, metric: "cron_sweep_failures_total" }, "cron.sweep.failed");
        break;
      }
      if (decision.kind === "none") break;
      processed += 1;
      // Decision telemetry only after the claim txn committed successfully.
      emitSweepDecisionTelemetry(decision, sweepStartedAt);
      if (decision.kind === "accepted") {
        try {
          await runDeferredSendMessagePostCommitEffects(db, decision.deferred);
          notifyRecipients(notifier, decision.recipients, decision.messageId);
          await notifier.notifyChatUpdated(decision.controlChatId);
        } catch (err) {
          log.error(
            { err, jobId: decision.jobId, messageId: decision.messageId, metric: "cron_post_commit_failures_total" },
            "cron post-commit effects failed",
          );
        }
      }
    }
  } finally {
    log.info(
      {
        processed,
        durationMs: Date.now() - sweepStartedAt,
        saturated: processed >= MAX_JOBS_PER_SWEEP,
        metric: "cron_sweep_duration_ms",
      },
      "cron.sweep.finished",
    );
  }
}

export function createCronScheduler(app: FastifyInstance): CronScheduler {
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight: Promise<void> | null = null;
  let stopping = false;

  const config = (): CronJobsRuntimeConfig => ({
    enabled: app.config.cronJobs.enabled,
    pollingIntervalSeconds: app.config.runtime.pollingIntervalSeconds,
  });

  const run = async () => {
    if (stopping) return;
    if (inFlight) return;
    if (!isCronWorkerRunnable(config())) return;
    const work = (async () => {
      try {
        await sweepCronJobs(app.db, app.notifier, {
          staleSeconds: app.config.runtime.presenceCleanupSeconds,
        });
      } catch (err) {
        log.error({ err, metric: "cron_sweep_failures_total" }, "cron.sweep.failed");
      }
    })();
    inFlight = work;
    try {
      await work;
    } finally {
      if (inFlight === work) inFlight = null;
    }
  };

  return {
    start() {
      if (timer || stopping) return;
      if (!isCronWorkerRunnable(config())) {
        log.info({ enabled: app.config.cronJobs.enabled }, "cron worker not started");
        return;
      }
      const ms = app.config.runtime.pollingIntervalSeconds * 1000;
      timer = setInterval(() => {
        void run();
      }, ms);
      void run();
    },
    async stop() {
      stopping = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (inFlight) {
        await inFlight;
      }
    },
    sweepOnce: run,
  };
}
