import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { agentPresence } from "../db/schema/agent-presence.js";
import { chats } from "../db/schema/chats.js";
import { clients } from "../db/schema/clients.js";
import { members } from "../db/schema/members.js";
import { createAgent } from "../services/agent.js";
import { createMeChat, listMeChats, pinMeChat, selectAttentionCandidateRows } from "../services/me-chat.js";
import { sendMessage } from "../services/message.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

/**
 * Server-side priority projection (PR3): `listMeChats` splits its result into
 * `priorityRows.attention` (a caller-managed speaker in `failed`, OR an open
 * request to the caller) → `priorityRows.pinned` (the caller's pins) → ordinary
 * `rows`, computed across the FULL matching set so a priority chat surfaces on
 * page 1 even when its `activity_at` would page it far down. `attention` and
 * `pinned` are disjoint; `rows` is additive (priority chats repeat there and the
 * client de-duplicates), and the priority groups are first-page only.
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

  it("pinned chats surface in priorityRows.pinned (pinned_at DESC); rows stays additive", async () => {
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
    // ADDITIVE contract: pinned chats ALSO appear in `rows` (the complete recency
    // stream) so a client that ignores priorityRows never loses them; the
    // priority-aware client de-duplicates them against priorityRows on render.
    expect(res.rows.some((r) => r.chatId === first)).toBe(true);
    expect(res.rows.some((r) => r.chatId === second)).toBe(true);
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
    // would put it dead last in the recency stream.
    expect(page1.priorityRows.pinned.map((r) => r.chatId)).toEqual([oldPinned]);
    // Ordinary page 1 returns the freshest 2 chats; `oldPinned` is absent here
    // only because its activity pages it far down (additive rows, not exclusion) —
    // it reappears in a later page and the client de-dupes it against the group.
    expect(page1.rows.map((r) => r.chatId)).toEqual([ordinary[3], ordinary[2]]);
    expect(page1.rows.some((r) => r.chatId === oldPinned)).toBe(false);
    expect(page1.nextCursor).not.toBeNull();
  });

  it("an open request routes the chat into priorityRows.attention (render group), additively in rows", async () => {
    const app = getApp();
    const owner = await createTestAdmin(app);
    const peer = await managedAgent(app, owner, "req-peer");

    const chatId = await chatWith(app, owner, peer.uuid);
    await raiseRequest(app, chatId, peer.uuid, owner.humanAgentUuid);

    const res = await list(app, owner);
    // groupOf uses render precedence (attention > pinned > rows).
    expect(groupOf(res, chatId)).toBe("attention");
    const row = res.priorityRows.attention.find((r) => r.chatId === chatId);
    expect(row?.openRequestCount).toBe(1);
    // ADDITIVE: also present in the recency stream (client de-dupes on render).
    expect(res.rows.some((r) => r.chatId === chatId)).toBe(true);
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

  it("keeps an errored chat in attention while its managed speaker is offline", async () => {
    const app = getApp();
    const owner = await createTestAdmin(app);
    const peer = await managedAgent(app, owner, "offline-failed-peer");

    const chatId = await chatWith(app, owner, peer.uuid);
    await markFailed(app, peer.uuid, peer.clientId, chatId);
    await app.db.update(agentPresence).set({ clientId: null }).where(eq(agentPresence.agentId, peer.uuid));

    const offline = await list(app, owner);
    expect(groupOf(offline, chatId)).toBe("attention");
    expect(offline.priorityRows.attention.find((r) => r.chatId === chatId)?.failedAgentIds).toContain(peer.uuid);

    await app.db.update(agentPresence).set({ clientId: peer.clientId }).where(eq(agentPresence.agentId, peer.uuid));
    await app.db.execute(sql`
      UPDATE agent_chat_sessions
      SET state = 'active', runtime_state = 'idle', runtime_state_at = NOW(), updated_at = NOW()
      WHERE agent_id = ${peer.uuid} AND chat_id = ${chatId}
    `);

    const recovered = await list(app, owner);
    expect(groupOf(recovered, chatId)).toBe("rows");
    expect(recovered.rows.find((r) => r.chatId === chatId)?.failedAgentIds).toEqual([]);
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

  it("renders each chat in exactly one group: attention and pinned are disjoint, precedence picks the group", async () => {
    const app = getApp();
    const owner = await createTestAdmin(app);
    const peer = await managedAgent(app, owner, "once-peer");

    const attn = await chatWith(app, owner, peer.uuid);
    await raiseRequest(app, attn, peer.uuid, owner.humanAgentUuid);
    const pinnedChat = await chatWith(app, owner, peer.uuid);
    await pinMeChat(app.db, pinnedChat, owner.humanAgentUuid, true);
    const ordinary = await chatWith(app, owner, peer.uuid);

    const res = await list(app, owner);
    // The two PRIORITY groups are disjoint (a chat is in at most one of them) —
    // that is the server's "once" guarantee. `rows` is additive on top, and the
    // client renders each chat once via the same precedence `groupOf` encodes.
    const attnIds = new Set(res.priorityRows.attention.map((r) => r.chatId));
    const pinnedIds = new Set(res.priorityRows.pinned.map((r) => r.chatId));
    expect([...attnIds].some((id) => pinnedIds.has(id))).toBe(false);
    expect(groupOf(res, attn)).toBe("attention");
    expect(groupOf(res, pinnedChat)).toBe("pinned");
    expect(groupOf(res, ordinary)).toBe("rows");
  });

  it("priority groups are computed on the first page and gated off on load-more", async () => {
    const app = getApp();
    const owner = await createTestAdmin(app);
    const peer = await managedAgent(app, owner, "gate-peer");

    const a = await chatWith(app, owner, peer.uuid);
    const b = await chatWith(app, owner, peer.uuid);
    await raiseRequest(app, a, peer.uuid, owner.humanAgentUuid);
    await raiseRequest(app, b, peer.uuid, owner.humanAgentUuid);

    // First page (no cursor): the whole-set priority groups.
    const page1 = await list(app, owner, { limit: 1 });
    expect(page1.priorityRows.attention.length).toBe(2);
    expect(page1.nextCursor).not.toBeNull();

    // Load-more page (cursor set): priority groups are gated OFF — the client
    // reads them from page 1 only — so the whole-set work runs once per open.
    const page2 = await list(app, owner, { cursor: page1.nextCursor ?? undefined, limit: 1 });
    expect(page2.priorityRows.attention).toEqual([]);
    expect(page2.priorityRows.pinned).toEqual([]);
  });

  it("an undecodable / legacy cursor restarts from the first page instead of erroring", async () => {
    const app = getApp();
    const owner = await createTestAdmin(app);
    const peer = await managedAgent(app, owner, "cursor-peer");
    const pinnedChat = await chatWith(app, owner, peer.uuid);
    await pinMeChat(app.db, pinnedChat, owner.humanAgentUuid, true);

    // A pre-PR (unversioned) cursor shape: base64url of `<iso>|<chatId>`, which
    // the v2 decoder no longer accepts. It must recover as a first-page request,
    // not throw or strand the caller.
    const legacyCursor = Buffer.from("2026-05-06T10:24:00.000Z|some-old-chat", "utf8").toString("base64url");
    const res = await list(app, owner, { cursor: legacyCursor });
    // Treated as page 1: the priority groups are populated (they would be gated
    // off on a genuine load-more page), and the call did not error.
    expect(res.priorityRows.pinned.some((r) => r.chatId === pinnedChat)).toBe(true);
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

  it("keyset pagination walks the complete activity-ordered recency stream (no gaps or dups)", async () => {
    const app = getApp();
    const owner = await createTestAdmin(app);
    const peer = await managedAgent(app, owner, "page-peer");

    // Five chats with strictly descending activity (c-4 newest … c-0 oldest).
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const c = await chatWith(app, owner, peer.uuid, `c-${i}`);
      await setActivity(app, c, `2026-05-0${i + 1}T00:00:00.000Z`);
      ids.push(c);
    }
    const expectedNewestFirst = [...ids].reverse();

    // Walk pages of 2 via nextCursor, collecting the ordinary stream.
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page = await list(app, owner, { limit: 2, cursor });
      seen.push(...page.rows.map((r) => r.chatId));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    // Complete + ordered across every page boundary — the cursor never skips or
    // repeats a row (the `(activity_at, id)` keyset is a total order).
    expect(seen).toEqual(expectedNewestFirst);
  });

  it("a peer's failed speaker (not caller-managed) never pins the chat — it stays in rows", async () => {
    const app = getApp();
    const owner = await createTestAdmin(app);
    // A second member in the same org whose managed agent will fail.
    const peerAdmin = await createTestAdmin(app);
    const peerAgent = await managedAgent(app, peerAdmin, "peer-failed");

    const chatId = await chatWith(app, owner, peerAgent.uuid);
    await markFailed(app, peerAgent.uuid, peerAgent.clientId, chatId);

    const res = await list(app, owner);
    // The failed speaker belongs to a PEER (manager != caller), so the
    // manager-scoped candidate filter + the `isMine` failed narrowing keep it out
    // of the caller's attention — someone else's broken agent is not my problem.
    expect(groupOf(res, chatId)).toBe("rows");
    expect(res.priorityRows.attention.some((r) => r.chatId === chatId)).toBe(false);
    // And the row the caller does see carries no failed marker for the peer agent.
    expect(res.rows.find((r) => r.chatId === chatId)?.failedAgentIds).toEqual([]);
  });

  it("a managed agent with a global error but a stamped per-chat idle session stays in rows", async () => {
    const app = getApp();
    const owner = await createTestAdmin(app);
    const peer = await managedAgent(app, owner, "stamped-idle");
    const chatId = await chatWith(app, owner, peer.uuid);

    // Agent-global presence error (reachable), BUT the per-chat session is active
    // with a STAMPED per-chat runtime of `idle`. Once a per-chat stamp exists, the
    // per-chat runtime is authoritative and the global error is ignored — so the
    // agent is canonically NOT failed here. The narrowed candidate filter must
    // gate the presence fallback on the missing stamp, so this chat is neither a
    // candidate nor attention.
    await app.db
      .insert(agentPresence)
      .values({
        agentId: peer.uuid,
        clientId: peer.clientId,
        lastSeenAt: new Date(),
        runtimeState: "error",
        activeSessions: 1,
        totalSessions: 1,
      })
      .onConflictDoUpdate({
        target: [agentPresence.agentId],
        set: { clientId: peer.clientId, runtimeState: "error" },
      });
    await app.db.execute(sql`
      INSERT INTO agent_chat_sessions (agent_id, chat_id, state, runtime_state, runtime_state_at, updated_at)
      VALUES (${peer.uuid}, ${chatId}, 'active', 'idle', NOW(), NOW())
      ON CONFLICT (agent_id, chat_id) DO UPDATE
        SET state = 'active', runtime_state = 'idle', runtime_state_at = NOW()
    `);

    const res = await list(app, owner);
    expect(groupOf(res, chatId)).toBe("rows");
    expect(res.priorityRows.attention.some((r) => r.chatId === chatId)).toBe(false);
  });

  it("the attention-candidate query admits a failed managed speaker but NOT a stamped-idle one", async () => {
    const app = getApp();
    const owner = await createTestAdmin(app);
    const failedPeer = await managedAgent(app, owner, "cand-failed");
    const idlePeer = await managedAgent(app, owner, "cand-idle");
    const healthyPeer = await managedAgent(app, owner, "cand-healthy");

    // failed: session `errored` → a candidate (the perf contract's positive path).
    const failedChat = await chatWith(app, owner, failedPeer.uuid);
    await markFailed(app, failedPeer.uuid, failedPeer.clientId, failedChat);

    // stamped-idle: agent-global runtime error, but the per-chat session is active
    // with a STAMPED idle runtime — the stamp overrides the global error, so it is
    // canonically NOT failed. This is exactly the row the pre-narrowing SQL wrongly
    // admitted (and re-enriched on every poll).
    const idleChat = await chatWith(app, owner, idlePeer.uuid);
    await app.db
      .insert(agentPresence)
      .values({
        agentId: idlePeer.uuid,
        clientId: idlePeer.clientId,
        lastSeenAt: new Date(),
        runtimeState: "error",
        activeSessions: 1,
        totalSessions: 1,
      })
      .onConflictDoUpdate({
        target: [agentPresence.agentId],
        set: { clientId: idlePeer.clientId, runtimeState: "error" },
      });
    await app.db.execute(sql`
      INSERT INTO agent_chat_sessions (agent_id, chat_id, state, runtime_state, runtime_state_at, updated_at)
      VALUES (${idlePeer.uuid}, ${idleChat}, 'active', 'idle', NOW(), NOW())
      ON CONFLICT (agent_id, chat_id) DO UPDATE
        SET state = 'active', runtime_state = 'idle', runtime_state_at = NOW()
    `);

    // healthy: reachable, no error anywhere → NOT a candidate.
    const healthyChat = await chatWith(app, owner, healthyPeer.uuid);

    // Observe the candidate boundary DIRECTLY (no mocking): this query is what
    // decides which chats pay the expensive canonical enrichment on every poll.
    const candidateIds = (
      await selectAttentionCandidateRows(app.db, {
        humanAgentId: owner.humanAgentUuid,
        organizationId: owner.organizationId,
        callerMemberId: owner.memberId,
        filters: sql`TRUE`,
        orderBy: sql`c.id`,
      })
    ).map((r) => r.chat_id);

    // Positive control — the mechanism genuinely admits candidates, so the
    // exclusions below can't pass vacuously on an always-empty result.
    expect(candidateIds).toContain(failedChat);
    // The narrowing under test: a stamped-idle (and a healthy) managed speaker
    // are NOT admitted, so they never reach canonical enrichment.
    expect(candidateIds).not.toContain(idleChat);
    expect(candidateIds).not.toContain(healthyChat);
  });
});
