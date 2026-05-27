import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { raiseAttention } from "../services/attention.js";
import { createMeChat, listMeChats, markMeChatRead } from "../services/me-chat.js";
import { sendMessage } from "../services/message.js";
import { createTestAdmin, createTestAgent, useTestApp } from "./helpers.js";

/**
 * Chat-granularity "Needs attention" scoping — three-rule projection.
 *
 * After the three-rule simplification, a chat enters the "Needs attention"
 * bucket when ANY of:
 *
 *   R1. `failedAgentIds.length > 0`
 *       — A non-human agent I MANAGE is `failed` in this chat. Server
 *         narrows to `manager_id = caller_member`.
 *
 *   R2. `chatHasExplicitMentionToMe === true`
 *       — There's at least one unread message whose
 *         `messages.metadata.mentions` explicitly contains my human-agent
 *         uuid. The v1 1-on-1 implicit DM auto-mention is intentionally
 *         excluded — it bumps `unreadMentionCount` for the red dot but
 *         never writes the recipient into `metadata.mentions`.
 *
 *   R3. `chatHasOpenAttentionForMe === true`
 *       — There's at least one `attentions.state='open'` row in this chat
 *         whose `target_human_id` is my human-agent uuid.
 *
 * This file pins the SERVER projection for the new fields. The front-end
 * predicate (`group-rows.ts`) is unit-tested separately.
 */
