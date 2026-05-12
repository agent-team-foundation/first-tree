/**
 * Seed legacy chat_participants + chat_subscriptions rows for migration
 * 0038 backfill verification. Mimics realistic shapes that the
 * post-cutover code can no longer produce on its own (we removed the
 * service-layer writers in this branch).
 *
 * Coverage matrix:
 *   - direct chat with 2 humans, both with read state
 *   - direct chat (agent-only, mention_only)
 *   - group chat (3 speakers, 1 watcher)
 *   - watcher row only (no speaker counterpart)
 *   - speaker with subscription collision (proposal §3 invariant 1 violation —
 *     this should never happen but we test the "speaker wins" merge anyway)
 *
 * Run: DATABASE_URL=... pnpm --filter @first-tree-hub/server tsx scripts/seed-legacy-chat-data.ts
 */

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { connectDatabase } from "../src/db/connection.js";
import { agents } from "../src/db/schema/agents.js";
import { chatParticipants, chatSubscriptions, chats } from "../src/db/schema/chats.js";
import { members } from "../src/db/schema/members.js";
import { messages } from "../src/db/schema/messages.js";
import { organizations } from "../src/db/schema/organizations.js";
import { users } from "../src/db/schema/users.js";

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  const db = connectDatabase(databaseUrl);

  console.log("Seeding legacy chat data...");

  await db.transaction(async (tx) => {
    // ── Organizations ────────────────────────────────────────────────
    const acmeId = "org-acme-test";
    const betaId = "org-beta-test";
    await tx.insert(organizations).values([
      { id: acmeId, name: "acme-test", displayName: "AcmeCorp Test", maxAgents: 100, maxMessagesPerMinute: 100 },
      { id: betaId, name: "beta-test", displayName: "BetaCo Test", maxAgents: 100, maxMessagesPerMinute: 100 },
    ]);

    // ── Users ───────────────────────────────────────────────────────
    const aliceId = "user-alice";
    const bobId = "user-bob";
    const carolId = "user-carol";
    await tx.insert(users).values([
      { id: aliceId, username: "alice", passwordHash: "x", displayName: "Alice" },
      { id: bobId, username: "bob", passwordHash: "x", displayName: "Bob" },
      { id: carolId, username: "carol", passwordHash: "x", displayName: "Carol" },
    ]);

    // ── Agents ───────────────────────────────────────────────────────
    // human agents: each member needs one (referenced from members.agent_id)
    // non-human agents: managed by the human's member row
    const aliceHumanUuid = randomUUID();
    const bobHumanUuid = randomUUID();
    const carolHumanUuid = randomUUID();
    const agentXUuid = randomUUID();
    const agentYUuid = randomUUID();
    const agentZUuid = randomUUID();
    const agentPUuid = randomUUID();

    // Members rows must be created BEFORE the non-human agents that reference them as manager
    const aliceMemberId = "mem-alice";
    const bobMemberId = "mem-bob";
    const carolMemberId = "mem-carol";

    await tx.insert(agents).values([
      {
        uuid: aliceHumanUuid,
        name: "alice-h",
        type: "human",
        status: "active",
        visibility: "organization",
        organizationId: acmeId,
        inboxId: `inbox-${aliceHumanUuid.slice(0, 8)}`,
        managerId: aliceMemberId,
        displayName: "Alice (human)",
        runtimeProvider: "noop",
        metadata: {},
      },
      {
        uuid: bobHumanUuid,
        name: "bob-h",
        type: "human",
        status: "active",
        visibility: "organization",
        organizationId: acmeId,
        inboxId: `inbox-${bobHumanUuid.slice(0, 8)}`,
        managerId: bobMemberId,
        displayName: "Bob (human)",
        runtimeProvider: "noop",
        metadata: {},
      },
      {
        uuid: carolHumanUuid,
        name: "carol-h",
        type: "human",
        status: "active",
        visibility: "organization",
        organizationId: betaId,
        inboxId: `inbox-${carolHumanUuid.slice(0, 8)}`,
        managerId: carolMemberId,
        displayName: "Carol (human)",
        runtimeProvider: "noop",
        metadata: {},
      },
      {
        uuid: agentXUuid,
        name: "agent-x",
        type: "autonomous_agent",
        status: "active",
        visibility: "organization",
        organizationId: acmeId,
        inboxId: `inbox-${agentXUuid.slice(0, 8)}`,
        managerId: aliceMemberId,
        displayName: "Agent X",
        runtimeProvider: "claude",
        metadata: {},
      },
      {
        uuid: agentYUuid,
        name: "agent-y",
        type: "autonomous_agent",
        status: "active",
        visibility: "organization",
        organizationId: acmeId,
        inboxId: `inbox-${agentYUuid.slice(0, 8)}`,
        managerId: aliceMemberId,
        displayName: "Agent Y",
        runtimeProvider: "claude",
        metadata: {},
      },
      {
        uuid: agentZUuid,
        name: "agent-z",
        type: "autonomous_agent",
        status: "active",
        visibility: "organization",
        organizationId: acmeId,
        inboxId: `inbox-${agentZUuid.slice(0, 8)}`,
        managerId: bobMemberId,
        displayName: "Agent Z",
        runtimeProvider: "claude",
        metadata: {},
      },
      {
        uuid: agentPUuid,
        name: "agent-p",
        type: "autonomous_agent",
        status: "active",
        visibility: "organization",
        organizationId: betaId,
        inboxId: `inbox-${agentPUuid.slice(0, 8)}`,
        managerId: carolMemberId,
        displayName: "Agent P",
        runtimeProvider: "claude",
        metadata: {},
      },
    ]);

    await tx.insert(members).values([
      {
        id: aliceMemberId,
        userId: aliceId,
        organizationId: acmeId,
        agentId: aliceHumanUuid,
        role: "admin",
        status: "active",
      },
      {
        id: bobMemberId,
        userId: bobId,
        organizationId: acmeId,
        agentId: bobHumanUuid,
        role: "member",
        status: "active",
      },
      {
        id: carolMemberId,
        userId: carolId,
        organizationId: betaId,
        agentId: carolHumanUuid,
        role: "admin",
        status: "active",
      },
    ]);

    // ── Chats ────────────────────────────────────────────────────────
    // Scenario 1: human-human direct (Alice + Bob), both with read state
    const chat1 = randomUUID();
    // Scenario 2: agent-only direct (Agent X + Agent Y), mention_only both sides
    const chat2 = randomUUID();
    // Scenario 3: group (Alice + Bob + Agent X), all speakers, Alice has watcher view too
    const chat3 = randomUUID();
    // Scenario 4: watcher-only row (Alice manages Agent Z which is in chat by itself); only via subscription
    const chat4 = randomUUID();
    // Scenario 5: Beta org direct (cross-org isolation check)
    const chat5 = randomUUID();

    await tx.insert(chats).values([
      {
        id: chat1,
        organizationId: acmeId,
        type: "direct",
        topic: "1on1 alice bob",
        lastMessageAt: new Date(Date.now() - 1000 * 60 * 5),
        lastMessagePreview: "see you tomorrow",
      },
      {
        id: chat2,
        organizationId: acmeId,
        type: "direct",
        topic: null,
        lastMessageAt: new Date(Date.now() - 1000 * 60 * 30),
        lastMessagePreview: "research note",
      },
      {
        id: chat3,
        organizationId: acmeId,
        type: "group",
        topic: "design review",
        lastMessageAt: new Date(),
        lastMessagePreview: "shipping it",
      },
      {
        id: chat4,
        organizationId: acmeId,
        type: "direct",
        topic: "agent-z solo",
        lastMessageAt: new Date(Date.now() - 1000 * 60 * 60 * 24),
        lastMessagePreview: "auto report",
      },
      { id: chat5, organizationId: betaId, type: "direct", topic: null, lastMessageAt: null, lastMessagePreview: null },
    ]);

    // ── Legacy chat_participants ──────────────────────────────────────
    const fiveMinAgo = new Date(Date.now() - 1000 * 60 * 5);
    const oneHourAgo = new Date(Date.now() - 1000 * 60 * 60);

    await tx.insert(chatParticipants).values([
      // chat 1: Alice + Bob, both with read state
      {
        chatId: chat1,
        agentId: aliceHumanUuid,
        role: "owner",
        mode: "full",
        lastReadAt: fiveMinAgo,
        unreadMentionCount: 0,
      },
      {
        chatId: chat1,
        agentId: bobHumanUuid,
        role: "member",
        mode: "full",
        lastReadAt: oneHourAgo,
        unreadMentionCount: 2,
      },
      // chat 2: agent-only direct, mention_only on both ends
      {
        chatId: chat2,
        agentId: agentXUuid,
        role: "owner",
        mode: "mention_only",
        lastReadAt: null,
        unreadMentionCount: 0,
      },
      {
        chatId: chat2,
        agentId: agentYUuid,
        role: "member",
        mode: "mention_only",
        lastReadAt: null,
        unreadMentionCount: 1,
      },
      // chat 3: group (3 speakers); Alice owner full, Bob full, Agent X mention_only
      {
        chatId: chat3,
        agentId: aliceHumanUuid,
        role: "owner",
        mode: "full",
        lastReadAt: fiveMinAgo,
        unreadMentionCount: 0,
      },
      { chatId: chat3, agentId: bobHumanUuid, role: "member", mode: "full", lastReadAt: null, unreadMentionCount: 3 },
      {
        chatId: chat3,
        agentId: agentXUuid,
        role: "member",
        mode: "mention_only",
        lastReadAt: null,
        unreadMentionCount: 0,
      },
      // chat 4: Agent Z alone (will gain Alice as watcher below)
      {
        chatId: chat4,
        agentId: agentZUuid,
        role: "owner",
        mode: "mention_only",
        lastReadAt: oneHourAgo,
        unreadMentionCount: 0,
      },
      // chat 5: cross-org (Carol + Agent P)
      { chatId: chat5, agentId: carolHumanUuid, role: "owner", mode: "full", lastReadAt: null, unreadMentionCount: 0 },
      { chatId: chat5, agentId: agentPUuid, role: "member", mode: "full", lastReadAt: null, unreadMentionCount: 0 },
    ]);

    // ── Legacy chat_subscriptions ────────────────────────────────────
    await tx.insert(chatSubscriptions).values([
      // chat 3: Alice's "watching" view (she's also a speaker — this is the speaker-wins merge test case)
      { chatId: chat3, agentId: aliceHumanUuid, lastReadAt: fiveMinAgo, unreadMentionCount: 0 },
      // chat 4: Alice watches because she manages Agent Z (proper watcher, no participant row)
      { chatId: chat4, agentId: aliceHumanUuid, lastReadAt: oneHourAgo, unreadMentionCount: 5 },
      // Bob has a stale subscription on chat 4 even though he doesn't manage Agent Z anymore (legacy noise)
      { chatId: chat4, agentId: bobHumanUuid, lastReadAt: null, unreadMentionCount: 0 },
    ]);

    // ── A few messages so chats.last_message_at projection holds ─────
    await tx.insert(messages).values([
      {
        id: randomUUID(),
        chatId: chat1,
        senderId: aliceHumanUuid,
        format: "text",
        content: { text: "morning" },
        metadata: {},
        createdAt: new Date(Date.now() - 1000 * 60 * 5),
      },
      {
        id: randomUUID(),
        chatId: chat3,
        senderId: agentXUuid,
        format: "text",
        content: { text: "shipping it" },
        metadata: {},
        createdAt: new Date(),
      },
    ]);

    // ── Snapshot expected counts ─────────────────────────────────────
    const result = await tx.execute<{ p: number; s: number; collisions: number; with_state: number }>(sql`
    SELECT
      (SELECT COUNT(*) FROM chat_participants)::int AS p,
      (SELECT COUNT(*) FROM chat_subscriptions)::int AS s,
      (SELECT COUNT(*) FROM chat_participants cp
        WHERE EXISTS (SELECT 1 FROM chat_subscriptions cs
                       WHERE cs.chat_id = cp.chat_id AND cs.agent_id = cp.agent_id))::int AS collisions,
      (SELECT COUNT(*) FROM (
         SELECT chat_id, agent_id FROM chat_participants
           WHERE last_read_at IS NOT NULL OR unread_mention_count > 0
         UNION
         SELECT chat_id, agent_id FROM chat_subscriptions
           WHERE last_read_at IS NOT NULL OR unread_mention_count > 0
       ) u)::int AS with_state
  `);
    const r = result[0];
    console.log("");
    console.log("Seed complete. Pre-0038 counts:");
    console.log(`  chat_participants:  ${r?.p}`);
    console.log(`  chat_subscriptions: ${r?.s}`);
    console.log(`  collisions:         ${r?.collisions}  (proposal §3 invariant 1; speaker wins)`);
    console.log(`  union with state:   ${r?.with_state}  (= expected chat_user_state rows)`);
    console.log("");
    console.log("Expected post-0038:");
    console.log(`  chat_membership   = ${(r?.p ?? 0) + (r?.s ?? 0) - (r?.collisions ?? 0)} (union)`);
    console.log(`  speaker rows      = ${r?.p}`);
    console.log(`  watcher rows      = ${(r?.s ?? 0) - (r?.collisions ?? 0)}`);
    console.log(`  chat_user_state   = ${r?.with_state}`);
  });

  await db.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
