import { eq, inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { messageAttachments } from "../db/schema/message-attachments.js";
import {
  createAttachment,
  gcOrphanedAttachments,
  getAttachmentForDownload,
  prepareAttachmentsForSend,
} from "../services/attachment.js";
import { createChat } from "../services/chat.js";
import { sendMessage } from "../services/message.js";
import { createTestAgent, useTestApp } from "./helpers.js";

/** Helper: upload one attachment as `uploaderId` into `chatId`. */
async function upload(
  app: ReturnType<ReturnType<typeof useTestApp>>,
  chatId: string,
  uploaderId: string,
  name = "notes.md",
) {
  return createAttachment(app.db, {
    chatId,
    uploaderId,
    filename: name,
    declaredMime: "text/markdown",
    bytes: Buffer.from("# hello\nbody\n"),
  });
}

describe("attachment binding (C3 + send)", () => {
  const getApp = useTestApp();

  it("rejects attaching another agent's upload, accepts the uploader's own", async () => {
    const app = getApp();
    const { agent: a1 } = await createTestAgent(app, { name: `att-a1-${crypto.randomUUID().slice(0, 6)}` });
    const { agent: a2 } = await createTestAgent(app, { name: `att-a2-${crypto.randomUUID().slice(0, 6)}` });
    const chat = await createChat(app.db, a1.uuid, { type: "group", participantIds: [a2.uuid] });

    const ref = await upload(app, chat.id, a1.uuid);

    // C3: a2 cannot reference a1's pending upload.
    await expect(
      prepareAttachmentsForSend(app.db, { chatId: chat.id, senderId: a2.uuid, attachmentIds: [ref.attachmentId] }),
    ).rejects.toThrow(/uploaded by someone else/i);

    // The uploader can, and gets authoritative refs back.
    const refs = await prepareAttachmentsForSend(app.db, {
      chatId: chat.id,
      senderId: a1.uuid,
      attachmentIds: [ref.attachmentId],
    });
    expect(refs).toHaveLength(1);
    expect(refs[0]?.attachmentId).toBe(ref.attachmentId);
    expect(refs[0]?.mimeType).toBe("text/markdown");
    expect(refs[0]?.kind).toBe("file");
  });

  it("binds attachments into metadata.attachments on send and rejects re-binding", async () => {
    const app = getApp();
    const { agent: a1 } = await createTestAgent(app, { name: `att-b1-${crypto.randomUUID().slice(0, 6)}` });
    const { agent: a2 } = await createTestAgent(app, { name: `att-b2-${crypto.randomUUID().slice(0, 6)}` });
    const chat = await createChat(app.db, a1.uuid, { type: "group", participantIds: [a2.uuid] });

    const ref = await upload(app, chat.id, a1.uuid);

    const result = await sendMessage(
      app.db,
      chat.id,
      a1.uuid,
      { source: "web", format: "text", content: "see attached", metadata: { mentions: [a2.uuid] } },
      { attachmentIds: [ref.attachmentId] },
    );

    // A′: the message stays plain text; the attachment rides metadata.attachments.
    expect(result.message.format).toBe("text");
    const meta = result.message.metadata as { attachments?: Array<{ attachmentId: string }> };
    expect(meta.attachments).toHaveLength(1);
    expect(meta.attachments?.[0]?.attachmentId).toBe(ref.attachmentId);

    // Already bound → a second send referencing it is rejected.
    await expect(
      sendMessage(
        app.db,
        chat.id,
        a1.uuid,
        { source: "web", format: "text", content: "again", metadata: { mentions: [a2.uuid] } },
        { attachmentIds: [ref.attachmentId] },
      ),
    ).rejects.toThrow(/already attached/i);
  });
});

describe("attachment security hardening (codex blockers)", () => {
  const getApp = useTestApp();

  // Blocker 1: a caller can omit attachmentIds and forge metadata.attachments;
  // the server must strip the client-supplied key so only server-generated refs
  // (from prepareAttachmentsForSend) survive.
  it("strips client-forged metadata.attachments when no attachmentIds are given", async () => {
    const app = getApp();
    const { agent: a1 } = await createTestAgent(app, { name: `att-c1-${crypto.randomUUID().slice(0, 6)}` });
    const { agent: a2 } = await createTestAgent(app, { name: `att-c2-${crypto.randomUUID().slice(0, 6)}` });
    const chat = await createChat(app.db, a1.uuid, { type: "group", participantIds: [a2.uuid] });
    const ref = await upload(app, chat.id, a1.uuid);

    const result = await sendMessage(app.db, chat.id, a1.uuid, {
      source: "web",
      format: "text",
      content: "sneaky",
      // Forged: references a real upload but bypasses attachmentIds validation.
      metadata: {
        attachments: [
          { attachmentId: ref.attachmentId, mimeType: "text/markdown", filename: "x.md", size: 5, kind: "file" },
        ],
      },
    });

    const meta = result.message.metadata as { attachments?: unknown };
    expect(meta.attachments).toBeUndefined();
    // The referenced upload stays unbound (the forge didn't bind it).
    const [row] = await app.db
      .select({ messageId: messageAttachments.messageId })
      .from(messageAttachments)
      .where(eq(messageAttachments.id, ref.attachmentId));
    expect(row?.messageId).toBeNull();
  });

  // Blocker 2: a given upload must bind to at most one message under concurrency.
  it("binds an upload to at most one message under concurrent sends", async () => {
    const app = getApp();
    const { agent: a1 } = await createTestAgent(app, { name: `att-r1-${crypto.randomUUID().slice(0, 6)}` });
    const { agent: a2 } = await createTestAgent(app, { name: `att-r2-${crypto.randomUUID().slice(0, 6)}` });
    const chat = await createChat(app.db, a1.uuid, { type: "group", participantIds: [a2.uuid] });
    const ref = await upload(app, chat.id, a1.uuid);

    const send = () =>
      sendMessage(
        app.db,
        chat.id,
        a1.uuid,
        { source: "web", format: "text", content: "x", metadata: { mentions: [a2.uuid] } },
        { attachmentIds: [ref.attachmentId] },
      );
    const results = await Promise.allSettled([send(), send()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });

  // Blocker 3: orphan GC removes aged unbound uploads, keeps bound + recent.
  it("gcOrphanedAttachments deletes aged unbound uploads but keeps bound + recent", async () => {
    const app = getApp();
    const { agent: a1 } = await createTestAgent(app, { name: `att-g1-${crypto.randomUUID().slice(0, 6)}` });
    const { agent: a2 } = await createTestAgent(app, { name: `att-g2-${crypto.randomUUID().slice(0, 6)}` });
    const chat = await createChat(app.db, a1.uuid, { type: "group", participantIds: [a2.uuid] });

    const orphan = await upload(app, chat.id, a1.uuid, "orphan.md");
    const recent = await upload(app, chat.id, a1.uuid, "recent.md");
    const boundRef = await upload(app, chat.id, a1.uuid, "bound.md");
    await sendMessage(
      app.db,
      chat.id,
      a1.uuid,
      { source: "web", format: "text", content: "x", metadata: { mentions: [a2.uuid] } },
      { attachmentIds: [boundRef.attachmentId] },
    );

    // Age the orphan past the 24h TTL.
    await app.db
      .update(messageAttachments)
      .set({ createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })
      .where(eq(messageAttachments.id, orphan.attachmentId));

    const deleted = await gcOrphanedAttachments(app.db);
    expect(deleted).toBeGreaterThanOrEqual(1);

    const remaining = await app.db
      .select({ id: messageAttachments.id })
      .from(messageAttachments)
      .where(inArray(messageAttachments.id, [orphan.attachmentId, recent.attachmentId, boundRef.attachmentId]));
    const ids = new Set(remaining.map((r) => r.id));
    expect(ids.has(orphan.attachmentId)).toBe(false);
    expect(ids.has(recent.attachmentId)).toBe(true);
    expect(ids.has(boundRef.attachmentId)).toBe(true);
  });

  // Non-blocking hardening: an unbound upload is downloadable only by uploader.
  it("gates unbound-attachment download to the uploader, opens up once bound", async () => {
    const app = getApp();
    const { agent: a1 } = await createTestAgent(app, { name: `att-d1-${crypto.randomUUID().slice(0, 6)}` });
    const { agent: a2 } = await createTestAgent(app, { name: `att-d2-${crypto.randomUUID().slice(0, 6)}` });
    const chat = await createChat(app.db, a1.uuid, { type: "group", participantIds: [a2.uuid] });
    const ref = await upload(app, chat.id, a1.uuid);

    // Still unbound: another member cannot pull it.
    await expect(
      getAttachmentForDownload(app.db, { chatId: chat.id, attachmentId: ref.attachmentId, viewerId: a2.uuid }),
    ).rejects.toThrow();
    // The uploader can.
    const own = await getAttachmentForDownload(app.db, {
      chatId: chat.id,
      attachmentId: ref.attachmentId,
      viewerId: a1.uuid,
    });
    expect(own.filename).toBe("notes.md");

    // Once bound to a message, any chat member can download it.
    await sendMessage(
      app.db,
      chat.id,
      a1.uuid,
      { source: "web", format: "text", content: "x", metadata: { mentions: [a2.uuid] } },
      { attachmentIds: [ref.attachmentId] },
    );
    const seen = await getAttachmentForDownload(app.db, {
      chatId: chat.id,
      attachmentId: ref.attachmentId,
      viewerId: a2.uuid,
    });
    expect(seen.size).toBeGreaterThan(0);
  });
});
