/**
 * HTTP-level tests for `POST /api/v1/chats/:chatId/pin` (per-user pin route).
 *
 * Class C route — `docs/development/http-path-conventions.md` requires
 * multi-org / access coverage. Verifies:
 *   1. Success: pin → 200 + non-null pinnedAt; unpin → 200 + null.
 *   2. Invalid payload → 400 (pinMeChatSchema).
 *   3. A watcher (supervisor of a non-human speaker) can pin — pin is not
 *      speaker-gated, matching requireChatAccess.
 *   4. A caller without chat access (different org) → 404 (anti-enumeration).
 */

import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chats } from "../db/schema/chats.js";
import { organizations } from "../db/schema/organizations.js";
import { createAgent } from "../services/agent.js";
import { createMeChat } from "../services/me-chat.js";
import { createTestAdmin, createTestAgent, useTestApp } from "./helpers.js";

describe("POST /chats/:chatId/pin", () => {
  const getApp = useTestApp();

  it("pins then unpins for the caller (200 + persisted pinnedAt)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: "pin-peer-1" });
    const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });

    const pinRes = await app.inject({
      method: "POST",
      url: `/api/v1/chats/${encodeURIComponent(chatId)}/pin`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { pinned: true },
    });
    expect(pinRes.statusCode).toBe(200);
    expect(pinRes.json<{ chatId: string; pinnedAt: string | null }>().pinnedAt).not.toBeNull();

    const unpinRes = await app.inject({
      method: "POST",
      url: `/api/v1/chats/${encodeURIComponent(chatId)}/pin`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { pinned: false },
    });
    expect(unpinRes.statusCode).toBe(200);
    expect(unpinRes.json<{ pinnedAt: string | null }>().pinnedAt).toBeNull();
  });

  it("rejects an invalid payload with 400", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: "pin-peer-bad" });
    const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/chats/${encodeURIComponent(chatId)}/pin`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { pinned: "yes" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("lets a watcher (supervisor of a speaker) pin", async () => {
    const app = getApp();
    const manager = await createTestAdmin(app);
    const peer = await createTestAdmin(app);
    const managed = await createAgent(app.db, {
      name: `pin-managed-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Pin Managed",
      managerId: manager.memberId,
      organizationId: manager.organizationId,
    });
    // `peer` opens a chat with the managed agent; `manager` supervises it as a watcher.
    const { chatId } = await createMeChat(app.db, peer.humanAgentUuid, peer.organizationId, {
      participantIds: [managed.uuid],
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/chats/${encodeURIComponent(chatId)}/pin`,
      headers: { authorization: `Bearer ${manager.accessToken}` },
      payload: { pinned: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ pinnedAt: string | null }>().pinnedAt).not.toBeNull();
  });

  it("returns 404 for a same-org caller who is not a chat member (anti-enumeration)", async () => {
    const app = getApp();
    const ownerSide = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: "pin-peer-iso" });
    const outsider = await createTestAdmin(app);
    const { chatId } = await createMeChat(app.db, ownerSide.humanAgentUuid, ownerSide.organizationId, {
      participantIds: [peer.agent.uuid],
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/chats/${encodeURIComponent(chatId)}/pin`,
      headers: { authorization: `Bearer ${outsider.accessToken}` },
      payload: { pinned: true },
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 404 for a caller in a different organization (cross-org boundary)", async () => {
    const app = getApp();
    const caller = await createTestAdmin(app); // default org

    // A genuinely separate organization B, with its own agent + a chat that
    // lives entirely in B (valid org/agent/participant records). The caller has
    // no membership in B, so requireChatAccess resolves the chat's org (B) and
    // the cross-org `resolveCallerInOrg` branch rejects with 404.
    const orgB = `org-pin-${crypto.randomUUID().slice(0, 6)}`;
    await app.db.insert(organizations).values({ id: orgB, name: orgB.slice(0, 30), displayName: "Org B" });
    const botUuid = crypto.randomUUID();
    await app.db.insert(agents).values({
      uuid: botUuid,
      name: `bot-b-${crypto.randomUUID().slice(0, 6)}`,
      organizationId: orgB,
      type: "agent",
      displayName: "Bot B",
      inboxId: `inbox_${botUuid}`,
      // FK is unconstrained across orgs in the schema; mirrors the cross-org
      // pollution suite's convention for building a side-org agent cheaply.
      managerId: caller.memberId,
    });
    const chatIdB = crypto.randomUUID();
    await app.db.insert(chats).values({ id: chatIdB, organizationId: orgB, type: "direct" });
    await app.db
      .insert(chatMembership)
      .values({ chatId: chatIdB, agentId: botUuid, role: "member", accessMode: "speaker" });

    expect(caller.organizationId).not.toBe(orgB);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/chats/${encodeURIComponent(chatIdB)}/pin`,
      headers: { authorization: `Bearer ${caller.accessToken}` },
      payload: { pinned: true },
    });
    expect(res.statusCode).toBe(404);
  });
});
