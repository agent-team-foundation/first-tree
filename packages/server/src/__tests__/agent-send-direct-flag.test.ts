import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { chatMembership } from "../db/schema/chat-membership.js";
import { messages } from "../db/schema/messages.js";
import { createChat, findOrCreateDirectChat, isParticipant } from "../services/chat.js";
import { sendToAgent } from "../services/message.js";
import { createTestAgent, useTestApp } from "./helpers.js";

/**
 * v1 §四 改造 1 — `chat send <name>` defaults to "members of the current
 * chat only". The legacy implicit fallback into a direct chat now requires
 * `direct: true`; otherwise the call errors loudly with
 * `AGENT_SEND_NON_MEMBER` so #311-style silent side-channels stop.
 *
 * Pins:
 *   1. member + member of replyToChat → message lands in that chat.
 *   2. non-member + no `direct` → throws AGENT_SEND_NON_MEMBER and does
 *      NOT call findOrCreateDirectChat.
 *   3. non-member + `direct: true` → opens / reuses the direct chat
 *      (legacy behaviour preserved as opt-in escape hatch).
 *   4. Error message includes the v1 hint: `--direct` example + "ask a
 *      human" workflow; it does NOT recommend `add-participant` (v1 has
 *      no agent-callable add-participant CLI).
 */

