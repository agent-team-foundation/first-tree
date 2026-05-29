import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { chats } from "../db/schema/chats.js";
import { messages } from "../db/schema/messages.js";
import { uuidv7 } from "../uuid.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

/**
 * Phase 2 lightweight Team features:
 *   - `PATCH /me/profile` self-service display-name edit (role is never editable).
 *   - Member `lastActiveAt` derived from the most recent message (口径 B), no column.
 */
describe("PATCH /me/profile", () => {
  const getApp = useTestApp();

  const listMembers = (app: FastifyInstance, admin: { organizationId: string; accessToken: string }) =>
    app.inject({
      method: "GET",
      url: `/api/v1/orgs/${admin.organizationId}/members`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });

  it("lets the caller rename themselves (mirrored to the member list)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `me-prof-${Date.now()}` });

    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/me/profile",
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { displayName: "Renamed Self" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ displayName: string }>().displayName).toBe("Renamed Self");

    const me = (await listMembers(app, admin))
      .json<Array<{ id: string; displayName: string }>>()
      .find((m) => m.id === admin.memberId);
    expect(me?.displayName).toBe("Renamed Self");
  });

  it("ignores a `role` field — self-edit can never change the caller's role", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `me-prof-role-${Date.now()}` });

    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/me/profile",
      headers: { authorization: `Bearer ${admin.accessToken}` },
      // role is not part of updateMyProfileSchema — zod strips it; the row stays admin.
      payload: { displayName: "Still Admin", role: "member" },
    });
    expect(res.statusCode).toBe(200);

    const me = (await listMembers(app, admin))
      .json<Array<{ id: string; role: string }>>()
      .find((m) => m.id === admin.memberId);
    expect(me?.role).toBe("admin");
  });

  it("rejects an empty display name", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `me-prof-empty-${Date.now()}` });
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/me/profile",
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { displayName: "" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("member lastActiveAt (derived from most recent message)", () => {
  const getApp = useTestApp();

  it("is null before any message and set after the member's agent sends one", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `me-active-${Date.now()}` });
    const list = () =>
      app.inject({
        method: "GET",
        url: `/api/v1/orgs/${admin.organizationId}/members`,
        headers: { authorization: `Bearer ${admin.accessToken}` },
      });

    const before = (await list())
      .json<Array<{ id: string; lastActiveAt: string | null }>>()
      .find((m) => m.id === admin.memberId);
    expect(before?.lastActiveAt).toBeNull();

    // Seed a chat + a message authored by this member's human agent.
    const chatId = uuidv7();
    await app.db.insert(chats).values({ id: chatId, organizationId: admin.organizationId, type: "group" });
    await app.db.insert(messages).values({
      id: uuidv7(),
      chatId,
      senderId: admin.humanAgentUuid,
      format: "text",
      content: "hello team",
      source: "web",
    });

    const after = (await list())
      .json<Array<{ id: string; lastActiveAt: string | null }>>()
      .find((m) => m.id === admin.memberId);
    expect(after?.lastActiveAt).not.toBeNull();
  });
});
