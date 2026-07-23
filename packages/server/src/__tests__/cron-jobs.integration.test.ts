import { CRON_TRIGGER_METADATA_KEY } from "@first-tree/shared";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agentPresence } from "../db/schema/agent-presence.js";
import { agents } from "../db/schema/agents.js";
import { chatUserState } from "../db/schema/chat-user-state.js";
import { clients } from "../db/schema/clients.js";
import { cronJobs } from "../db/schema/cron-jobs.js";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { messages } from "../db/schema/messages.js";
import { serverInstances } from "../db/schema/server-instances.js";
import { createChat } from "../services/chat.js";
import { createCronJob, deleteCronJob, updateCronJob } from "../services/cron-job.js";
import { createCronScheduler } from "../services/cron-scheduler.js";
import { setChatEngagement } from "../services/me-chat.js";
import { sendMessage } from "../services/message.js";
import { createTestAgent, useTestApp } from "./helpers.js";

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

  it("serializes concurrent resume against owner chat deletion without deadlock", async () => {
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

    // Active job + concurrent activate (advisory+row) vs owner delete (advisory+row).
    const raced = Promise.allSettled([
      updateCronJob(app.db, {
        jobId: job.id,
        expectedRevision: job.revision,
        body: { state: "active" },
        config,
        agentScope: { agentId: runtime.agent.uuid, controlChatId: chatId },
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

    const [row] = await app.db.select().from(cronJobs).where(eq(cronJobs.id, job.id)).limit(1);
    expect(row?.state).toBe("paused");
    expect(row?.stateReason).toBe("owner_chat_deleted");
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
});
