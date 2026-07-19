import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { messages } from "../db/schema/messages.js";
import { createAgent } from "../services/agent.js";
import { createMeChat, pinMeChat } from "../services/me-chat.js";
import { sendMessage } from "../services/message.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

/**
 * Wire-level end-to-end coverage for the live-activity field exposed by
 * `GET /orgs/:orgId/chats?scope=mine`. The pure service-level invariants
 * live in `me-chat-activity.test.ts`; this file pins the HTTP shape (Fastify
 * response serialisation does not strip the field) and the cross-user /
 * cross-org isolation that was the original #366 / #367 motivator.
 */

describe("GET /orgs/:orgId/chats — liveActivity wire shape", () => {
  const getApp = useTestApp();

  async function setSessionState(db: ReturnType<typeof getApp>["db"], agentId: string, chatId: string, state: string) {
    // Per #553 rebase: liveActivity rides on composite working; working is
    // gated by per-chat runtime_state='working' + fresh stamp (the new
    // authoritative D-axis). Real clients always emit `session:runtime
    // working` right after `session:state active`; tests mirror that wire
    // order by seeding both fields together when state='active'. State
    // transitions to suspended/errored keep their stale runtime — that
    // matches what the suspend / errored paths look like in production.
    await db.execute(sql`
      INSERT INTO agent_chat_sessions (agent_id, chat_id, state, runtime_state, runtime_state_at, updated_at)
      VALUES (
        ${agentId}, ${chatId}, ${state},
        CASE WHEN ${state} = 'active' THEN 'working' ELSE 'idle' END,
        CASE WHEN ${state} = 'active' THEN NOW() ELSE NULL END,
        NOW()
      )
      ON CONFLICT (agent_id, chat_id) DO UPDATE
        SET state = EXCLUDED.state,
            runtime_state = EXCLUDED.runtime_state,
            runtime_state_at = EXCLUDED.runtime_state_at
    `);
  }

  async function appendEvent(
    db: ReturnType<typeof getApp>["db"],
    agentId: string,
    chatId: string,
    kind: string,
    payload: unknown,
  ) {
    const id = crypto.randomUUID();
    await db.execute(sql`
      INSERT INTO session_events (id, agent_id, chat_id, seq, kind, payload, created_at)
      SELECT ${id}, ${agentId}, ${chatId},
             COALESCE(MAX(seq), 0) + 1, ${kind}, ${JSON.stringify(payload)}::jsonb, NOW()
        FROM session_events
       WHERE agent_id = ${agentId} AND chat_id = ${chatId}
    `);
  }

  it("response payload exposes liveActivity with the correct types (and no engaged/working fields)", async () => {
    const app = getApp();
    const alice = await createTestAdmin(app);
    const peer = await createAgent(app.db, {
      name: `e2e-peer-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "E2E Peer",
      managerId: alice.memberId,
      organizationId: alice.organizationId,
    });

    const { chatId } = await createMeChat(app.db, alice.humanAgentUuid, alice.organizationId, {
      participantIds: [peer.uuid],
    });
    await setSessionState(app.db, peer.uuid, chatId, "active");
    await appendEvent(app.db, peer.uuid, chatId, "tool_call", {
      toolUseId: "t1",
      name: "Bash",
      args: {},
      status: "pending",
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${encodeURIComponent(alice.organizationId)}/chats`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ rows: Array<Record<string, unknown>> }>();
    const row = body.rows.find((r) => r.chatId === chatId);
    expect(row, "chat row should be present in the response").toBeDefined();

    // 1. The legacy per-agent ring fields are GONE — `liveActivity` presence is
    //    the only working signal the chat list consumes.
    expect(row).not.toHaveProperty("workingAgentIds");
    expect(row).not.toHaveProperty("engagedAgentIds");

    // 2. liveActivity is a structured object with the documented fields.
    expect(row?.liveActivity).toMatchObject({
      agentId: peer.uuid,
      kind: "tool_call",
      label: "Bash",
    });
    expect(typeof (row?.liveActivity as { startedAt: unknown }).startedAt).toBe("string");
  });

  // Codex-class regression: per-(agent,chat) `runtime_state='working'` MUST
  // light busyAgentIds even when the runtime emits zero session_events
  // (codex-only-emits-on-completion case). `liveActivity` alone — the legacy
  // freshness proxy — would miss this.
  it("codex no-events: working runtime_state lights busyAgentIds without a liveActivity", async () => {
    const app = getApp();
    const alice = await createTestAdmin(app);
    const peer = await createAgent(app.db, {
      name: `e2e-codex-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Codex Peer",
      managerId: alice.memberId,
      organizationId: alice.organizationId,
    });
    const { chatId } = await createMeChat(app.db, alice.humanAgentUuid, alice.organizationId, {
      participantIds: [peer.uuid],
    });
    // session=active + runtime=working stamped fresh — but NO session_events.
    await setSessionState(app.db, peer.uuid, chatId, "active");

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${encodeURIComponent(alice.organizationId)}/chats`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const row = res.json<{ rows: Array<Record<string, unknown>> }>().rows.find((r) => r.chatId === chatId);
    expect(row?.busyAgentIds).toEqual([peer.uuid]);
    // No events emitted yet → no live description; UI renders a generic
    // "Working" chip from busyAgentIds alone.
    expect(row?.liveActivity).toBeNull();
  });

  it("idle session → liveActivity null", async () => {
    const app = getApp();
    const alice = await createTestAdmin(app);
    const peer = await createAgent(app.db, {
      name: `e2e-idle-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Idle Peer",
      managerId: alice.memberId,
      organizationId: alice.organizationId,
    });
    const { chatId } = await createMeChat(app.db, alice.humanAgentUuid, alice.organizationId, {
      participantIds: [peer.uuid],
    });
    // No agent_chat_sessions row, no session_events.

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${encodeURIComponent(alice.organizationId)}/chats`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const row = res.json<{ rows: Array<Record<string, unknown>> }>().rows.find((r) => r.chatId === chatId);
    expect(row?.liveActivity).toBeNull();
  });

  it("turn_end → liveActivity null", async () => {
    const app = getApp();
    const alice = await createTestAdmin(app);
    const peer = await createAgent(app.db, {
      name: `e2e-end-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Ended Peer",
      managerId: alice.memberId,
      organizationId: alice.organizationId,
    });
    const { chatId } = await createMeChat(app.db, alice.humanAgentUuid, alice.organizationId, {
      participantIds: [peer.uuid],
    });
    await setSessionState(app.db, peer.uuid, chatId, "active");
    await appendEvent(app.db, peer.uuid, chatId, "tool_call", {
      toolUseId: "t1",
      name: "Read",
      args: {},
      status: "ok",
    });
    await appendEvent(app.db, peer.uuid, chatId, "turn_end", { status: "success" });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${encodeURIComponent(alice.organizationId)}/chats`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    const row = res.json<{ rows: Array<Record<string, unknown>> }>().rows.find((r) => r.chatId === chatId);
    // Live indicator: terminal event → no chip (the session lifecycle stays
    // active, but the chat list only consumes liveActivity presence now).
    expect(row?.liveActivity).toBeNull();
  });
});

describe("GET/POST /chats/:chatId resource routes", () => {
  const getApp = useTestApp();

  it("returns watcher membership kind on chat detail for supervised chats", async () => {
    const app = getApp();
    const manager = await createTestAdmin(app);
    const peer = await createTestAdmin(app);
    const managed = await createAgent(app.db, {
      name: `detail-managed-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Detail Managed",
      managerId: manager.memberId,
      organizationId: manager.organizationId,
    });
    const { chatId } = await createMeChat(app.db, peer.humanAgentUuid, peer.organizationId, {
      participantIds: [managed.uuid],
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/chats/${chatId}`,
      headers: { authorization: `Bearer ${manager.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ viewerMembershipKind: string | null }>().viewerMembershipKind).toBe("watching");
  });

  it("exercises token usage, github entity list, unread, participant add, workspace leave, and message pagination", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const peerA = await createAgent(app.db, {
      name: `route-peer-a-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Route Peer A",
      managerId: admin.memberId,
      organizationId: admin.organizationId,
    });
    const peerB = await createAgent(app.db, {
      name: `route-peer-b-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Route Peer B",
      managerId: admin.memberId,
      organizationId: admin.organizationId,
    });
    const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peerA.uuid],
    });
    const firstMessage = await sendMessage(
      app.db,
      chatId,
      admin.humanAgentUuid,
      { source: "api", format: "text", content: "first route message" },
      { allowRecipientlessSend: true },
    );
    const secondMessage = await sendMessage(
      app.db,
      chatId,
      admin.humanAgentUuid,
      { source: "api", format: "text", content: "second route message" },
      { allowRecipientlessSend: true },
    );
    await app.db
      .update(messages)
      .set({ createdAt: sql`${"2026-07-17T09:00:00.123900Z"}::timestamptz` })
      .where(eq(messages.id, firstMessage.message.id));
    await app.db
      .update(messages)
      .set({ createdAt: sql`${"2026-07-17T09:00:00.123800Z"}::timestamptz` })
      .where(eq(messages.id, secondMessage.message.id));

    const headers = { authorization: `Bearer ${admin.accessToken}` };
    const tokenUsage = await app.inject({ method: "GET", url: `/api/v1/chats/${chatId}/token-usage`, headers });
    expect(tokenUsage.statusCode).toBe(200);

    const githubEntities = await app.inject({ method: "GET", url: `/api/v1/chats/${chatId}/github-entities`, headers });
    expect(githubEntities.statusCode).toBe(200);
    expect(githubEntities.json<{ items: unknown[] }>().items).toEqual([]);

    const unfollowMissing = await app.inject({
      method: "DELETE",
      url: `/api/v1/chats/${chatId}/github-entities`,
      headers,
    });
    expect(unfollowMissing.statusCode).toBe(400);
    const unfollow = await app.inject({
      method: "DELETE",
      url: `/api/v1/chats/${chatId}/github-entities?entity=${encodeURIComponent("owner/repo#1")}`,
      headers,
    });
    expect(unfollow.statusCode).toBe(200);
    expect(unfollow.json<{ removed: number }>().removed).toBe(0);

    const unread = await app.inject({ method: "POST", url: `/api/v1/chats/${chatId}/unread`, headers });
    expect(unread.statusCode).toBe(200);
    expect(unread.json<{ unreadMentionCount: number }>().unreadMentionCount).toBe(1);

    const addParticipant = await app.inject({
      method: "POST",
      url: `/api/v1/chats/${chatId}/participants`,
      headers,
      payload: { participantIds: [peerB.uuid] },
    });
    expect(addParticipant.statusCode).toBe(204);

    const page1 = await app.inject({ method: "GET", url: `/api/v1/chats/${chatId}/messages?limit=1`, headers });
    expect(page1.statusCode).toBe(200);
    const page1Body = page1.json<{ items: Array<{ id: string; createdAt: string }>; nextCursor: string | null }>();
    expect(page1Body.items).toHaveLength(1);
    expect(page1Body.nextCursor).toBeTruthy();

    const page2 = await app.inject({
      method: "GET",
      url: `/api/v1/chats/${chatId}/messages?limit=1&cursor=${encodeURIComponent(page1Body.nextCursor ?? "")}`,
      headers,
    });
    expect(page2.statusCode).toBe(200);
    const page2Body = page2.json<{ items: Array<{ id: string }> }>();
    expect(page2Body.items).toHaveLength(1);
    expect(page2Body.items[0]?.id).not.toBe(page1Body.items[0]?.id);

    const leave = await app.inject({ method: "POST", url: `/api/v1/chats/${chatId}/workspace-leave`, headers });
    expect(leave.statusCode).toBe(200);
    expect(leave.json<{ chatId: string }>().chatId).toBe(chatId);
  });
});

describe("cross-user isolation — the original #366 / #367 bug scenario", () => {
  const getApp = useTestApp();

  async function setSessionState(db: ReturnType<typeof getApp>["db"], agentId: string, chatId: string, state: string) {
    // Per #553 rebase: liveActivity rides on composite working; working is
    // gated by per-chat runtime_state='working' + fresh stamp (the new
    // authoritative D-axis). Real clients always emit `session:runtime
    // working` right after `session:state active`; tests mirror that wire
    // order by seeding both fields together when state='active'. State
    // transitions to suspended/errored keep their stale runtime — that
    // matches what the suspend / errored paths look like in production.
    await db.execute(sql`
      INSERT INTO agent_chat_sessions (agent_id, chat_id, state, runtime_state, runtime_state_at, updated_at)
      VALUES (
        ${agentId}, ${chatId}, ${state},
        CASE WHEN ${state} = 'active' THEN 'working' ELSE 'idle' END,
        CASE WHEN ${state} = 'active' THEN NOW() ELSE NULL END,
        NOW()
      )
      ON CONFLICT (agent_id, chat_id) DO UPDATE
        SET state = EXCLUDED.state,
            runtime_state = EXCLUDED.runtime_state,
            runtime_state_at = EXCLUDED.runtime_state_at
    `);
  }
  async function appendEvent(
    db: ReturnType<typeof getApp>["db"],
    agentId: string,
    chatId: string,
    kind: string,
    payload: unknown,
  ) {
    const id = crypto.randomUUID();
    await db.execute(sql`
      INSERT INTO session_events (id, agent_id, chat_id, seq, kind, payload, created_at)
      SELECT ${id}, ${agentId}, ${chatId},
             COALESCE(MAX(seq), 0) + 1, ${kind}, ${JSON.stringify(payload)}::jsonb, NOW()
        FROM session_events
       WHERE agent_id = ${agentId} AND chat_id = ${chatId}
    `);
  }

  it("two humans talking to the SAME agent see ring/chip ONLY on the chat actually being worked on", async () => {
    // This is the failure mode #366 commit message described:
    //   "an agent running in any chat appears here for every chat
    //    they speak in."
    // With the new derivation (agent_chat_sessions.state per-(agent,chat) +
    // session_events per-(agent,chat)), Alice working with Nova in her
    // chat must NOT light up Bob's chat with Nova.
    const app = getApp();

    // Two members of the same default org — the helper plops both onto it.
    const alice = await createTestAdmin(app);
    const bob = await createTestAdmin(app);
    expect(alice.organizationId, "alice + bob share an org for this test").toBe(bob.organizationId);
    const orgId = alice.organizationId;
    const bobHumanId = bob.humanAgentUuid;
    const bobToken = bob.accessToken;

    // Nova — single shared agent.
    const nova = await createAgent(app.db, {
      name: `nova-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Nova",
      managerId: alice.memberId,
      organizationId: orgId,
    });

    // Alice ↔ Nova and Bob ↔ Nova: two distinct direct chats.
    const aliceChat = await createMeChat(app.db, alice.humanAgentUuid, orgId, { participantIds: [nova.uuid] });
    const bobChat = await createMeChat(app.db, bobHumanId, orgId, { participantIds: [nova.uuid] });

    // Nova is actively working IN ALICE'S CHAT ONLY.
    await setSessionState(app.db, nova.uuid, aliceChat.chatId, "active");
    await setSessionState(app.db, nova.uuid, bobChat.chatId, "suspended");
    await appendEvent(app.db, nova.uuid, aliceChat.chatId, "tool_call", {
      toolUseId: "x",
      name: "Edit",
      args: {},
      status: "pending",
    });
    // No events at all for Bob's chat with Nova.

    // Alice's chat list — Nova's chat should light up the live activity.
    const aliceRes = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${encodeURIComponent(orgId)}/chats`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    const aliceRow = aliceRes
      .json<{ rows: Array<Record<string, unknown>> }>()
      .rows.find((r) => r.chatId === aliceChat.chatId);
    expect((aliceRow?.liveActivity as { label?: string })?.label, "Alice's row: live label").toBe("Edit");

    // Bob's chat list — Nova's chat must NOT light up.
    const bobRes = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${encodeURIComponent(orgId)}/chats`,
      headers: { authorization: `Bearer ${bobToken}` },
    });
    const bobRow = bobRes
      .json<{ rows: Array<Record<string, unknown>> }>()
      .rows.find((r) => r.chatId === bobChat.chatId);
    expect(bobRow?.liveActivity, "Bob's row: no live activity").toBeNull();
  });

  it("wire response carries priorityRows (Fastify serializes the new field)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const agent = await createAgent(app.db, {
      name: `prio-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Prio Agent",
      managerId: admin.memberId,
      organizationId: admin.organizationId,
    });

    const pinned = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [agent.uuid],
    });
    await pinMeChat(app.db, pinned.chatId, admin.humanAgentUuid, true);

    const request = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [agent.uuid],
    });
    await sendMessage(app.db, request.chatId, agent.uuid, {
      source: "api",
      format: "request",
      content: "please look",
      metadata: { mentions: [admin.humanAgentUuid] },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${encodeURIComponent(admin.organizationId)}/chats`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      priorityRows: { attention: Array<{ chatId: string }>; pinned: Array<{ chatId: string }> };
      rows: Array<{ chatId: string }>;
    }>();

    // The route has no Fastify response schema, so priorityRows must survive the
    // default serializer end-to-end (the failure mode that would strip it).
    expect(body.priorityRows.attention.some((r) => r.chatId === request.chatId)).toBe(true);
    expect(body.priorityRows.pinned.some((r) => r.chatId === pinned.chatId)).toBe(true);
  });
});
