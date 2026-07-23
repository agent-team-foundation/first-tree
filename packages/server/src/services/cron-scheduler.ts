import {
  buildCronRunKey,
  CRON_DISPATCH_GRACE_MS,
  CRON_TRIGGER_METADATA_KEY,
  type CronOccurrenceSkipReason,
  type CronJobPauseReason,
} from "@first-tree/shared";
import { and, asc, eq, lte, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Database } from "../db/connection.js";
import { agentPresence } from "../db/schema/agent-presence.js";
import { agents } from "../db/schema/agents.js";
import { clients } from "../db/schema/clients.js";
import { cronJobs, type CronJobRow } from "../db/schema/cron-jobs.js";
import { serverInstances } from "../db/schema/server-instances.js";
import { createLogger } from "../observability/index.js";
import {
  databaseNow,
  isCronWorkerRunnable,
  loadOutstanding,
  revalidateOwnerChatAgent,
  type CronJobsRuntimeConfig,
} from "./cron-job.js";
import { firstOccurrenceStrictlyAfter } from "./cron-schedule.js";
import {
  runDeferredSendMessagePostCommitEffects,
  sendMessage,
  type DeferredSendMessagePostCommitEffects,
} from "./message.js";
import { notifyRecipients, type Notifier } from "./notifier.js";

const log = createLogger("CronScheduler");

const MAX_JOBS_PER_SWEEP = 100;

export type CronScheduler = {
  start(): void;
  stop(): void;
  /** Test/ops hook: run one sweep immediately. */
  sweepOnce(): Promise<void>;
};

type DispatchOk = { ok: true };
type DispatchFail = { ok: false; reason: Extract<CronOccurrenceSkipReason, "agent_offline" | "client_paused" | "route_stale"> };
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
      messageId: string;
      recipients: string[];
      deferred: DeferredSendMessagePostCommitEffects;
    }
  | { kind: "skipped" | "auto_paused"; jobId: string; reason: string };

async function claimAndProcessOne(
  db: Database,
  staleSeconds: number,
): Promise<SweepDecision> {
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
    const nextRunAt = firstOccurrenceStrictlyAfter(job.cronExpression, job.timezone, now);

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
      log.info(
        {
          jobId: job.id,
          controlChatId: job.controlChatId,
          agentId: job.agentId,
          scheduledFor: scheduledFor.toISOString(),
          decisionReason: reason,
        },
        "cron.job.auto_paused",
      );
      return { kind: "auto_paused", jobId: job.id, reason };
    };

    if (!nextRunAt) return pause("invalid_schedule");

    const permanent = await revalidateOwnerChatAgent(txDb, job);
    if (!permanent.ok) return pause(permanent.reason);

    const outstanding = await loadOutstanding(txDb, job);
    if (outstanding === "missing") return pause("inbox_state_missing");

    const skip = async (reason: CronOccurrenceSkipReason): Promise<SweepDecision> => {
      await tx
        .update(cronJobs)
        .set({ nextRunAt })
        .where(eq(cronJobs.id, job.id));
      log.info(
        {
          jobId: job.id,
          organizationId: permanent.organizationId,
          controlChatId: job.controlChatId,
          deliveryChatId: job.controlChatId,
          agentId: job.agentId,
          scheduledFor: scheduledFor.toISOString(),
          latenessMs: now.getTime() - scheduledFor.getTime(),
          decisionReason: reason,
        },
        "cron.occurrence.skipped",
      );
      return { kind: "skipped", jobId: job.id, reason };
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

    log.info(
      {
        jobId: job.id,
        organizationId: permanent.organizationId,
        controlChatId: job.controlChatId,
        deliveryChatId: job.controlChatId,
        agentId: job.agentId,
        scheduledFor: scheduledFor.toISOString(),
        latenessMs: now.getTime() - scheduledFor.getTime(),
        decisionReason: "accepted",
      },
      "cron.occurrence.accepted",
    );

    return {
      kind: "accepted" as const,
      jobId: job.id,
      organizationId: permanent.organizationId,
      controlChatId: job.controlChatId,
      agentId: job.agentId,
      scheduledFor,
      messageId: sent.message.id,
      recipients: sent.recipients,
      deferred: sent.deferredPostCommitEffects,
    };
  });
}

export async function sweepCronJobs(
  db: Database,
  notifier: Notifier,
  opts: { staleSeconds: number },
): Promise<void> {
  for (let i = 0; i < MAX_JOBS_PER_SWEEP; i++) {
    let decision: SweepDecision;
    try {
      decision = await claimAndProcessOne(db, opts.staleSeconds);
    } catch (err) {
      log.error({ err }, "cron.sweep.failed");
      break;
    }
    if (decision.kind === "none") break;
    if (decision.kind === "accepted") {
      try {
        await runDeferredSendMessagePostCommitEffects(db, decision.deferred);
        notifyRecipients(notifier, decision.recipients, decision.messageId);
        await notifier.notifyChatUpdated(decision.controlChatId);
      } catch (err) {
        log.error({ err, jobId: decision.jobId, messageId: decision.messageId }, "cron post-commit effects failed");
      }
    }
  }
}

export function createCronScheduler(app: FastifyInstance): CronScheduler {
  let timer: ReturnType<typeof setInterval> | null = null;
  let sweepInFlight = false;

  const config = (): CronJobsRuntimeConfig => ({
    enabled: app.config.cronJobs.enabled,
    pollingIntervalSeconds: app.config.runtime.pollingIntervalSeconds,
  });

  const run = async () => {
    if (sweepInFlight) return;
    if (!isCronWorkerRunnable(config())) return;
    sweepInFlight = true;
    try {
      await sweepCronJobs(app.db, app.notifier, {
        staleSeconds: app.config.runtime.presenceCleanupSeconds,
      });
    } catch (err) {
      log.error({ err }, "cron.sweep.failed");
    } finally {
      sweepInFlight = false;
    }
  };

  return {
    start() {
      if (timer) return;
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
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    sweepOnce: run,
  };
}
