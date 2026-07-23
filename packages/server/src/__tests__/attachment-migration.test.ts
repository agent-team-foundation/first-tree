import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { attachmentReferences } from "../db/schema/attachment-references.js";
import { attachments } from "../db/schema/attachments.js";
import { messages } from "../db/schema/messages.js";
import { createLegacyAttachment } from "../services/attachment.js";
import { migrateAttachmentsToObjectStorage } from "../services/attachment-migration.js";
import { createChat } from "../services/chat.js";
import { attachmentObjectKey, avatarObjectKey, createObjectStorage } from "../services/object-storage.js";
import { uuidv7 } from "../uuid.js";
import { createTestAdmin, createTestAgent, useTestApp, workerObjectStorage } from "./helpers.js";

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

describe("migrate:attachments — bytea to object storage", () => {
  const getApp = useTestApp({ objectStorage: workerObjectStorage() });
  const storage = () => createObjectStorage(workerObjectStorage());

  it("moves payloads, backfills org + edges, keeps downloads working, and is idempotent", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const uploader = await createTestAgent(app, { name: `mig-up-${uid}` });
    const { agent: peer } = await createTestAgent(app, { name: `mig-peer-${uid}`, type: "human" });

    // Legacy attachments: payload inline, no org, no object key.
    const payloadA = Buffer.from(`legacy-payload-A-${uid}`);
    const payloadB = Buffer.from(`legacy-payload-B-${uid}`);
    const legacyA = await createLegacyAttachment(app.db, {
      mimeType: "image/png",
      filename: "a.png",
      data: payloadA,
      uploadedBy: uploader.agent.uuid,
    });
    const legacyB = await createLegacyAttachment(app.db, {
      mimeType: "text/plain",
      filename: "b.txt",
      data: payloadB,
      uploadedBy: uploader.agent.uuid,
    });
    // An orphan uploader: no agent row backs this uploadedBy → org stays NULL.
    const orphanUploader = await createLegacyAttachment(app.db, {
      mimeType: "text/plain",
      filename: "orphan-uploader.txt",
      data: Buffer.from("x"),
      uploadedBy: crypto.randomUUID(),
    });

    // Historic messages referencing legacyA (single) and legacyB (metadata),
    // plus a dangling id that was never existence-checked — inserted
    // directly, as the pre-ledger code produced them (no edges).
    const chat = await createChat(app.db, uploader.agent.uuid, { type: "group", participantIds: [peer.uuid] });
    const danglingId = crypto.randomUUID();
    await app.db.insert(messages).values([
      {
        id: uuidv7(),
        chatId: chat.id,
        senderId: uploader.agent.uuid,
        format: "file",
        content: { imageId: legacyA.id, mimeType: "image/png", filename: "a.png" },
        metadata: {},
        source: "api",
      },
      {
        id: uuidv7(),
        chatId: chat.id,
        senderId: uploader.agent.uuid,
        format: "text",
        content: "see attached doc",
        metadata: {
          attachments: [
            {
              attachmentId: legacyB.id,
              kind: "document",
              mimeType: "text/plain",
              filename: "b.txt",
              size: payloadB.byteLength,
            },
          ],
        },
        source: "api",
      },
      {
        id: uuidv7(),
        chatId: chat.id,
        senderId: uploader.agent.uuid,
        format: "file",
        content: { imageId: danglingId, mimeType: "image/png", filename: "ghost.png" },
        metadata: {},
        source: "api",
      },
    ]);

    // Legacy avatar: inline bytea on the agent row.
    const avatarPayload = Buffer.from(`legacy-avatar-${uid}`);
    await app.db
      .update(agents)
      .set({ avatarImageData: avatarPayload, avatarImageMime: "image/png", avatarImageUpdatedAt: new Date() })
      .where(eq(agents.uuid, uploader.agent.uuid));

    const stats = await migrateAttachmentsToObjectStorage(app.db, storage());

    // Payloads moved and byte-identical in object storage; rows hold keys only.
    for (const [att, payload] of [
      [legacyA, payloadA],
      [legacyB, payloadB],
    ] as const) {
      const [row] = await app.db.select().from(attachments).where(eq(attachments.id, att.id));
      expect(row?.objectKey).toBe(attachmentObjectKey(att.id));
      expect(row?.data).toBeNull();
      expect(row?.organizationId).toBe(uploader.agent.organizationId);
      const object = await storage().getObjectStream(attachmentObjectKey(att.id));
      expect(object).not.toBeNull();
      if (object) {
        expect((await streamToBuffer(object.body)).equals(payload)).toBe(true);
      }
    }

    // Orphan-uploader row: payload moved, org stays NULL (quota-exempt legacy).
    const [orphanRow] = await app.db.select().from(attachments).where(eq(attachments.id, orphanUploader.id));
    expect(orphanRow?.organizationId).toBeNull();
    expect(orphanRow?.data).toBeNull();

    // Edges: real references recorded, dangling id filtered.
    const edgesA = await app.db
      .select()
      .from(attachmentReferences)
      .where(eq(attachmentReferences.attachmentId, legacyA.id));
    expect(edgesA).toHaveLength(1);
    const edgesB = await app.db
      .select()
      .from(attachmentReferences)
      .where(eq(attachmentReferences.attachmentId, legacyB.id));
    expect(edgesB).toHaveLength(1);
    expect(stats.edgesInserted).toBeGreaterThanOrEqual(2);

    // Avatar moved.
    const [agentRow] = await app.db
      .select({ objectKey: agents.avatarObjectKey, data: agents.avatarImageData })
      .from(agents)
      .where(eq(agents.uuid, uploader.agent.uuid));
    expect(agentRow?.objectKey).toBe(avatarObjectKey(uploader.agent.uuid));
    expect(agentRow?.data).toBeNull();
    const avatarObject = await storage().getObjectStream(avatarObjectKey(uploader.agent.uuid));
    expect(avatarObject).not.toBeNull();
    if (avatarObject) {
      expect((await streamToBuffer(avatarObject.body)).equals(avatarPayload)).toBe(true);
    }

    // Verify phase reports completion...
    expect(stats.attachmentsRemaining).toBe(0);
    expect(stats.avatarsRemaining).toBe(0);

    // ...and pre-migration attachments still download through the API.
    const admin = await createTestAdmin(app, { username: `mig-dl-${uid}` });
    const download = await app.inject({
      method: "GET",
      url: `/api/v1/attachments/${legacyA.id}`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload.equals(payloadA)).toBe(true);

    // Idempotent: a second run finds nothing to do and changes nothing.
    const second = await migrateAttachmentsToObjectStorage(app.db, storage());
    expect(second.attachmentsMoved).toBe(0);
    expect(second.avatarsMoved).toBe(0);
    expect(second.edgesInserted).toBe(0);
    expect(second.attachmentsRemaining).toBe(0);
  });

  it("0-row phase C swap keeps the object when a rival run already migrated the row", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const uploader = await createTestAgent(app, { name: `mig-rival-${uid}` });
    const payload = Buffer.from(`rival-${uid}`);
    const legacy = await createLegacyAttachment(app.db, {
      mimeType: "text/plain",
      filename: "rival.txt",
      data: payload,
      uploadedBy: uploader.agent.uuid,
    });

    const stats = await migrateAttachmentsToObjectStorage(app.db, storage(), {
      beforeAttachmentUpdate: async (attachmentId) => {
        // A rival run wins the swap between our PUT and our UPDATE.
        await app.db
          .update(attachments)
          .set({ objectKey: attachmentObjectKey(attachmentId), data: null })
          .where(eq(attachments.id, attachmentId));
      },
    });
    expect(stats.attachmentsSkipped).toBe(1);

    // The row owns the key — the object must have survived our 0-row branch.
    const [row] = await app.db.select().from(attachments).where(eq(attachments.id, legacy.id));
    expect(row?.objectKey).toBe(attachmentObjectKey(legacy.id));
    const object = await storage().getObjectStream(attachmentObjectKey(legacy.id));
    expect(object).not.toBeNull();
    if (object) {
      expect((await streamToBuffer(object.body)).equals(payload)).toBe(true);
    }
  });

  it("0-row phase C swap deletes the object when the sweep destroyed the row mid-flight", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const uploader = await createTestAgent(app, { name: `mig-swept-${uid}` });
    const legacy = await createLegacyAttachment(app.db, {
      mimeType: "text/plain",
      filename: "swept.txt",
      data: Buffer.from(`swept-${uid}`),
      uploadedBy: uploader.agent.uuid,
    });

    const stats = await migrateAttachmentsToObjectStorage(app.db, storage(), {
      beforeAttachmentUpdate: async (attachmentId) => {
        // Sweep tombstoned + destroyed the row while our PUT was in flight.
        await app.db.delete(attachments).where(eq(attachments.id, attachmentId));
      },
    });
    expect(stats.attachmentsSkipped).toBe(1);

    // Ownerless object must not leak (no row → the sweep can never see it).
    await expect(storage().getObjectStream(attachmentObjectKey(legacy.id))).resolves.toBeNull();
  });

  it("0-row phase D swap keeps the avatar a user uploaded mid-migration", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const { agent } = await createTestAgent(app, { name: `mig-av-race-${uid}` });
    await app.db
      .update(agents)
      .set({
        avatarImageData: Buffer.from("old-avatar"),
        avatarImageMime: "image/png",
        avatarImageUpdatedAt: new Date(),
      })
      .where(eq(agents.uuid, agent.uuid));

    const newAvatar = Buffer.from(`new-avatar-${uid}`);
    const stats = await migrateAttachmentsToObjectStorage(app.db, storage(), {
      beforeAvatarUpdate: async (agentUuid) => {
        // An online avatar upload lands between our PUT and our UPDATE.
        const { setAgentAvatarImage } = await import("../services/agent.js");
        await setAgentAvatarImage(app.db, storage(), agentUuid, Readable.from([newAvatar]), {
          mime: "image/png",
          contentLength: newAvatar.byteLength,
        });
      },
    });
    expect(stats.avatarsSkipped).toBe(1);
    expect(stats.avatarsMoved).toBe(0);

    // The freshly uploaded avatar must survive: row keeps its key and the
    // object holds the NEW bytes (the online upload wrote after our PUT).
    const [row] = await app.db
      .select({ objectKey: agents.avatarObjectKey, data: agents.avatarImageData })
      .from(agents)
      .where(eq(agents.uuid, agent.uuid));
    expect(row?.objectKey).toBe(avatarObjectKey(agent.uuid));
    expect(row?.data).toBeNull();
    const object = await storage().getObjectStream(avatarObjectKey(agent.uuid));
    expect(object).not.toBeNull();
    if (object) {
      expect((await streamToBuffer(object.body)).equals(newAvatar)).toBe(true);
    }
  });
});
