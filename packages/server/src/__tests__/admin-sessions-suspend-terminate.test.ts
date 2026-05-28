import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { agentChatSessions } from "../db/schema/agent-chat-sessions.js";
import * as activityService from "../services/activity.js";
import { createAgent } from "../services/agent.js";
import { createChat } from "../services/chat.js";
import { sendMessage } from "../services/message.js";
import * as sessionService from "../services/session.js";
import * as sessionEventService from "../services/session-event.js";
import { createAdminContext, useTestApp } from "./helpers.js";

describe("Admin sessions — Suspend / Terminate (server-authoritative)", () => {
  const getApp = useTestApp();

  async function seedSession(app: FastifyInstance, agentId: string, chatId: string, state: string) {
    await app.db
      .insert(agentChatSessions)
      .values({ agentId, chatId, state })
      .onConflictDoUpdate({
        target: [agentChatSessions.agentId, agentChatSessions.chatId],
        set: { state, updatedAt: new Date() },
      });
  }

  async function readState(app: FastifyInstance, agentId: string, chatId: string): Promise<string | null> {
    const { and, eq } = await import("drizzle-orm");
    const [row] = await app.db
      .select({ state: agentChatSessions.state })
      .from(agentChatSessions)
      .where(and(eq(agentChatSessions.agentId, agentId), eq(agentChatSessions.chatId, chatId)))
      .limit(1);
    return row?.state ?? null;
  }

  it("Suspend on an active row transitions to suspended and returns 200 { transitioned: true }", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `suspend-a-${crypto.randomUUID().slice(0, 6)}` });
    const agent = await createAgent(app.db, {
      name: `susp-agent-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Susp target",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });
    const chat = await createChat(app.db, admin.humanAgentUuid, { type: "group", participantIds: [agent.uuid] });
    await seedSession(app, agent.uuid, chat.id, "active");

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${agent.uuid}/sessions/${chat.id}/suspend`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ state: string; transitioned: boolean; agentId: string; chatId: string }>();
    expect(body).toMatchObject({ agentId: agent.uuid, chatId: chat.id, state: "suspended", transitioned: true });

    expect(await readState(app, agent.uuid, chat.id)).toBe("suspended");
  });

  it("Suspend on an already-suspended row is a no-op 200 { transitioned: false }", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `suspend-b-${crypto.randomUUID().slice(0, 6)}` });
    const agent = await createAgent(app.db, {
      name: `susp-agent-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Susp target",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });
    const chat = await createChat(app.db, admin.humanAgentUuid, { type: "group", participantIds: [agent.uuid] });
    await seedSession(app, agent.uuid, chat.id, "suspended");

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${agent.uuid}/sessions/${chat.id}/suspend`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ state: "suspended", transitioned: false });
  });

  it("Terminate on a suspended row transitions to evicted, clears events, returns 200", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `term-a-${crypto.randomUUID().slice(0, 6)}` });
    const agent = await createAgent(app.db, {
      name: `term-agent-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Term target",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });
    const chat = await createChat(app.db, admin.humanAgentUuid, { type: "group", participantIds: [agent.uuid] });
    await seedSession(app, agent.uuid, chat.id, "suspended");
    await sessionEventService.appendEvent(app.db, agent.uuid, chat.id, {
      kind: "error",
      payload: { source: "sdk", message: "pre-terminate event" },
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${agent.uuid}/sessions/${chat.id}/terminate`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ state: "evicted", transitioned: true });

    expect(await readState(app, agent.uuid, chat.id)).toBe("evicted");

    // clearEvents fires best-effort — poll briefly for eventual consistency.
    const deadline = Date.now() + 2000;
    let items: Awaited<ReturnType<typeof sessionEventService.listEvents>>["items"] = [];
    while (Date.now() < deadline) {
      items = (await sessionEventService.listEvents(app.db, agent.uuid, chat.id, { limit: 10 })).items;
      if (items.length === 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(items).toEqual([]);
  });

  it("Terminate on an active row is a no-op 200 { transitioned: false } — UI gates behind Suspend", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `term-b-${crypto.randomUUID().slice(0, 6)}` });
    const agent = await createAgent(app.db, {
      name: `term-agent-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Term target",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });
    const chat = await createChat(app.db, admin.humanAgentUuid, { type: "group", participantIds: [agent.uuid] });
    await seedSession(app, agent.uuid, chat.id, "active");

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${agent.uuid}/sessions/${chat.id}/terminate`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ state: "active", transitioned: false });
    expect(await readState(app, agent.uuid, chat.id)).toBe("active");
  });

  it("Terminate on an already-evicted row is idempotent 200 { transitioned: false }", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `term-c-${crypto.randomUUID().slice(0, 6)}` });
    const agent = await createAgent(app.db, {
      name: `term-agent-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Term target",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });
    const chat = await createChat(app.db, admin.humanAgentUuid, { type: "group", participantIds: [agent.uuid] });
    await seedSession(app, agent.uuid, chat.id, "evicted");

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${agent.uuid}/sessions/${chat.id}/terminate`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ state: "evicted", transitioned: false });
  });

  it("Suspend on a missing chat returns 404", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `term-d-${crypto.randomUUID().slice(0, 6)}` });
    const agent = await createAgent(app.db, {
      name: `term-agent-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Term target",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${agent.uuid}/sessions/chat-does-not-exist/suspend`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it("Resume route is removed — 404 on POST", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `resume-x-${crypto.randomUUID().slice(0, 6)}` });
    const agent = await createAgent(app.db, {
      name: `resume-agent-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Resume target",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });
    const chat = await createChat(app.db, admin.humanAgentUuid, { type: "group", participantIds: [agent.uuid] });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${agent.uuid}/sessions/${chat.id}/resume`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it("allows an evicted row to be overwritten when the client starts a fresh runtime session", async () => {
    // `agent_chat_sessions.(agent_id, chat_id)` is a single-row "current
    // session state" cache, NOT a session history log. After terminate the
    // chat keeps its stable chat_id; the next inbound message legitimately
    // produces a new runtime session whose
    // `active` state MUST overwrite the terminal `evicted` row, otherwise
    // the chat becomes invisible in web listings forever even though it is
    // still functional. Pinning this behaviour so the pre-refactor
    // "revival defense" does not sneak back in.
    const app = getApp();
    const admin = await createAdminContext(app, { username: `revive-${crypto.randomUUID().slice(0, 6)}` });
    const agent = await createAgent(app.db, {
      name: `revive-agent-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Revive target",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });
    const chat = await createChat(app.db, admin.humanAgentUuid, { type: "group", participantIds: [agent.uuid] });
    await seedSession(app, agent.uuid, chat.id, "evicted");

    // Client reports `active` because a new runtime session just started.
    await activityService.upsertSessionState(app.db, agent.uuid, chat.id, "active", "org-test");

    expect(await readState(app, agent.uuid, chat.id)).toBe("active");
  });

  it("suspended → active upsert still works (non-terminal transitions are unaffected)", async () => {
    // Guards against over-correction: removing the revival defense must not
    // accidentally block legit suspend→active transitions that were already
    // supported.
    const app = getApp();
    const admin = await createAdminContext(app, { username: `susp-${crypto.randomUUID().slice(0, 6)}` });
    const agent = await createAgent(app.db, {
      name: `susp-agent-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Suspend target",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });
    const chat = await createChat(app.db, admin.humanAgentUuid, { type: "group", participantIds: [agent.uuid] });
    await seedSession(app, agent.uuid, chat.id, "suspended");

    await activityService.upsertSessionState(app.db, agent.uuid, chat.id, "active", "org-test");

    expect(await readState(app, agent.uuid, chat.id)).toBe("active");
  });

  it("default listing hides evicted rows; explicit ?state=evicted still returns them", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `list-${crypto.randomUUID().slice(0, 6)}` });
    const agent = await createAgent(app.db, {
      name: `list-agent-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "List target",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });
    const chatActive = await createChat(app.db, admin.humanAgentUuid, { type: "group", participantIds: [agent.uuid] });
    const chatEvicted = await createChat(app.db, admin.humanAgentUuid, {
      type: "group",
      participantIds: [agent.uuid],
    });
    await seedSession(app, agent.uuid, chatActive.id, "active");
    await seedSession(app, agent.uuid, chatEvicted.id, "evicted");

    const defaultRes = await app.inject({
      method: "GET",
      url: `/api/v1/agents/${agent.uuid}/sessions`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(defaultRes.statusCode).toBe(200);
    const defaultChats = defaultRes.json<Array<{ chatId: string; state: string }>>().map((r) => r.chatId);
    expect(defaultChats).toContain(chatActive.id);
    expect(defaultChats).not.toContain(chatEvicted.id);

    const filteredRes = await app.inject({
      method: "GET",
      url: `/api/v1/agents/${agent.uuid}/sessions?state=evicted`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(filteredRes.statusCode).toBe(200);
    const filteredChats = filteredRes.json<Array<{ chatId: string; state: string }>>().map((r) => r.chatId);
    expect(filteredChats).toContain(chatEvicted.id);
  });

  it("archive vs sendMessage race always resolves to active (sendMessage wins via archive's conservative gate, R3)", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `race-${crypto.randomUUID().slice(0, 6)}` });
    const sender = await createAgent(app.db, {
      name: `race-snd-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Race sender",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });
    const targetName = `race-tgt-${crypto.randomUUID().slice(0, 6)}`;
    const target = await createAgent(app.db, {
      name: targetName,
      type: "agent",
      displayName: "Race target",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });
    const chat = await createChat(app.db, admin.humanAgentUuid, {
      type: "group",
      participantIds: [sender.uuid, target.uuid],
    });
    await seedSession(app, target.uuid, chat.id, "suspended");

    // Concurrently fire archive (suspended → evicted, gated by from=['suspended'])
    // and sendMessage (any → active via upsertSessionState, unconditional).
    // Both touch the same agent_chat_sessions row, so PG row-level locks
    // serialize them. Either commit order resolves to active:
    //
    // - archive first → state becomes 'evicted'; the upsert then unconditionally
    //   overrides → 'active'.
    // - upsert first → state becomes 'active'; archive then sees 'active' which
    //   is NOT in its `from=['suspended']` gate, so it becomes a no-op
    //   (transitioned=false).
    //
    // sendMessage always wins, due to archive's conservative gate.
    //
    // The predictive session-activation path fires only for notify=true
    // recipients (`metadata.mentions` or `addressedToAgentIds`); declare
    // the target explicitly so the race semantics are exercised.
    await Promise.all([
      sessionService.archiveSession(app.db, target.uuid, chat.id, admin.organizationId, app.notifier),
      sendMessage(app.db, chat.id, sender.uuid, {
        source: "api",
        format: "text",
        content: `race @${targetName}`,
        metadata: { mentions: [target.uuid] },
      }),
    ]);

    expect(await readState(app, target.uuid, chat.id)).toBe("active");
  });
});
