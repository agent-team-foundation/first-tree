import { ATTACHMENT_FILENAME_HEADER, ATTACHMENT_MIME_HEADER, MAX_ATTACHMENT_BYTES } from "@first-tree/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { attachments } from "../db/schema/attachments.js";
import { members } from "../db/schema/members.js";
import { organizations } from "../db/schema/organizations.js";
import { createAgent } from "../services/agent.js";
import { createChat } from "../services/chat.js";
import { uuidv7 } from "../uuid.js";
import { createAdminContext, createTestAdmin, useTestApp } from "./helpers.js";

type Admin = Awaited<ReturnType<typeof createTestAdmin>>;

function postAttachment(
  app: FastifyInstance,
  caller: Admin,
  payload: Buffer,
  overrides: Partial<{ mime: string; filename: string; contentType: string }> = {},
) {
  return app.inject({
    method: "POST",
    url: "/api/v1/attachments",
    headers: {
      authorization: `Bearer ${caller.accessToken}`,
      "content-type": overrides.contentType ?? "application/octet-stream",
      [ATTACHMENT_MIME_HEADER]: overrides.mime ?? "image/png",
      [ATTACHMENT_FILENAME_HEADER]: overrides.filename ?? "test.png",
    },
    payload,
  });
}

function getAttachment(app: FastifyInstance, caller: Admin, id: string, chatId?: string) {
  const qs = chatId ? `?chatId=${encodeURIComponent(chatId)}` : "";
  return app.inject({
    method: "GET",
    url: `/api/v1/attachments/${id}${qs}`,
    headers: { authorization: `Bearer ${caller.accessToken}` },
  });
}

