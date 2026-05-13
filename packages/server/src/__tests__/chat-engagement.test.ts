/**
 * HTTP-level tests for per-(chat, user) engagement state.
 *
 * Engagement lives on `chat_user_state.engagement_status` (one row per
 * (chat_id, agent_id)). The HTTP surface is:
 *   - `GET  /api/v1/chats/:chatId`         → exposes caller's engagement
 *   - `POST /api/v1/chats/:chatId/engagement` → write transition
 *
 * Verifies:
 *   1. State machine: active → archived → active → deleted → active
 *      (the latter being the Restore path from the chat detail page).
 *   2. `GET` reports the caller's engagement (defaults to `'active'`
 *      when no `chat_user_state` row exists yet — lazy materialisation).
 *   3. Schema rejects invalid status payloads with 400.
 *   4. Non-member callers get 404 (anti-enumeration via requireChatAccess).
 *   5. Per-user isolation — one user's transition never bleeds into
 *      another participant's row.
 */

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
        sql`SELECT engagement_status FROM chat_user_state
             WHERE chat_id = ${chatId} AND agent_id = ${admin.humanAgentUuid}`,
      );
      expect(row?.engagement_status).toBe(status);
    }
  });

  it("GET /chats/:chatId returns caller engagement (defaults to 'active' before any write)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: "eng-peer-get" });

    const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });

    // No chat_user_state row written yet — lazy default is 'active'.
    let res = await app.inject({
      method: "GET",
      url: `/api/v1/chats/${encodeURIComponent(chatId)}`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ engagementStatus: string }>().engagementStatus).toBe("active");

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
    expect(res.json<{ engagementStatus: string }>().engagementStatus).toBe("archived");
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

  it("non-member caller gets 404 (anti-enumeration via requireChatAccess)", async () => {
    const app = getApp();
    const ownerSide = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: "eng-peer-iso" });
    const outsider = await createTestAdmin(app);

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

    // A archives. Peer's engagement should remain implicit 'active' — and
    // because peer never wrote engagement, peer's chat_user_state row may
    // not exist at all (lazy materialisation). Either way, A's row alone
    // carries the 'archived' marker.
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/chats/${encodeURIComponent(chatId)}/engagement`,
      headers: { authorization: `Bearer ${a.accessToken}` },
      payload: { status: "archived" },
    });
    expect(res.statusCode).toBe(200);

    const [rowA] = await app.db.execute<{ engagement_status: string }>(
      sql`SELECT engagement_status FROM chat_user_state
           WHERE chat_id = ${chatId} AND agent_id = ${a.humanAgentUuid}`,
    );
    expect(rowA?.engagement_status).toBe("archived");

    // Peer's lazy row should be absent or still 'active' — never carry A's transition.
    const peerRows = await app.db.execute<{ engagement_status: string }>(
      sql`SELECT engagement_status FROM chat_user_state
           WHERE chat_id = ${chatId} AND agent_id = ${peer.agent.uuid}`,
    );
    if (peerRows.length > 0) {
      expect(peerRows[0]?.engagement_status).toBe("active");
    }
  });
});
