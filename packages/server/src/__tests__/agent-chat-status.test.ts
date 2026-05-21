import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { pendingQuestions } from "../db/schema/pending-questions.js";
import { getChatAgentStatuses } from "../services/agent-chat-status.js";
import { createMeChat } from "../services/me-chat.js";
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

  async function bindPresence(agentId: string, clientId: string): Promise<void> {
    await getApp().db.execute(sql`
      INSERT INTO agent_presence (agent_id, status, client_id, runtime_state, last_seen_at)
      VALUES (${agentId}, 'online', ${clientId}, 'idle', NOW())
      ON CONFLICT (agent_id) DO UPDATE SET status = 'online', client_id = EXCLUDED.client_id
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
});
