import { Readable } from "node:stream";
import { GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  ATTACHMENT_FILENAME_HEADER,
  ATTACHMENT_MIME_HEADER,
  ATTACHMENT_QUOTA_EXCEEDED,
  ATTACHMENT_STORAGE_NOT_CONFIGURED,
  ATTACHMENT_UPLOAD_CONCURRENCY_EXCEEDED,
  ATTACHMENT_UPLOAD_MAX_IN_FLIGHT_GLOBAL,
  ATTACHMENT_UPLOAD_MAX_IN_FLIGHT_PER_UPLOADER,
  MAX_ATTACHMENT_BYTES,
  ORG_ATTACHMENT_MAX_COUNT,
} from "@first-tree/shared";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { attachments } from "../db/schema/attachments.js";
import { chats } from "../db/schema/chats.js";
import { messages } from "../db/schema/messages.js";
import {
  AttachmentUploadConcurrencyError,
  acquireAttachmentUploadSlot,
  createAttachment,
  createAttachmentFromStream,
  sweepOrphanAttachments,
} from "../services/attachment.js";
import { migrateLegacyAttachmentsToS3 } from "../services/attachment-migration.js";
import { editMessage } from "../services/message.js";
import { uuidv7 } from "../uuid.js";
import { createTestAdmin, fetchPresignedAttachment, useTestApp } from "./helpers.js";

type Admin = Awaited<ReturnType<typeof createTestAdmin>>;

/** S3 client pointed at this worker's own bucket (same env helpers.ts uses). */
function testS3() {
  const client = new S3Client({
    region: process.env.VITEST_S3_REGION ?? "us-east-1",
    endpoint: process.env.VITEST_S3_ENDPOINT,
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.VITEST_S3_ACCESS_KEY_ID ?? "minioadmin",
      secretAccessKey: process.env.VITEST_S3_SECRET_ACCESS_KEY ?? "minioadmin",
    },
  });
  return { client, bucket: process.env.VITEST_S3_BUCKET ?? "attachments-w1" };
}

async function readS3Bytes(key: string): Promise<Buffer> {
  const { client, bucket } = testS3();
  const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!res.Body) throw new Error(`S3 object ${key} has no body`);
  return Buffer.from(await res.Body.transformToByteArray());
}

async function s3ObjectExists(key: string): Promise<boolean> {
  const { client, bucket } = testS3();
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (err) {
    const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    const name = (err as { name?: string }).name;
    if (status === 404 || name === "NotFound" || name === "NoSuchKey") return false;
    throw err;
  }
}

function postAttachment(app: FastifyInstance, caller: Admin, payload: Buffer, filename = "test.png") {
  return app.inject({
    method: "POST",
    url: `/api/v1/orgs/${caller.organizationId}/attachments`,
    headers: {
      authorization: `Bearer ${caller.accessToken}`,
      "content-type": "application/octet-stream",
      [ATTACHMENT_MIME_HEADER]: "image/png",
      [ATTACHMENT_FILENAME_HEADER]: filename,
    },
    payload,
  });
}

async function uploadBytes(
  app: FastifyInstance,
  caller: Admin,
  bytes: Buffer,
): Promise<{ id: string; objectKey: string }> {
  const res = await postAttachment(app, caller, bytes);
  expect(res.statusCode).toBe(201);
  const { id } = res.json() as { id: string };
  const [row] = await app.db.select().from(attachments).where(eq(attachments.id, id)).limit(1);
  if (!row?.objectKey) throw new Error(`uploaded row ${id} has no object_key`);
  return { id, objectKey: row.objectKey };
}

/** Move a row past the 24h orphan grace so the sweeper considers it. */
async function ageAttachment(app: FastifyInstance, id: string): Promise<void> {
  await app.db.execute(sql`UPDATE attachments SET created_at = now() - interval '25 hours' WHERE id = ${id}`);
}

async function seedChat(app: FastifyInstance, organizationId: string): Promise<string> {
  const chatId = uuidv7();
  await app.db.insert(chats).values({ id: chatId, organizationId, type: "group" });
  return chatId;
}

