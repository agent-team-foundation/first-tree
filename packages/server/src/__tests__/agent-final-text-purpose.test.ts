import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { createChat, findOrCreateDirectChat } from "../services/chat.js";
import { sendMessage } from "../services/message.js";
import { createTestAgent, useTestApp } from "./helpers.js";

/**
 * v1 §四 改造 4 (b) — `purpose: "agent-final-text"` bypass channel.
 *
 * `result-sink.forwardResult` and `AskUserQuestion.canUseTool` (claude-code
 * handler) both call `sdk.sendMessage` with this tag set. Without the bypass,
 * the server's `enforceGroupMention` guard rejects every group-chat write
 * that has no explicit `@<name>` — and改造 4 deleted the auto-mention
 * injection that previously fed it. These tests pin:
 *
 *   1. group chat + no @ + `purpose` tag → message stored, every fan-out row
 *      is `notify=false`, no recipients are woken;
 *   2. group chat + no @ + NO `purpose` tag → still 400 (regression guard);
 *   3. direct chat: bypass also flips fan-out to silent so peer agents don't
 *      get woken by a stray final text;
 *   4. group chat WITH @ + `purpose` tag → still silent (the bypass also
 *      mutes wakeups it would otherwise produce — final text never wakes,
 *      even if it incidentally names someone).
 */

