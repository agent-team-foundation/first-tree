import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { agentPresence } from "../db/schema/agent-presence.js";
import { chats } from "../db/schema/chats.js";
import { clients } from "../db/schema/clients.js";
import { members } from "../db/schema/members.js";
import { createAgent } from "../services/agent.js";
import { createMeChat, listMeChats, markMeChatRead, pinMeChat } from "../services/me-chat.js";
import { sendMessage } from "../services/message.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

/**
 * Server-side priority projection (PR3): `listMeChats` splits its result into
 * `priorityRows.attention` (a caller-managed speaker in `failed`, OR an open
 * request to the caller) → `priorityRows.pinned` (the caller's pins) → ordinary
 * `rows`, computed across the FULL matching set so a priority chat surfaces on
 * page 1 even when its `activity_at` would page it far down. Every chat appears
 * in exactly one group. Plus a page-independent `counts.unread` aggregate.
 */
describe("listMeChats — server priority projection (PR3)", () => {
  const getApp = useTestApp();

  type Admin = Awaited<ReturnType<typeof createTestAdmin>>;
  type ListResult = Awaited<ReturnType<typeof listMeChats>>;

  async function ownerUserId(app: FastifyInstance, owner: Admin): Promise<string> {
    const [m] = await app.db.select().from(members).where(eq(members.id, owner.memberId)).limit(1);
    if (!m) throw new Error("owner member missing");
    return m.userId;
  }

  /** A non-human agent the caller manages, pinned to a fresh connected client. */
  async function managedAgent(
    app: FastifyInstance,
    owner: Admin,
    name: string,
  ): Promise<{ uuid: string; clientId: string }> {
    const clientId = `cli-${crypto.randomUUID().slice(0, 8)}`;
    await app.db.insert(clients).values({
      id: clientId,
      userId: await ownerUserId(app, owner),
      organizationId: owner.organizationId,
      status: "connected",
    });
    const agent = await createAgent(app.db, {
      name,
      type: "agent",
      displayName: name,
      managerId: owner.memberId,
      organizationId: owner.organizationId,
      clientId,
    });
    if (!agent) throw new Error("managed agent setup failed");
    return { uuid: agent.uuid, clientId };
  }

  async function chatWith(app: FastifyInstance, owner: Admin, agentUuid: string, topic?: string): Promise<string> {
    const { chatId } = await createMeChat(app.db, owner.humanAgentUuid, owner.organizationId, {
      participantIds: [agentUuid],
      topic: topic ?? null,
    });
    return chatId;
  }

  /** Set a chat's `activity_at` directly so ordering across pages is deterministic. */
  async function setActivity(app: FastifyInstance, chatId: string, iso: string): Promise<void> {
    await app.db
      .update(chats)
      .set({ activityAt: new Date(iso) })
      .where(eq(chats.id, chatId));
  }

  /** Agent → human `request` message: bumps the human's open_request_count + unread mention. */
  async function raiseRequest(app: FastifyInstance, chatId: string, fromAgent: string, toHuman: string): Promise<void> {
    await sendMessage(app.db, chatId, fromAgent, {
      source: "api",
      format: "request",
      content: "Please look",
      metadata: { mentions: [toHuman] },
    });
  }

  /** Make a caller-managed speaker read `failed`: reachable (client presence) + session `errored`. */
  async function markFailed(app: FastifyInstance, agentUuid: string, clientId: string, chatId: string): Promise<void> {
    await app.db
      .insert(agentPresence)
      .values({ agentId: agentUuid, clientId, lastSeenAt: new Date(), activeSessions: 0, totalSessions: 0 })
      .onConflictDoUpdate({ target: [agentPresence.agentId], set: { clientId, lastSeenAt: new Date() } });
    await app.db.execute(sql`
      INSERT INTO agent_chat_sessions (agent_id, chat_id, state, runtime_state, updated_at)
      VALUES (${agentUuid}, ${chatId}, 'errored', 'idle', NOW())
      ON CONFLICT (agent_id, chat_id) DO UPDATE SET state = 'errored', updated_at = NOW()
    `);
  }

  function list(
    app: FastifyInstance,
    owner: Admin,
    query: Partial<Parameters<typeof listMeChats>[4]> = {},
  ): Promise<ListResult> {
    return listMeChats(app.db, owner.humanAgentUuid, owner.memberId, owner.organizationId, {
      limit: 50,
      filter: "all",
      engagement: "all",
      ...query,
    });
  }

  function groupOf(res: ListResult, chatId: string): "attention" | "pinned" | "rows" | null {
    if (res.priorityRows.attention.some((r) => r.chatId === chatId)) return "attention";
    if (res.priorityRows.pinned.some((r) => r.chatId === chatId)) return "pinned";
    if (res.rows.some((r) => r.chatId === chatId)) return "rows";
    return null;
  }

  it("pinned chats surface in priorityRows.pinned (pinned_at DESC) and drop out of ordinary rows", async () => {
    const app = getApp();
    const owner = await createTestAdmin(app);
    const peer = await managedAgent(app, owner, "pin-peer");

    const first = await chatWith(app, owner, peer.uuid, "first");
    const second = await chatWith(app, owner, peer.uuid, "second");
    await pinMeChat(app.db, first, owner.humanAgentUuid, true);
    // Later pin → sorts ahead (pinned_at DESC).
    await pinMeChat(app.db, second, owner.humanAgentUuid, true);

    const res = await list(app, owner);
    expect(res.priorityRows.pinned.map((r) => r.chatId)).toEqual([second, first]);
    // Not duplicated in ordinary rows.
    expect(res.rows.some((r) => r.chatId === first || r.chatId === second)).toBe(false);
  });

  it("pinned extraction is global — a low-activity pinned chat appears on page 1 despite paging", async () => {
    const app = getApp();
    const owner = await createTestAdmin(app);
    const peer = await managedAgent(app, owner, "global-peer");

    // Four fresh ordinary chats + one OLD pinned chat that would page far down.
    const ordinary: string[] = [];
    for (let i = 0; i < 4; i++) {
      const c = await chatWith(app, owner, peer.uuid, `ordinary-${i}`);
      await setActivity(app, c, `2026-06-0${i + 1}T00:00:00.000Z`);
      ordinary.push(c);
    }
    const oldPinned = await chatWith(app, owner, peer.uuid, "old-pinned");
    await setActivity(app, oldPinned, "2020-01-01T00:00:00.000Z");
    await pinMeChat(app.db, oldPinned, owner.humanAgentUuid, true);

    const page1 = await list(app, owner, { limit: 2 });
    // The old pinned chat is on page 1's priority group even though its activity
    // would put it dead last in the ordinary stream.
    expect(page1.priorityRows.pinned.map((r) => r.chatId)).toEqual([oldPinned]);
    expect(page1.rows.some((r) => r.chatId === oldPinned)).toBe(false);
    // Ordinary page still returns the freshest 2 ordinary chats.
    expect(page1.rows.map((r) => r.chatId)).toEqual([ordinary[3], ordinary[2]]);
    expect(page1.nextCursor).not.toBeNull();
  });

  it("an open request routes the chat into priorityRows.attention, not ordinary rows", async () => {
    const app = getApp();
    const owner = await createTestAdmin(app);
    const peer = await managedAgent(app, owner, "req-peer");

    const chatId = await chatWith(app, owner, peer.uuid);
    await raiseRequest(app, chatId, peer.uuid, owner.humanAgentUuid);

    const res = await list(app, owner);
    expect(groupOf(res, chatId)).toBe("attention");
    const row = res.priorityRows.attention.find((r) => r.chatId === chatId);
    expect(row?.openRequestCount).toBe(1);
  });

  it("a failed caller-managed speaker routes the chat into priorityRows.attention", async () => {
    const app = getApp();
    const owner = await createTestAdmin(app);
    const peer = await managedAgent(app, owner, "failed-peer");

    const chatId = await chatWith(app, owner, peer.uuid);
    await markFailed(app, peer.uuid, peer.clientId, chatId);

    const res = await list(app, owner);
    expect(groupOf(res, chatId)).toBe("attention");
    expect(res.priorityRows.attention.find((r) => r.chatId === chatId)?.failedAgentIds).toContain(peer.uuid);
  });

  it("a healthy managed speaker (no request, no failure) stays in ordinary rows", async () => {
    const app = getApp();
    const owner = await createTestAdmin(app);
    const peer = await managedAgent(app, owner, "healthy-peer");

    // Chat has a caller-managed non-human speaker — so it enters the attention
    // CANDIDATE set — but the speaker is neither failed nor has an open request,
    // so it must NOT be promoted to attention.
    const chatId = await chatWith(app, owner, peer.uuid);

    const res = await list(app, owner);
    expect(groupOf(res, chatId)).toBe("rows");
  });

  it("attention orders failed before request", async () => {
    const app = getApp();
    const owner = await createTestAdmin(app);
    const failPeer = await managedAgent(app, owner, "fail-peer");
    const reqPeer = await managedAgent(app, owner, "req-peer");

    // Request chat is fresher than the failed chat — proving failed still sorts
    // first (tier beats activity), then activity within a tier.
    const failedChat = await chatWith(app, owner, failPeer.uuid);
    await markFailed(app, failPeer.uuid, failPeer.clientId, failedChat);
    await setActivity(app, failedChat, "2026-01-01T00:00:00.000Z");

    const requestChat = await chatWith(app, owner, reqPeer.uuid);
    await raiseRequest(app, requestChat, reqPeer.uuid, owner.humanAgentUuid);
    await setActivity(app, requestChat, "2026-12-01T00:00:00.000Z");

    const res = await list(app, owner);
    expect(res.priorityRows.attention.map((r) => r.chatId)).toEqual([failedChat, requestChat]);
  });

  it("attention outranks pinned — a pinned chat with an open request appears only in attention", async () => {
    const app = getApp();
    const owner = await createTestAdmin(app);
    const peer = await managedAgent(app, owner, "both-peer");

    const chatId = await chatWith(app, owner, peer.uuid);
    await pinMeChat(app.db, chatId, owner.humanAgentUuid, true);
    await raiseRequest(app, chatId, peer.uuid, owner.humanAgentUuid);

    const res = await list(app, owner);
    expect(groupOf(res, chatId)).toBe("attention");
    expect(res.priorityRows.pinned.some((r) => r.chatId === chatId)).toBe(false);
  });

  it("every chat appears exactly once across attention / pinned / rows", async () => {
    const app = getApp();
    const owner = await createTestAdmin(app);
    const peer = await managedAgent(app, owner, "once-peer");

    const attn = await chatWith(app, owner, peer.uuid);
    await raiseRequest(app, attn, peer.uuid, owner.humanAgentUuid);
    const pinnedChat = await chatWith(app, owner, peer.uuid);
    await pinMeChat(app.db, pinnedChat, owner.humanAgentUuid, true);
    const ordinary = await chatWith(app, owner, peer.uuid);

    const res = await list(app, owner);
    const all = [...res.priorityRows.attention, ...res.priorityRows.pinned, ...res.rows].map((r) => r.chatId);
    // No chat id appears twice.
    expect(new Set(all).size).toBe(all.length);
    expect(groupOf(res, attn)).toBe("attention");
    expect(groupOf(res, pinnedChat)).toBe("pinned");
    expect(groupOf(res, ordinary)).toBe("rows");
  });

  it("counts.unread aggregates the caller's unread chats independent of the page", async () => {
    const app = getApp();
    const owner = await createTestAdmin(app);
    const peer = await managedAgent(app, owner, "unread-peer");

    const a = await chatWith(app, owner, peer.uuid);
    const b = await chatWith(app, owner, peer.uuid);
    await raiseRequest(app, a, peer.uuid, owner.humanAgentUuid);
    await raiseRequest(app, b, peer.uuid, owner.humanAgentUuid);

    const before = await list(app, owner, { limit: 1 });
    expect(before.counts.unread).toBe(2);

    // Reading one clears its unread; the aggregate follows, still page-independent.
    await markMeChatRead(app.db, a, owner.humanAgentUuid);
    const after = await list(app, owner, { limit: 1 });
    expect(after.counts.unread).toBe(1);
  });

  it("the active filter narrows the priority groups too (origin filter drops a mismatched pinned chat)", async () => {
    const app = getApp();
    const owner = await createTestAdmin(app);
    const peer = await managedAgent(app, owner, "origin-peer");

    const manualChat = await chatWith(app, owner, peer.uuid, "manual");
    const githubChat = await chatWith(app, owner, peer.uuid, "github");
    await app.db
      .update(chats)
      .set({ metadata: { source: "github", entityType: "github_pull_request" } })
      .where(eq(chats.id, githubChat));
    await pinMeChat(app.db, manualChat, owner.humanAgentUuid, true);
    await pinMeChat(app.db, githubChat, owner.humanAgentUuid, true);

    const manualOnly = await list(app, owner, { origin: ["manual"] });
    expect(manualOnly.priorityRows.pinned.map((r) => r.chatId)).toEqual([manualChat]);

    const githubOnly = await list(app, owner, { origin: ["github"] });
    expect(githubOnly.priorityRows.pinned.map((r) => r.chatId)).toEqual([githubChat]);
  });
});
