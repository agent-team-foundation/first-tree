import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createMeChat, listMeChats } from "../services/me-chat.js";
import { createTestAdmin, createTestAgent, useTestApp } from "./helpers.js";

/**
 * Chat-granularity "Needs attention" scoping — server projection.
 *
 * The chat-list pinning rule has four parts; the server is responsible for
 * R1 (mine-failed), R2 (mine-pending), and the raw R3 bit
 * (`chatHasOpenQuestion`). R4 (unread mention) and the R3 speaker check both
 * live on the front-end — see `packages/web/.../group-rows.ts`.
 *
 * Matrix:
 *   B1  mine failed, caller is speaker          → failedAgentIds = [mine]
 *   B2  theirs failed, caller is speaker        → failedAgentIds = []
 *   B3  theirs failed, caller is watcher        → failedAgentIds = []
 *   B4  mine failed, caller is watcher          → failedAgentIds = [mine]   (boundary A)
 *   B5  mine pending question                    → pending = [mine], chatHasOpenQuestion = true
 *   B6  theirs pending, caller is speaker        → pending = [], chatHasOpenQuestion = true
 *   B7  theirs pending, caller is watcher        → pending = [], chatHasOpenQuestion = true
 *   B8  nothing pending / failed                → all new fields empty/false
 *   B9  multi-chat list mixing B1 + B2          → projections per-row independent
 *   B10 chat with only my own human + a peer     → no false positives on quiet
 *
 * See docs/development/needs-attention-scoping.20260526.md.
 */