describe("attachments route — upload + auth + download", () => {
  const getApp = useTestApp();

  it("uploads then downloads via uploader (uploader-relation auth)", async () => {
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
      url: "/api/v1/attachments",
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

  it("stranger without chatId → 403; with chatId where they are a member → 200", async () => {
    const app = getApp();
    const uploader = await createAdminContext(app, { username: `up-${crypto.randomUUID().slice(0, 6)}` });
    const stranger = await createAdminContext(app, { username: `st-${crypto.randomUUID().slice(0, 6)}` });

    const bytes = Buffer.from("share");
    const upload = await postAttachment(app, uploader, bytes);
    const id = (upload.json() as { id: string }).id;

    // No chatId: stranger has no relation to uploader -> 403.
    const denied = await getAttachment(app, stranger, id);
    expect(denied.statusCode).toBe(403);

    // Create a chat that includes both uploader's human agent and stranger's
    // human agent; stranger now has chat-context access.
    const chat = await createChat(app.db, uploader.humanAgentUuid, {
      type: "group",
      participantIds: [stranger.humanAgentUuid],
    });

    const allowed = await getAttachment(app, stranger, id, chat.id);
    expect(allowed.statusCode).toBe(200);
    expect(allowed.rawPayload.equals(bytes)).toBe(true);
  });

  it("stranger with chatId they are not in → 403", async () => {
    const app = getApp();
    const uploader = await createAdminContext(app, { username: `up2-${crypto.randomUUID().slice(0, 6)}` });
    const stranger = await createAdminContext(app, { username: `st2-${crypto.randomUUID().slice(0, 6)}` });
    const bystander = await createAdminContext(app, { username: `by-${crypto.randomUUID().slice(0, 6)}` });

    const upload = await postAttachment(app, uploader, Buffer.from("private"));
    const id = (upload.json() as { id: string }).id;

    // Chat between uploader and bystander; stranger is not a member.
    const chat = await createChat(app.db, uploader.humanAgentUuid, {
      type: "group",
      participantIds: [bystander.humanAgentUuid],
    });

    const denied = await getAttachment(app, stranger, id, chat.id);
    expect(denied.statusCode).toBe(403);
  });

  it("multi-org caller without ?orgId → 400; with ?orgId → 201; with wrong orgId → 403", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `mo-${crypto.randomUUID().slice(0, 6)}` });

    // Seed a second org and add the caller as an active member with a
    // brand-new humanAgent. Now the user has 2 active memberships and the
    // upload route should refuse to pick.
    const otherOrgId = uuidv7();
    await app.db
      .insert(organizations)
      .values({ id: otherOrgId, name: otherOrgId.slice(0, 30), displayName: "Other Org" });

    const otherAgent = await createAgent(app.db, {
      name: `mo-agent-${crypto.randomUUID().slice(0, 6)}`,
      type: "human",
      displayName: "Other Org Agent",
      managerId: admin.memberId,
      organizationId: otherOrgId,
    });
    const otherMemberId = uuidv7();
    await app.db.insert(members).values({
      id: otherMemberId,
      userId: admin.userId,
      organizationId: otherOrgId,
      agentId: otherAgent.uuid,
      role: "member",
    });

    // No orgId on a multi-org caller → 400.
    const ambiguous = await postAttachment(app, admin, Buffer.from("multi"));
    expect(ambiguous.statusCode).toBe(400);

    // With orgId pointing at the second org → 201, uploaded_by is that
    // org's humanAgentId (not the first one).
    const targeted = await app.inject({
      method: "POST",
      url: `/api/v1/attachments?orgId=${encodeURIComponent(otherOrgId)}`,
      headers: {
        authorization: `Bearer ${admin.accessToken}`,
        "content-type": "application/octet-stream",
        [ATTACHMENT_MIME_HEADER]: "image/png",
        [ATTACHMENT_FILENAME_HEADER]: "x.png",
      },
      payload: Buffer.from("ok"),
    });
    expect(targeted.statusCode).toBe(201);
    expect((targeted.json() as { uploadedBy: string }).uploadedBy).toBe(otherAgent.uuid);

    // With an orgId the caller is not a member of → 403.
    const wrongOrgId = uuidv7();
    await app.db
      .insert(organizations)
      .values({ id: wrongOrgId, name: wrongOrgId.slice(0, 30), displayName: "Wrong Org" });
    const wrong = await app.inject({
      method: "POST",
      url: `/api/v1/attachments?orgId=${encodeURIComponent(wrongOrgId)}`,
      headers: {
        authorization: `Bearer ${admin.accessToken}`,
        "content-type": "application/octet-stream",
        [ATTACHMENT_MIME_HEADER]: "image/png",
        [ATTACHMENT_FILENAME_HEADER]: "x.png",
      },
      payload: Buffer.from("ok"),
    });
    expect(wrong.statusCode).toBe(403);
  });

  it("multi-org uploader downloads own attachment without chatId (manager-join self-resolution)", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `mos-${crypto.randomUUID().slice(0, 6)}` });

    // Second org + a brand-new humanAgent for the same user. Now the caller
    // has 2 active memberships, so the download-path `resolveCallerHumanAgentId`
    // (LIMIT 1, no ORDER BY) may pick *either* humanAgentId.
    const otherOrgId = uuidv7();
    await app.db
      .insert(organizations)
      .values({ id: otherOrgId, name: otherOrgId.slice(0, 30), displayName: "Other Org" });
    const otherAgent = await createAgent(app.db, {
      name: `mos-agent-${crypto.randomUUID().slice(0, 6)}`,
      type: "human",
      displayName: "Other Org Agent",
      managerId: admin.memberId,
      organizationId: otherOrgId,
    });
    await app.db.insert(members).values({
      id: uuidv7(),
      userId: admin.userId,
      organizationId: otherOrgId,
      agentId: otherAgent.uuid,
      role: "member",
    });

    // Upload pinned to the second org → uploaded_by = otherAgent.uuid.
    const bytes = Buffer.from("self-multi-org");
    const upload = await app.inject({
      method: "POST",
      url: `/api/v1/attachments?orgId=${encodeURIComponent(otherOrgId)}`,
      headers: {
        authorization: `Bearer ${admin.accessToken}`,
        "content-type": "application/octet-stream",
        [ATTACHMENT_MIME_HEADER]: "image/png",
        [ATTACHMENT_FILENAME_HEADER]: "self.png",
      },
      payload: bytes,
    });
    expect(upload.statusCode).toBe(201);
    const id = (upload.json() as { id: string }).id;

    // Download with no chatId. Even when the picked humanAgentId differs from
    // uploaded_by, the manager-join falls back on userId (human agents
    // self-manage), so the uploader still gets their own bytes.
    const download = await getAttachment(app, admin, id);
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload.equals(bytes)).toBe(true);
  });

  it("manager of uploading agent has uploader-relation access", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `mgr-${crypto.randomUUID().slice(0, 6)}` });

    // Create a non-human agent the admin manages; simulate it uploading by
    // writing the row directly with `uploaded_by = agent.uuid`.
    const subAgent = await createAgent(app.db, {
      name: `sub-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Sub Agent",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });

    const bytes = Buffer.from("by-sub");
    const id = crypto.randomUUID();
    await app.db.insert(attachments).values({
      id,
      mimeType: "text/plain",
      filename: "x.txt",
      sizeBytes: bytes.byteLength,
      data: bytes,
      uploadedBy: subAgent.uuid,
    });

    // Sanity — the row landed.
    const [row] = await app.db.select().from(attachments).where(eq(attachments.id, id)).limit(1);
    expect(row?.uploadedBy).toBe(subAgent.uuid);

    // Admin is the agent's manager, so download succeeds without chatId.
    const reply = await getAttachment(app, admin, id);
    expect(reply.statusCode).toBe(200);
    expect(reply.rawPayload.equals(bytes)).toBe(true);
  });
});