describe("sendToAgent — v1 §四 改造 1: member-default routing + --direct flag", () => {
  const getApp = useTestApp();

  it("member-of-current-chat: message lands in replyToChat (regression — behaviour preserved)", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const sender = await createTestAgent(app, { name: `mem-s-${uid}` });
    const target = await createTestAgent(app, { name: `mem-t-${uid}` });
    if (!target.agent.name) throw new Error("target name missing");

    const group = await createChat(app.db, sender.agent.uuid, {
      type: "group",
      participantIds: [target.agent.uuid],
    });

    const result = await sendToAgent(app.db, sender.agent.uuid, target.agent.name, {
      format: "text",
      content: "status?",
      replyToChat: group.id,
    });

    expect(result.message.chatId).toBe(group.id);
  });

  it("non-member without --direct: throws AGENT_SEND_NON_MEMBER and no direct chat / message is created", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const sender = await createTestAgent(app, { name: `nm-s-${uid}` });
    const inGroupPeer = await createTestAgent(app, { name: `nm-peer-${uid}` });
    const outsider = await createTestAgent(app, { name: `nm-out-${uid}` });
    if (!outsider.agent.name) throw new Error("outsider name missing");

    const group = await createChat(app.db, sender.agent.uuid, {
      type: "group",
      participantIds: [inGroupPeer.agent.uuid],
    });

    const beforeMembership = await app.db
      .select({ chatId: chatMembership.chatId })
      .from(chatMembership)
      .where(eq(chatMembership.agentId, outsider.agent.uuid));
    const beforeMessages = await app.db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.senderId, sender.agent.uuid));

    await expect(
      sendToAgent(app.db, sender.agent.uuid, outsider.agent.name, {
        format: "text",
        content: "ping",
        replyToChat: group.id,
      }),
    ).rejects.toMatchObject({ code: "AGENT_SEND_NON_MEMBER" });

    // No new chat-membership row for outsider (findOrCreateDirectChat was
    // not called) and no message persisted.
    const afterMembership = await app.db
      .select({ chatId: chatMembership.chatId })
      .from(chatMembership)
      .where(eq(chatMembership.agentId, outsider.agent.uuid));
    expect(afterMembership.length).toBe(beforeMembership.length);
    const afterMessages = await app.db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.senderId, sender.agent.uuid));
    expect(afterMessages.length).toBe(beforeMessages.length);
  });

  it("non-member with --direct: opens or reuses the direct chat (legacy escape hatch)", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const sender = await createTestAgent(app, { name: `dir-s-${uid}` });
    const inGroupPeer = await createTestAgent(app, { name: `dir-peer-${uid}` });
    const outsider = await createTestAgent(app, { name: `dir-out-${uid}` });
    if (!outsider.agent.name) throw new Error("outsider name missing");

    const group = await createChat(app.db, sender.agent.uuid, {
      type: "group",
      participantIds: [inGroupPeer.agent.uuid],
    });

    const result = await sendToAgent(app.db, sender.agent.uuid, outsider.agent.name, {
      format: "text",
      content: "private ping",
      replyToChat: group.id,
      direct: true,
    });

    // Message landed in a NEW chat (not the group) — the find-or-create
    // direct chat between sender and outsider.
    expect(result.message.chatId).not.toBe(group.id);
    // Both ends are members of the resulting chat.
    expect(await isParticipant(app.db, result.message.chatId, sender.agent.uuid)).toBe(true);
    expect(await isParticipant(app.db, result.message.chatId, outsider.agent.uuid)).toBe(true);

    // Calling again finds (does not duplicate) the same direct chat.
    const direct = await findOrCreateDirectChat(app.db, sender.agent.uuid, outsider.agent.uuid);
    expect(direct.id).toBe(result.message.chatId);
  });

  it("error message recommends --direct and 'ask a human to add them', NOT add-participant CLI", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const sender = await createTestAgent(app, { name: `er-s-${uid}` });
    const outsider = await createTestAgent(app, { name: `er-out-${uid}` });
    if (!outsider.agent.name) throw new Error("outsider name missing");

    try {
      await sendToAgent(app.db, sender.agent.uuid, outsider.agent.name, {
        format: "text",
        content: "ping",
      });
      throw new Error("Expected sendToAgent to reject");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain("--direct");
      expect(message).toContain(outsider.agent.name);
      // v1 has no agent-callable add-participant CLI, so the hint must not
      // recommend that command — it should point at "ask a human in this
      // chat to add ...".
      expect(message).not.toMatch(/add-participant/i);
      expect(message).toMatch(/human|add /i);
    }
  });

  it("no replyToChat + no --direct: still errors (no implicit DM creation)", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const sender = await createTestAgent(app, { name: `nor-s-${uid}` });
    const outsider = await createTestAgent(app, { name: `nor-t-${uid}` });
    if (!outsider.agent.name) throw new Error("outsider name missing");

    await expect(
      sendToAgent(app.db, sender.agent.uuid, outsider.agent.name, {
        format: "text",
        content: "hi",
      }),
    ).rejects.toMatchObject({ code: "AGENT_SEND_NON_MEMBER" });

    // No message or chatMembership row created as a side effect.
    const msgRows = await app.db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.senderId, sender.agent.uuid));
    expect(msgRows.length).toBe(0);
    const memberRows = await app.db
      .select({ chatId: chatMembership.chatId })
      .from(chatMembership)
      .where(and(eq(chatMembership.agentId, outsider.agent.uuid), eq(chatMembership.accessMode, "speaker")));
    expect(memberRows.length).toBe(0);
  });

  it("API integration: POST /agent/agents/:name/messages accepts `direct: true` and returns 201", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const sender = await createTestAgent(app, { name: `api-s-${uid}` });
    const outsider = await createTestAgent(app, { name: `api-t-${uid}` });
    if (!outsider.agent.name) throw new Error("outsider name missing");

    const res = await sender.request("POST", `/api/v1/agent/agents/${outsider.agent.name}/messages`, {
      format: "text",
      content: "ping",
      direct: true,
    });
    expect(res.statusCode).toBe(201);
  });

  it("API integration: POST /agent/agents/:name/messages without `direct` returns 400 AGENT_SEND_NON_MEMBER", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const sender = await createTestAgent(app, { name: `api-nd-s-${uid}` });
    const outsider = await createTestAgent(app, { name: `api-nd-t-${uid}` });
    if (!outsider.agent.name) throw new Error("outsider name missing");

    const res = await sender.request("POST", `/api/v1/agent/agents/${outsider.agent.name}/messages`, {
      format: "text",
      content: "ping",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/--direct/);
  });
});