describe("sendMessage — agent-final-text bypass (v1 §四 改造 4 b)", () => {
  const getApp = useTestApp();

  it("accepts a group-chat send with no @ when purpose='agent-final-text' (no 400)", async () => {
    const app = getApp();
    const owner = await createTestAgent(app, { type: "human" });
    const peerA = await createTestAgent(app, { type: "autonomous_agent" });
    const peerB = await createTestAgent(app, { type: "autonomous_agent" });

    const chat = await createChat(app.db, owner.agent.uuid, {
      type: "group",
      participantIds: [peerA.agent.uuid, peerB.agent.uuid],
    });

    const result = await sendMessage(
      app.db,
      chat.id,
      peerA.agent.uuid,
      {
        format: "text",
        content: "i am done — turn ended",
        purpose: "agent-final-text",
      },
      { enforceGroupMention: true },
    );

    expect(result.message).toBeDefined();
    // No wake-ups: recipients list is empty (the inbox writes still happen
    // but every row is notify=false, see below).
    expect(result.recipients).toEqual([]);
  });

  it("forces every fan-out row to notify=false when purpose='agent-final-text'", async () => {
    const app = getApp();
    const owner = await createTestAgent(app, { type: "human" });
    const peerA = await createTestAgent(app, { type: "autonomous_agent" });
    const peerB = await createTestAgent(app, { type: "autonomous_agent" });

    const chat = await createChat(app.db, owner.agent.uuid, {
      type: "group",
      participantIds: [peerA.agent.uuid, peerB.agent.uuid],
    });

    const r = await sendMessage(
      app.db,
      chat.id,
      peerA.agent.uuid,
      {
        format: "text",
        content: "final text broadcast",
        purpose: "agent-final-text",
      },
      { enforceGroupMention: true },
    );

    // Every fan-out row for this message must be notify=false.
    const fanRows = await app.db
      .select({ inboxId: inboxEntries.inboxId, notify: inboxEntries.notify })
      .from(inboxEntries)
      .where(eq(inboxEntries.messageId, r.message.id));
    expect(fanRows.length).toBeGreaterThan(0);
    for (const row of fanRows) {
      expect(row.notify).toBe(false);
    }
  });

  it("still 400s when purpose is absent (regression guard for the enforce rule)", async () => {
    const app = getApp();
    const owner = await createTestAgent(app, { type: "human" });
    const peerA = await createTestAgent(app, { type: "autonomous_agent" });
    const peerB = await createTestAgent(app, { type: "autonomous_agent" });

    const chat = await createChat(app.db, owner.agent.uuid, {
      type: "group",
      participantIds: [peerA.agent.uuid, peerB.agent.uuid],
    });

    await expect(
      sendMessage(
        app.db,
        chat.id,
        peerA.agent.uuid,
        { format: "text", content: "i am done — turn ended" },
        { enforceGroupMention: true },
      ),
    ).rejects.toThrow(/explicit @mention/i);
  });

  it("direct chat: bypass forces fan-out notify=false even when peer would normally wake on mention", async () => {
    // direct chat agent↔agent is `mention_only` post-migration 0029. Without
    // the bypass, an explicit @<peer> here would wake peer; the bypass tag
    // must override that so final text never wakes anyone in any chat
    // shape — same invariant client-side `silent-turn` guards against.
    const app = getApp();
    const a = await createTestAgent(app, { type: "autonomous_agent" });
    const b = await createTestAgent(app, { type: "autonomous_agent" });

    const chat = await createChat(app.db, a.agent.uuid, {
      type: "direct",
      participantIds: [b.agent.uuid],
    });

    const r = await sendMessage(app.db, chat.id, a.agent.uuid, {
      format: "text",
      content: `@${b.agent.name} thanks`,
      metadata: { mentions: [b.agent.uuid] },
      purpose: "agent-final-text",
    });

    expect(r.recipients).toEqual([]);
    const fanRows = await app.db
      .select({ notify: inboxEntries.notify })
      .from(inboxEntries)
      .where(and(eq(inboxEntries.messageId, r.message.id), eq(inboxEntries.inboxId, b.agent.inboxId)));
    expect(fanRows.length).toBe(1);
    expect(fanRows[0]?.notify).toBe(false);
  });

  it("API integration: POST /agent/chats/:id/messages with purpose='agent-final-text' returns 201 on a group send without @", async () => {
    const app = getApp();
    const sender = await createTestAgent(app, { type: "autonomous_agent" });
    const peer = await createTestAgent(app, { type: "autonomous_agent" });

    const chatRes = await sender.request("POST", "/api/v1/agent/chats", {
      type: "group",
      participantIds: [peer.agent.uuid],
    });
    expect(chatRes.statusCode).toBe(201);
    const chatId = chatRes.json().id as string;

    const res = await sender.request("POST", `/api/v1/agent/chats/${chatId}/messages`, {
      format: "text",
      content: "this is my final text",
      purpose: "agent-final-text",
    });
    expect(res.statusCode).toBe(201);
  });

  it("API integration: same endpoint without `purpose` still rejects no-@ group sends with 400 (regression)", async () => {
    const app = getApp();
    const sender = await createTestAgent(app, { type: "autonomous_agent" });
    const peer = await createTestAgent(app, { type: "autonomous_agent" });

    const chatRes = await sender.request("POST", "/api/v1/agent/chats", {
      type: "group",
      participantIds: [peer.agent.uuid],
    });
    const chatId = chatRes.json().id as string;

    const res = await sender.request("POST", `/api/v1/agent/chats/${chatId}/messages`, {
      format: "text",
      content: "this is my final text",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/explicit @mention/i);
  });

  it("regression: cross-chat replyTo route still wakes the original delegator when reply carries purpose='agent-final-text'", async () => {
    // PR #393 v1.7 dogfood found that v1.6 over-tightened the bypass channel:
    // when A in c1 delegated to B via `chat send --direct B`, B's final-text
    // reply (which carries `purpose: "agent-final-text"`) had its cross-chat
    // replyTo inbox row force-set to notify=false. A never woke in c1, and
    // the conversation got stranded in c2.
    //
    // Fix: the cross-chat replyTo route is delegation-closure semantics, not
    // chat-internal peer wake. It honours `isSilentSend` only — the bypass
    // channel does NOT silence the back-channel to the original sender.
    const app = getApp();

    // Cast: A in chat c1 (group). B is NOT a member of c1.
    const a = await createTestAgent(app, { type: "autonomous_agent" });
    const human = await createTestAgent(app, { type: "human" });
    const b = await createTestAgent(app, { type: "autonomous_agent" });

    const c1 = await createChat(app.db, a.agent.uuid, {
      type: "group",
      participantIds: [human.agent.uuid],
    });

    // A delegates: sends to B with replyToChat=c1 (the env-bound chat),
    // mirroring what CLI `chat send --direct B` does behind the scenes.
    const c2 = await findOrCreateDirectChat(app.db, a.agent.uuid, b.agent.uuid);
    const delegated = await sendMessage(app.db, c2.id, a.agent.uuid, {
      format: "text",
      content: `@${b.agent.name} please answer the user's question`,
      metadata: { mentions: [b.agent.uuid] },
      replyToInbox: a.agent.inboxId,
      replyToChat: c1.id,
    });

    // B's session forwards its final text via result-sink — same shape
    // result-sink uses (`purpose: "agent-final-text"` + `inReplyTo` set).
    const reply = await sendMessage(app.db, c2.id, b.agent.uuid, {
      format: "text",
      content: "Sure, the answer is X.",
      inReplyTo: delegated.message.id,
      purpose: "agent-final-text",
    });

    // The cross-chat replyTo row routed back to A in c1 must be notify=true
    // — otherwise A never wakes and the delegation is stranded in c2.
    const replyRow = await app.db
      .select({ notify: inboxEntries.notify, chatId: inboxEntries.chatId })
      .from(inboxEntries)
      .where(
        and(
          eq(inboxEntries.messageId, reply.message.id),
          eq(inboxEntries.inboxId, a.agent.inboxId),
          eq(inboxEntries.chatId, c1.id),
        ),
      );
    expect(replyRow.length).toBe(1);
    expect(replyRow[0]?.notify).toBe(true);

    // And the c2 in-chat fan-out still respects the bypass — A's c2 row
    // (if any) stays notify=false so we don't ALSO wake A in c2.
    const c2Rows = await app.db
      .select({ notify: inboxEntries.notify })
      .from(inboxEntries)
      .where(
        and(
          eq(inboxEntries.messageId, reply.message.id),
          eq(inboxEntries.inboxId, a.agent.inboxId),
          eq(inboxEntries.chatId, c2.id),
        ),
      );
    for (const row of c2Rows) {
      expect(row.notify).toBe(false);
    }

    // recipients reflects the wake-up signal sent to PG NOTIFY layer —
    // A's inbox should be there (because the replyTo back-channel woke it).
    expect(reply.recipients).toContain(a.agent.inboxId);
  });

  it("silent-send (empty content after @-strip) still silences the cross-chat replyTo row", async () => {
    // The fix above only loosened `isAgentFinalText`. The `isSilentSend`
    // path — message body collapses to mention prefix only — should still
    // silence the back-channel so the silent-send invariant holds.
    const app = getApp();
    const a = await createTestAgent(app, { type: "autonomous_agent" });
    const b = await createTestAgent(app, { type: "autonomous_agent" });
    const c1 = await createChat(app.db, a.agent.uuid, {
      type: "group",
      participantIds: [b.agent.uuid],
    });
    const c2 = await findOrCreateDirectChat(app.db, a.agent.uuid, b.agent.uuid);
    const seed = await sendMessage(app.db, c2.id, a.agent.uuid, {
      format: "text",
      content: `@${b.agent.name} ping`,
      metadata: { mentions: [b.agent.uuid] },
      replyToInbox: a.agent.inboxId,
      replyToChat: c1.id,
    });
    // A silent-send: just an @-prefix, nothing after.
    const silent = await sendMessage(app.db, c2.id, b.agent.uuid, {
      format: "text",
      content: `@${a.agent.name}`,
      inReplyTo: seed.message.id,
    });
    const rows = await app.db
      .select({ notify: inboxEntries.notify })
      .from(inboxEntries)
      .where(
        and(
          eq(inboxEntries.messageId, silent.message.id),
          eq(inboxEntries.inboxId, a.agent.inboxId),
          eq(inboxEntries.chatId, c1.id),
        ),
      );
    for (const row of rows) {
      expect(row.notify).toBe(false);
    }
  });
});
