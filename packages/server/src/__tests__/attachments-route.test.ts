import { ATTACHMENT_FILENAME_HEADER, ATTACHMENT_MIME_HEADER, MAX_ATTACHMENT_BYTES } from "@first-tree/shared";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { organizations } from "../db/schema/organizations.js";
import { createAttachment } from "../services/attachment.js";
import { ensureMembership } from "../services/membership.js";
import { uuidv7 } from "../uuid.js";
import { createAdminContext, createTestAdmin, useTestApp } from "./helpers.js";

type Admin = Awaited<ReturnType<typeof createTestAdmin>>;

function postAttachment(
  app: FastifyInstance,
  caller: Admin,
  payload: Buffer,
  overrides: Partial<{ mime: string; filename: string; contentType: string; orgId: string }> = {},
) {
  const orgId = overrides.orgId ?? caller.organizationId;
  return app.inject({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/attachments`,
    headers: {
      authorization: `Bearer ${caller.accessToken}`,
      "content-type": overrides.contentType ?? "application/octet-stream",
      [ATTACHMENT_MIME_HEADER]: overrides.mime ?? "image/png",
      [ATTACHMENT_FILENAME_HEADER]: overrides.filename ?? "test.png",
    },
    payload,
  });
}

function getAttachment(app: FastifyInstance, caller: Admin, id: string) {
  return app.inject({
    method: "GET",
    url: `/api/v1/attachments/${id}`,
    headers: { authorization: `Bearer ${caller.accessToken}` },
  });
}

describe("attachments route — upload + capability download", () => {
  const getApp = useTestApp();

  it("uploads then downloads via uploader", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `up-self-${crypto.randomUUID().slice(0, 6)}` });

    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const upload = await postAttachment(app, admin, bytes, { filename: "kitten.png" });
    expect(upload.statusCode).toBe(201);
    const body = upload.json() as { id: string; sizeBytes: number; uploadedBy: string };
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.sizeBytes).toBe(bytes.byteLength);
    expect(body.uploadedBy).toBe(admin.humanAgentUuid);

    const download = await getAttachment(app, admin, body.id);
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-type"]).toBe("image/png");
    expect(download.headers["content-length"]).toBe(String(bytes.byteLength));
    expect(download.headers["x-content-type-options"]).toBe("nosniff");
    expect(download.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
    expect(download.headers.etag).toBe(`"${body.id}"`);
    expect(download.headers["content-disposition"]).toBe('inline; filename="kitten.png"');
    expect(download.rawPayload.equals(bytes)).toBe(true);
  });

  it("capability model: any authenticated user with the id can download", async () => {
    const app = getApp();
    const uploader = await createAdminContext(app, { username: `cap-up-${crypto.randomUUID().slice(0, 6)}` });
    const other = await createAdminContext(app, { username: `cap-ot-${crypto.randomUUID().slice(0, 6)}` });

    const bytes = Buffer.from("shared-by-capability");
    const upload = await postAttachment(app, uploader, bytes);
    const id = (upload.json() as { id: string }).id;

    // A different authenticated user who knows the id downloads it — the
    // unguessable id is the bearer capability; no chat/uploader relation
    // required. Stronger ACL is the consumer's job, not the primitive's.
    const download = await getAttachment(app, other, id);
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload.equals(bytes)).toBe(true);
  });

  it("rejects download without a JWT (401)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `noauth-${crypto.randomUUID().slice(0, 6)}` });
    const upload = await postAttachment(app, admin, Buffer.from("guarded"));
    const id = (upload.json() as { id: string }).id;

    const reply = await app.inject({ method: "GET", url: `/api/v1/attachments/${id}` });
    expect(reply.statusCode).toBe(401);
  });

  it("ETag 304 on If-None-Match hit", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `etag-${crypto.randomUUID().slice(0, 6)}` });
    const upload = await postAttachment(app, admin, Buffer.from("hi"));
    const id = (upload.json() as { id: string }).id;

    const reply = await app.inject({
      method: "GET",
      url: `/api/v1/attachments/${id}`,
      headers: {
        authorization: `Bearer ${admin.accessToken}`,
        "if-none-match": `"${id}"`,
      },
    });
    expect(reply.statusCode).toBe(304);
    expect(reply.headers["x-content-type-options"]).toBe("nosniff");
    expect(reply.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(reply.headers["x-frame-options"]).toBe("DENY");
  });

  it("rejects upload with wrong Content-Type", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `wct-${crypto.randomUUID().slice(0, 6)}` });
    const reply = await postAttachment(app, admin, Buffer.from("hi"), { contentType: "application/json" });
    expect(reply.statusCode).toBe(400);
  });

  it("rejects upload missing the mime header", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `mh-${crypto.randomUUID().slice(0, 6)}` });
    const reply = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${admin.organizationId}/attachments`,
      headers: {
        authorization: `Bearer ${admin.accessToken}`,
        "content-type": "application/octet-stream",
        [ATTACHMENT_FILENAME_HEADER]: "x.bin",
      },
      payload: Buffer.from("hi"),
    });
    expect(reply.statusCode).toBe(400);
  });

  it("rejects empty body", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `eb-${crypto.randomUUID().slice(0, 6)}` });
    const reply = await postAttachment(app, admin, Buffer.alloc(0));
    expect(reply.statusCode).toBe(400);
  });

  it("rejects blank attachment mime type and filename", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `blank-attachment-${crypto.randomUUID().slice(0, 6)}` });

    const blankMime = await postAttachment(app, admin, Buffer.from("mime"), { mime: " " });
    expect(blankMime.statusCode).toBe(400);

    await expect(
      createAttachment(app.db, {
        mimeType: "image/png",
        filename: " ",
        data: Buffer.from("filename"),
        uploadedBy: admin.humanAgentUuid,
      }),
    ).rejects.toThrow("Attachment filename is required");
  });

  it("surfaces an empty insert-returning result from the attachment store", async () => {
    const fakeDb = {
      insert: () => ({
        values: () => ({
          returning: async () => [],
        }),
      }),
    };

    await expect(
      createAttachment(fakeDb as never, {
        mimeType: "image/png",
        filename: "x.png",
        data: Buffer.from("bytes"),
        uploadedBy: "agent_1",
      }),
    ).rejects.toThrow("Attachment insert returned no row");
  });

  it("rejects oversize at bodyLimit (413) or service cap (400)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `os-${crypto.randomUUID().slice(0, 6)}` });
    // 1 KB over the cap — well under the route bodyLimit, so the service-
    // layer cap is what fires.
    const oversize = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1024);
    const reply = await postAttachment(app, admin, oversize);
    expect([400, 413]).toContain(reply.statusCode);
  });

  it("returns 404 for unknown attachment id", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `nf-${crypto.randomUUID().slice(0, 6)}` });
    const reply = await getAttachment(app, admin, "00000000-0000-4000-8000-000000000000");
    expect(reply.statusCode).toBe(404);
  });

  it("rejects upload to an org the caller is not a member of (403)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `noorg-${crypto.randomUUID().slice(0, 6)}` });

    const foreignOrgId = uuidv7();
    await app.db
      .insert(organizations)
      .values({ id: foreignOrgId, name: foreignOrgId.slice(0, 30), displayName: "Foreign Org" });

    const reply = await postAttachment(app, admin, Buffer.from("nope"), { orgId: foreignOrgId });
    expect(reply.statusCode).toBe(403);
  });

  it("uploaded_by is determined by the org in the path (multi-org caller)", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `mo-${crypto.randomUUID().slice(0, 6)}` });

    // Seed a second org with a brand-new humanAgent for the same user.
    const otherOrgId = uuidv7();
    await app.db
      .insert(organizations)
      .values({ id: otherOrgId, name: otherOrgId.slice(0, 30), displayName: "Other Org" });
    const otherMember = await ensureMembership(app.db, {
      userId: admin.userId,
      organizationId: otherOrgId,
      role: "member",
      displayName: "Other Org Agent",
      username: admin.username,
    });

    // Upload via the first org → uploaded_by = first org's humanAgent.
    const first = await postAttachment(app, admin, Buffer.from("first"));
    expect(first.statusCode).toBe(201);
    expect((first.json() as { uploadedBy: string }).uploadedBy).toBe(admin.humanAgentUuid);

    // Upload via the second org → uploaded_by = second org's humanAgent.
    const second = await postAttachment(app, admin, Buffer.from("second"), { orgId: otherOrgId });
    expect(second.statusCode).toBe(201);
    expect((second.json() as { uploadedBy: string }).uploadedBy).toBe(otherMember.agentId);
  });
});
