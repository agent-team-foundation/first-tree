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
});
