import { Readable } from "node:stream";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { attachmentReferences } from "../db/schema/attachment-references.js";
import { attachments } from "../db/schema/attachments.js";
import {
  type AttachmentMeta,
  createLegacyAttachment,
  finalizeAttachment,
  reserveAttachment,
} from "../services/attachment.js";
import { collectAttachmentIds, destroyDeletingAttachments } from "../services/attachment-references.js";
import { createChat } from "../services/chat.js";
import { editMessage, sendMessage } from "../services/message.js";
import { attachmentObjectKey, createObjectStorage } from "../services/object-storage.js";
import { createOrganization } from "../services/organization.js";
import { createTestAgent, useTestApp, workerObjectStorage } from "./helpers.js";

const QUOTA = { maxTotalBytes: 1024 * 1024, maxObjectCount: 100 };

describe("attachment reference lifecycle", () => {
  const getApp = useTestApp({ objectStorage: workerObjectStorage() });
  const storage = () => createObjectStorage(workerObjectStorage());

  async function setup(uid: string) {
    const app = getApp();
    const sender = await createTestAgent(app, { name: `ref-sender-${uid}` });
    const { agent: peer } = await createTestAgent(app, { name: `ref-peer-${uid}`, type: "human" });
    const chat = await createChat(app.db, sender.agent.uuid, { type: "group", participantIds: [peer.uuid] });
    const organizationId = sender.agent.organizationId;
    return { app, sender, peer, chat, organizationId };
  }

  /** Reserve + upload + finalize a real stored attachment owned by `orgId`. */
  async function storedAttachment(
    app: ReturnType<typeof getApp>,
    orgId: string,
    uploadedBy: string,
    payload = Buffer.from("attachment-bytes"),
  ): Promise<AttachmentMeta> {
    const reserved = await reserveAttachment(app.db, {
      organizationId: orgId,
      mimeType: "image/png",
      filename: "ref.png",
      sizeBytes: payload.byteLength,
      uploadedBy,
      quota: QUOTA,
    });
    if (!reserved.objectKey) throw new Error("reservation missing object key");
    await storage().putObjectStream(reserved.objectKey, Readable.from([payload]), {
      contentLength: payload.byteLength,
      contentType: "image/png",
    });
    expect(await finalizeAttachment(app.db, reserved.id)).toBe(true);
    return reserved;
  }

  function imageContent(att: AttachmentMeta) {
    return { imageId: att.id, mimeType: "image/png" as const, filename: att.filename };
  }

  async function edgesOf(app: ReturnType<typeof getApp>, messageId: string): Promise<string[]> {
    const rows = await app.db
      .select({ attachmentId: attachmentReferences.attachmentId })
      .from(attachmentReferences)
      .where(eq(attachmentReferences.messageId, messageId));
    return rows.map((r) => r.attachmentId).sort();
  }

  it("collectAttachmentIds covers single, batch, and metadata shapes (deduped)", () => {
    const a = "11111111-1111-4111-8111-111111111111";
    const b = "22222222-2222-4222-8222-222222222222";
    expect(collectAttachmentIds({ imageId: a, mimeType: "image/png", filename: "x.png" }, {})).toEqual(new Set([a]));
    expect(
      collectAttachmentIds(
        {
          attachments: [
            { imageId: a, mimeType: "image/png", filename: "x.png" },
            { imageId: b, mimeType: "image/png", filename: "y.png" },
          ],
        },
        undefined,
      ),
    ).toEqual(new Set([a, b]));
    expect(
      collectAttachmentIds("plain text", {
        attachments: [{ attachmentId: a, kind: "document", mimeType: "text/plain", filename: "d.txt", size: 3 }],
      }),
    ).toEqual(new Set([a]));
    // Same id in content and metadata collapses to one entry.
    expect(
      collectAttachmentIds(
        { imageId: a, mimeType: "image/png", filename: "x.png" },
        {
          attachments: [{ attachmentId: a, kind: "document", mimeType: "image/png", filename: "x.png", size: 3 }],
        },
      ),
    ).toEqual(new Set([a]));
    expect(collectAttachmentIds("hello", {})).toEqual(new Set());
  });

  it("send records edges for single-image content", async () => {
    const uid = crypto.randomUUID().slice(0, 6);
    const { app, sender, peer, chat, organizationId } = await setup(uid);
    const att = await storedAttachment(app, organizationId, sender.agent.uuid);

    const { message } = await sendMessage(app.db, chat.id, sender.agent.uuid, {
      source: "api",
      format: "file",
      content: imageContent(att),
      metadata: { mentions: [peer.uuid] },
    });
    expect(await edgesOf(app, message.id)).toEqual([att.id]);
  });

  it("send records edges for batch content and metadata refs together", async () => {
    const uid = crypto.randomUUID().slice(0, 6);
    const { app, sender, peer, chat, organizationId } = await setup(uid);
    const a = await storedAttachment(app, organizationId, sender.agent.uuid);
    const b = await storedAttachment(app, organizationId, sender.agent.uuid);
    const doc = await storedAttachment(app, organizationId, sender.agent.uuid, Buffer.from("doc-bytes"));

    const { message } = await sendMessage(app.db, chat.id, sender.agent.uuid, {
      source: "api",
      format: "file",
      content: { caption: "two shots", attachments: [imageContent(a), imageContent(b)] },
      metadata: {
        mentions: [peer.uuid],
        attachments: [
          {
            attachmentId: doc.id,
            kind: "document",
            mimeType: doc.mimeType,
            filename: doc.filename,
            size: doc.sizeBytes,
          },
        ],
      },
    });
    expect(await edgesOf(app, message.id)).toEqual([a.id, b.id, doc.id].sort());
  });

  it("send rejects unknown, pending, deleting, and cross-org attachment references", async () => {
    const uid = crypto.randomUUID().slice(0, 6);
    const { app, sender, peer, chat, organizationId } = await setup(uid);

    const sendWith = (content: unknown) =>
      sendMessage(app.db, chat.id, sender.agent.uuid, {
        source: "api",
        format: "file",
        content,
        metadata: { mentions: [peer.uuid] },
      });

    // Unknown id — shape-valid, existence-invalid.
    await expect(
      sendWith({ imageId: crypto.randomUUID(), mimeType: "image/png", filename: "ghost.png" }),
    ).rejects.toThrow(/unknown attachment/);

    // Pending reservation (upload not finalized).
    const pending = await reserveAttachment(app.db, {
      organizationId,
      mimeType: "image/png",
      filename: "pending.png",
      sizeBytes: 8,
      uploadedBy: sender.agent.uuid,
      quota: QUOTA,
    });
    await expect(sendWith(imageContent(pending))).rejects.toThrow(/not available/);

    // Deleting tombstone.
    const doomed = await storedAttachment(app, organizationId, sender.agent.uuid);
    await app.db.update(attachments).set({ state: "deleting" }).where(eq(attachments.id, doomed.id));
    await expect(sendWith(imageContent(doomed))).rejects.toThrow(/not available/);

    // Cross-org reference.
    const otherOrg = await createOrganization(app.db, {
      name: `ref-org-${uid}`,
      displayName: "Ref Other Org",
    });
    const foreign = await storedAttachment(app, otherOrg.id, sender.agent.uuid);
    await expect(sendWith(imageContent(foreign))).rejects.toThrow(/different organization/);

    // Legacy NULL-org rows stay referenceable (pre-backfill grandfathering).
    const legacy = await createLegacyAttachment(app.db, {
      mimeType: "image/png",
      filename: "legacy.png",
      data: Buffer.from("legacy"),
      uploadedBy: sender.agent.uuid,
    });
    const { message } = await sendWith(imageContent(legacy));
    expect(await edgesOf(app, message.id)).toEqual([legacy.id]);
  });

  it("edit dropping the last reference destroys the attachment (object + row)", async () => {
    const uid = crypto.randomUUID().slice(0, 6);
    const { app, sender, peer, chat, organizationId } = await setup(uid);
    const att = await storedAttachment(app, organizationId, sender.agent.uuid);

    const { message } = await sendMessage(app.db, chat.id, sender.agent.uuid, {
      source: "api",
      format: "file",
      content: imageContent(att),
      metadata: { mentions: [peer.uuid] },
    });

    await editMessage(app.db, storage(), chat.id, message.id, sender.agent.uuid, {
      format: "text",
      content: "image retracted",
    });

    expect(await edgesOf(app, message.id)).toEqual([]);
    const [row] = await app.db.select().from(attachments).where(eq(attachments.id, att.id));
    expect(row).toBeUndefined();
    await expect(storage().getObjectStream(attachmentObjectKey(att.id))).resolves.toBeNull();
  });

  it("edit replacing image A with image B moves the edge and destroys only A", async () => {
    const uid = crypto.randomUUID().slice(0, 6);
    const { app, sender, peer, chat, organizationId } = await setup(uid);
    const a = await storedAttachment(app, organizationId, sender.agent.uuid);
    const b = await storedAttachment(app, organizationId, sender.agent.uuid);

    const { message } = await sendMessage(app.db, chat.id, sender.agent.uuid, {
      source: "api",
      format: "file",
      content: imageContent(a),
      metadata: { mentions: [peer.uuid] },
    });

    await editMessage(app.db, storage(), chat.id, message.id, sender.agent.uuid, { content: imageContent(b) });

    expect(await edgesOf(app, message.id)).toEqual([b.id]);
    const [rowA] = await app.db.select().from(attachments).where(eq(attachments.id, a.id));
    expect(rowA).toBeUndefined();
    const [rowB] = await app.db.select().from(attachments).where(eq(attachments.id, b.id));
    expect(rowB?.state).toBe("stored");
  });

  it("an attachment still referenced by another message survives an edit", async () => {
    const uid = crypto.randomUUID().slice(0, 6);
    const { app, sender, peer, chat, organizationId } = await setup(uid);
    const shared = await storedAttachment(app, organizationId, sender.agent.uuid);

    const first = await sendMessage(app.db, chat.id, sender.agent.uuid, {
      source: "api",
      format: "file",
      content: imageContent(shared),
      metadata: { mentions: [peer.uuid] },
    });
    const second = await sendMessage(app.db, chat.id, sender.agent.uuid, {
      source: "api",
      format: "file",
      content: imageContent(shared),
      metadata: { mentions: [peer.uuid] },
    });

    await editMessage(app.db, storage(), chat.id, first.message.id, sender.agent.uuid, {
      format: "text",
      content: "retracted",
    });

    expect(await edgesOf(app, first.message.id)).toEqual([]);
    expect(await edgesOf(app, second.message.id)).toEqual([shared.id]);
    const [row] = await app.db.select().from(attachments).where(eq(attachments.id, shared.id));
    expect(row?.state).toBe("stored");
    expect(await storage().getObjectStream(attachmentObjectKey(shared.id))).not.toBeNull();
  });

  it("destroyDeletingAttachments leaves S3-backed tombstones alone when storage is unavailable", async () => {
    const uid = crypto.randomUUID().slice(0, 6);
    const { app, sender, organizationId } = await setup(uid);
    const att = await storedAttachment(app, organizationId, sender.agent.uuid);
    await app.db.update(attachments).set({ state: "deleting" }).where(eq(attachments.id, att.id));

    await destroyDeletingAttachments(app.db, null, [att.id]);
    const [kept] = await app.db
      .select()
      .from(attachments)
      .where(and(eq(attachments.id, att.id), eq(attachments.state, "deleting")));
    expect(kept).toBeDefined();

    await destroyDeletingAttachments(app.db, storage(), [att.id]);
    const [gone] = await app.db.select().from(attachments).where(eq(attachments.id, att.id));
    expect(gone).toBeUndefined();
  });
});
