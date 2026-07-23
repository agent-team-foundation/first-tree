import { CRON_TRIGGER_METADATA_KEY } from "@first-tree/shared";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
import { connectDatabase, sslOptions } from "../db/connection.js";
import { agentPresence } from "../db/schema/agent-presence.js";
import { agents } from "../db/schema/agents.js";
import { chatUserState } from "../db/schema/chat-user-state.js";
import { clients } from "../db/schema/clients.js";
import { cronJobs } from "../db/schema/cron-jobs.js";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { messages } from "../db/schema/messages.js";
import { serverInstances } from "../db/schema/server-instances.js";
import { createChat, ensureParticipant } from "../services/chat.js";
import { createCronJob, deleteCronJob, updateCronJob } from "../services/cron-job.js";
import { computeDueToCommitMs, createCronScheduler, sweepCronJobs } from "../services/cron-scheduler.js";
import { setChatEngagement } from "../services/me-chat.js";
import { sendMessage } from "../services/message.js";
import { createNotifier } from "../services/notifier.js";
import { createTestAgent, useTestApp } from "./helpers.js";

function databaseUrlWithApplicationName(url: string, applicationName: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("application_name", applicationName);
  return parsed.toString();
}

async function waitForPostgresLockWait(observer: ReturnType<typeof postgres>, applicationName: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await observer<{ wait_event_type: string | null }[]>`
      SELECT wait_event_type
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND application_name = ${applicationName}
    `;
    if (rows.some((row) => row.wait_event_type === "Lock")) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for PostgreSQL lock: ${applicationName}`);
}

async function seedDispatchRoute(app: ReturnType<ReturnType<typeof useTestApp>>, agentId: string, clientId: string) {
  const now = new Date();
  const instanceId = app.config.instanceId;
  await app.db
    .update(clients)
    .set({ status: "connected", instanceId, lastSeenAt: now, pausedReason: null })
    .where(eq(clients.id, clientId));
  await app.db
    .insert(agentPresence)
    .values({
      agentId,
      status: "online",
      clientId,
      instanceId,
      lastSeenAt: now,
    })
    .onConflictDoUpdate({
      target: [agentPresence.agentId],
      set: { status: "online", clientId, instanceId, lastSeenAt: now },
    });
  await app.db
    .insert(serverInstances)
    .values({ instanceId, lastHeartbeat: now })
    .onConflictDoUpdate({
      target: [serverInstances.instanceId],
      set: { lastHeartbeat: now },
    });
}

describe("cron jobs integration", () => {
  const getApp = useTestApp({ cronJobsEnabled: true });

  async function setupChatWithAgent() {
    const app = getApp();
    const runtime = await createTestAgent(app, { name: `cron-agent-${crypto.randomUUID().slice(0, 6)}` });
    const chat = await createChat(app.db, runtime.humanAgentUuid, {
      type: "group",
      participantIds: [runtime.agent.uuid],
    });
    await seedDispatchRoute(app, runtime.agent.uuid, runtime.clientId);
    return { app, runtime, chatId: chat.id };
  }

  it("rejects forged cronTrigger metadata on ordinary sends", async () => {
    const { app, runtime, chatId } = await setupChatWithAgent();
    await expect(
      sendMessage(app.db, chatId, runtime.humanAgentUuid, {
        source: "api",
        format: "markdown",
        content: "forged",
        metadata: {
          mentions: [runtime.agent.uuid],
          [CRON_TRIGGER_METADATA_KEY]: {
            jobId: "job-1",
            scheduledFor: new Date().toISOString(),
            runKey: "cron/job-1/now",
          },
        },
      }),
    ).rejects.toThrow(/reserved/i);
  });

  it("claims due jobs exclusively across independent pools with a start barrier", async () => {
    const { app, runtime, chatId } = await setupChatWithAgent();
    const createRes = await runtime.request("POST", `/api/v1/agent/chats/${chatId}/cron-jobs`, {
      name: "hourly-barrier",
      schedule: "0 * * * *",
      timezone: "UTC",
      prompt: "check inbox",
    });
    expect(createRes.statusCode).toBe(201);
    const job = createRes.json() as { id: string };
    await app.db
      .update(cronJobs)
      .set({ nextRunAt: new Date(Date.now() - 5_000) })
      .where(eq(cronJobs.id, job.id));

    const databaseUrl = process.env.DATABASE_URL ?? "";
    if (!databaseUrl) throw new Error("DATABASE_URL is required for the concurrency test");

    const poolA = connectDatabase(
      databaseUrlWithApplicationName(databaseUrl, `cron_sw_a_${crypto.randomUUID().slice(0, 8)}`),
    );
    const poolB = connectDatabase(
      databaseUrlWithApplicationName(databaseUrl, `cron_sw_b_${crypto.randomUUID().slice(0, 8)}`),
    );
    try {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let arrived = 0;
      let bothArrived!: () => void;
      const bothReady = new Promise<void>((resolve) => {
        bothArrived = resolve;
      });
      const beforeClaimForTest = async () => {
        arrived += 1;
        if (arrived >= 2) bothArrived();
        await gate;
      };

      const staleSeconds = app.config.runtime.presenceCleanupSeconds;
      const sweepA = sweepCronJobs(poolA, app.notifier, { staleSeconds, beforeClaimForTest });
      const sweepB = sweepCronJobs(poolB, app.notifier, { staleSeconds, beforeClaimForTest });
      await Promise.race([
        bothReady,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("two-worker barrier timeout")), 10_000);
        }),
      ]);
      expect(arrived).toBeGreaterThanOrEqual(2);
      release();
      await Promise.all([sweepA, sweepB]);

      const rows = await app.db.select().from(messages).where(eq(messages.chatId, chatId));
      const cronMessages = rows.filter((row) => {
        const meta = row.metadata as Record<string, unknown>;
        return meta?.[CRON_TRIGGER_METADATA_KEY] != null;
      });
      expect(cronMessages).toHaveLength(1);
    } finally {
      await poolA.end();
      await poolB.end();
    }
  });

  it("claims due jobs exclusively and materializes one trigger message", async () => {
    const { app, runtime, chatId } = await setupChatWithAgent();
    const createRes = await runtime.request("POST", `/api/v1/agent/chats/${chatId}/cron-jobs`, {
      name: "hourly",
      schedule: "0 * * * *",
      timezone: "UTC",
      prompt: "check inbox",
    });
    expect(createRes.statusCode).toBe(201);
    const job = createRes.json() as { id: string };
    await app.db
      .update(cronJobs)
      .set({ nextRunAt: new Date(Date.now() - 5_000) })
      .where(eq(cronJobs.id, job.id));

    const schedulerA = createCronScheduler(app);
    const schedulerB = createCronScheduler(app);
    await Promise.all([schedulerA.sweepOnce(), schedulerB.sweepOnce()]);

    const rows = await app.db.select().from(messages).where(eq(messages.chatId, chatId));
    const cronMessages = rows.filter((row) => {
      const meta = row.metadata as Record<string, unknown>;
      return meta?.[CRON_TRIGGER_METADATA_KEY] != null;
    });
    expect(cronMessages).toHaveLength(1);
  });

  it("skips when previous trigger is still pending", async () => {
    const { app, runtime, chatId } = await setupChatWithAgent();
    const createRes = await runtime.request("POST", `/api/v1/agent/chats/${chatId}/cron-jobs`, {
      name: "backlog",
      schedule: "0 * * * *",
      timezone: "UTC",
      prompt: "tick",
    });
    const job = createRes.json() as { id: string };
    const sent = await sendMessage(
      app.db,
      chatId,
      runtime.humanAgentUuid,
      {
        source: "api",
        format: "markdown",
        content: "seed",
        metadata: { mentions: [runtime.agent.uuid] },
      },
      { addressedToAgentIds: [runtime.agent.uuid] },
    );
    await app.db
      .update(cronJobs)
      .set({ lastTriggerMessageId: sent.message.id, nextRunAt: new Date(Date.now() - 5_000) })
      .where(eq(cronJobs.id, job.id));

    const before = await app.db.select().from(messages).where(eq(messages.chatId, chatId));
    await createCronScheduler(app).sweepOnce();
    const after = await app.db.select().from(messages).where(eq(messages.chatId, chatId));
    expect(after.length).toBe(before.length);
  });

  it("returns 409 on stale revision", async () => {
    const { runtime, chatId } = await setupChatWithAgent();
    const createRes = await runtime.request("POST", `/api/v1/agent/chats/${chatId}/cron-jobs`, {
      name: "rev",
      schedule: "0 12 * * *",
      timezone: "UTC",
      prompt: "rev test",
    });
    const job = createRes.json() as { id: string; revision: number };
    const patch = await runtime.request(
      "PATCH",
      `/api/v1/agent/chats/${chatId}/cron-jobs/${job.id}`,
      { state: "paused" },
      { "if-match": String(job.revision + 99) },
    );
    expect(patch.statusCode).toBe(409);
    expect(patch.json()).toMatchObject({ code: "CRON_JOB_REVISION_MISMATCH" });
  });

  it("pauses active jobs when owner deletes chat engagement", async () => {
    const { app, runtime, chatId } = await setupChatWithAgent();
    const createRes = await runtime.request("POST", `/api/v1/agent/chats/${chatId}/cron-jobs`, {
      name: "delete-hook",
      schedule: "0 8 * * *",
      timezone: "UTC",
      prompt: "before delete",
    });
    expect(createRes.statusCode).toBe(201);
    await setChatEngagement(app.db, chatId, runtime.humanAgentUuid, "deleted");
    const [row] = await app.db.select().from(cronJobs).where(eq(cronJobs.controlChatId, chatId));
    expect(row?.state).toBe("paused");
    expect(row?.stateReason).toBe("owner_chat_deleted");
    expect(row?.nextRunAt).toBeNull();
    const [engagement] = await app.db
      .select()
      .from(chatUserState)
      .where(and(eq(chatUserState.chatId, chatId), eq(chatUserState.agentId, runtime.humanAgentUuid)));
    expect(engagement?.engagementStatus).toBe("deleted");
  });

  it("projects outstanding=null after target inbox entry is acked", async () => {
    const { app, runtime, chatId } = await setupChatWithAgent();
    const createRes = await runtime.request("POST", `/api/v1/agent/chats/${chatId}/cron-jobs`, {
      name: "outstanding",
      schedule: "0 7 * * *",
      timezone: "UTC",
      prompt: "out",
    });
    const job = createRes.json() as { id: string };
    const sent = await sendMessage(app.db, chatId, runtime.humanAgentUuid, {
      source: "api",
      format: "markdown",
      content: "trigger",
      metadata: { mentions: [runtime.agent.uuid] },
    });
    await app.db.update(cronJobs).set({ lastTriggerMessageId: sent.message.id }).where(eq(cronJobs.id, job.id));
    await app.db
      .update(inboxEntries)
      .set({ status: "acked", ackedAt: new Date() })
      .where(and(eq(inboxEntries.messageId, sent.message.id), eq(inboxEntries.inboxId, runtime.agent.inboxId)));

    const show = await runtime.request("GET", `/api/v1/agent/chats/${chatId}/cron-jobs/${job.id}`);
    expect(show.statusCode).toBe(200);
    expect((show.json() as { outstanding: unknown }).outstanding).toBeNull();
  });

  it("auto-pauses an unparsable due job so a later valid job can still run", async () => {
    const { app, runtime, chatId } = await setupChatWithAgent();
    const poisonRes = await runtime.request("POST", `/api/v1/agent/chats/${chatId}/cron-jobs`, {
      name: "poison",
      schedule: "0 * * * *",
      timezone: "UTC",
      prompt: "bad",
    });
    const validRes = await runtime.request("POST", `/api/v1/agent/chats/${chatId}/cron-jobs`, {
      name: "valid-follower",
      schedule: "0 * * * *",
      timezone: "UTC",
      prompt: "ok",
    });
    expect(poisonRes.statusCode).toBe(201);
    expect(validRes.statusCode).toBe(201);
    const poison = poisonRes.json() as { id: string };
    const valid = validRes.json() as { id: string };
    const due = new Date(Date.now() - 5_000);
    await app.db.update(cronJobs).set({ timezone: "Not/ARealZone", nextRunAt: due }).where(eq(cronJobs.id, poison.id));
    await app.db
      .update(cronJobs)
      .set({ nextRunAt: new Date(due.getTime() + 1) })
      .where(eq(cronJobs.id, valid.id));

    await createCronScheduler(app).sweepOnce();
    await createCronScheduler(app).sweepOnce();

    const [poisonRow] = await app.db.select().from(cronJobs).where(eq(cronJobs.id, poison.id));
    expect(poisonRow?.state).toBe("paused");
    expect(poisonRow?.stateReason).toBe("invalid_schedule");

    const rows = await app.db.select().from(messages).where(eq(messages.chatId, chatId));
    const cronMessages = rows.filter((row) => {
      const meta = row.metadata as Record<string, unknown>;
      return meta?.[CRON_TRIGGER_METADATA_KEY] != null;
    });
    expect(cronMessages.length).toBeGreaterThanOrEqual(1);
  });

  it("applies field changes when pausing an already user-paused job", async () => {
    const { runtime, chatId } = await setupChatWithAgent();
    const createRes = await runtime.request("POST", `/api/v1/agent/chats/${chatId}/cron-jobs`, {
      name: "rename-while-paused",
      schedule: "0 12 * * *",
      timezone: "UTC",
      prompt: "before",
    });
    const job = createRes.json() as { id: string; revision: number };
    const pause = await runtime.request(
      "PATCH",
      `/api/v1/agent/chats/${chatId}/cron-jobs/${job.id}`,
      { state: "paused" },
      { "if-match": String(job.revision) },
    );
    expect(pause.statusCode).toBe(200);
    const paused = pause.json() as { revision: number; state: string };
    const rename = await runtime.request(
      "PATCH",
      `/api/v1/agent/chats/${chatId}/cron-jobs/${job.id}`,
      { state: "paused", name: "renamed", prompt: "after" },
      { "if-match": String(paused.revision) },
    );
    expect(rename.statusCode).toBe(200);
    expect(rename.json()).toMatchObject({
      name: "renamed",
      prompt: "after",
      state: "paused",
      stateReason: "user_paused",
    });
  });

  it("maps rename unique violations to CRON_JOB_NAME_CONFLICT on pause branch", async () => {
    const { runtime, chatId } = await setupChatWithAgent();
    const first = await runtime.request("POST", `/api/v1/agent/chats/${chatId}/cron-jobs`, {
      name: "alpha",
      schedule: "0 1 * * *",
      timezone: "UTC",
      prompt: "a",
    });
    const second = await runtime.request("POST", `/api/v1/agent/chats/${chatId}/cron-jobs`, {
      name: "beta",
      schedule: "0 2 * * *",
      timezone: "UTC",
      prompt: "b",
    });
    const job = second.json() as { id: string; revision: number };
    const conflict = await runtime.request(
      "PATCH",
      `/api/v1/agent/chats/${chatId}/cron-jobs/${job.id}`,
      { state: "paused", name: "alpha" },
      { "if-match": String(job.revision) },
    );
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: "CRON_JOB_NAME_CONFLICT" });
    expect(first.statusCode).toBe(201);
  });

  it("keeps revision and nextRunAt stable on already-active state:active no-op", async () => {
    const { runtime, chatId } = await setupChatWithAgent();
    const createRes = await runtime.request("POST", `/api/v1/agent/chats/${chatId}/cron-jobs`, {
      name: "noop-active",
      schedule: "0 12 * * *",
      timezone: "UTC",
      prompt: "keep",
    });
    const job = createRes.json() as { id: string; revision: number; nextRunAt: string };
    const patch = await runtime.request(
      "PATCH",
      `/api/v1/agent/chats/${chatId}/cron-jobs/${job.id}`,
      { state: "active" },
      { "if-match": String(job.revision) },
    );
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toMatchObject({
      revision: job.revision,
      nextRunAt: job.nextRunAt,
      state: "active",
    });
  });

  it("preserves nextRunAt on prompt-only edit of an active job", async () => {
    const { runtime, chatId } = await setupChatWithAgent();
    const createRes = await runtime.request("POST", `/api/v1/agent/chats/${chatId}/cron-jobs`, {
      name: "prompt-only",
      schedule: "0 15 * * *",
      timezone: "UTC",
      prompt: "before",
    });
    const job = createRes.json() as { id: string; revision: number; nextRunAt: string };
    const patch = await runtime.request(
      "PATCH",
      `/api/v1/agent/chats/${chatId}/cron-jobs/${job.id}`,
      { prompt: "after" },
      { "if-match": String(job.revision) },
    );
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toMatchObject({
      prompt: "after",
      nextRunAt: job.nextRunAt,
      revision: job.revision + 1,
    });
  });

  it("rejects former manager after agent reassignment", async () => {
    const { app, runtime, chatId } = await setupChatWithAgent();
    const other = await createTestAgent(app, { name: `cron-other-${crypto.randomUUID().slice(0, 6)}` });
    await app.db.update(agents).set({ managerId: other.memberId }).where(eq(agents.uuid, runtime.agent.uuid));
    const denied = await runtime.request("POST", `/api/v1/agent/chats/${chatId}/cron-jobs`, {
      name: "stolen",
      schedule: "0 3 * * *",
      timezone: "UTC",
      prompt: "no",
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: "CRON_JOB_FORBIDDEN" });
  });

  it("rejects create when owner engagement is deleted", async () => {
    const { app, runtime, chatId } = await setupChatWithAgent();
    await setChatEngagement(app.db, chatId, runtime.humanAgentUuid, "deleted");
    const denied = await runtime.request("POST", `/api/v1/agent/chats/${chatId}/cron-jobs`, {
      name: "after-delete",
      schedule: "0 4 * * *",
      timezone: "UTC",
      prompt: "no",
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: "CRON_JOB_FORBIDDEN" });
  });

  it("returns stable codes for invalid timezone and reserved cronTrigger forge", async () => {
    const { app, runtime, chatId } = await setupChatWithAgent();
    const preview = await runtime.request("POST", `/api/v1/agent/chats/${chatId}/cron-jobs/preview`, {
      schedule: "0 9 * * *",
      timezone: "Not/AZone",
    });
    expect(preview.statusCode).toBe(400);
    expect(preview.json()).toMatchObject({ code: "CRON_JOB_INVALID_TIMEZONE" });

    await expect(
      sendMessage(app.db, chatId, runtime.humanAgentUuid, {
        source: "api",
        format: "markdown",
        content: "forged",
        metadata: {
          mentions: [runtime.agent.uuid],
          [CRON_TRIGGER_METADATA_KEY]: {
            jobId: "job-1",
            scheduledFor: new Date().toISOString(),
            runKey: "cron/job-1/now",
          },
        },
      }),
    ).rejects.toMatchObject({ attrs: { code: "CRON_TRIGGER_METADATA_RESERVED" } });
  });

  it("idempotently returns the same job for concurrent identical creates", async () => {
    const { app, runtime, chatId } = await setupChatWithAgent();
    const body = {
      name: "concurrent-identical",
      schedule: "0 6 * * *",
      timezone: "UTC",
      prompt: "same",
    };
    const config = {
      enabled: true,
      pollingIntervalSeconds: app.config.runtime.pollingIntervalSeconds,
    };
    const [a, b] = await Promise.all([
      createCronJob(app.db, {
        controlChatId: chatId,
        agentId: runtime.agent.uuid,
        body,
        config,
      }),
      createCronJob(app.db, {
        controlChatId: chatId,
        agentId: runtime.agent.uuid,
        body,
        config,
      }),
    ]);
    expect(a.id).toBe(b.id);
    expect(a.revision).toBe(b.revision);
    const rows = await app.db
      .select()
      .from(cronJobs)
      .where(and(eq(cronJobs.controlChatId, chatId), eq(cronJobs.name, body.name)));
    expect(rows).toHaveLength(1);
  });

  it("serializes concurrent Class D resume against owner chat deletion without deadlock", async () => {
    const { app, runtime, chatId } = await setupChatWithAgent();
    const createRes = await runtime.request("POST", `/api/v1/agent/chats/${chatId}/cron-jobs`, {
      name: "resume-vs-delete",
      schedule: "0 7 * * *",
      timezone: "UTC",
      prompt: "tick",
    });
    expect(createRes.statusCode).toBe(201);
    const job = createRes.json() as { id: string; revision: number };
    const config = {
      enabled: true,
      pollingIntervalSeconds: app.config.runtime.pollingIntervalSeconds,
    };

    // Class D caller fields exercise member→agent→speakers→advisory→engagement
    // recheck (not the legacy internal path that skipped auth locks).
    const raced = Promise.allSettled([
      updateCronJob(app.db, {
        jobId: job.id,
        expectedRevision: job.revision,
        body: { state: "active" },
        config,
        agentScope: { agentId: runtime.agent.uuid, controlChatId: chatId },
        callerMemberId: runtime.memberId,
        callerHumanAgentId: runtime.humanAgentUuid,
      }),
      setChatEngagement(app.db, chatId, runtime.humanAgentUuid, "deleted"),
    ]);
    const outcome = await Promise.race([
      raced,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("resume-vs-delete deadlock timeout")), 15_000);
      }),
    ]);
    expect(outcome).toHaveLength(2);
    expect(outcome[1]?.status).toBe("fulfilled");
    const resumeResult = outcome[0];
    if (resumeResult?.status === "rejected") {
      expect(resumeResult.reason).toMatchObject({ code: "CRON_JOB_FORBIDDEN", statusCode: 403 });
    }

    const [row] = await app.db.select().from(cronJobs).where(eq(cronJobs.id, job.id)).limit(1);
    expect(row?.state).toBe("paused");
    expect(row?.stateReason).toBe("owner_chat_deleted");
  });

  it("serializes Class D create against chat deletion when engagement row is missing", async () => {
    const { app, runtime, chatId } = await setupChatWithAgent();
    // createChat does not seed chat_user_state — missing-row case for Class D.
    const existing = await app.db
      .select()
      .from(chatUserState)
      .where(and(eq(chatUserState.chatId, chatId), eq(chatUserState.agentId, runtime.humanAgentUuid)));
    expect(existing).toHaveLength(0);

    const config = {
      enabled: true,
      pollingIntervalSeconds: app.config.runtime.pollingIntervalSeconds,
    };
    const raced = Promise.allSettled([
      createCronJob(app.db, {
        controlChatId: chatId,
        agentId: runtime.agent.uuid,
        body: {
          name: "create-vs-delete-missing-engagement",
          schedule: "0 9 * * *",
          timezone: "UTC",
          prompt: "must not land after chat delete",
        },
        config,
        callerMemberId: runtime.memberId,
        callerHumanAgentId: runtime.humanAgentUuid,
      }),
      setChatEngagement(app.db, chatId, runtime.humanAgentUuid, "deleted"),
    ]);
    const outcome = await Promise.race([
      raced,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("create-vs-delete missing-engagement deadlock timeout")), 15_000);
      }),
    ]);
    expect(outcome).toHaveLength(2);
    expect(outcome[1]?.status).toBe("fulfilled");

    const createResult = outcome[0];
    const rows = await app.db
      .select()
      .from(cronJobs)
      .where(and(eq(cronJobs.controlChatId, chatId), eq(cronJobs.name, "create-vs-delete-missing-engagement")));
    if (createResult?.status === "fulfilled") {
      expect(rows).toHaveLength(1);
      expect(rows[0]?.state).toBe("paused");
      expect(rows[0]?.stateReason).toBe("owner_chat_deleted");
    } else {
      expect(createResult?.reason).toMatchObject({ code: "CRON_JOB_FORBIDDEN", statusCode: 403 });
      expect(rows).toHaveLength(0);
    }
    const [engagement] = await app.db
      .select()
      .from(chatUserState)
      .where(and(eq(chatUserState.chatId, chatId), eq(chatUserState.agentId, runtime.humanAgentUuid)))
      .limit(1);
    expect(engagement?.engagementStatus).toBe("deleted");
  });

  it("serializes Class D pause against owner chat deletion without deadlock", async () => {
    const { app, runtime, chatId } = await setupChatWithAgent();
    await setChatEngagement(app.db, chatId, runtime.humanAgentUuid, "active");
    const createRes = await runtime.request("POST", `/api/v1/agent/chats/${chatId}/cron-jobs`, {
      name: "pause-vs-delete",
      schedule: "0 10 * * *",
      timezone: "UTC",
      prompt: "tick",
    });
    const job = createRes.json() as { id: string; revision: number };
    const config = {
      enabled: true,
      pollingIntervalSeconds: app.config.runtime.pollingIntervalSeconds,
    };

    const raced = Promise.allSettled([
      updateCronJob(app.db, {
        jobId: job.id,
        expectedRevision: job.revision,
        body: { state: "paused" },
        config,
        agentScope: { agentId: runtime.agent.uuid, controlChatId: chatId },
        callerMemberId: runtime.memberId,
        callerHumanAgentId: runtime.humanAgentUuid,
      }),
      setChatEngagement(app.db, chatId, runtime.humanAgentUuid, "deleted"),
    ]);
    const outcome = await Promise.race([
      raced,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("pause-vs-delete deadlock timeout")), 15_000);
      }),
    ]);
    expect(outcome).toHaveLength(2);
    expect(outcome[1]?.status).toBe("fulfilled");
    const mutate = outcome[0];
    if (mutate?.status === "rejected") {
      expect(["CRON_JOB_FORBIDDEN", "CRON_JOB_REVISION_MISMATCH"]).toContain((mutate.reason as { code?: string }).code);
    }

    const [row] = await app.db.select().from(cronJobs).where(eq(cronJobs.id, job.id)).limit(1);
    expect(row?.state).toBe("paused");
    expect(["owner_chat_deleted", "user_paused"]).toContain(row?.stateReason);
  });

  it("serializes Class D config update against owner chat deletion without deadlock", async () => {
    const { app, runtime, chatId } = await setupChatWithAgent();
    await setChatEngagement(app.db, chatId, runtime.humanAgentUuid, "active");
    const createRes = await runtime.request("POST", `/api/v1/agent/chats/${chatId}/cron-jobs`, {
      name: "config-vs-delete",
      schedule: "0 11 * * *",
      timezone: "UTC",
      prompt: "tick",
    });
    const job = createRes.json() as { id: string; revision: number };
    const config = {
      enabled: true,
      pollingIntervalSeconds: app.config.runtime.pollingIntervalSeconds,
    };

    const raced = Promise.allSettled([
      updateCronJob(app.db, {
        jobId: job.id,
        expectedRevision: job.revision,
        body: { prompt: "rewritten" },
        config,
        agentScope: { agentId: runtime.agent.uuid, controlChatId: chatId },
        callerMemberId: runtime.memberId,
        callerHumanAgentId: runtime.humanAgentUuid,
      }),
      setChatEngagement(app.db, chatId, runtime.humanAgentUuid, "deleted"),
    ]);
    const outcome = await Promise.race([
      raced,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("config-vs-delete deadlock timeout")), 15_000);
      }),
    ]);
    expect(outcome).toHaveLength(2);
    expect(outcome[1]?.status).toBe("fulfilled");
    const mutate = outcome[0];
    if (mutate?.status === "rejected") {
      expect(["CRON_JOB_FORBIDDEN", "CRON_JOB_REVISION_MISMATCH"]).toContain((mutate.reason as { code?: string }).code);
    }

    const [row] = await app.db.select().from(cronJobs).where(eq(cronJobs.id, job.id)).limit(1);
    expect(row).toBeTruthy();
    expect(row?.state).toBe("paused");
    expect(row?.stateReason).toBe("owner_chat_deleted");
  });

  it("serializes Class D job delete against owner chat deletion without deadlock", async () => {
    const { app, runtime, chatId } = await setupChatWithAgent();
    await setChatEngagement(app.db, chatId, runtime.humanAgentUuid, "active");
    const createRes = await runtime.request("POST", `/api/v1/agent/chats/${chatId}/cron-jobs`, {
      name: "job-delete-vs-chat-delete",
      schedule: "0 12 * * *",
      timezone: "UTC",
      prompt: "tick",
    });
    const job = createRes.json() as { id: string; revision: number };

    const raced = Promise.allSettled([
      deleteCronJob(app.db, {
        jobId: job.id,
        expectedRevision: job.revision,
        agentScope: { agentId: runtime.agent.uuid, controlChatId: chatId },
        callerMemberId: runtime.memberId,
        callerHumanAgentId: runtime.humanAgentUuid,
      }),
      setChatEngagement(app.db, chatId, runtime.humanAgentUuid, "deleted"),
    ]);
    const outcome = await Promise.race([
      raced,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("job-delete-vs-chat-delete deadlock timeout")), 15_000);
      }),
    ]);
    expect(outcome).toHaveLength(2);
    expect(outcome[1]?.status).toBe("fulfilled");
    const mutate = outcome[0];
    if (mutate?.status === "rejected") {
      expect(["CRON_JOB_FORBIDDEN", "CRON_JOB_REVISION_MISMATCH"]).toContain((mutate.reason as { code?: string }).code);
    }

    const rows = await app.db.select().from(cronJobs).where(eq(cronJobs.id, job.id));
    if (rows.length === 1) {
      expect(rows[0]?.state).toBe("paused");
      expect(rows[0]?.stateReason).toBe("owner_chat_deleted");
    } else {
      expect(rows).toHaveLength(0);
    }
  });

  it("returns CRON_JOB_INVALID_REQUEST for malformed If-Match and empty PATCH", async () => {
    const { runtime, chatId } = await setupChatWithAgent();
    const createRes = await runtime.request("POST", `/api/v1/agent/chats/${chatId}/cron-jobs`, {
      name: "codes",
      schedule: "0 8 * * *",
      timezone: "UTC",
      prompt: "tick",
    });
    const job = createRes.json() as { id: string; revision: number };

    const badMatch = await runtime.request(
      "PATCH",
      `/api/v1/agent/chats/${chatId}/cron-jobs/${job.id}`,
      { prompt: "x" },
      { "if-match": "not-a-revision" },
    );
    expect(badMatch.statusCode).toBe(400);
    expect(badMatch.json()).toMatchObject({ code: "CRON_JOB_INVALID_REQUEST" });

    const emptyPatch = await runtime.request(
      "PATCH",
      `/api/v1/agent/chats/${chatId}/cron-jobs/${job.id}`,
      {},
      { "if-match": String(job.revision) },
    );
    expect(emptyPatch.statusCode).toBe(400);
    expect(emptyPatch.json()).toMatchObject({ code: "CRON_JOB_INVALID_REQUEST" });

    const badName = await runtime.request(
      "PATCH",
      `/api/v1/agent/chats/${chatId}/cron-jobs/${job.id}`,
      { name: "" },
      { "if-match": String(job.revision) },
    );
    expect(badName.statusCode).toBe(400);
    expect(badName.json()).toMatchObject({ code: "CRON_JOB_INVALID_REQUEST" });
  });

  it("returns CRON_JOB_FORBIDDEN when a non-participant agent hits Class D cron routes", async () => {
    const { app, chatId } = await setupChatWithAgent();
    const outsider = await createTestAgent(app, { name: `cron-out-${crypto.randomUUID().slice(0, 6)}` });
    const denied = await outsider.request("GET", `/api/v1/agent/chats/${chatId}/cron-jobs`);
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: "CRON_JOB_FORBIDDEN" });
  });

  it("rejects Class D create/PATCH/DELETE when the caller is no longer the manager", async () => {
    const { app, runtime, chatId } = await setupChatWithAgent();
    const createRes = await runtime.request("POST", `/api/v1/agent/chats/${chatId}/cron-jobs`, {
      name: "pre-reassign",
      schedule: "0 9 * * *",
      timezone: "UTC",
      prompt: "tick",
    });
    expect(createRes.statusCode).toBe(201);
    const job = createRes.json() as { id: string; revision: number };

    const other = await createTestAgent(app, { name: `cron-mgr-${crypto.randomUUID().slice(0, 6)}` });
    // Keep agent in original chat as speaker; only flip manager.
    await app.db.update(agents).set({ managerId: other.memberId }).where(eq(agents.uuid, runtime.agent.uuid));

    const config = {
      enabled: true,
      pollingIntervalSeconds: app.config.runtime.pollingIntervalSeconds,
    };
    await expect(
      createCronJob(app.db, {
        controlChatId: chatId,
        agentId: runtime.agent.uuid,
        body: { name: "after-reassign", schedule: "0 10 * * *", timezone: "UTC", prompt: "no" },
        config,
        callerMemberId: runtime.memberId,
        callerHumanAgentId: runtime.humanAgentUuid,
      }),
    ).rejects.toMatchObject({ code: "CRON_JOB_FORBIDDEN", statusCode: 403 });

    await expect(
      updateCronJob(app.db, {
        jobId: job.id,
        expectedRevision: job.revision,
        body: { prompt: "stolen" },
        config,
        agentScope: { agentId: runtime.agent.uuid, controlChatId: chatId },
        callerMemberId: runtime.memberId,
        callerHumanAgentId: runtime.humanAgentUuid,
      }),
    ).rejects.toMatchObject({ code: "CRON_JOB_FORBIDDEN", statusCode: 403 });

    await expect(
      deleteCronJob(app.db, {
        jobId: job.id,
        expectedRevision: job.revision,
        agentScope: { agentId: runtime.agent.uuid, controlChatId: chatId },
        callerMemberId: runtime.memberId,
        callerHumanAgentId: runtime.humanAgentUuid,
      }),
    ).rejects.toMatchObject({ code: "CRON_JOB_FORBIDDEN", statusCode: 403 });
  });

  it("rejects Class D PATCH/DELETE from a new manager who is also a chat speaker", async () => {
    const { app, runtime, chatId } = await setupChatWithAgent();
    const createRes = await runtime.request("POST", `/api/v1/agent/chats/${chatId}/cron-jobs`, {
      name: "owned-by-a",
      schedule: "0 13 * * *",
      timezone: "UTC",
      prompt: "owner A schedule",
    });
    expect(createRes.statusCode).toBe(201);
    const job = createRes.json() as { id: string; revision: number; prompt: string };
    expect(job.prompt).toBe("owner A schedule");

    const newMgr = await createTestAgent(app, { name: `cron-newmgr-${crypto.randomUUID().slice(0, 6)}` });
    await ensureParticipant(app.db, chatId, newMgr.humanAgentUuid);
    await app.db.update(agents).set({ managerId: newMgr.memberId }).where(eq(agents.uuid, runtime.agent.uuid));

    const config = {
      enabled: true,
      pollingIntervalSeconds: app.config.runtime.pollingIntervalSeconds,
    };

    // New manager passes current-manager+speaker auth but is not the schedule owner.
    await expect(
      updateCronJob(app.db, {
        jobId: job.id,
        expectedRevision: job.revision,
        body: { prompt: "stolen by B" },
        config,
        agentScope: { agentId: runtime.agent.uuid, controlChatId: chatId },
        callerMemberId: newMgr.memberId,
        callerHumanAgentId: newMgr.humanAgentUuid,
      }),
    ).rejects.toMatchObject({ code: "CRON_JOB_FORBIDDEN", statusCode: 403 });

    await expect(
      deleteCronJob(app.db, {
        jobId: job.id,
        expectedRevision: job.revision,
        agentScope: { agentId: runtime.agent.uuid, controlChatId: chatId },
        callerMemberId: newMgr.memberId,
        callerHumanAgentId: newMgr.humanAgentUuid,
      }),
    ).rejects.toMatchObject({ code: "CRON_JOB_FORBIDDEN", statusCode: 403 });

    const [row] = await app.db.select().from(cronJobs).where(eq(cronJobs.id, job.id)).limit(1);
    expect(row?.ownerMemberId).toBe(runtime.memberId);
    expect(row?.prompt).toBe("owner A schedule");
    expect(row?.state).toBe("active");
  });

  it("keeps reassigned owner-scoped job intact when new manager races chat deletion", async () => {
    const { app, runtime, chatId } = await setupChatWithAgent();
    await setChatEngagement(app.db, chatId, runtime.humanAgentUuid, "active");
    const createRes = await runtime.request("POST", `/api/v1/agent/chats/${chatId}/cron-jobs`, {
      name: "reassign-vs-delete",
      schedule: "0 14 * * *",
      timezone: "UTC",
      prompt: "must stay owner-scoped",
    });
    const job = createRes.json() as { id: string; revision: number };

    const newMgr = await createTestAgent(app, { name: `cron-race-b-${crypto.randomUUID().slice(0, 6)}` });
    await ensureParticipant(app.db, chatId, newMgr.humanAgentUuid);
    await app.db.update(agents).set({ managerId: newMgr.memberId }).where(eq(agents.uuid, runtime.agent.uuid));

    const config = {
      enabled: true,
      pollingIntervalSeconds: app.config.runtime.pollingIntervalSeconds,
    };

    // B's mutate must fail on owner identity before taking (chat, A) advisory;
    // B's engagement delete uses (chat, B) and must not pause A's jobs.
    // Owner A's chat delete pauses the job under the correct advisory key.
    const raced = Promise.allSettled([
      updateCronJob(app.db, {
        jobId: job.id,
        expectedRevision: job.revision,
        body: { prompt: "B must not win" },
        config,
        agentScope: { agentId: runtime.agent.uuid, controlChatId: chatId },
        callerMemberId: newMgr.memberId,
        callerHumanAgentId: newMgr.humanAgentUuid,
      }),
      setChatEngagement(app.db, chatId, newMgr.humanAgentUuid, "deleted"),
      setChatEngagement(app.db, chatId, runtime.humanAgentUuid, "deleted"),
    ]);
    const outcome = await Promise.race([
      raced,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("reassign-vs-delete deadlock timeout")), 15_000);
      }),
    ]);
    expect(outcome).toHaveLength(3);
    expect(outcome[0]?.status).toBe("rejected");
    if (outcome[0]?.status === "rejected") {
      expect(outcome[0].reason).toMatchObject({ code: "CRON_JOB_FORBIDDEN", statusCode: 403 });
    }
    expect(outcome[1]?.status).toBe("fulfilled");
    expect(outcome[2]?.status).toBe("fulfilled");

    const [row] = await app.db.select().from(cronJobs).where(eq(cronJobs.id, job.id)).limit(1);
    expect(row?.ownerMemberId).toBe(runtime.memberId);
    expect(row?.prompt).toBe("must stay owner-scoped");
    expect(row?.state).toBe("paused");
    expect(row?.stateReason).toBe("owner_chat_deleted");
  });

  it("maps create racing a name-only rename to CRON_JOB_NAME_CONFLICT without 25P02", async () => {
    const { app, runtime, chatId } = await setupChatWithAgent();
    const config = {
      enabled: true,
      pollingIntervalSeconds: app.config.runtime.pollingIntervalSeconds,
    };
    const existing = await createCronJob(app.db, {
      controlChatId: chatId,
      agentId: runtime.agent.uuid,
      body: { name: "before-rename", schedule: "0 11 * * *", timezone: "UTC", prompt: "a" },
      config,
      callerMemberId: runtime.memberId,
      callerHumanAgentId: runtime.humanAgentUuid,
    });

    const outcomes = await Promise.allSettled([
      updateCronJob(app.db, {
        jobId: existing.id,
        expectedRevision: existing.revision,
        body: { name: "raced-name" },
        config,
        agentScope: { agentId: runtime.agent.uuid, controlChatId: chatId },
        callerMemberId: runtime.memberId,
        callerHumanAgentId: runtime.humanAgentUuid,
      }),
      createCronJob(app.db, {
        controlChatId: chatId,
        agentId: runtime.agent.uuid,
        body: { name: "raced-name", schedule: "0 12 * * *", timezone: "UTC", prompt: "b" },
        config,
        callerMemberId: runtime.memberId,
        callerHumanAgentId: runtime.humanAgentUuid,
      }),
    ]);

    const rejected = outcomes.filter((item) => item.status === "rejected");
    for (const item of rejected) {
      expect(item.status).toBe("rejected");
      if (item.status === "rejected") {
        expect(item.reason).toMatchObject({ code: "CRON_JOB_NAME_CONFLICT", statusCode: 409 });
        expect(String(item.reason?.cause?.code ?? "")).not.toBe("25P02");
        expect(String(item.reason?.message ?? "")).not.toMatch(/current transaction is aborted/i);
      }
    }
    const rows = await app.db
      .select()
      .from(cronJobs)
      .where(and(eq(cronJobs.controlChatId, chatId), eq(cronJobs.name, "raced-name")));
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it("does not advance nextRunAt or revision for an identical schedule/timezone PATCH", async () => {
    const { app, runtime, chatId } = await setupChatWithAgent();
    const createRes = await runtime.request("POST", `/api/v1/agent/chats/${chatId}/cron-jobs`, {
      name: "due-preserve",
      schedule: "0 * * * *",
      timezone: "UTC",
      prompt: "tick",
    });
    const job = createRes.json() as { id: string; revision: number; schedule: string; timezone: string };
    const dueAt = new Date(Date.now() - 5_000);
    await app.db.update(cronJobs).set({ nextRunAt: dueAt }).where(eq(cronJobs.id, job.id));

    const patched = await updateCronJob(app.db, {
      jobId: job.id,
      expectedRevision: job.revision,
      body: { schedule: job.schedule, timezone: job.timezone },
      config: {
        enabled: true,
        pollingIntervalSeconds: app.config.runtime.pollingIntervalSeconds,
      },
      agentScope: { agentId: runtime.agent.uuid, controlChatId: chatId },
      callerMemberId: runtime.memberId,
      callerHumanAgentId: runtime.humanAgentUuid,
    });

    expect(patched.revision).toBe(job.revision);
    expect(patched.nextRunAt).toBe(dueAt.toISOString());
  });

  it("rejects create when kill switch is off but still allows pause", async () => {
    const { app, runtime, chatId } = await setupChatWithAgent();
    const enabledConfig = {
      enabled: true,
      pollingIntervalSeconds: app.config.runtime.pollingIntervalSeconds,
    };
    const job = await createCronJob(app.db, {
      controlChatId: chatId,
      agentId: runtime.agent.uuid,
      body: { name: "kill-switch", schedule: "0 13 * * *", timezone: "UTC", prompt: "x" },
      config: enabledConfig,
      callerMemberId: runtime.memberId,
      callerHumanAgentId: runtime.humanAgentUuid,
    });

    await expect(
      createCronJob(app.db, {
        controlChatId: chatId,
        agentId: runtime.agent.uuid,
        body: { name: "disabled-create", schedule: "0 14 * * *", timezone: "UTC", prompt: "x" },
        config: { enabled: false, pollingIntervalSeconds: 5 },
        callerMemberId: runtime.memberId,
        callerHumanAgentId: runtime.humanAgentUuid,
      }),
    ).rejects.toMatchObject({ code: "CRON_JOBS_DISABLED" });

    const paused = await updateCronJob(app.db, {
      jobId: job.id,
      expectedRevision: job.revision,
      body: { state: "paused" },
      config: { enabled: false, pollingIntervalSeconds: 5 },
      agentScope: { agentId: runtime.agent.uuid, controlChatId: chatId },
      callerMemberId: runtime.memberId,
      callerHumanAgentId: runtime.humanAgentUuid,
    });
    expect(paused.state).toBe("paused");
  });

  it("awaits an in-flight sweep before scheduler stop resolves", async () => {
    const { app, runtime, chatId } = await setupChatWithAgent();
    const createRes = await runtime.request("POST", `/api/v1/agent/chats/${chatId}/cron-jobs`, {
      name: "shutdown-drain",
      schedule: "0 * * * *",
      timezone: "UTC",
      prompt: "tick",
    });
    const job = createRes.json() as { id: string };
    await app.db
      .update(cronJobs)
      .set({ nextRunAt: new Date(Date.now() - 1_000) })
      .where(eq(cronJobs.id, job.id));

    const scheduler = createCronScheduler(app);
    const sweep = scheduler.sweepOnce();
    await scheduler.stop();
    await expect(sweep).resolves.toBeUndefined();
    const [row] = await app.db.select().from(cronJobs).where(eq(cronJobs.id, job.id)).limit(1);
    expect(row?.nextRunAt?.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it("rejects create when manager reassignment commits between auth lock and write", async () => {
    const { app, runtime, chatId } = await setupChatWithAgent();
    const other = await createTestAgent(app, { name: `cron-race-mgr-${crypto.randomUUID().slice(0, 6)}` });
    const databaseUrl = process.env.DATABASE_URL ?? "";
    if (!databaseUrl) throw new Error("DATABASE_URL is required for the concurrency test");

    const createAppName = `cron_create_auth_${crypto.randomUUID().slice(0, 8)}`;
    const createDb = connectDatabase(databaseUrlWithApplicationName(databaseUrl, createAppName));
    const blocker = postgres(databaseUrl, { max: 1, ...sslOptions(databaseUrl) });
    const observer = postgres(databaseUrl, { max: 1, ...sslOptions(databaseUrl) });
    let blockerCommitted = false;
    try {
      // Hold the agent row between the Class D guard and the insert path.
      await blocker`BEGIN`;
      await blocker`SELECT uuid FROM agents WHERE uuid = ${runtime.agent.uuid} FOR UPDATE`;

      const createPromise = createCronJob(createDb, {
        controlChatId: chatId,
        agentId: runtime.agent.uuid,
        body: {
          name: "mid-txn-reassign",
          schedule: "0 16 * * *",
          timezone: "UTC",
          prompt: "must not land under new manager",
        },
        config: {
          enabled: true,
          pollingIntervalSeconds: app.config.runtime.pollingIntervalSeconds,
        },
        callerMemberId: runtime.memberId,
        callerHumanAgentId: runtime.humanAgentUuid,
      });
      await waitForPostgresLockWait(observer, createAppName);

      // Reassign while create is blocked on the agent FOR UPDATE, then release.
      await blocker`UPDATE agents SET manager_id = ${other.memberId}, updated_at = NOW() WHERE uuid = ${runtime.agent.uuid}`;
      await blocker`COMMIT`;
      blockerCommitted = true;

      await expect(createPromise).rejects.toMatchObject({ code: "CRON_JOB_FORBIDDEN", statusCode: 403 });
      const rows = await app.db
        .select()
        .from(cronJobs)
        .where(and(eq(cronJobs.controlChatId, chatId), eq(cronJobs.name, "mid-txn-reassign")));
      expect(rows).toHaveLength(0);
    } finally {
      if (!blockerCommitted) await blocker`ROLLBACK`;
      await createDb.end();
      await blocker.end();
      await observer.end();
    }
  });

  it("emits dueToCommitMs from scheduledFor to commit, not sweep-loop duration", async () => {
    const { app, runtime, chatId } = await setupChatWithAgent();
    const createRes = await runtime.request("POST", `/api/v1/agent/chats/${chatId}/cron-jobs`, {
      name: "latency-metric",
      schedule: "0 * * * *",
      timezone: "UTC",
      prompt: "tick",
    });
    const job = createRes.json() as { id: string };
    const scheduledFor = new Date(Date.now() - 5_000);
    await app.db.update(cronJobs).set({ nextRunAt: scheduledFor }).where(eq(cronJobs.id, job.id));

    const seen: Array<{ kind: string; dueToCommitMs: number; latenessMs?: number }> = [];
    await sweepCronJobs(app.db, app.notifier, {
      staleSeconds: app.config.runtime.presenceCleanupSeconds,
      onDecisionForTest: (fields) => {
        seen.push(fields);
      },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.kind).toBe("accepted");
    expect(seen[0]?.dueToCommitMs).toBeGreaterThanOrEqual(4_500);
    expect(seen[0]?.latenessMs).toBeGreaterThanOrEqual(4_500);
    // Must track scheduledFor→commit, not a near-zero sweep-slice clock.
    expect(seen[0]?.dueToCommitMs).toBeGreaterThan(1_000);
    expect(Math.abs((seen[0]?.dueToCommitMs ?? 0) - (seen[0]?.latenessMs ?? 0))).toBeLessThan(5_000);
    expect(computeDueToCommitMs(scheduledFor, scheduledFor.getTime() + 5_012)).toBe(5_012);
  });

  it("rolls back pre-commit claim faults and delivers once after repair", async () => {
    const { app, runtime, chatId } = await setupChatWithAgent();
    const createRes = await runtime.request("POST", `/api/v1/agent/chats/${chatId}/cron-jobs`, {
      name: "precommit-fault",
      schedule: "0 * * * *",
      timezone: "UTC",
      prompt: "tick",
    });
    const job = createRes.json() as { id: string };
    const dueAt = new Date(Date.now() - 5_000);
    await app.db.update(cronJobs).set({ nextRunAt: dueAt }).where(eq(cronJobs.id, job.id));

    const staleSeconds = app.config.runtime.presenceCleanupSeconds;
    const first = await sweepCronJobs(app.db, app.notifier, {
      staleSeconds,
      afterClaimForTest: async () => {
        throw new Error("injected pre-commit fault");
      },
    });
    expect(first.processed).toBe(0);

    const [afterFault] = await app.db.select().from(cronJobs).where(eq(cronJobs.id, job.id)).limit(1);
    expect(afterFault?.nextRunAt?.getTime()).toBe(dueAt.getTime());
    expect(afterFault?.lastTriggerMessageId).toBeNull();

    await sweepCronJobs(app.db, app.notifier, { staleSeconds });
    const rows = await app.db.select().from(messages).where(eq(messages.chatId, chatId));
    const cronMessages = rows.filter((row) => {
      const meta = row.metadata as Record<string, unknown>;
      return meta?.[CRON_TRIGGER_METADATA_KEY] != null;
    });
    expect(cronMessages).toHaveLength(1);

    await sweepCronJobs(app.db, app.notifier, { staleSeconds });
    const rowsAgain = await app.db.select().from(messages).where(eq(messages.chatId, chatId));
    const cronAgain = rowsAgain.filter((row) => {
      const meta = row.metadata as Record<string, unknown>;
      return meta?.[CRON_TRIGGER_METADATA_KEY] != null;
    });
    expect(cronAgain).toHaveLength(1);
  });

  it("records post-commit notifier faults without rematerializing the occurrence", async () => {
    const { app, runtime, chatId } = await setupChatWithAgent();
    const createRes = await runtime.request("POST", `/api/v1/agent/chats/${chatId}/cron-jobs`, {
      name: "postcommit-notifier-fault",
      schedule: "0 * * * *",
      timezone: "UTC",
      prompt: "tick",
    });
    const job = createRes.json() as { id: string };
    await app.db
      .update(cronJobs)
      .set({ nextRunAt: new Date(Date.now() - 5_000) })
      .where(eq(cronJobs.id, job.id));

    const failingNotifier = {
      notify: async () => undefined,
      notifyStrict: async () => {
        throw new Error("injected inbox notify failure");
      },
      notifyChatUpdated: async () => undefined,
    };

    const staleSeconds = app.config.runtime.presenceCleanupSeconds;
    const accepted = await sweepCronJobs(app.db, failingNotifier as never, { staleSeconds });
    expect(accepted.processed).toBe(1);
    expect(accepted.postCommitFailures).toBe(1);

    const rows = await app.db.select().from(messages).where(eq(messages.chatId, chatId));
    const cronMessages = rows.filter((row) => {
      const meta = row.metadata as Record<string, unknown>;
      return meta?.[CRON_TRIGGER_METADATA_KEY] != null;
    });
    expect(cronMessages).toHaveLength(1);

    const [row] = await app.db.select().from(cronJobs).where(eq(cronJobs.id, job.id)).limit(1);
    expect(row?.lastTriggerMessageId).toBe(cronMessages[0]?.id);
    expect(row?.nextRunAt?.getTime()).toBeGreaterThan(Date.now() - 60_000);

    // Backlog repair / later sweep must not rematerialize the same occurrence.
    await sweepCronJobs(app.db, app.notifier, { staleSeconds });
    const rowsAgain = await app.db.select().from(messages).where(eq(messages.chatId, chatId));
    const cronAgain = rowsAgain.filter((row) => {
      const meta = row.metadata as Record<string, unknown>;
      return meta?.[CRON_TRIGGER_METADATA_KEY] != null;
    });
    expect(cronAgain).toHaveLength(1);
  });

  it("records production createNotifier pg_notify failures on the cron settled path", async () => {
    const { app, runtime, chatId } = await setupChatWithAgent();
    const createRes = await runtime.request("POST", `/api/v1/agent/chats/${chatId}/cron-jobs`, {
      name: "postcommit-pg-notify-fault",
      schedule: "0 * * * *",
      timezone: "UTC",
      prompt: "tick",
    });
    const job = createRes.json() as { id: string };
    await app.db
      .update(cronJobs)
      .set({ nextRunAt: new Date(Date.now() - 5_000) })
      .where(eq(cronJobs.id, job.id));

    const rejectingClient = Object.assign(
      vi.fn(async () => {
        throw new Error("pg_notify failed");
      }),
      {
        listen: vi.fn(async () => ({ unlisten: vi.fn(async () => undefined) })),
      },
    );
    const productionNotifier = createNotifier(rejectingClient as never);
    // Keep chat-updated soft so only inbox NOTIFY fails through notifyStrict.
    productionNotifier.notifyChatUpdated = async () => undefined;

    const accepted = await sweepCronJobs(app.db, productionNotifier, {
      staleSeconds: app.config.runtime.presenceCleanupSeconds,
    });
    expect(accepted.processed).toBe(1);
    expect(accepted.postCommitFailures).toBe(1);

    const cronMessages = (await app.db.select().from(messages).where(eq(messages.chatId, chatId))).filter((row) => {
      const meta = row.metadata as Record<string, unknown>;
      return meta?.[CRON_TRIGGER_METADATA_KEY] != null;
    });
    expect(cronMessages).toHaveLength(1);
  });
});