describe("listMeChats: needs-attention scoping (R1-R3 backend projection)", () => {
  const getApp = useTestApp();

  // Make an agent reachable by mirroring its `agents.client_id` into
  // `agent_presence`. `deriveMainStatus` returns "offline" when
  // `reachable=false`, gating ALL other states — so without a presence row,
  // `markErrored` alone would promote main to "offline" instead of "failed"
  // and the projection would emit `[]` even for mine-failed (false-pass).
  //
  // Reuses the client the agent is already pinned to (seeded by
  // `createTestAgent`) instead of allocating a parallel client row — keeps
  // the FK chain consistent with how the real runtime binds presence.
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

  // Mark an `(agent,chat)` pair as failed by writing an `agent_chat_sessions`
  // row with `state='errored'`. `computeErrored` in `agent-chat-status.ts`
  // promotes this into `errored=true`, and `deriveMainStatus` promotes that
  // (gated on `reachable`) into `main === "failed"`. Pair with `makeReachable`.
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

  // Seed an open NHA request authored by `agentId` in the chat. After the
  // M1 末 repoint, `derivePendingQuestions` reads from `attentions` instead of
  // `pending_questions`, so the test fixture mirrors that. Direct INSERT
  // bypasses the service-layer invariants — the projection only looks at
  // (origin_chat_id, origin_agent_id, state, requires_response), so the
  // target_human_id can be any non-null string.
  async function markPending(agentId: string, chatId: string): Promise<void> {
    const app = getApp();
    await app.db.execute(sql`
      INSERT INTO attentions (
        id, origin_agent_id, origin_chat_id, target_human_id,
        subject, body, requires_response, state, metadata, created_at
      )
      VALUES (
        ${crypto.randomUUID()}, ${agentId}, ${chatId}, ${crypto.randomUUID()},
        'test-seeded ask', '', true, 'open', '{}'::jsonb, NOW()
      )
    `);
  }

  // Like `markPending`, but explicitly aims the ask at a specific human
  // — used to exercise the "target = me" arm of the strict scoping.
  async function markPendingTo(originAgentId: string, chatId: string, targetHumanId: string): Promise<void> {
    const app = getApp();
    await app.db.execute(sql`
      INSERT INTO attentions (
        id, origin_agent_id, origin_chat_id, target_human_id,
        subject, body, requires_response, state, metadata, created_at
      )
      VALUES (
        ${crypto.randomUUID()}, ${originAgentId}, ${chatId}, ${targetHumanId},
        'test-seeded ask (targeted)', '', true, 'open', '{}'::jsonb, NOW()
      )
    `);
  }

  // `createTestAgent` always creates an internal admin and binds the agent's
  // managerId to that admin's memberId. Re-anchor to a chosen memberId via a
  // direct UPDATE — `agents.manager_id` is plain text with no FK / trigger,
  // and re-targeting it is exactly what a future "transfer manager" admin
  // action would do.
  async function setManager(agentId: string, memberId: string): Promise<void> {
    const app = getApp();
    await app.db.execute(sql`UPDATE agents SET manager_id = ${memberId} WHERE uuid = ${agentId}`);
  }

  // Add the caller's human agent as a *watcher* of a chat that someone else
  // created. The chat membership table has no FK / trigger; an INSERT with
  // `access_mode='watcher'` is sufficient to flip the row's
  // `membershipKind` to "watching" in the listMeChats projection.
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

  it("B1: my failed agent, caller is speaker → failedAgentIds = [mine]", async () => {
    const app = getApp();
    const me = await createTestAdmin(app);
    const mine = await createTestAgent(app, { name: `b1-${crypto.randomUUID().slice(0, 6)}` });
    await setManager(mine.agent.uuid, me.memberId);
    const { chatId } = await createMeChat(app.db, me.humanAgentUuid, me.organizationId, {
      participantIds: [mine.agent.uuid],
    });
    await markErrored(mine.agent.uuid, chatId);
    const row = await rowFor(chatId, me);
    expect(row?.failedAgentIds).toEqual([mine.agent.uuid]);
  });

  it("B2: peer's failed agent, caller is speaker → failedAgentIds = []", async () => {
    const app = getApp();
    const me = await createTestAdmin(app);
    const them = await createTestAdmin(app, { username: `peer-${crypto.randomUUID().slice(0, 8)}` });
    const theirs = await createTestAgent(app, { name: `b2-${crypto.randomUUID().slice(0, 6)}` });
    await setManager(theirs.agent.uuid, them.memberId);
    // `me` creates the chat so `me` is the speaker.
    const { chatId } = await createMeChat(app.db, me.humanAgentUuid, me.organizationId, {
      participantIds: [theirs.agent.uuid],
    });
    await markErrored(theirs.agent.uuid, chatId);
    const row = await rowFor(chatId, me);
    expect(row?.failedAgentIds).toEqual([]);
  });

  it("B3: peer's failed agent, caller is watcher → failedAgentIds = []", async () => {
    const app = getApp();
    const me = await createTestAdmin(app);
    const them = await createTestAdmin(app, { username: `peer-${crypto.randomUUID().slice(0, 8)}` });
    const theirs = await createTestAgent(app, { name: `b3-${crypto.randomUUID().slice(0, 6)}` });
    await setManager(theirs.agent.uuid, them.memberId);
    // `them` creates the chat; `me` watches.
    const { chatId } = await createMeChat(app.db, them.humanAgentUuid, them.organizationId, {
      participantIds: [theirs.agent.uuid],
    });
    await addAsWatcher(chatId, me.humanAgentUuid);
    await markErrored(theirs.agent.uuid, chatId);
    const row = await rowFor(chatId, me);
    expect(row?.failedAgentIds).toEqual([]);
  });

  it("B4: my failed agent, caller is watcher → failedAgentIds = [mine] (boundary A)", async () => {
    const app = getApp();
    const me = await createTestAdmin(app);
    const them = await createTestAdmin(app, { username: `peer-${crypto.randomUUID().slice(0, 8)}` });
    const mine = await createTestAgent(app, { name: `b4-${crypto.randomUUID().slice(0, 6)}` });
    await setManager(mine.agent.uuid, me.memberId);
    // `them` creates the chat; `me` watches.
    const { chatId } = await createMeChat(app.db, them.humanAgentUuid, them.organizationId, {
      participantIds: [mine.agent.uuid],
    });
    await addAsWatcher(chatId, me.humanAgentUuid);
    await markErrored(mine.agent.uuid, chatId);
    const row = await rowFor(chatId, me);
    expect(row?.failedAgentIds).toEqual([mine.agent.uuid]);
  });

  it("B5: my pending question → pending = [mine] AND chatHasOpenQuestion = true", async () => {
    const app = getApp();
    const me = await createTestAdmin(app);
    const mine = await createTestAgent(app, { name: `b5-${crypto.randomUUID().slice(0, 6)}` });
    await setManager(mine.agent.uuid, me.memberId);
    const { chatId } = await createMeChat(app.db, me.humanAgentUuid, me.organizationId, {
      participantIds: [mine.agent.uuid],
    });
    await markPending(mine.agent.uuid, chatId);
    const row = await rowFor(chatId, me);
    expect(row?.pendingQuestionAgentIds).toEqual([mine.agent.uuid]);
    expect(row?.chatHasOpenQuestion).toBe(true);
  });

  it("B6: peer's pending question, caller is speaker → pending = [] AND chatHasOpenQuestion = false (strict)", async () => {
    // Post-NHA-strict-scoping: a peer's open ask in a chat I'm in but
    // not the target of, no longer pins my row to "Needs attention".
    // Only target=me OR origin=my-managed-agent lights the bit.
    const app = getApp();
    const me = await createTestAdmin(app);
    const them = await createTestAdmin(app, { username: `peer-${crypto.randomUUID().slice(0, 8)}` });
    const theirs = await createTestAgent(app, { name: `b6-${crypto.randomUUID().slice(0, 6)}` });
    await setManager(theirs.agent.uuid, them.memberId);
    const { chatId } = await createMeChat(app.db, me.humanAgentUuid, me.organizationId, {
      participantIds: [theirs.agent.uuid],
    });
    await markPending(theirs.agent.uuid, chatId);
    const row = await rowFor(chatId, me);
    expect(row?.pendingQuestionAgentIds).toEqual([]);
    expect(row?.chatHasOpenQuestion).toBe(false);
  });

  it("B7: peer's pending question, caller is watcher → pending = [] AND chatHasOpenQuestion = false (strict)", async () => {
    // Same strict policy as B6 — being a chat watcher doesn't earn you
    // a "Needs attention" signal for someone else's ask.
    const app = getApp();
    const me = await createTestAdmin(app);
    const them = await createTestAdmin(app, { username: `peer-${crypto.randomUUID().slice(0, 8)}` });
    const theirs = await createTestAgent(app, { name: `b7-${crypto.randomUUID().slice(0, 6)}` });
    await setManager(theirs.agent.uuid, them.memberId);
    const { chatId } = await createMeChat(app.db, them.humanAgentUuid, them.organizationId, {
      participantIds: [theirs.agent.uuid],
    });
    await addAsWatcher(chatId, me.humanAgentUuid);
    await markPending(theirs.agent.uuid, chatId);
    const row = await rowFor(chatId, me);
    expect(row?.pendingQuestionAgentIds).toEqual([]);
    expect(row?.chatHasOpenQuestion).toBe(false);
  });

  it("B6b: peer's bot asks ME → pending = [] AND chatHasOpenQuestion = true (target arm)", async () => {
    // The "target = me" arm of the strict union. Peer owns the bot, the
    // bot asks me. I am not the manager-of-origin, but I am the target.
    // pendingQuestionAgentIds stays empty (the agent isn't mine — we
    // don't list peer agents under "my pending"), but chatHasOpenQuestion
    // is true so the row pins to "Needs attention".
    const app = getApp();
    const me = await createTestAdmin(app);
    const them = await createTestAdmin(app, { username: `peer-${crypto.randomUUID().slice(0, 8)}` });
    const theirs = await createTestAgent(app, { name: `b6b-${crypto.randomUUID().slice(0, 6)}` });
    await setManager(theirs.agent.uuid, them.memberId);
    const { chatId } = await createMeChat(app.db, me.humanAgentUuid, me.organizationId, {
      participantIds: [theirs.agent.uuid],
    });
    await markPendingTo(theirs.agent.uuid, chatId, me.humanAgentUuid);
    const row = await rowFor(chatId, me);
    expect(row?.pendingQuestionAgentIds).toEqual([]);
    expect(row?.chatHasOpenQuestion).toBe(true);
  });

  it("B8: nothing failed / no pending → all attention fields empty / false", async () => {
    const app = getApp();
    const me = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: `b8-${crypto.randomUUID().slice(0, 6)}` });
    const { chatId } = await createMeChat(app.db, me.humanAgentUuid, me.organizationId, {
      participantIds: [peer.agent.uuid],
    });
    const row = await rowFor(chatId, me);
    expect(row?.failedAgentIds).toEqual([]);
    expect(row?.pendingQuestionAgentIds).toEqual([]);
    expect(row?.chatHasOpenQuestion).toBe(false);
  });

  it("B9: multi-chat list — mine-failed + peer-failed are projected independently per row", async () => {
    const app = getApp();
    const me = await createTestAdmin(app);
    const them = await createTestAdmin(app, { username: `peer-${crypto.randomUUID().slice(0, 8)}` });
    // Chat A — my failed agent.
    const mineFailed = await createTestAgent(app, { name: `b9-mf-${crypto.randomUUID().slice(0, 6)}` });
    await setManager(mineFailed.agent.uuid, me.memberId);
    const { chatId: chatA } = await createMeChat(app.db, me.humanAgentUuid, me.organizationId, {
      participantIds: [mineFailed.agent.uuid],
    });
    await markErrored(mineFailed.agent.uuid, chatA);
    // Chat B — their failed agent (me as speaker).
    const theirsFailed = await createTestAgent(app, { name: `b9-tf-${crypto.randomUUID().slice(0, 6)}` });
    await setManager(theirsFailed.agent.uuid, them.memberId);
    const { chatId: chatB } = await createMeChat(app.db, me.humanAgentUuid, me.organizationId, {
      participantIds: [theirsFailed.agent.uuid],
    });
    await markErrored(theirsFailed.agent.uuid, chatB);

    const { rows } = await listMeChats(app.db, me.humanAgentUuid, me.memberId, me.organizationId, {
      limit: 50,
      filter: "all",
      engagement: "all",
    });
    const rowA = rows.find((r) => r.chatId === chatA);
    const rowB = rows.find((r) => r.chatId === chatB);
    expect(rowA?.failedAgentIds).toEqual([mineFailed.agent.uuid]);
    expect(rowB?.failedAgentIds).toEqual([]);
  });

  it("B10: chat with only a quiet peer agent → no false positives", async () => {
    const app = getApp();
    const me = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: `b10-${crypto.randomUUID().slice(0, 6)}` });
    const { chatId } = await createMeChat(app.db, me.humanAgentUuid, me.organizationId, {
      participantIds: [peer.agent.uuid],
    });
    const row = await rowFor(chatId, me);
    expect(row?.failedAgentIds).toEqual([]);
    expect(row?.pendingQuestionAgentIds).toEqual([]);
    expect(row?.chatHasOpenQuestion).toBe(false);
  });
});
