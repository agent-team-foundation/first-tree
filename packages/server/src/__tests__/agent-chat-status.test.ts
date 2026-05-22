import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { pendingQuestions } from "../db/schema/pending-questions.js";
import { getChatAgentStatuses } from "../services/agent-chat-status.js";
import { createMeChat, deriveFailedAgents } from "../services/me-chat.js";
import { createTestAdmin, createTestAgent, useTestApp } from "./helpers.js";

describe("getChatAgentStatuses", () => {
  const getApp = useTestApp();

  async function newChatWithAgent() {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: `acs-${randomUUID().slice(0, 6)}` });
    const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });
    return { app, admin, peer, chatId };
  }

  async function bindPresence(agentId: string, clientId: string, runtimeState = "idle"): Promise<void> {
    await getApp().db.execute(sql`
      INSERT INTO agent_presence (agent_id, status, client_id, runtime_state, last_seen_at)
      VALUES (${agentId}, 'online', ${clientId}, ${runtimeState}, NOW())
      ON CONFLICT (agent_id) DO UPDATE
        SET status = 'online', client_id = EXCLUDED.client_id, runtime_state = EXCLUDED.runtime_state
    `);
  }

  async function setSession(agentId: string, chatId: string, state: string): Promise<void> {
    await getApp().db.execute(sql`
      INSERT INTO agent_chat_sessions (agent_id, chat_id, state, updated_at)
      VALUES (${agentId}, ${chatId}, ${state}, NOW())
      ON CONFLICT (agent_id, chat_id) DO UPDATE SET state = EXCLUDED.state
    `);
  }

  it("folds reachability + active session + pending question into needs_you, and excludes humans", async () => {
    const { app, admin, peer, chatId } = await newChatWithAgent();
    await bindPresence(peer.agent.uuid, peer.clientId);
    await setSession(peer.agent.uuid, chatId, "active");
    await app.db.insert(pendingQuestions).values({
      id: randomUUID(),
      agentId: peer.agent.uuid,
      chatId,
      messageId: randomUUID(),
      status: "pending",
    });

    const statuses = await getChatAgentStatuses(app.db, chatId);

    const s = statuses.find((x) => x.agentId === peer.agent.uuid);
    expect(s).toBeDefined();
    expect(s?.reachable).toBe(true);
    expect(s?.engagement).toBe("active");
    expect(s?.needsYou).toBe(true);
    expect(s?.main).toBe("needs_you"); // outranks working / ready

    // The human speaker is not a runtime agent — excluded from the status set.
    expect(statuses.some((x) => x.agentId === admin.humanAgentUuid)).toBe(false);
  });

  it("a reachable agent with no session reads as ready (not offline)", async () => {
    const { app, peer, chatId } = await newChatWithAgent();
    await bindPresence(peer.agent.uuid, peer.clientId);
    // no agent_chat_sessions row, no pending question, no events

    const s = (await getChatAgentStatuses(app.db, chatId)).find((x) => x.agentId === peer.agent.uuid);
    expect(s?.reachable).toBe(true);
    expect(s?.engagement).toBe("none");
    expect(s?.main).toBe("ready");
  });

  it("an unbound agent (no presence row) is offline even with an active session", async () => {
    const { app, peer, chatId } = await newChatWithAgent();
    // no presence row → unreachable
    await setSession(peer.agent.uuid, chatId, "active");

    const s = (await getChatAgentStatuses(app.db, chatId)).find((x) => x.agentId === peer.agent.uuid);
    expect(s?.reachable).toBe(false);
    expect(s?.main).toBe("offline"); // reachability gates everything
  });

  it("a reachable agent in global runtime error reads as failed (no session error needed)", async () => {
    const { app, peer, chatId } = await newChatWithAgent();
    // Reachable, runtime_state='error', and NO agent_chat_sessions row (so the
    // session axis is not 'errored'): failed must still come from runtime error
    // (§1.2: failed = session errored OR runtime error).
    await bindPresence(peer.agent.uuid, peer.clientId, "error");

    const s = (await getChatAgentStatuses(app.db, chatId)).find((x) => x.agentId === peer.agent.uuid);
    expect(s?.reachable).toBe(true);
    expect(s?.errored).toBe(true);
    expect(s?.main).toBe("failed");
  });

  it("a recent tool_call surfaces as working with the live activity label", async () => {
    const { app, peer, chatId } = await newChatWithAgent();
    await bindPresence(peer.agent.uuid, peer.clientId);
    await setSession(peer.agent.uuid, chatId, "active");
    await app.db.execute(sql`
      INSERT INTO session_events (id, agent_id, chat_id, seq, kind, payload, created_at)
      VALUES (${randomUUID()}, ${peer.agent.uuid}, ${chatId}, 1, 'tool_call',
              ${JSON.stringify({ toolUseId: "t1", name: "Bash", args: null, status: "pending" })}::jsonb, NOW())
    `);

    const s = (await getChatAgentStatuses(app.db, chatId)).find((x) => x.agentId === peer.agent.uuid);
    expect(s?.working).toBe(true);
    expect(s?.main).toBe("working");
    expect(s?.activity?.label).toBe("Bash");
  });
});

