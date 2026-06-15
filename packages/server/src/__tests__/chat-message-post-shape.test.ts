import { describe, expect, it } from "vitest";
import { createAgent } from "../services/agent.js";
import { createMeChat } from "../services/me-chat.js";
import { sendMessage } from "../services/message.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

/**
 * Wire-level shape of `POST /api/v1/chats/:chatId/messages` (the web
 * composer's send route).
 *
 * The 201 body must carry the STORED row's `metadata` and `inReplyTo`,
 * mirroring the GET list shape: the web composer swaps its optimistic cache
 * row for this response (`replaceOptimisticMessage`), so a body that omits
 * them strips `metadata.resolves` / `metadata.mentions` / threading from the
 * cache during the POST-success → refetch window — a just-answered docked
 * request flips back to open and a threaded reply unthreads (PR 981 review).
 */
describe("POST /chats/:chatId/messages — response carries metadata + inReplyTo", () => {
  const getApp = useTestApp();

  it("echoes resolves metadata, mentions, and inReplyTo on a clean dock answer", async () => {
    const app = getApp();
    const alice = await createTestAdmin(app);
    const peer = await createAgent(app.db, {
      name: `post-shape-peer-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Post Shape Peer",
      managerId: alice.memberId,
      organizationId: alice.organizationId,
    });
    const { chatId } = await createMeChat(app.db, alice.humanAgentUuid, alice.organizationId, {
      participantIds: [peer.uuid],
    });

    // The agent raises an open question at the human (service layer — the
    // HTTP surface under test is the human's answer below).
    const ask = await sendMessage(app.db, chatId, peer.uuid, {
      format: "request",
      content: "Ship it?",
      metadata: {
        mentions: [alice.humanAgentUuid],
        request: { questions: [{ id: "q1", prompt: "Ship it?", kind: "single", options: ["yes", "no"] }] },
      },
      source: "api",
    });

    // The human's clean dock answer: threads under the request and carries
    // the explicit resolution signal.
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/chats/${encodeURIComponent(chatId)}/messages`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
      payload: {
        format: "text",
        content: "yes",
        metadata: {
          mentions: [peer.uuid],
          resolves: { request: ask.message.id, kind: "answered" },
        },
        inReplyTo: ask.message.id,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<Record<string, unknown>>();

    // The fields the web cache swap depends on — must mirror the stored row.
    expect(body.inReplyTo).toBe(ask.message.id);
    expect(body.metadata).toMatchObject({
      mentions: [peer.uuid],
      resolves: { request: ask.message.id, kind: "answered" },
    });
  });
});
