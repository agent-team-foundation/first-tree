import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Database } from "../db/connection.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { createChat, ensureParticipant } from "../services/chat.js";
import { PRECEDING_CONTEXT_MAX_ENTRIES } from "../services/inbox.js";
import { addMeChatParticipants } from "../services/me-chat.js";
import { sendMessage } from "../services/message.js";
import { addChatParticipants } from "../services/participant-mode.js";
import { createTestAdmin, createTestAgent, useTestApp } from "./helpers.js";

/**
 * Silent-context backfill invariant — covers every join entrypoint via the
 * single helper `addChatParticipants` (proposal: backfill anchored to the
 * row-write helper, not service entrypoints).
 *
 * Companion to `add-participant-backfill.test.ts` (which pins the
 * `chat.ts::addParticipant` entrypoint specifically). The cases here pin the
 * helper-layer contract so any new join entrypoint that routes through
 * `addChatParticipants` inherits backfill automatically.
 *
 * Why this exists: PR #393 originally hooked backfill at
 * `chat.ts::addParticipant`. The web "add member" button went through
 * `me-chat.ts::addMeChatParticipants` instead, silently regressing the
 * invariant. Sinking backfill into the helper closes that whole class of
 * bug. These tests are the guard rail.
 */

async function countSilentEntries(db: Database, inboxId: string, chatId: string): Promise<number> {
  const rows = await db
    .select({ id: inboxEntries.id })
    .from(inboxEntries)
    .where(
      and(
        eq(inboxEntries.inboxId, inboxId),
        eq(inboxEntries.chatId, chatId),
        eq(inboxEntries.notify, false),
        eq(inboxEntries.status, "pending"),
      ),
    );
  return rows.length;
}

describe("addChatParticipants — silent-context backfill invariant", () => {
  const getApp = useTestApp();

  it("brand-new joiner inserted directly via helper gets backfilled", async () => {
    const app = getApp();
    const owner = await createTestAgent(app, { type: "human" });
    const peer = await createTestAgent(app, { type: "agent" });
    const newcomer = await createTestAgent(app, { type: "agent" });

    const chat = await createChat(app.db, owner.agent.uuid, {
      type: "group",
      participantIds: [peer.agent.uuid],
    });
    for (let i = 0; i < 7; i++) {
      await sendMessage(
        app.db,
        chat.id,
        owner.agent.uuid,
        { source: "api", format: "text", content: `m${i}` },
        {
          allowRecipientlessSend: true,
        },
      );
    }

    await app.db.transaction((tx) =>
      addChatParticipants(tx, chat.id, [{ agentId: newcomer.agent.uuid, role: "member" }]),
    );

    expect(await countSilentEntries(app.db, newcomer.agent.inboxId, chat.id)).toBe(7);
  });

  it("watcher → speaker upgrade is treated as a join and triggers backfill", async () => {
    // Watchers do not receive inbox fan-out (message.ts only joins
    // access_mode='speaker'), so the moment they become speakers everything
    // before that moment is unreachable without the silent replay.
    const app = getApp();
    const owner = await createTestAgent(app, { type: "human" });
    const peer = await createTestAgent(app, { type: "agent" });
    const promoted = await createTestAgent(app, { type: "agent" });

    const chat = await createChat(app.db, owner.agent.uuid, {
      type: "group",
      participantIds: [peer.agent.uuid],
    });
    for (let i = 0; i < 4; i++) {
      await sendMessage(
        app.db,
        chat.id,
        owner.agent.uuid,
        { source: "api", format: "text", content: `w${i}` },
        {
          allowRecipientlessSend: true,
        },
      );
    }

    // Seed a watcher row directly — recomputeChatWatchers would also work
    // but routes through the manager join logic; we want to pin the helper
    // behaviour in isolation.
    await app.db.insert(chatMembership).values({
      chatId: chat.id,
      agentId: promoted.agent.uuid,
      role: "member",
      accessMode: "watcher",
      mode: "mention_only",
      source: "manual",
    });

    // Watcher had no inbox rows so far (fan-out skips them).
    expect(await countSilentEntries(app.db, promoted.agent.inboxId, chat.id)).toBe(0);

    await app.db.transaction((tx) =>
      addChatParticipants(tx, chat.id, [{ agentId: promoted.agent.uuid }], { upgradeWatcherToSpeaker: true }),
    );

    expect(await countSilentEntries(app.db, promoted.agent.inboxId, chat.id)).toBe(4);
  });

  it("already-speaker no-op insert does not double-backfill", async () => {
    const app = getApp();
    const owner = await createTestAgent(app, { type: "human" });
    const newcomer = await createTestAgent(app, { type: "agent" });

    const chat = await createChat(app.db, owner.agent.uuid, {
      type: "group",
      participantIds: [newcomer.agent.uuid],
    });
    for (let i = 0; i < 3; i++) {
      await sendMessage(
        app.db,
        chat.id,
        owner.agent.uuid,
        { source: "api", format: "text", content: `n${i}` },
        {
          allowRecipientlessSend: true,
        },
      );
    }

    // `newcomer` was added as a speaker at chat creation time; createChat
    // sends no messages of its own, so the silent-row count is currently 0
    // (backfill ran but found no prior history). Now seed history and
    // re-invoke helper as an idempotent UPSERT — no new silent rows.
    const before = await countSilentEntries(app.db, newcomer.agent.inboxId, chat.id);

    await app.db.transaction((tx) =>
      addChatParticipants(tx, chat.id, [{ agentId: newcomer.agent.uuid }], { upgradeWatcherToSpeaker: true }),
    );

    expect(await countSilentEntries(app.db, newcomer.agent.inboxId, chat.id)).toBe(before);
  });

  it("mixed batch backfills only the agents that crossed into speaker", async () => {
    const app = getApp();
    const owner = await createTestAgent(app, { type: "human" });
    const existing = await createTestAgent(app, { type: "agent" });
    const brandNew = await createTestAgent(app, { type: "agent" });

    const chat = await createChat(app.db, owner.agent.uuid, {
      type: "group",
      participantIds: [existing.agent.uuid],
    });
    for (let i = 0; i < 5; i++) {
      await sendMessage(
        app.db,
        chat.id,
        owner.agent.uuid,
        { source: "api", format: "text", content: `b${i}` },
        {
          allowRecipientlessSend: true,
        },
      );
    }

    const existingBefore = await countSilentEntries(app.db, existing.agent.inboxId, chat.id);

    await app.db.transaction((tx) =>
      addChatParticipants(
        tx,
        chat.id,
        [
          { agentId: existing.agent.uuid }, // already a speaker — must NOT re-backfill
          { agentId: brandNew.agent.uuid }, // brand-new — must backfill
        ],
        { upgradeWatcherToSpeaker: true },
      ),
    );

    expect(await countSilentEntries(app.db, existing.agent.inboxId, chat.id)).toBe(existingBefore);
    expect(await countSilentEntries(app.db, brandNew.agent.inboxId, chat.id)).toBe(5);
  });
});

