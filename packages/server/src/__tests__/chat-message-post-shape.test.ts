import { ATTACHMENT_FILENAME_HEADER, ATTACHMENT_MIME_HEADER } from "@first-tree/shared";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { createAgent } from "../services/agent.js";
import { createMeChat } from "../services/me-chat.js";
import { sendMessage } from "../services/message.js";
import { createTestAdmin, fetchPresignedAttachment, useTestApp } from "./helpers.js";

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

  async function uploadAttachment(
    app: FastifyInstance,
    admin: Awaited<ReturnType<typeof createTestAdmin>>,
    bytes: Buffer,
    opts: { mimeType: string; filename: string },
  ): Promise<{ id: string; sizeBytes: number }> {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${encodeURIComponent(admin.organizationId)}/attachments`,
      headers: {
        authorization: `Bearer ${admin.accessToken}`,
        "content-type": "application/octet-stream",
        [ATTACHMENT_MIME_HEADER]: opts.mimeType,
        [ATTACHMENT_FILENAME_HEADER]: opts.filename,
      },
      payload: bytes,
    });
    expect(res.statusCode).toBe(201);
    return res.json<{ id: string; sizeBytes: number }>();
  }

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

  it("persists and serves document-only attachment refs on a task chat initial message", async () => {
    const app = getApp();
    const alice = await createTestAdmin(app);
    const peer = await createAgent(app.db, {
      name: `post-doc-peer-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Post Doc Peer",
      managerId: alice.memberId,
      organizationId: alice.organizationId,
    });
    const bytes = Buffer.from("quarter,amount\nQ4,1536\n");
    const uploaded = await uploadAttachment(app, alice, bytes, {
      mimeType: "text/csv",
      filename: "revenue.csv",
    });

    const create = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${encodeURIComponent(alice.organizationId)}/chats`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
      payload: {
        mode: "task",
        initialRecipientAgentIds: [peer.uuid],
        initialRecipientNames: [],
        contextParticipantAgentIds: [],
        contextParticipantNames: [],
        initialMessage: {
          format: "text",
          content: "",
          metadata: {
            attachments: [
              {
                attachmentId: uploaded.id,
                kind: "file",
                mimeType: "text/csv",
                filename: "revenue.csv",
                size: uploaded.sizeBytes,
              },
            ],
          },
        },
      },
    });
    expect(create.statusCode).toBe(201);
    const created = create.json<{ chatId: string; messageId: string }>();

    const messages = await app.inject({
      method: "GET",
      url: `/api/v1/chats/${encodeURIComponent(created.chatId)}/messages?limit=10`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(messages.statusCode).toBe(200);
    const sent = messages
      .json<{ items: Array<{ id: string; content: unknown; metadata: unknown }> }>()
      .items.find((item) => item.id === created.messageId);
    expect(sent?.content).toBe("");
    expect(sent?.metadata).toMatchObject({
      attachments: [
        {
          attachmentId: uploaded.id,
          kind: "file",
          mimeType: "text/csv",
          filename: "revenue.csv",
          size: uploaded.sizeBytes,
        },
      ],
    });

    const download = await app.inject({
      method: "GET",
      url: `/api/v1/attachments/${encodeURIComponent(uploaded.id)}`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    // S3-backed rows redirect to a presigned URL that serves the bytes.
    expect(download.statusCode).toBe(302);
    const objectRes = await fetchPresignedAttachment(download.headers.location);
    expect(objectRes.contentType).toBe("text/csv");
    expect(objectRes.body.equals(bytes)).toBe(true);
  });

  it("accepts a document-only chat message when the file ref is valid and addressed", async () => {
    const app = getApp();
    const alice = await createTestAdmin(app);
    const peer = await createAgent(app.db, {
      name: `post-doc-empty-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Post Doc Empty",
      managerId: alice.memberId,
      organizationId: alice.organizationId,
    });
    const { chatId } = await createMeChat(app.db, alice.humanAgentUuid, alice.organizationId, {
      participantIds: [peer.uuid],
    });
    const uploaded = await uploadAttachment(app, alice, Buffer.from("a,b\n1,2"), {
      mimeType: "text/csv",
      filename: "evidence.csv",
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/chats/${encodeURIComponent(chatId)}/messages`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
      payload: {
        format: "text",
        content: "",
        metadata: {
          mentions: [peer.uuid],
          attachments: [
            {
              attachmentId: uploaded.id,
              kind: "file",
              mimeType: "text/csv",
              filename: "evidence.csv",
              size: uploaded.sizeBytes,
            },
          ],
        },
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json<{ content: unknown; metadata: unknown }>()).toMatchObject({
      content: "",
      metadata: {
        mentions: [peer.uuid],
        attachments: [
          {
            attachmentId: uploaded.id,
            kind: "file",
            mimeType: "text/csv",
            filename: "evidence.csv",
            size: uploaded.sizeBytes,
          },
        ],
      },
    });
  });

  it("rejects document attachment refs whose declared metadata does not match the stored blob", async () => {
    const app = getApp();
    const alice = await createTestAdmin(app);
    const peer = await createAgent(app.db, {
      name: `post-doc-bad-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Post Doc Bad",
      managerId: alice.memberId,
      organizationId: alice.organizationId,
    });
    const { chatId } = await createMeChat(app.db, alice.humanAgentUuid, alice.organizationId, {
      participantIds: [peer.uuid],
    });
    const uploaded = await uploadAttachment(app, alice, Buffer.from("ok"), {
      mimeType: "text/plain",
      filename: "note.txt",
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/chats/${encodeURIComponent(chatId)}/messages`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
      payload: {
        format: "text",
        content: "bad ref",
        metadata: {
          mentions: [peer.uuid],
          attachments: [
            {
              attachmentId: uploaded.id,
              kind: "file",
              mimeType: "text/csv",
              filename: "note.txt",
              size: 999,
            },
          ],
        },
      },
    });
    expect(res.statusCode).toBe(400);
  });
});
