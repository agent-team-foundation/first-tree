import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createMeChat, listMeChats, markMeChatRead } from "../services/me-chat.js";
import { sendMessage } from "../services/message.js";
import { createTestAdmin, createTestAgent, useTestApp } from "./helpers.js";

/**
 * Chat-granularity "Needs attention" scoping — Phase 1 (two-rule predicate).
 *
 * R1. agent ∈ chat has main = 'failed'  AND  agent.manager = caller_member
 * R2. unreadMentionCount > 0  AND  ∃ message in unread window with
 *     caller_human_id ∈ message.metadata.mentions
 *
 * The legacy R2 (mine-pending) and R3 (speaker-fallback chatHasOpenQuestion)
 * served by `pending_questions` were dropped in Phase 1 — the table has had
 * no production writer since PR #578 (NHA M0 prep), so the rules never fired
 * anyway. The legacy R4 (`unreadMentionCount > 0` unfiltered) is narrowed to
 * the new explicit-mention bool — closes the 1v1-DM-plain-final-message
 * false positive.
 *
 * The wire keeps `pendingQuestionAgentIds: []` and `chatHasOpenQuestion: false`
 * for backward compat (front-end no longer reads them). Follow-up PR drops.
 *
 * This file pins the SERVER projection for R1 (unchanged from PR #579) plus
 * the new `chatHasExplicitMentionToMe` boolean.
 */
describe("listMeChats: Phase 1 needs-attention scoping", () => {
  const getApp = useTestApp();

  // Make an agent reachable by mirroring `agents.client_id` into `agent_presence`.
  // `deriveMainStatus` returns "offline" when `reachable=false`, gating ALL
  // other states — so without a presence row, `markErrored` alone would
  // promote main to "offline" instead of "failed".
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

  // Mark an `(agent, chat)` pair as failed via `agent_chat_sessions.state='errored'`
  // + `runtime_state='error'`. Pair with `makeReachable` so the composite
  // promotes to `main = 'failed'`.
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

  // Add the caller's human agent as a *watcher* of a chat someone else created.
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
  // R1 — my failed agent (manager-narrowed). Same as PR #579 B1-B4.
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

  it("R2.a (痛点 t7): 1v1 agent → human plain message without explicit mention → chatHasExplicitMentionToMe = false", async () => {
    // Post-retire of content extraction + the 1:1 implicit-wake bypass, a
    // bare agent send to a human peer with no `metadata.mentions` neither
    // bumps the red-dot counter nor flags the chat as Needs-attention.
    // The original "痛点 t7" false positive (plain reply pinning the
    // chat) cannot recur because nothing about the send claims the
    // human's attention any more.
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
    // Without explicit mention, neither counter fires.
    expect(row?.unreadMentionCount ?? 0).toBe(0);
    expect(row?.chatHasExplicitMentionToMe).toBe(false);
  });

  it("R2.b: 1v1 agent → human with explicit @<me> → chatHasExplicitMentionToMe = true", async () => {
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

  it("R2.c: group, explicit @<me> by any agent → chatHasExplicitMentionToMe = true", async () => {
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

  it("R2.d: group, explicit @ <someone else> (not me) → chatHasExplicitMentionToMe = false", async () => {
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

  it("R2.e: mark-read advances last_read_at → chatHasExplicitMentionToMe flips back to false", async () => {
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
  // Deprecation guards — wire fields kept emitting empty / false
  // ---------------------------------------------------------------------------

  it("deprecation: pendingQuestionAgentIds emits [] (dormant source post-#578)", async () => {
    const app = getApp();
    const me = await createTestAdmin(app);
    const mine = await createTestAgent(app, { name: `dep-${crypto.randomUUID().slice(0, 6)}` });
    await setManager(mine.agent.uuid, me.memberId);
    const { chatId } = await createMeChat(app.db, me.humanAgentUuid, me.organizationId, {
      participantIds: [mine.agent.uuid],
    });
    const row = await rowFor(chatId, me);
    // pending_questions has no production writer; the field still ships
    // on the wire but always reads empty.
    expect(row?.pendingQuestionAgentIds).toEqual([]);
    expect(row?.chatHasOpenQuestion).toBe(false);
  });
});