async function seedMessage(
  app: FastifyInstance,
  input: { chatId: string; senderId: string; format: string; content: unknown; metadata?: Record<string, unknown> },
): Promise<string> {
  const id = uuidv7();
  await app.db.insert(messages).values({
    id,
    chatId: input.chatId,
    senderId: input.senderId,
    format: input.format,
    content: input.content,
    metadata: input.metadata ?? {},
    source: "api",
  });
  return id;
}

describe("attachments S3 storage", () => {
  const getApp = useTestApp();

  it("upload lands in S3 with only metadata in Postgres", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `s3up-${crypto.randomUUID().slice(0, 6)}` });

    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const res = await postAttachment(app, admin, bytes, "kitten.png");
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; sizeBytes: number };

    const [row] = await app.db.select().from(attachments).where(eq(attachments.id, body.id)).limit(1);
    expect(row).toBeDefined();
    expect(row?.objectKey).toBe(`attachments/${admin.organizationId}/${body.id}`);
    expect(row?.data).toBeNull();
    expect(row?.orgId).toBe(admin.organizationId);
    expect(row?.sizeBytes).toBe(bytes.byteLength);

    const stored = await readS3Bytes(row?.objectKey ?? "");
    expect(stored.equals(bytes)).toBe(true);
  });

  it("download redirects 302 to a presigned URL that serves the bytes", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `s3dl-${crypto.randomUUID().slice(0, 6)}` });
    const bytes = Buffer.from("presigned-download-bytes");
    const { id } = await uploadBytes(app, admin, bytes);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/attachments/${id}`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers["cache-control"]).toBe("private, no-cache");
    expect(res.headers.etag).toBe(`"${id}"`);
    const location = res.headers.location;
    expect(location).toBeDefined();
    // The presigned URL carries the stored mime / filename as signed response
    // overrides; expiry is the 300s the store is configured with.
    expect(location).toContain("response-content-type=image%2Fpng");
    expect(location).toContain("response-content-disposition=");
    expect(location).toContain("X-Amz-Expires=300");

    // Presigned URLs authorize without the API JWT — fetch it directly.
    const objectRes = await fetchPresignedAttachment(location);
    expect(objectRes.contentType).toBe("image/png");
    expect(objectRes.contentDisposition).toBe('inline; filename="test.png"');
    expect(objectRes.body.equals(bytes)).toBe(true);
  });

  it("legacy bytea rows still download through the buffered path", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `legacy-${crypto.randomUUID().slice(0, 6)}` });
    const bytes = Buffer.from("pre-migration-bytes");
    const row = await createAttachment(app.db, {
      mimeType: "image/png",
      filename: "legacy.png",
      data: bytes,
      uploadedBy: admin.humanAgentUuid,
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/attachments/${row.id}`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.rawPayload.equals(bytes)).toBe(true);
  });

  it("rejects an oversize stream with 413 and stores nothing", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `s3os-${crypto.randomUUID().slice(0, 6)}` });
    const oversize = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1024);
    const res = await postAttachment(app, admin, oversize);
    expect(res.statusCode).toBe(413);

    const count = await app.db
      .select({ count: sql<number>`count(*)::int` })
      .from(attachments)
      .where(eq(attachments.orgId, admin.organizationId));
    expect(Number(count[0]?.count ?? 0)).toBe(0);
  });

  it("rejects uploads over the org byte quota with 422", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `qbytes-${crypto.randomUUID().slice(0, 6)}` });
    // Seed usage at exactly the 2 GiB line with two 1 GiB rows (size_bytes is
    // int4, so the full 2 GiB value itself would overflow the column).
    const gib = 1024 * 1024 * 1024;
    await app.db.insert(attachments).values([
      {
        id: uuidv7(),
        mimeType: "image/png",
        filename: "seed-1.bin",
        sizeBytes: gib,
        objectKey: `attachments/${admin.organizationId}/seed-1`,
        orgId: admin.organizationId,
        uploadedBy: admin.humanAgentUuid,
      },
      {
        id: uuidv7(),
        mimeType: "image/png",
        filename: "seed-2.bin",
        sizeBytes: gib,
        objectKey: `attachments/${admin.organizationId}/seed-2`,
        orgId: admin.organizationId,
        uploadedBy: admin.humanAgentUuid,
      },
    ]);

    const res = await postAttachment(app, admin, Buffer.from("one byte too many"));
    expect(res.statusCode).toBe(422);
    expect((res.json() as { code?: string }).code).toBe(ATTACHMENT_QUOTA_EXCEEDED);
  });

  it("rejects uploads over the org count quota with 422", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `qcount-${crypto.randomUUID().slice(0, 6)}` });
    const rows = Array.from({ length: ORG_ATTACHMENT_MAX_COUNT }, (_, i) => ({
      id: uuidv7(),
      mimeType: "image/png",
      filename: `seed-${i}.bin`,
      sizeBytes: 1,
      objectKey: `attachments/${admin.organizationId}/seed-${i}`,
      orgId: admin.organizationId,
      uploadedBy: admin.humanAgentUuid,
    }));
    await app.db.insert(attachments).values(rows);

    const res = await postAttachment(app, admin, Buffer.from("row 1001"));
    expect(res.statusCode).toBe(422);
    expect((res.json() as { code?: string }).code).toBe(ATTACHMENT_QUOTA_EXCEEDED);
  });

  it("serializes concurrent uploads at the org quota line via the org row lock", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `grace-${crypto.randomUUID().slice(0, 6)}` });
    // Seed usage one row below the count cap: exactly ONE of the concurrent
    // uploads may win. The serialization happens on the organizations row
    // lock in Postgres, not in the event loop, so app.inject concurrency is
    // enough to exercise the TOCTOU barrier.
    const rows = Array.from({ length: ORG_ATTACHMENT_MAX_COUNT - 1 }, (_, i) => ({
      id: uuidv7(),
      mimeType: "image/png",
      filename: `seed-${i}.bin`,
      sizeBytes: 1,
      objectKey: `attachments/${admin.organizationId}/seed-${i}`,
      orgId: admin.organizationId,
      uploadedBy: admin.humanAgentUuid,
    }));
    await app.db.insert(attachments).values(rows);

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => postAttachment(app, admin, Buffer.from(`race-${i}`))),
    );
    const statuses = results.map((r) => r.statusCode).sort((a, b) => a - b);
    expect(statuses).toEqual([201, 422, 422, 422, 422]);
    for (const res of results) {
      if (res.statusCode === 422) {
        expect((res.json() as { code?: string }).code).toBe(ATTACHMENT_QUOTA_EXCEEDED);
      }
    }

    const count = await app.db
      .select({ count: sql<number>`count(*)::int` })
      .from(attachments)
      .where(eq(attachments.orgId, admin.organizationId));
    expect(Number(count[0]?.count ?? 0)).toBe(ORG_ATTACHMENT_MAX_COUNT);
  });

  it("rejects an empty upload with 400 and leaves no DB row or S3 object", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `empty-${crypto.randomUUID().slice(0, 6)}` });

    // Route level: an empty body is a 400 one way or another.
    const res = await postAttachment(app, admin, Buffer.alloc(0));
    expect(res.statusCode).toBe(400);

    // Service level: an empty STREAM must also be rejected (lib-storage would
    // otherwise complete a 0-byte multipart object), and the compensation
    // delete must leave nothing behind in the bucket. A caller-supplied id
    // makes the would-be object key deterministic. (The per-worker bucket is
    // shared across tests, so a prefix listing cannot isolate this call.)
    const store = app.attachmentStore;
    if (!store) throw new Error("test app must have an attachment store");
    const emptyId = crypto.randomUUID();
    await expect(
      createAttachmentFromStream(app.db, store, {
        id: emptyId,
        mimeType: "image/png",
        filename: "empty.png",
        stream: Readable.from([]),
        uploadedBy: admin.humanAgentUuid,
        orgId: admin.organizationId,
      }),
    ).rejects.toThrow("Attachment is empty");

    const count = await app.db
      .select({ count: sql<number>`count(*)::int` })
      .from(attachments)
      .where(eq(attachments.orgId, admin.organizationId));
    expect(Number(count[0]?.count ?? 0)).toBe(0);
    expect(await s3ObjectExists(`attachments/${admin.organizationId}/${emptyId}`)).toBe(false);
  });

  it("upload concurrency guard enforces per-uploader and global caps", () => {
    const releases: Array<() => void> = [];
    try {
      for (let i = 0; i < ATTACHMENT_UPLOAD_MAX_IN_FLIGHT_PER_UPLOADER; i += 1) {
        releases.push(acquireAttachmentUploadSlot("uploader-a"));
      }
      expect(() => acquireAttachmentUploadSlot("uploader-a")).toThrow(AttachmentUploadConcurrencyError);
      try {
        acquireAttachmentUploadSlot("uploader-a");
      } catch (err) {
        expect((err as AttachmentUploadConcurrencyError).code).toBe(ATTACHMENT_UPLOAD_CONCURRENCY_EXCEEDED);
      }

      // Distinct uploaders drain the global cap.
      for (
        let i = 0;
        i < ATTACHMENT_UPLOAD_MAX_IN_FLIGHT_GLOBAL - ATTACHMENT_UPLOAD_MAX_IN_FLIGHT_PER_UPLOADER;
        i += 1
      ) {
        releases.push(acquireAttachmentUploadSlot(`uploader-g${i}`));
      }
      expect(() => acquireAttachmentUploadSlot("uploader-z")).toThrow(AttachmentUploadConcurrencyError);
    } finally {
      for (const release of releases) release();
    }

    // Releasing frees slots again (guard is not latched).
    const release = acquireAttachmentUploadSlot("uploader-a");
    release();
  });

  it("orphan sweep deletes unreferenced rows and their S3 objects", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `sweep-${crypto.randomUUID().slice(0, 6)}` });
    const bytes = Buffer.from("orphan-bytes");
    const { id, objectKey } = await uploadBytes(app, admin, bytes);
    await ageAttachment(app, id);

    const stats = await sweepOrphanAttachments(app.db, app.attachmentStore);
    expect(stats.scanned).toBe(1);
    expect(stats.deleted).toBe(1);
    expect(stats.failed).toBe(0);

    const [row] = await app.db.select().from(attachments).where(eq(attachments.id, id)).limit(1);
    expect(row).toBeUndefined();
    expect(await s3ObjectExists(objectKey)).toBe(false);
  });

  it("orphan sweep keeps rows referenced by any of the three reference shapes", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `refs-${crypto.randomUUID().slice(0, 6)}` });
    const chatId = await seedChat(app, admin.organizationId);

    const single = await uploadBytes(app, admin, Buffer.from("single-image"));
    const batch = await uploadBytes(app, admin, Buffer.from("batch-image"));
    const generic = await uploadBytes(app, admin, Buffer.from("generic-doc"));

    await seedMessage(app, {
      chatId,
      senderId: admin.humanAgentUuid,
      format: "file",
      content: { imageId: single.id, mimeType: "image/png", filename: "single.png" },
    });
    await seedMessage(app, {
      chatId,
      senderId: admin.humanAgentUuid,
      format: "file",
      content: { caption: "two", attachments: [{ imageId: batch.id, mimeType: "image/png", filename: "batch.png" }] },
    });
    await seedMessage(app, {
      chatId,
      senderId: admin.humanAgentUuid,
      format: "text",
      content: "see doc",
      metadata: {
        attachments: [
          {
            attachmentId: generic.id,
            kind: "document",
            mimeType: "image/png",
            filename: "doc.png",
            size: 11,
          },
        ],
      },
    });

    await ageAttachment(app, single.id);
    await ageAttachment(app, batch.id);
    await ageAttachment(app, generic.id);

    const stats = await sweepOrphanAttachments(app.db, app.attachmentStore);
    expect(stats.scanned).toBe(3);
    expect(stats.deleted).toBe(0);

    const remaining = await app.db.select({ id: attachments.id }).from(attachments);
    expect(remaining.map((r) => r.id).sort()).toEqual([batch.id, generic.id, single.id].sort());
    expect(await s3ObjectExists(single.objectKey)).toBe(true);
    expect(await s3ObjectExists(batch.objectKey)).toBe(true);
    expect(await s3ObjectExists(generic.objectKey)).toBe(true);
  });

  it("message edit dropping the last reference deletes the attachment immediately", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `edit-${crypto.randomUUID().slice(0, 6)}` });
    const chatId = await seedChat(app, admin.organizationId);
    const { id, objectKey } = await uploadBytes(app, admin, Buffer.from("edit-me-away"));
    const messageId = await seedMessage(app, {
      chatId,
      senderId: admin.humanAgentUuid,
      format: "file",
      content: { imageId: id, mimeType: "image/png", filename: "edit.png" },
    });

    await editMessage(
      app.db,
      chatId,
      messageId,
      admin.humanAgentUuid,
      { format: "text", content: "no image anymore" },
      app.attachmentStore,
    );

    const [row] = await app.db.select().from(attachments).where(eq(attachments.id, id)).limit(1);
    expect(row).toBeUndefined();
    expect(await s3ObjectExists(objectKey)).toBe(false);
  });

  it("message edit keeps the attachment when another reference remains", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `keep-${crypto.randomUUID().slice(0, 6)}` });
    const chatId = await seedChat(app, admin.organizationId);
    const { id } = await uploadBytes(app, admin, Buffer.from("still-referenced"));
    await seedMessage(app, {
      chatId,
      senderId: admin.humanAgentUuid,
      format: "text",
      content: "doc ref survives",
      metadata: {
        attachments: [{ attachmentId: id, kind: "image", mimeType: "image/png", filename: "keep.png", size: 17 }],
      },
    });
    const edited = await seedMessage(app, {
      chatId,
      senderId: admin.humanAgentUuid,
      format: "file",
      content: { imageId: id, mimeType: "image/png", filename: "keep.png" },
    });

    await editMessage(
      app.db,
      chatId,
      edited,
      admin.humanAgentUuid,
      { format: "text", content: "image removed here" },
      app.attachmentStore,
    );

    const [row] = await app.db.select().from(attachments).where(eq(attachments.id, id)).limit(1);
    expect(row).toBeDefined();
  });

  it("migration drains legacy bytea rows to S3 and is idempotent", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `mig-${crypto.randomUUID().slice(0, 6)}` });
    const store = app.attachmentStore;
    if (!store) throw new Error("test app must have an attachment store");

    const legacyA = await createAttachment(app.db, {
      mimeType: "image/png",
      filename: "a.png",
      data: Buffer.from("legacy-a-bytes"),
      uploadedBy: admin.humanAgentUuid,
    });
    const legacyB = await createAttachment(app.db, {
      mimeType: "text/markdown",
      filename: "b.md",
      data: Buffer.from("legacy-b-markdown"),
      uploadedBy: admin.humanAgentUuid,
    });

    const first = await migrateLegacyAttachmentsToS3(app.db, store);
    expect(first).toEqual({ scanned: 2, migrated: 2, failed: 0 });

    for (const legacy of [legacyA, legacyB]) {
      const [row] = await app.db.select().from(attachments).where(eq(attachments.id, legacy.id)).limit(1);
      expect(row?.data).toBeNull();
      expect(row?.objectKey).toBe(`attachments/${admin.organizationId}/${legacy.id}`);
      expect(row?.orgId).toBe(admin.organizationId);
    }
    expect(
      (await readS3Bytes(`attachments/${admin.organizationId}/${legacyA.id}`)).equals(Buffer.from("legacy-a-bytes")),
    ).toBe(true);

    // Rerun is a no-op — completed rows are excluded by the batch query.
    const second = await migrateLegacyAttachmentsToS3(app.db, store);
    expect(second).toEqual({ scanned: 0, migrated: 0, failed: 0 });

    // Migrated rows download via the 302 path.
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/attachments/${legacyB.id}`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.statusCode).toBe(302);
    const objectRes = await fetchPresignedAttachment(res.headers.location);
    expect(objectRes.body.equals(Buffer.from("legacy-b-markdown"))).toBe(true);
  });
});

describe("attachments without S3 configured", () => {
  const getApp = useTestApp({ s3: false });

  it("upload fails fast with 503 + ATTACHMENT_STORAGE_NOT_CONFIGURED", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `nos3-${crypto.randomUUID().slice(0, 6)}` });
    const res = await postAttachment(app, admin, Buffer.from("no store"));
    expect(res.statusCode).toBe(503);
    expect((res.json() as { code?: string }).code).toBe(ATTACHMENT_STORAGE_NOT_CONFIGURED);
  });

  it("legacy bytea download is unaffected", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `nos3dl-${crypto.randomUUID().slice(0, 6)}` });
    const bytes = Buffer.from("legacy-still-served");
    const row = await createAttachment(app.db, {
      mimeType: "image/png",
      filename: "legacy.png",
      data: bytes,
      uploadedBy: admin.humanAgentUuid,
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/attachments/${row.id}`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(bytes)).toBe(true);
  });
});
