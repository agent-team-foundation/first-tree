import { describe, expect, it } from "vitest";
import { createAgent } from "../services/agent.js";
import { createMeChat } from "../services/me-chat.js";
import { sendMessage } from "../services/message.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

/**
 * `GET /api/v1/chats/:chatId/open-requests` must be served on the USER-scope
 * chat router — the route the web actually calls (the same scope as
 * `/chats/:chatId/messages`).
 *
 * Regression guard: the window-independent open-requests source was first
 * wired only onto the agent-scope router, so the web's member-JWT call 404'd
 * and an open ask that had scrolled past the latest message page never
 * surfaced in the blocking takeover. This pins the route to the web scope and
 * the open/resolved semantics it returns.
 */
describe("GET /chats/:chatId/open-requests — user-scope route", () => {
  const getApp = useTestApp();

  it("returns the viewer's open asks and drops them once resolved", async () => {
    const app = getApp();
    const alice = await createTestAdmin(app);
    const peer = await createAgent(app.db, {
      name: `open-req-peer-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Open Req Peer",
      managerId: alice.memberId,
      organizationId: alice.organizationId,
    });
    const { chatId } = await createMeChat(app.db, alice.humanAgentUuid, alice.organizationId, {
      participantIds: [peer.uuid],
    });

    // The agent raises an open question directed at the human.
    const ask = await sendMessage(app.db, chatId, peer.uuid, {
      format: "request",
      content: "Approve the migration?",
      metadata: {
        mentions: [alice.humanAgentUuid],
        request: {
          options: [
            { label: "Approve", description: "go" },
            { label: "Hold", description: "wait" },
          ],
        },
      },
      source: "api",
    });

    // The web (member JWT) reads the open-requests source on the user scope.
    const open = await app.inject({
      method: "GET",
      url: `/api/v1/chats/${encodeURIComponent(chatId)}/open-requests`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(open.statusCode).toBe(200);
    const body = open.json<{ items: { id: string; content: string }[] }>();
    expect(body.items.map((m) => m.id)).toEqual([ask.message.id]);
    expect(body.items[0]?.content).toBe("Approve the migration?");

    // The target human answers → the ask is no longer open.
    await sendMessage(app.db, chatId, alice.humanAgentUuid, {
      format: "text",
      content: "Approve",
      metadata: { mentions: [peer.uuid], resolves: { request: ask.message.id, kind: "answered" } },
      inReplyTo: ask.message.id,
      source: "api",
    });

    const after = await app.inject({
      method: "GET",
      url: `/api/v1/chats/${encodeURIComponent(chatId)}/open-requests`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(after.statusCode).toBe(200);
    expect(after.json<{ items: unknown[] }>().items).toEqual([]);
  });
});
