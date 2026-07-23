import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { attachmentReferences } from "../db/schema/attachment-references.js";
import { attachments } from "../db/schema/attachments.js";
import { messages } from "../db/schema/messages.js";
import { type AttachmentMeta, finalizeAttachment, reserveAttachment } from "../services/attachment.js";
import { sweepAttachments } from "../services/attachment-sweep.js";
import { createChat } from "../services/chat.js";
import { attachmentObjectKey, createObjectStorage } from "../services/object-storage.js";
import { uuidv7 } from "../uuid.js";
import { createTestAgent, useTestApp, workerObjectStorage } from "./helpers.js";

const QUOTA = { maxTotalBytes: 1024 * 1024, maxObjectCount: 100 };
const SWEEP_OPTS = { orphanGraceSeconds: 3600, pendingTtlSeconds: 600 };

describe("attachment orphan sweep", () => {
  const getApp = useTestApp({ objectStorage: workerObjectStorage() });
  const storage = () => createObjectStorage(workerObjectStorage());

  async function backdate(app: ReturnType<typeof getApp>, id: string, seconds: number): Promise<void> {
    await app.db
      .update(attachments)
      .set({ createdAt: new Date(Date.now() - seconds * 1000) })
      .where(eq(attachments.id, id));
  }

  async function reservedAttachment(app: ReturnType<typeof getApp>, uploadedBy: string): Promise<AttachmentMeta> {
    const org = (await import("../services/organization.js")).resolveDefaultOrgId;
    return reserveAttachment(app.db, {
      organizationId: await org(app.db),
      mimeType: "image/png",
      filename: "sweep.png",
      sizeBytes: 10,
      uploadedBy,
      quota: QUOTA,
    });
  }

  async function storedAttachment(app: ReturnType<typeof getApp>, uploadedBy: string): Promise<AttachmentMeta> {
    const reserved = await reservedAttachment(app, uploadedBy);
    if (!reserved.objectKey) throw new Error("missing object key");
    const payload = Buffer.alloc(10, 1);
    await storage().putObjectStream(reserved.objectKey, Readable.from([payload]), {
      contentLength: payload.byteLength,
      contentType: "image/png",
    });
    await finalizeAttachment(app.db, reserved.id);
    return reserved;
  }

  async function rowOf(app: ReturnType<typeof getApp>, id: string) {
    const [row] = await app.db.select().from(attachments).where(eq(attachments.id, id));
    return row;
  }

  it("reclaims expired pending reservations and leaves fresh ones", async () => {
    const app = getApp();
    const { agent } = await createTestAgent(app, { name: `sw-pend-${crypto.randomUUID().slice(0, 6)}` });
    const expired = await reservedAttachment(app, agent.uuid);
    const fresh = await reservedAttachment(app, agent.uuid);
    await backdate(app, expired.id, SWEEP_OPTS.pendingTtlSeconds + 60);

    const stats = await sweepAttachments(app.db, storage(), SWEEP_OPTS);
    expect(stats.pendingReclaimed).toBe(1);
    expect(await rowOf(app, expired.id)).toBeUndefined();
    expect((await rowOf(app, fresh.id))?.state).toBe("pending");
  });

  it("deletes aged zero-edge stored attachments (object + row), keeps young and referenced ones", async () => {
    const app = getApp();
    const { agent } = await createTestAgent(app, { name: `sw-orph-${crypto.randomUUID().slice(0, 6)}` });
    const { agent: peer } = await createTestAgent(app, {
      name: `sw-peer-${crypto.randomUUID().slice(0, 6)}`,
      type: "human",
    });

    const orphan = await storedAttachment(app, agent.uuid);
    const young = await storedAttachment(app, agent.uuid);
    const referenced = await storedAttachment(app, agent.uuid);
    await backdate(app, orphan.id, SWEEP_OPTS.orphanGraceSeconds + 60);
    await backdate(app, referenced.id, SWEEP_OPTS.orphanGraceSeconds + 60);

    // Give `referenced` a real ledger edge via an actual message.
    const chat = await createChat(app.db, agent.uuid, { type: "group", participantIds: [peer.uuid] });
    const { sendMessage } = await import("../services/message.js");
    await sendMessage(app.db, chat.id, agent.uuid, {
      source: "api",
      format: "file",
      content: { imageId: referenced.id, mimeType: "image/png", filename: referenced.filename },
      metadata: { mentions: [peer.uuid] },
    });

    const stats = await sweepAttachments(app.db, storage(), SWEEP_OPTS);
    expect(stats.orphansDeleted).toBe(1);
    expect(await rowOf(app, orphan.id)).toBeUndefined();
    await expect(storage().getObjectStream(attachmentObjectKey(orphan.id))).resolves.toBeNull();
    expect((await rowOf(app, young.id))?.state).toBe("stored");
    expect((await rowOf(app, referenced.id))?.state).toBe("stored");
  });

  it("verify scan vetoes candidates whose id appears in message text without a ledger edge", async () => {
    const app = getApp();
    const { agent } = await createTestAgent(app, { name: `sw-veto-${crypto.randomUUID().slice(0, 6)}` });
    const { agent: peer } = await createTestAgent(app, {
      name: `sw-vpeer-${crypto.randomUUID().slice(0, 6)}`,
      type: "human",
    });
    const preBackfill = await storedAttachment(app, agent.uuid);
    await backdate(app, preBackfill.id, SWEEP_OPTS.orphanGraceSeconds + 60);

    // Simulate the deploy-before-backfill window: a message row references
    // the id in content jsonb, but no `attachment_references` edge exists
    // (written directly, bypassing the send path that would record one).
    const chat = await createChat(app.db, agent.uuid, { type: "group", participantIds: [peer.uuid] });
    await app.db.insert(messages).values({
      id: uuidv7(),
      chatId: chat.id,
      senderId: agent.uuid,
      format: "file",
      content: { imageId: preBackfill.id, mimeType: "image/png", filename: "old.png" },
      metadata: {},
      source: "api",
    });
    const edges = await app.db
      .select()
      .from(attachmentReferences)
      .where(eq(attachmentReferences.attachmentId, preBackfill.id));
    expect(edges).toHaveLength(0);

    const stats = await sweepAttachments(app.db, storage(), SWEEP_OPTS);
    expect(stats.orphansVetoed).toBe(1);
    expect(stats.orphansDeleted).toBe(0);
    expect((await rowOf(app, preBackfill.id))?.state).toBe("stored");
    await expect(storage().getObjectStream(attachmentObjectKey(preBackfill.id))).resolves.not.toBeNull();
  });

  it("clears leftover deleting tombstones, including legacy rows without objects", async () => {
    const app = getApp();
    const { agent } = await createTestAgent(app, { name: `sw-tomb-${crypto.randomUUID().slice(0, 6)}` });
    const tombstoned = await storedAttachment(app, agent.uuid);
    await app.db.update(attachments).set({ state: "deleting" }).where(eq(attachments.id, tombstoned.id));

    // Legacy shape: bytea payload, no object key, tombstoned.
    const legacyId = crypto.randomUUID();
    await app.db.insert(attachments).values({
      id: legacyId,
      organizationId: null,
      mimeType: "text/plain",
      filename: "legacy.txt",
      sizeBytes: 6,
      objectKey: null,
      state: "deleting",
      data: Buffer.from("legacy"),
      uploadedBy: agent.uuid,
    });

    const stats = await sweepAttachments(app.db, storage(), SWEEP_OPTS);
    expect(stats.tombstonesCleared).toBe(2);
    expect(await rowOf(app, tombstoned.id)).toBeUndefined();
    expect(await rowOf(app, legacyId)).toBeUndefined();
    await expect(storage().getObjectStream(attachmentObjectKey(tombstoned.id))).resolves.toBeNull();
  });

  it("concurrent sweeps split the work without double-processing errors", async () => {
    const app = getApp();
    const { agent } = await createTestAgent(app, { name: `sw-conc-${crypto.randomUUID().slice(0, 6)}` });
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const att = await storedAttachment(app, agent.uuid);
      await backdate(app, att.id, SWEEP_OPTS.orphanGraceSeconds + 60);
      ids.push(att.id);
    }

    const [a, b] = await Promise.all([
      sweepAttachments(app.db, storage(), SWEEP_OPTS),
      sweepAttachments(app.db, storage(), SWEEP_OPTS),
    ]);
    // Between the two runs every orphan is gone exactly once; SKIP LOCKED
    // partitions the claims, and idempotent destroy tolerates overlap on
    // the tombstone pass.
    expect(a.orphansDeleted + b.orphansDeleted).toBeGreaterThanOrEqual(ids.length);
    for (const id of ids) {
      expect(await rowOf(app, id)).toBeUndefined();
    }
  });
});
