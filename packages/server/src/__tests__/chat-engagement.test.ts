import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createMeChat } from "../services/me-chat.js";
import { createTestAdmin, createTestAgent, useTestApp } from "./helpers.js";

describe("POST /chats/:chatId/engagement", () => {
  const getApp = useTestApp();

  it("transitions active → archived → active → deleted → active (Restore)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: "eng-peer-1" });

    const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });

    for (const status of ["archived", "active", "deleted", "active"] as const) {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/chats/${encodeURIComponent(chatId)}/engagement`,
        headers: { authorization: `Bearer ${admin.accessToken}` },
        payload: { status },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ engagementStatus: string }>();
      expect(body.engagementStatus).toBe(status);

      const [row] = await app.db.execute<{ engagement_status: string }>(
        sql`SELECT engagement_status FROM chat_participants WHERE chat_id = ${chatId} AND agent_id = ${admin.humanAgentUuid}`,
      );
      expect(row?.engagement_status).toBe(status);
    }
  });

  it("GET /chats/:chatId returns caller engagement state", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: "eng-peer-get" });

    const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });

    // Default is active.
    let res = await app.inject({
      method: "GET",
      url: `/api/v1/chats/${encodeURIComponent(chatId)}`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ engagementStatus: string | null }>().engagementStatus).toBe("active");

    await app.inject({
      method: "POST",
      url: `/api/v1/chats/${encodeURIComponent(chatId)}/engagement`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { status: "archived" },
    });

    res = await app.inject({
      method: "GET",
      url: `/api/v1/chats/${encodeURIComponent(chatId)}`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.json<{ engagementStatus: string | null }>().engagementStatus).toBe("archived");
  });

  it("rejects invalid status payload with 400", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: "eng-peer-bad" });

    const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/chats/${encodeURIComponent(chatId)}/engagement`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { status: "nope" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("non-member caller gets 404 (anti-enumeration)", async () => {
    const app = getApp();
    const ownerSide = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: "eng-peer-iso" });
    const outsider = await createTestAdmin(app); // separate org

    const { chatId } = await createMeChat(app.db, ownerSide.humanAgentUuid, ownerSide.organizationId, {
      participantIds: [peer.agent.uuid],
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/chats/${encodeURIComponent(chatId)}/engagement`,
      headers: { authorization: `Bearer ${outsider.accessToken}` },
      payload: { status: "archived" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("per-user isolation: A's archive does not touch other participants' rows", async () => {
    const app = getApp();
    const a = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: "eng-peer-iso2" });

    const { chatId } = await createMeChat(app.db, a.humanAgentUuid, a.organizationId, {
      participantIds: [peer.agent.uuid],
    });

    // A archives. Peer's row should remain 'active' — engagement state is
    // per (chat, user) and one user's transition never leaks across rows.
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/chats/${encodeURIComponent(chatId)}/engagement`,
      headers: { authorization: `Bearer ${a.accessToken}` },
      payload: { status: "archived" },
    });
    expect(res.statusCode).toBe(200);

    const [rowA] = await app.db.execute<{ engagement_status: string }>(
      sql`SELECT engagement_status FROM chat_participants WHERE chat_id = ${chatId} AND agent_id = ${a.humanAgentUuid}`,
    );
    const [rowPeer] = await app.db.execute<{ engagement_status: string }>(
      sql`SELECT engagement_status FROM chat_participants WHERE chat_id = ${chatId} AND agent_id = ${peer.agent.uuid}`,
    );
    expect(rowA?.engagement_status).toBe("archived");
    expect(rowPeer?.engagement_status).toBe("active");
  });
});