describe("listMeChats: three-rule needs-attention scoping", () => {
  const getApp = useTestApp();

  // Make an agent reachable by mirroring `agents.client_id` into
  // `agent_presence`. Without this, `deriveMainStatus` returns "offline" and
  // `markErrored` would never promote main to "failed".
  async function makeReachable(agentId: string): Promise<void> {
    const app = getApp();
    const [row] = await app.db.execute<{ client_id: string | null }>(sql`
      SELECT client_id FROM agents WHERE uuid = ${agentId}
    `);
    if (!row?.client_id) {
      throw new Error(`agents.client_id is null for ${agentId} — non-human test agents need a pinned client`);
    }
    await app.db.execute(sql`
      INSERT INTO agent_presence (agent_id, status, client_id, last_seen_at)
      VALUES (${agentId}, 'online', ${row.client_id}, NOW())
      ON CONFLICT (agent_id) DO UPDATE
        SET status = EXCLUDED.status,
            client_id = EXCLUDED.client_id,
            last_seen_at = EXCLUDED.last_seen_at
    `);
  }

  // Mark an `(agent,chat)` pair as failed: `agent_chat_sessions.state='errored'`
  // + `runtime_state='error'`. Pair with `makeReachable` so the composite
  // promotes to `main === 'failed'`.
  async function markErrored(agentId: string, chatId: string): Promise<void> {
    const app = getApp();
    await app.db.execute(sql`
      INSERT INTO agent_chat_sessions (agent_id, chat_id, state, runtime_state, runtime_state_at, updated_at)
      VALUES (${agentId}, ${chatId}, 'errored', 'error', NOW(), NOW())
      ON CONFLICT (agent_id, chat_id) DO UPDATE
        SET state = EXCLUDED.state,
            runtime_state = EXCLUDED.runtime_state,
            runtime_state_at = EXCLUDED.runtime_state_at
    `);
    await makeReachable(agentId);
  }

  // `createTestAgent` binds the agent's `managerId` to the seeding admin's
  // memberId. Re-anchor by direct UPDATE — `agents.manager_id` is plain text
  // with no FK/trigger, exactly what a future "transfer manager" admin
  // action would do.
  async function setManager(agentId: string, memberId: string): Promise<void> {
    const app = getApp();
    await app.db.execute(sql`UPDATE agents SET manager_id = ${memberId} WHERE uuid = ${agentId}`);
  }

  // Add the caller's human agent as a *watcher* on a chat someone else
  // created.
  async function addAsWatcher(chatId: string, humanAgentUuid: string): Promise<void> {
    const app = getApp();
    await app.db.execute(sql`
      INSERT INTO chat_membership (chat_id, agent_id, role, access_mode, mode, source, joined_at)
      VALUES (${chatId}, ${humanAgentUuid}, 'member', 'watcher', 'mention_only', 'manual', NOW())
      ON CONFLICT (chat_id, agent_id) DO NOTHING
    `);
  }

  async function rowFor(chatId: string, caller: Awaited<ReturnType<typeof createTestAdmin>>) {
    const app = getApp();
    const { rows } = await listMeChats(app.db, caller.humanAgentUuid, caller.memberId, caller.organizationId, {
      limit: 50,
      filter: "all",
      engagement: "all",
    });
    return rows.find((r) => r.chatId === chatId) ?? null;
  }

  // ---------------------------------------------------------------------------
  // R1 — my failed agent (manager-narrowed)
  // ---------------------------------------------------------------------------

  it("R1.a: my failed agent, caller is speaker → failedAgentIds = [mine]", async () => {
    const app = getApp();
    const me = await createTestAdmin(app);
    const mine = await createTestAgent(app, { name: `r1a-${crypto.randomUUID().slice(0, 6)}` });
    await setManager(mine.agent.uuid, me.memberId);
    const { chatId } = await createMeChat(app.db, me.humanAgentUuid, me.organizationId, {
      participantIds: [mine.agent.uuid],
    });
    await markErrored(mine.agent.uuid, chatId);
    const row = await rowFor(chatId, me);
    expect(row?.failedAgentIds).toEqual([mine.agent.uuid]);
  });

  it("R1.b: peer's failed agent, caller is speaker → failedAgentIds = [] (manager-narrowed)", async () => {
    const app = getApp();
    const me = await createTestAdmin(app);
    const them = await createTestAdmin(app, { username: `peer-${crypto.randomUUID().slice(0, 8)}` });
    const theirs = await createTestAgent(app, { name: `r1b-${crypto.randomUUID().slice(0, 6)}` });
    await setManager(theirs.agent.uuid, them.memberId);
    const { chatId } = await createMeChat(app.db, me.humanAgentUuid, me.organizationId, {
      participantIds: [theirs.agent.uuid],
    });
    await markErrored(theirs.agent.uuid, chatId);
    const row = await rowFor(chatId, me);
    expect(row?.failedAgentIds).toEqual([]);
  });

  it("R1.c: my failed agent, caller is watcher → failedAgentIds = [mine] (boundary A)", async () => {
    const app = getApp();
    const me = await createTestAdmin(app);
    const them = await createTestAdmin(app, { username: `peer-${crypto.randomUUID().slice(0, 8)}` });
    const mine = await createTestAgent(app, { name: `r1c-${crypto.randomUUID().slice(0, 6)}` });
    await setManager(mine.agent.uuid, me.memberId);
    const { chatId } = await createMeChat(app.db, them.humanAgentUuid, them.organizationId, {
      participantIds: [mine.agent.uuid],
    });
    await addAsWatcher(chatId, me.humanAgentUuid);
    await markErrored(mine.agent.uuid, chatId);
    const row = await rowFor(chatId, me);
    expect(row?.failedAgentIds).toEqual([mine.agent.uuid]);
  });

  // ---------------------------------------------------------------------------
  // R2 — explicit @me in unread window
  // ---------------------------------------------------------------------------

  it("R2.a — t7 (user's痛点): 1v1 agent → human plain final message → mention bool stays false", async () => {
    // The v1 1-on-1 auto-mention still bumps `unread_mention_count` (red
    // dot stays correct), but `metadata.mentions` is empty, so
    // `chatHasExplicitMentionToMe` is false → R2 does NOT fire.
    const app = getApp();
    const me = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: `r2a-${crypto.randomUUID().slice(0, 6)}` });
    const { chatId } = await createMeChat(app.db, me.humanAgentUuid, me.organizationId, {
      participantIds: [peer.agent.uuid],
    });
    await sendMessage(app.db, chatId, peer.agent.uuid, {
      source: "api",
      format: "text",
      content: "ack",
    });
    const row = await rowFor(chatId, me);
    // v1 red-dot contract preserved.
    expect(row?.unreadMentionCount).toBeGreaterThanOrEqual(1);
    // R2 not fired — the chat must not pin into Needs attention on this
    // axis. Implementations may have edge cases that toggle the bool,
    // but the strict invariant is "must be false on a plain DM".
    expect(row?.chatHasExplicitMentionToMe).toBe(false);
  });

  it("R2.b: 1v1 agent → human with explicit @<me> → mention bool true", async () => {
    const app = getApp();
    const me = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: `r2b-${crypto.randomUUID().slice(0, 6)}` });
    const { chatId } = await createMeChat(app.db, me.humanAgentUuid, me.organizationId, {
      participantIds: [peer.agent.uuid],
    });
    await sendMessage(app.db, chatId, peer.agent.uuid, {
      source: "api",
      format: "text",
      content: "fyi look at this",
      metadata: { mentions: [me.humanAgentUuid] },
    });
    const row = await rowFor(chatId, me);
    expect(row?.chatHasExplicitMentionToMe).toBe(true);
  });

  it("R2.c: group, explicit @<me> by any agent → mention bool true", async () => {
    const app = getApp();
    const me = await createTestAdmin(app);
    const peerA = await createTestAgent(app, { name: `r2c-a-${crypto.randomUUID().slice(0, 6)}` });
    const peerB = await createTestAgent(app, { name: `r2c-b-${crypto.randomUUID().slice(0, 6)}` });
    const { chatId } = await createMeChat(app.db, me.humanAgentUuid, me.organizationId, {
      participantIds: [peerA.agent.uuid, peerB.agent.uuid],
    });
    await sendMessage(app.db, chatId, peerA.agent.uuid, {
      source: "api",
      format: "text",
      content: "hey check this",
      metadata: { mentions: [me.humanAgentUuid] },
    });
    const row = await rowFor(chatId, me);
    expect(row?.chatHasExplicitMentionToMe).toBe(true);
  });

  it("R2.d: group, explicit @ <someone else> (not me) → mention bool false", async () => {
    const app = getApp();
    const me = await createTestAdmin(app);
    const peerA = await createTestAgent(app, { name: `r2d-a-${crypto.randomUUID().slice(0, 6)}` });
    const peerB = await createTestAgent(app, { name: `r2d-b-${crypto.randomUUID().slice(0, 6)}` });
    const { chatId } = await createMeChat(app.db, me.humanAgentUuid, me.organizationId, {
      participantIds: [peerA.agent.uuid, peerB.agent.uuid],
    });
    await sendMessage(app.db, chatId, peerA.agent.uuid, {
      source: "api",
      format: "text",
      content: "hey B",
      metadata: { mentions: [peerB.agent.uuid] },
    });
    const row = await rowFor(chatId, me);
    expect(row?.chatHasExplicitMentionToMe).toBe(false);
  });

  it("R2.e: mark-read advances last_read_at → mention bool flips back to false", async () => {
    const app = getApp();
    const me = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: `r2e-${crypto.randomUUID().slice(0, 6)}` });
    const { chatId } = await createMeChat(app.db, me.humanAgentUuid, me.organizationId, {
      participantIds: [peer.agent.uuid],
    });
    await sendMessage(app.db, chatId, peer.agent.uuid, {
      source: "api",
      format: "text",
      content: "look",
      metadata: { mentions: [me.humanAgentUuid] },
    });
    const before = await rowFor(chatId, me);
    expect(before?.chatHasExplicitMentionToMe).toBe(true);
    await markMeChatRead(app.db, chatId, me.humanAgentUuid);
    const after = await rowFor(chatId, me);
    expect(after?.chatHasExplicitMentionToMe).toBe(false);
    expect(after?.unreadMentionCount).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // R3 — open attention targeting me
  // ---------------------------------------------------------------------------

  it("R3.a: 1v1 — my agent raises attention(target=me) → attention bool true", async () => {
    // The user's "1v1 attention" path: even though there is no explicit @me
    // in the question message body (1v1 implicit), the attentions row
    // carries `target_human_id` directly so R3 fires precisely.
    const app = getApp();
    const me = await createTestAdmin(app);
    const mine = await createTestAgent(app, { name: `r3a-${crypto.randomUUID().slice(0, 6)}` });
    await setManager(mine.agent.uuid, me.memberId);
    const { chatId } = await createMeChat(app.db, me.humanAgentUuid, me.organizationId, {
      participantIds: [mine.agent.uuid],
    });
    await raiseAttention(app.db, mine.agent.uuid, {
      chatId,
      target: me.humanAgentUuid,
      subject: "ready?",
      body: "",
      requiresResponse: true,
      metadata: {},
    });
    const row = await rowFor(chatId, me);
    expect(row?.chatHasOpenAttentionForMe).toBe(true);
  });

  it("R3.b: group — peer agent raises attention targeting someone else → attention bool false for me", async () => {
    const app = getApp();
    const me = await createTestAdmin(app);
    const them = await createTestAdmin(app, { username: `peer-${crypto.randomUUID().slice(0, 8)}` });
    const peerAgent = await createTestAgent(app, { name: `r3b-${crypto.randomUUID().slice(0, 6)}` });
    await setManager(peerAgent.agent.uuid, them.memberId);
    const { chatId } = await createMeChat(app.db, them.humanAgentUuid, them.organizationId, {
      participantIds: [peerAgent.agent.uuid, me.humanAgentUuid],
    });
    await raiseAttention(app.db, peerAgent.agent.uuid, {
      chatId,
      target: them.humanAgentUuid,
      subject: "for you",
      body: "",
      requiresResponse: true,
      metadata: {},
    });
    const row = await rowFor(chatId, me);
    expect(row?.chatHasOpenAttentionForMe).toBe(false);
  });

  it("R3.c: group — peer agent raises attention targeting me → attention bool true", async () => {
    const app = getApp();
    const me = await createTestAdmin(app);
    const them = await createTestAdmin(app, { username: `peer-${crypto.randomUUID().slice(0, 8)}` });
    const peerAgent = await createTestAgent(app, { name: `r3c-${crypto.randomUUID().slice(0, 6)}` });
    await setManager(peerAgent.agent.uuid, them.memberId);
    const { chatId } = await createMeChat(app.db, them.humanAgentUuid, them.organizationId, {
      participantIds: [peerAgent.agent.uuid, me.humanAgentUuid],
    });
    await raiseAttention(app.db, peerAgent.agent.uuid, {
      chatId,
      target: me.humanAgentUuid,
      subject: "for you",
      body: "",
      requiresResponse: true,
      metadata: {},
    });
    const row = await rowFor(chatId, me);
    expect(row?.chatHasOpenAttentionForMe).toBe(true);
  });

  it("R3.d: notification-only attention (requires_response=false) → state='closed' on creation → R3 false", async () => {
    const app = getApp();
    const me = await createTestAdmin(app);
    const mine = await createTestAgent(app, { name: `r3d-${crypto.randomUUID().slice(0, 6)}` });
    await setManager(mine.agent.uuid, me.memberId);
    const { chatId } = await createMeChat(app.db, me.humanAgentUuid, me.organizationId, {
      participantIds: [mine.agent.uuid],
    });
    await raiseAttention(app.db, mine.agent.uuid, {
      chatId,
      target: me.humanAgentUuid,
      subject: "fyi",
      body: "",
      requiresResponse: false,
      metadata: {},
    });
    const row = await rowFor(chatId, me);
    expect(row?.chatHasOpenAttentionForMe).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Composite + deprecation guards
  // ---------------------------------------------------------------------------

  it("composite: failed + explicit-mention + open-attention all on same chat → all three bools true", async () => {
    const app = getApp();
    const me = await createTestAdmin(app);
    const mine = await createTestAgent(app, { name: `cx-${crypto.randomUUID().slice(0, 6)}` });
    await setManager(mine.agent.uuid, me.memberId);
    const { chatId } = await createMeChat(app.db, me.humanAgentUuid, me.organizationId, {
      participantIds: [mine.agent.uuid],
    });
    await markErrored(mine.agent.uuid, chatId);
    await sendMessage(app.db, chatId, mine.agent.uuid, {
      source: "api",
      format: "text",
      content: "look",
      metadata: { mentions: [me.humanAgentUuid] },
    });
    await raiseAttention(app.db, mine.agent.uuid, {
      chatId,
      target: me.humanAgentUuid,
      subject: "ready?",
      body: "",
      requiresResponse: true,
      metadata: {},
    });
    const row = await rowFor(chatId, me);
    expect(row?.failedAgentIds).toEqual([mine.agent.uuid]);
    expect(row?.chatHasExplicitMentionToMe).toBe(true);
    expect(row?.chatHasOpenAttentionForMe).toBe(true);
  });

  it("deprecation: pendingQuestionAgentIds always emits [] and chatHasOpenQuestion always emits false", async () => {
    // These legacy fields are kept on the wire for one release so old web
    // bundles don't crash on missing keys, but the server permanently
    // emits empty/false. Followup PR drops the fields entirely.
    const app = getApp();
    const me = await createTestAdmin(app);
    const mine = await createTestAgent(app, { name: `dep-${crypto.randomUUID().slice(0, 6)}` });
    await setManager(mine.agent.uuid, me.memberId);
    const { chatId } = await createMeChat(app.db, me.humanAgentUuid, me.organizationId, {
      participantIds: [mine.agent.uuid],
    });
    // Even an open attention raised by my agent — which under the old R2
    // would have made `pendingQuestionAgentIds = [mine]` — must keep the
    // deprecated field empty under the new contract.
    await raiseAttention(app.db, mine.agent.uuid, {
      chatId,
      target: me.humanAgentUuid,
      subject: "ready?",
      body: "",
      requiresResponse: true,
      metadata: {},
    });
    const row = await rowFor(chatId, me);
    expect(row?.pendingQuestionAgentIds).toEqual([]);
    expect(row?.chatHasOpenQuestion).toBe(false);
    // ... while the new field correctly reflects the same state.
    expect(row?.chatHasOpenAttentionForMe).toBe(true);
  });
});
