import { PassThrough } from "node:stream";
import { ATTACHMENT_ERROR_CODES, ATTACHMENT_FILENAME_HEADER, ATTACHMENT_MIME_HEADER } from "@first-tree/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { attachments } from "../db/schema/attachments.js";
import { TooManyRequestsError } from "../errors.js";
import { createUploadGate } from "../services/upload-gate.js";
import { createTestAdmin, createTestApp, workerObjectStorage } from "./helpers.js";

type Admin = Awaited<ReturnType<typeof createTestAdmin>>;

function upload(app: FastifyInstance, caller: Admin, payload: Buffer, filename = "q.bin") {
  return app.inject({
    method: "POST",
    url: `/api/v1/orgs/${caller.organizationId}/attachments`,
    headers: {
      authorization: `Bearer ${caller.accessToken}`,
      "content-type": "application/octet-stream",
      [ATTACHMENT_MIME_HEADER]: "application/octet-stream",
      [ATTACHMENT_FILENAME_HEADER]: filename,
    },
    payload,
  });
}

describe("attachment org quotas — hard reject", () => {
  it("rejects with 422 + stable code when the byte quota would be exceeded", async () => {
    const app = await createTestApp({
      objectStorage: workerObjectStorage(),
      attachments: { orgQuotaBytes: 100 },
    });
    try {
      const admin = await createTestAdmin(app, { username: `qb-${crypto.randomUUID().slice(0, 6)}` });
      expect((await upload(app, admin, Buffer.alloc(60))).statusCode).toBe(201);

      const reply = await upload(app, admin, Buffer.alloc(60));
      expect(reply.statusCode).toBe(422);
      const body = reply.json() as { code?: string; error?: string };
      expect(body.code).toBe(ATTACHMENT_ERROR_CODES.quotaExceeded);
      expect(body.error).toMatch(/storage quota/);

      // Hard reject means no soft admission: usage stays at one object.
      expect((await upload(app, admin, Buffer.alloc(40))).statusCode).toBe(201);
    } finally {
      await app.close();
    }
  });

  it("rejects with 422 + stable code when the object-count quota would be exceeded", async () => {
    const app = await createTestApp({
      objectStorage: workerObjectStorage(),
      attachments: { orgQuotaCount: 1 },
    });
    try {
      const admin = await createTestAdmin(app, { username: `qc-${crypto.randomUUID().slice(0, 6)}` });
      expect((await upload(app, admin, Buffer.alloc(8))).statusCode).toBe(201);

      const reply = await upload(app, admin, Buffer.alloc(8));
      expect(reply.statusCode).toBe(422);
      const body = reply.json() as { code?: string; error?: string };
      expect(body.code).toBe(ATTACHMENT_ERROR_CODES.quotaExceeded);
      expect(body.error).toMatch(/count quota/);
    } finally {
      await app.close();
    }
  });

  it("admits exactly one of two concurrent uploads that each fit but jointly exceed the quota", async () => {
    const app = await createTestApp({
      objectStorage: workerObjectStorage(),
      attachments: { orgQuotaBytes: 100 },
    });
    try {
      const admin = await createTestAdmin(app, { username: `qr-${crypto.randomUUID().slice(0, 6)}` });
      const [a, b] = await Promise.all([
        upload(app, admin, Buffer.alloc(70), "race-a.bin"),
        upload(app, admin, Buffer.alloc(70), "race-b.bin"),
      ]);
      const statuses = [a.statusCode, b.statusCode].sort();
      // The per-org advisory xact lock serializes admission: never both.
      expect(statuses).toEqual([201, 422]);

      // DB-level invariant: admitted usage never exceeds the quota.
      const [usage] = await app.db
        .select({ totalBytes: sql<string>`COALESCE(SUM(${attachments.sizeBytes}), 0)` })
        .from(attachments)
        .where(
          and(eq(attachments.organizationId, admin.organizationId), inArray(attachments.state, ["pending", "stored"])),
        );
      expect(Number(usage?.totalBytes ?? 0)).toBeLessThanOrEqual(100);
    } finally {
      await app.close();
    }
  });

  it("answers 429 + stable code over the wire while an uploader holds its only slot", async () => {
    const app = await createTestApp({
      objectStorage: workerObjectStorage(),
      attachments: { maxConcurrentUploadsPerUploader: 1 },
    });
    try {
      const admin = await createTestAdmin(app, { username: `qg-${crypto.randomUUID().slice(0, 6)}` });

      // First upload holds its slot: the payload stream stays open until we
      // end it, so the gate stays occupied deterministically.
      const held = new PassThrough();
      const payload = Buffer.from("held-upload-body");
      const firstReply = app.inject({
        method: "POST",
        url: `/api/v1/orgs/${admin.organizationId}/attachments`,
        headers: {
          authorization: `Bearer ${admin.accessToken}`,
          "content-type": "application/octet-stream",
          "content-length": String(payload.byteLength),
          [ATTACHMENT_MIME_HEADER]: "application/octet-stream",
          [ATTACHMENT_FILENAME_HEADER]: "held.bin",
        },
        payload: held,
      });

      // The slot is taken as soon as the first request reaches the gate;
      // poll (bounded) until the second upload observes the 429.
      let second: Awaited<ReturnType<typeof upload>> | undefined;
      for (let attempt = 0; attempt < 100; attempt++) {
        second = await upload(app, admin, Buffer.alloc(4), `probe-${attempt}.bin`);
        if (second.statusCode === 429) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(second?.statusCode).toBe(429);
      expect((second?.json() as { code?: string }).code).toBe(ATTACHMENT_ERROR_CODES.concurrencyExceeded);

      // Release the held stream — the first upload completes and frees the slot.
      held.end(payload);
      expect((await firstReply).statusCode).toBe(201);
      expect((await upload(app, admin, Buffer.alloc(4), "after.bin")).statusCode).toBe(201);
    } finally {
      await app.close();
    }
  });

  it("upload gate bounds per-uploader concurrency with 429 + stable code", () => {
    const gate = createUploadGate(2);
    const releaseA = gate.acquire("uploader-1");
    const releaseB = gate.acquire("uploader-1");
    // Third concurrent slot for the same uploader is refused...
    try {
      gate.acquire("uploader-1");
      expect.unreachable("expected TooManyRequestsError");
    } catch (error) {
      expect(error).toBeInstanceOf(TooManyRequestsError);
      expect((error as TooManyRequestsError).attrs?.code).toBe(ATTACHMENT_ERROR_CODES.concurrencyExceeded);
    }
    // ...while other uploaders are unaffected, and release frees the slot.
    const releaseOther = gate.acquire("uploader-2");
    releaseA();
    const releaseC = gate.acquire("uploader-1");
    // Double-release is a no-op, not an underflow.
    releaseA();
    releaseB();
    releaseC();
    releaseOther();
    const again = gate.acquire("uploader-1");
    again();
  });
});