describe("backfill invariant — service entrypoints (regression: PR #393 follow-up)", () => {
  const getApp = useTestApp();

  it("addMeChatParticipants (web `POST /chats/:id/participants`) backfills the joiner", async () => {
    // The bug this PR fixes: the web "add member" button went through
    // `addMeChatParticipants`, which never called `backfillSilentContext...`.
    // The agent joined with an empty inbox and read no history.
    const app = getApp();
    const owner = await createTestAdmin(app);
    const peer = await createTestAgent(app, { type: "agent", name: "amcp-peer" });
    const newcomer = await createTestAgent(app, { type: "agent", name: "amcp-newcomer" });

    const chat = await createChat(app.db, owner.humanAgentUuid, {
      type: "group",
      participantIds: [peer.agent.uuid],
    });
    for (let i = 0; i < 6; i++) {
      await sendMessage(
        app.db,
        chat.id,
        owner.humanAgentUuid,
        {
          source: "api",
          format: "text",
          content: `web-${i}`,
        },
        { allowRecipientlessSend: true },
      );
    }

    await addMeChatParticipants(app.db, chat.id, owner.humanAgentUuid, owner.organizationId, {
      participantIds: [newcomer.agent.uuid],
    });

    expect(await countSilentEntries(app.db, newcomer.agent.inboxId, chat.id)).toBe(6);
  });

  it("ensureParticipant (adapter/HTTP send fallback) backfills the joiner on first call", async () => {
    // adapter-mapping calls ensureParticipant on every IM message. The first
    // call promotes a missing/watcher row to speaker — that crossing must
    // backfill. Subsequent calls short-circuit (already a speaker) and must
    // not re-backfill.
    const app = getApp();
    const owner = await createTestAgent(app, { type: "human" });
    const peer = await createTestAgent(app, { type: "agent" });
    const newcomer = await createTestAgent(app, { type: "agent" });

    const chat = await createChat(app.db, owner.agent.uuid, {
      type: "group",
      participantIds: [peer.agent.uuid],
    });
    for (let i = 0; i < 5; i++) {
      await sendMessage(
        app.db,
        chat.id,
        owner.agent.uuid,
        { source: "api", format: "text", content: `e${i}` },
        {
          allowRecipientlessSend: true,
        },
      );
    }

    await ensureParticipant(app.db, chat.id, newcomer.agent.uuid);
    expect(await countSilentEntries(app.db, newcomer.agent.inboxId, chat.id)).toBe(5);

    // Idempotent: a second call (e.g. the next IM message) must not double up.
    await ensureParticipant(app.db, chat.id, newcomer.agent.uuid);
    expect(await countSilentEntries(app.db, newcomer.agent.inboxId, chat.id)).toBe(5);
  });

  it("backfill caps at PRECEDING_CONTEXT_MAX_ENTRIES across helper-level invocations", async () => {
    // Sanity: the helper does not bypass the global cap when called directly.
    const app = getApp();
    const owner = await createTestAgent(app, { type: "human" });
    const peer = await createTestAgent(app, { type: "agent" });
    const newcomer = await createTestAgent(app, { type: "agent" });

    const chat = await createChat(app.db, owner.agent.uuid, {
      type: "group",
      participantIds: [peer.agent.uuid],
    });
    const total = PRECEDING_CONTEXT_MAX_ENTRIES + 10;
    for (let i = 0; i < total; i++) {
      await sendMessage(
        app.db,
        chat.id,
        owner.agent.uuid,
        { source: "api", format: "text", content: `c${i}` },
        {
          allowRecipientlessSend: true,
        },
      );
    }

    await app.db.transaction((tx) => addChatParticipants(tx, chat.id, [{ agentId: newcomer.agent.uuid }]));

    expect(await countSilentEntries(app.db, newcomer.agent.inboxId, chat.id)).toBe(PRECEDING_CONTEXT_MAX_ENTRIES);
  });
});
