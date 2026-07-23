import { CRON_TRIGGER_METADATA_KEY } from "@first-tree/shared";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agentPresence } from "../db/schema/agent-presence.js";
import { chatUserState } from "../db/schema/chat-user-state.js";
import { clients } from "../db/schema/clients.js";
import { cronJobs } from "../db/schema/cron-jobs.js";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { messages } from "../db/schema/messages.js";
import { serverInstances } from "../db/schema/server-instances.js";
import { createChat } from "../services/chat.js";
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

    const scheduler = createCronScheduler(app);
    await Promise.all([scheduler.sweepOnce(), scheduler.sweepOnce()]);

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
});