describe("deriveFailedAgents — chat-list failed signal", () => {
  const getApp = useTestApp();

  async function bindPresence(agentId: string, clientId: string, runtimeState = "idle"): Promise<void> {
    await getApp().db.execute(sql`
      INSERT INTO agent_presence (agent_id, status, client_id, runtime_state, last_seen_at)
      VALUES (${agentId}, 'online', ${clientId}, ${runtimeState}, NOW())
      ON CONFLICT (agent_id) DO UPDATE
        SET status = 'online', client_id = EXCLUDED.client_id, runtime_state = EXCLUDED.runtime_state
    `);
  }

  async function setSession(agentId: string, chatId: string, state: string): Promise<void> {
    await getApp().db.execute(sql`
      INSERT INTO agent_chat_sessions (agent_id, chat_id, state, updated_at)
      VALUES (${agentId}, ${chatId}, ${state}, NOW())
      ON CONFLICT (agent_id, chat_id) DO UPDATE SET state = EXCLUDED.state
    `);
  }

  async function newChatWithAgent() {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: `df-${randomUUID().slice(0, 6)}` });
    const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });
    return { app, peer, chatId };
  }

  it("returns an empty map for no chatIds", async () => {
    expect((await deriveFailedAgents(getApp().db, [])).size).toBe(0);
  });

  it("includes a reachable agent whose per-chat session is errored", async () => {
    const { app, peer, chatId } = await newChatWithAgent();
    await bindPresence(peer.agent.uuid, peer.clientId);
    await setSession(peer.agent.uuid, chatId, "errored");

    expect((await deriveFailedAgents(app.db, [chatId])).get(chatId)).toEqual([peer.agent.uuid]);
  });

  it("includes a reachable agent in global runtime error (no session row needed)", async () => {
    const { app, peer, chatId } = await newChatWithAgent();
    await bindPresence(peer.agent.uuid, peer.clientId, "error");

    expect((await deriveFailedAgents(app.db, [chatId])).get(chatId)).toEqual([peer.agent.uuid]);
  });

  it("EXCLUDES an unreachable errored agent — it is offline, not failed", async () => {
    const { app, peer, chatId } = await newChatWithAgent();
    // No presence row → unreachable; session errored. offline outranks failed,
    // so it must NOT appear in the chat-list failed set (stays consistent with
    // the right sidebar).
    await setSession(peer.agent.uuid, chatId, "errored");

    expect((await deriveFailedAgents(app.db, [chatId])).has(chatId)).toBe(false);
  });

  it("does not flag a reachable agent with a healthy active session", async () => {
    const { app, peer, chatId } = await newChatWithAgent();
    await bindPresence(peer.agent.uuid, peer.clientId);
    await setSession(peer.agent.uuid, chatId, "active");

    expect((await deriveFailedAgents(app.db, [chatId])).has(chatId)).toBe(false);
  });
});

describe("GET /chats/:chatId/agent-status — route auth + shape", () => {
  const getApp = useTestApp();

  it("a chat participant gets 200 and an AgentChatStatus[] of non-human speakers", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: `acs-http-${randomUUID().slice(0, 6)}` });
    const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/chats/${chatId}/agent-status`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ agentId: string; main: string }>;
    expect(Array.isArray(body)).toBe(true);
    const entry = body.find((x) => x.agentId === peer.agent.uuid);
    expect(entry).toBeDefined();
    expect(typeof entry?.main).toBe("string");
    // The human creator is a speaker but not a runtime agent — excluded.
    expect(body.some((x) => x.agentId === admin.humanAgentUuid)).toBe(false);
  });

  it("a non-member (different org) gets 404, not the status set", async () => {
    const app = getApp();
    const owner = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: `acs-http2-${randomUUID().slice(0, 6)}` });
    const { chatId } = await createMeChat(app.db, owner.humanAgentUuid, owner.organizationId, {
      participantIds: [peer.agent.uuid],
    });
    const outsider = await createTestAdmin(app); // own org, not a member of this chat's org

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/chats/${chatId}/agent-status`,
      headers: { authorization: `Bearer ${outsider.accessToken}` },
    });

    expect(res.statusCode).toBe(404);
  });
});
