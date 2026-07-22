import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { chatUserState } from "../db/schema/chat-user-state.js";
import { messages } from "../db/schema/messages.js";
import { BadRequestError } from "../errors.js";
import { createAgent } from "../services/agent.js";
import { createChat } from "../services/chat.js";
import { listMeChats } from "../services/me-chat.js";
import { editMessage, sendMessage } from "../services/message.js";
import { createTestAdmin, createTestAgent, TEST_AVATAR_AUTHORITY_TAG, useTestApp } from "./helpers.js";

/**
 * Open-question (group-chat-unified-send P4) service-layer contract:
 *
 *   - `format=request` is an "ask" directed at exactly one human (the sole
 *     `metadata.mentions` entry) — enforced at the service layer.
 *   - `chat_user_state.open_request_count` is the answer-cleared counter
 *     behind the `needs_you` red-dot:
 *       +1  a FRESH request (format=request) → target human.
 *       -1  an EXPLICIT resolution: a message carrying
 *           `metadata.resolves = {request, kind}` pointed at the question,
 *           ONLY from the target human (the web answer). An agent — including
 *           the asker — cannot resolve. Idempotent and floored at zero.
 *   - `inReplyTo` is pure threading and NEVER resolves: a "chat about this"
 *     discussion reply leaves the question open. Re-asking (a new
 *     `format=request`) opens a second independent question (+1) — it does
 *     not auto-supersede the one it threads under.
 *   - An invalid `resolves` target FAILS LOUD: the whole send is rejected
 *     (tx rollback, no message row) when the request id is missing from this
 *     chat, points at a non-request message, or the sender is not the target
 *     human (resolution is human-only — an agent, including the asker, cannot
 *     resolve). Re-resolving an already-resolved question stays a soft success
 *     (idempotent counter).
 *
 * No lifecycle state is stored on the message — these tests pin the counter,
 * which is the only persisted signal.
 */
describe("open-question (format=request) + open_request_count", () => {
  const getApp = useTestApp();

  async function openReqCount(app: ReturnType<typeof getApp>, chatId: string, agentUuid: string): Promise<number> {
    const [row] = await app.db
      .select({ c: chatUserState.openRequestCount })
      .from(chatUserState)
      .where(and(eq(chatUserState.chatId, chatId), eq(chatUserState.agentId, agentUuid)))
      .limit(1);
    return row?.c ?? 0;
  }

  async function setup(app: ReturnType<typeof getApp>, uid: string) {
    const asker = await createTestAgent(app, { name: `oq-asker-${uid}` });
    const { agent: human } = await createTestAgent(app, { name: `oq-human-${uid}`, type: "human" });
    const { agent: other } = await createTestAgent(app, { name: `oq-other-${uid}` });
    const chat = await createChat(app.db, asker.agent.uuid, {
      type: "group",
      participantIds: [human.uuid, other.uuid],
    });
    return { asker, human, other, chat };
  }

  it("a fresh request increments the target human's open_request_count by 1", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const { asker, human, chat } = await setup(app, uid);

    await sendMessage(app.db, chat.id, asker.agent.uuid, {
      source: "api",
      format: "request",
      content: "Confirm the rollout ratio before we ship.",
      metadata: { mentions: [human.uuid], request: { question: "5% first, or straight to 20%?" } },
    });

    expect(await openReqCount(app, chat.id, human.uuid)).toBe(1);
  });

  it("rejects a request that does not mention exactly one recipient", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const { asker, human, other, chat } = await setup(app, uid);

    await expect(
      sendMessage(app.db, chat.id, asker.agent.uuid, {
        source: "api",
        format: "request",
        content: "ask",
        metadata: { mentions: [human.uuid, other.uuid] },
      }),
    ).rejects.toThrow(/exactly one/i);

    await expect(
      sendMessage(app.db, chat.id, asker.agent.uuid, {
        source: "api",
        format: "request",
        content: "ask",
        // no mentions at all
      }),
    ).rejects.toThrow(/exactly one/i);
  });

  it("rejects a request whose single target is not a human", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const { asker, other, chat } = await setup(app, uid);

    await expect(
      sendMessage(app.db, chat.id, asker.agent.uuid, {
        source: "api",
        format: "request",
        content: "ask",
        metadata: { mentions: [other.uuid] }, // `other` is an agent, not a human
      }),
    ).rejects.toThrow(/human/i);
  });

  it("allows an agent's plain (non-request) message addressed to a human — `chat send` reaches a human", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const { asker, human, other, chat } = await setup(app, uid);

    // Agent → human as a plain message is a free reply / conversational answer:
    // it lands in history like any other send and does NOT open a question.
    await sendMessage(app.db, chat.id, asker.agent.uuid, {
      source: "api",
      format: "text",
      content: "quick update for you",
      metadata: { mentions: [human.uuid] },
    });

    // Mixed mention (agent + human) in any format is fine too.
    await sendMessage(app.db, chat.id, asker.agent.uuid, {
      source: "api",
      format: "markdown",
      content: "**fyi** both",
      metadata: { mentions: [other.uuid, human.uuid] },
    });

    // Both sends landed in history — a plain agent→human send raises no red dot.
    const landed = await app.db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.chatId, chat.id), eq(messages.senderId, asker.agent.uuid)));
    expect(landed).toHaveLength(2);
    expect(await openReqCount(app, chat.id, human.uuid)).toBe(0);

    // The same target as an ASK (format=request) still opens a tracked question.
    await sendMessage(app.db, chat.id, asker.agent.uuid, {
      source: "api",
      format: "request",
      content: "need a quick decision",
      metadata: { mentions: [human.uuid], request: { question: "ok to ship?" } },
    });
    expect(await openReqCount(app, chat.id, human.uuid)).toBe(1);

    // Agent → agent plain message is unaffected.
    await sendMessage(app.db, chat.id, asker.agent.uuid, {
      source: "api",
      format: "text",
      content: "ping",
      metadata: { mentions: [other.uuid] },
    });

    // A HUMAN sender addressing anyone is unaffected.
    await sendMessage(app.db, chat.id, human.uuid, {
      source: "web",
      format: "text",
      content: "hi team",
      metadata: { mentions: [other.uuid] },
    });
  });

  it("an explicit answer resolution decrements the count; further resolutions are no-ops", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const { asker, human, chat } = await setup(app, uid);

    const { message: question } = await sendMessage(app.db, chat.id, asker.agent.uuid, {
      source: "api",
      format: "request",
      content: "ratio?",
      metadata: { mentions: [human.uuid], request: { question: "5% or 20%?" } },
    });
    expect(await openReqCount(app, chat.id, human.uuid)).toBe(1);

    // The target answers explicitly (metadata.resolves) → -1. `inReplyTo` is
    // set for threading but is NOT what drives the decrement.
    await sendMessage(
      app.db,
      chat.id,
      human.uuid,
      {
        source: "web",
        format: "text",
        content: "5% or 20%? → 5%",
        inReplyTo: question.id,
        metadata: { resolves: { request: question.id, kind: "answered" } },
      },
      { allowRecipientlessSend: true },
    );
    expect(await openReqCount(app, chat.id, human.uuid)).toBe(0);

    // A second resolution of the SAME question must NOT decrement again
    // (idempotent, floored at zero).
    await sendMessage(
      app.db,
      chat.id,
      human.uuid,
      {
        source: "web",
        format: "text",
        content: "5% or 20%? → still 5%",
        metadata: { resolves: { request: question.id, kind: "answered" } },
      },
      { allowRecipientlessSend: true },
    );
    expect(await openReqCount(app, chat.id, human.uuid)).toBe(0);
  });

  it("a threaded discussion reply (inReplyTo set, no resolves) does NOT change the count", async () => {
    // The core "chat about this" guarantee: the human and asking agent can go
    // back and forth threaded under the question without resolving it.
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const { asker, human, chat } = await setup(app, uid);

    const { message: question } = await sendMessage(app.db, chat.id, asker.agent.uuid, {
      source: "api",
      format: "request",
      content: "ratio?",
      metadata: { mentions: [human.uuid], request: { question: "5% or 20%?" } },
    });
    expect(await openReqCount(app, chat.id, human.uuid)).toBe(1);

    // Human threads a clarifying question onto the request — no resolves.
    const { message: disc } = await sendMessage(
      app.db,
      chat.id,
      human.uuid,
      { source: "web", format: "text", content: "what's the rollback window?", inReplyTo: question.id },
      { allowRecipientlessSend: true },
    );
    expect(await openReqCount(app, chat.id, human.uuid)).toBe(1);

    // Asking agent replies into the discussion line — still no resolves.
    await sendMessage(
      app.db,
      chat.id,
      asker.agent.uuid,
      { source: "api", format: "text", content: "seconds — old env stays warm", inReplyTo: disc.id },
      { allowRecipientlessSend: true },
    );
    expect(await openReqCount(app, chat.id, human.uuid)).toBe(1);
  });

  it("a plain reply with neither inReplyTo nor resolves does not change the count", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const { asker, human, chat } = await setup(app, uid);

    await sendMessage(app.db, chat.id, asker.agent.uuid, {
      source: "api",
      format: "request",
      content: "ratio?",
      metadata: { mentions: [human.uuid], request: { question: "5% or 20%?" } },
    });
    expect(await openReqCount(app, chat.id, human.uuid)).toBe(1);

    await sendMessage(
      app.db,
      chat.id,
      human.uuid,
      { source: "web", format: "text", content: "give me a sec" },
      { allowRecipientlessSend: true },
    );
    expect(await openReqCount(app, chat.id, human.uuid)).toBe(1);
  });

  it("re-asking (a new format=request) opens a SECOND independent question (+1, no auto-supersede)", async () => {
    // Under the explicit-resolution model a new request never auto-closes the
    // one it threads under — both stay open and the human works them
    // oldest-first (re-asking opens a new, independent question).
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const { asker, human, chat } = await setup(app, uid);

    const { message: question } = await sendMessage(app.db, chat.id, asker.agent.uuid, {
      source: "api",
      format: "request",
      content: "ratio?",
      metadata: { mentions: [human.uuid], request: { question: "5% or 20%?" } },
    });
    expect(await openReqCount(app, chat.id, human.uuid)).toBe(1);

    await sendMessage(app.db, chat.id, asker.agent.uuid, {
      source: "api",
      format: "request",
      content: "(re-ask) to be clear:",
      inReplyTo: question.id,
      metadata: { mentions: [human.uuid], request: { question: "5%, 10%, or 20%?" } },
    });

    // Two independent open questions now.
    expect(await openReqCount(app, chat.id, human.uuid)).toBe(2);
  });

  it("the asking agent CANNOT resolve its own question — resolution is human-only", async () => {
    // The asker raises the question but can neither answer nor close it; only
    // the target human resolves (in the web UI). Both shapes of an asker-sent
    // resolution are refused, and the open count stays up.
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const { asker, human, chat } = await setup(app, uid);

    const { message: question } = await sendMessage(app.db, chat.id, asker.agent.uuid, {
      source: "api",
      format: "request",
      content: "ratio?",
      metadata: { mentions: [human.uuid], request: {} },
    });
    expect(await openReqCount(app, chat.id, human.uuid)).toBe(1);

    // Recipientless asker resolution (the old "resolve on the human's behalf"
    // shape) is refused by the resolution authz — only the target may resolve.
    await expect(
      sendMessage(
        app.db,
        chat.id,
        asker.agent.uuid,
        {
          source: "api",
          format: "text",
          content: "Going with 20%.",
          metadata: { resolves: { request: question.id, kind: "answered" } },
        },
        { allowRecipientlessSend: true },
      ),
    ).rejects.toThrow(/only the question's target may resolve/i);
    expect(await openReqCount(app, chat.id, human.uuid)).toBe(1);

    // Addressing the human is fine as a plain send now, but the resolution authz
    // still refuses an asker-written resolution — only the target may resolve, so
    // the count holds.
    await expect(
      sendMessage(app.db, chat.id, asker.agent.uuid, {
        source: "api",
        format: "text",
        content: "Going with 20%.",
        metadata: { mentions: [human.uuid], resolves: { request: question.id, kind: "answered" } },
      }),
    ).rejects.toThrow(/only the question's target may resolve/i);
    expect(await openReqCount(app, chat.id, human.uuid)).toBe(1);
  });

  it("the target human resolves their own question (web answer) → clears the count", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const { asker, human, chat } = await setup(app, uid);

    const { message: question } = await sendMessage(app.db, chat.id, asker.agent.uuid, {
      source: "api",
      format: "request",
      content: "ratio?",
      metadata: { mentions: [human.uuid], request: {} },
    });
    expect(await openReqCount(app, chat.id, human.uuid)).toBe(1);

    // The human's web answer carries the resolution; senderId === target → allowed.
    await sendMessage(
      app.db,
      chat.id,
      human.uuid,
      {
        source: "web",
        format: "text",
        content: "Going with 20%.",
        inReplyTo: question.id,
        metadata: { resolves: { request: question.id, kind: "answered" } },
      },
      { allowRecipientlessSend: true },
    );
    expect(await openReqCount(app, chat.id, human.uuid)).toBe(0);
  });

  it("a plain agent→human send WITHOUT a resolution is allowed (free reply, no red dot)", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const { asker, human, chat } = await setup(app, uid);

    await sendMessage(app.db, chat.id, asker.agent.uuid, {
      source: "api",
      format: "text",
      content: "just pinging you",
      metadata: { mentions: [human.uuid] },
    });
    // It lands as an ordinary message and opens no tracked question.
    expect(await openReqCount(app, chat.id, human.uuid)).toBe(0);
  });

  it("a resolves from anyone other than the target is REJECTED (unauthorized, fail loud)", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const { asker, human, other, chat } = await setup(app, uid);

    const { message: question } = await sendMessage(app.db, chat.id, asker.agent.uuid, {
      source: "api",
      format: "request",
      content: "ratio?",
      metadata: { mentions: [human.uuid], request: { question: "5% or 20%?" } },
    });
    expect(await openReqCount(app, chat.id, human.uuid)).toBe(1);

    // `other` (an unrelated participant, not the target human) tries to resolve
    // — must fail loud.
    await expect(
      sendMessage(
        app.db,
        chat.id,
        other.uuid,
        {
          source: "api",
          format: "text",
          content: "I'll close this",
          metadata: { resolves: { request: question.id, kind: "answered" } },
        },
        { allowRecipientlessSend: true },
      ),
    ).rejects.toThrow(/only the question's target may resolve/i);
    expect(await openReqCount(app, chat.id, human.uuid)).toBe(1);

    // The rejected send must not leave a message in history (tx rollback).
    const stray = await app.db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.chatId, chat.id), eq(messages.senderId, other.uuid)));
    expect(stray).toHaveLength(0);
  });

  it("a resolves pointed at a nonexistent message id is REJECTED and writes nothing", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const { asker, human, chat } = await setup(app, uid);

    await sendMessage(app.db, chat.id, asker.agent.uuid, {
      source: "api",
      format: "request",
      content: "ratio?",
      metadata: { mentions: [human.uuid], request: { question: "5% or 20%?" } },
    });
    expect(await openReqCount(app, chat.id, human.uuid)).toBe(1);

    // Stale/bogus id (the QA `--answer <missing id>` shape) — fail loud.
    await expect(
      sendMessage(
        app.db,
        chat.id,
        asker.agent.uuid,
        {
          source: "api",
          format: "text",
          content: "STALE_ANSWER_SHOULD_FAIL",
          inReplyTo: "00000000-0000-0000-0000-000000000000",
          metadata: { resolves: { request: "00000000-0000-0000-0000-000000000000", kind: "answered" } },
        },
        { allowRecipientlessSend: true },
      ),
    ).rejects.toThrow(/no such message/i);
    expect(await openReqCount(app, chat.id, human.uuid)).toBe(1);

    // Rollback: no dangling resolution message in history.
    const stale = await app.db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.chatId, chat.id), sql`${messages.metadata} -> 'resolves' ->> 'kind' IS NOT NULL`));
    expect(stale).toHaveLength(0);
  });

  it("a resolves pointed at a message in ANOTHER chat is REJECTED", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const { asker, human, chat } = await setup(app, uid);
    const otherChat = await createChat(app.db, asker.agent.uuid, {
      type: "group",
      participantIds: [human.uuid],
    });

    const { message: question } = await sendMessage(app.db, otherChat.id, asker.agent.uuid, {
      source: "api",
      format: "request",
      content: "ratio?",
      metadata: { mentions: [human.uuid], request: { question: "5% or 20%?" } },
    });

    // Real request id, wrong chat — must not resolve across chats.
    await expect(
      sendMessage(
        app.db,
        chat.id,
        asker.agent.uuid,
        {
          source: "api",
          format: "text",
          content: "cross-chat resolve",
          metadata: { resolves: { request: question.id, kind: "answered" } },
        },
        { allowRecipientlessSend: true },
      ),
    ).rejects.toThrow(/no such message/i);
    expect(await openReqCount(app, otherChat.id, human.uuid)).toBe(1);
  });

  it("a resolves pointed at a non-request message is REJECTED", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const { asker, human, chat } = await setup(app, uid);

    const { message: plain } = await sendMessage(
      app.db,
      chat.id,
      asker.agent.uuid,
      { source: "api", format: "text", content: "just a remark" },
      { allowRecipientlessSend: true },
    );

    await expect(
      sendMessage(
        app.db,
        chat.id,
        asker.agent.uuid,
        {
          source: "api",
          format: "text",
          content: "closing a non-question",
          metadata: { resolves: { request: plain.id, kind: "closed" } },
        },
        { allowRecipientlessSend: true },
      ),
    ).rejects.toThrow(/not a tracked request/i);
    expect(await openReqCount(app, chat.id, human.uuid)).toBe(0);
  });

  it("a MALFORMED metadata.resolves is REJECTED outright (never stored as inert metadata)", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const { asker, human, chat } = await setup(app, uid);

    const { message: question } = await sendMessage(app.db, chat.id, asker.agent.uuid, {
      source: "api",
      format: "request",
      content: "ratio?",
      metadata: { mentions: [human.uuid], request: { question: "5% or 20%?" } },
    });
    expect(await openReqCount(app, chat.id, human.uuid)).toBe(1);

    // Valid request id but a bogus `kind` — must fail loud on the schema parse
    // (before any authz), not land as ordinary metadata (which would poison the
    // priors scan).
    await expect(
      sendMessage(
        app.db,
        chat.id,
        asker.agent.uuid,
        {
          source: "api",
          format: "text",
          content: "resolving with a typo'd kind",
          metadata: { resolves: { request: question.id, kind: "anwsered" } },
        },
        { allowRecipientlessSend: true },
      ),
    ).rejects.toThrow(/malformed "metadata.resolves"/i);
    // Missing `kind` entirely — same rejection.
    await expect(
      sendMessage(
        app.db,
        chat.id,
        asker.agent.uuid,
        {
          source: "api",
          format: "text",
          content: "resolving with no kind",
          metadata: { resolves: { request: question.id } },
        },
        { allowRecipientlessSend: true },
      ),
    ).rejects.toThrow(/malformed "metadata.resolves"/i);
    expect(await openReqCount(app, chat.id, human.uuid)).toBe(1);

    // Rollback: neither malformed send left a message row.
    const stray = await app.db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.chatId, chat.id), sql`${messages.metadata} ? 'resolves'`));
    expect(stray).toHaveLength(0);

    // The legitimate resolution (from the target human) still works and clears
    // the count.
    await sendMessage(
      app.db,
      chat.id,
      human.uuid,
      {
        source: "web",
        format: "text",
        content: "confirmed: 5%",
        metadata: { resolves: { request: question.id, kind: "answered" } },
      },
      { allowRecipientlessSend: true },
    );
    expect(await openReqCount(app, chat.id, human.uuid)).toBe(0);
  });

  it("a malformed legacy resolves row (pre-validation) does NOT block a later legitimate resolution", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const { asker, human, chat } = await setup(app, uid);

    const { message: question } = await sendMessage(app.db, chat.id, asker.agent.uuid, {
      source: "api",
      format: "request",
      content: "ratio?",
      metadata: { mentions: [human.uuid], request: { question: "5% or 20%?" } },
    });
    expect(await openReqCount(app, chat.id, human.uuid)).toBe(1);

    // A pre-validation row whose sender is in the priors-scan scope (the asker,
    // kept in scope for legacy rows) with a malformed kind: it matches the priors
    // scan on `resolves ->> 'request'` + sender, but is not a schema-valid
    // resolution — it must not count as a "prior".
    await app.db.insert(messages).values({
      id: crypto.randomUUID(),
      chatId: chat.id,
      senderId: asker.agent.uuid,
      format: "text",
      content: "legacy malformed resolve",
      metadata: { resolves: { request: question.id, kind: "anwsered" } },
      source: "api",
    });

    // The target human's legitimate resolution still decrements past it.
    await sendMessage(
      app.db,
      chat.id,
      human.uuid,
      {
        source: "web",
        format: "text",
        content: "confirmed: 5%",
        metadata: { resolves: { request: question.id, kind: "answered" } },
      },
      { allowRecipientlessSend: true },
    );
    expect(await openReqCount(app, chat.id, human.uuid)).toBe(0);
  });

  it("a stray unauthorized resolves row (legacy, pre-gate) does NOT block a later legitimate resolution", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const { asker, human, other, chat } = await setup(app, uid);

    const { message: question } = await sendMessage(app.db, chat.id, asker.agent.uuid, {
      source: "api",
      format: "request",
      content: "ratio?",
      metadata: { mentions: [human.uuid], request: { question: "5% or 20%?" } },
    });
    expect(await openReqCount(app, chat.id, human.uuid)).toBe(1);

    // Unauthorized resolves are rejected at send nowadays, but rows written
    // before that gate existed can still be present. Simulate one with a
    // direct insert: it must not count as a "prior" that blocks the real
    // resolution — otherwise the red dot could never clear.
    await app.db.insert(messages).values({
      id: crypto.randomUUID(),
      chatId: chat.id,
      senderId: other.uuid,
      format: "text",
      content: "not my question, but here",
      metadata: { resolves: { request: question.id, kind: "answered" } },
      source: "api",
    });
    expect(await openReqCount(app, chat.id, human.uuid)).toBe(1);

    // The target's legitimate answer still decrements to 0.
    await sendMessage(
      app.db,
      chat.id,
      human.uuid,
      {
        source: "api",
        format: "text",
        content: "5% → yes",
        metadata: { resolves: { request: question.id, kind: "answered" } },
      },
      { allowRecipientlessSend: true },
    );
    expect(await openReqCount(app, chat.id, human.uuid)).toBe(0);
  });

  it("a NEW request after an answered one opens a fresh count (+1)", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const { asker, human, chat } = await setup(app, uid);

    const { message: q1 } = await sendMessage(app.db, chat.id, asker.agent.uuid, {
      source: "api",
      format: "request",
      content: "ratio?",
      metadata: { mentions: [human.uuid], request: { question: "5% or 20%?" } },
    });
    await sendMessage(
      app.db,
      chat.id,
      human.uuid,
      {
        source: "web",
        format: "text",
        content: "5%",
        inReplyTo: q1.id,
        metadata: { resolves: { request: q1.id, kind: "answered" } },
      },
      { allowRecipientlessSend: true },
    );
    expect(await openReqCount(app, chat.id, human.uuid)).toBe(0);

    // Asker follows up with a NEW request replying to the resolved q1.
    await sendMessage(app.db, chat.id, asker.agent.uuid, {
      source: "api",
      format: "request",
      content: "follow-up",
      inReplyTo: q1.id,
      metadata: { mentions: [human.uuid], request: { question: "and the timing?" } },
    });
    expect(await openReqCount(app, chat.id, human.uuid)).toBe(1);
  });

  it("editMessage refuses to change a message's format to or from 'request'", async () => {
    // Review #2: the counter is maintained only on send; a format edit would
    // desync it, so edits touching `request` are rejected.
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const { asker, human, other, chat } = await setup(app, uid);

    const { message: question } = await sendMessage(app.db, chat.id, asker.agent.uuid, {
      source: "api",
      format: "request",
      content: "ratio?",
      metadata: { mentions: [human.uuid], request: { question: "5% or 20%?" } },
    });
    // A plain agent message must target an agent (`other`); agent→human plain is
    // rejected. Recipient identity is irrelevant to this format-edit check.
    const { message: plain } = await sendMessage(app.db, chat.id, asker.agent.uuid, {
      source: "api",
      format: "text",
      content: "fyi",
      metadata: { mentions: [other.uuid] },
    });

    await expect(editMessage(app.db, chat.id, question.id, asker.agent.uuid, { format: "text" })).rejects.toThrow(
      /format to or from 'request'/i,
    );
    await expect(editMessage(app.db, chat.id, plain.id, asker.agent.uuid, { format: "request" })).rejects.toThrow(
      /format to or from 'request'/i,
    );
    // A content-only edit of the request is still allowed.
    const edited = await editMessage(app.db, chat.id, question.id, asker.agent.uuid, { content: "ratio (clarified)?" });
    expect(edited.format).toBe("request");
  });

  it("editMessage rejects turning a live message into an empty / placeholder body (R5)", async () => {
    // The format of an open `request` is frozen, but its body can still be
    // edited — an edit must not be able to replace a live ask with an empty /
    // whitespace / placeholder blocking card after creation.
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const { asker, human, chat } = await setup(app, uid);

    const { message: question } = await sendMessage(app.db, chat.id, asker.agent.uuid, {
      source: "api",
      format: "request",
      content: "ratio?",
      metadata: { mentions: [human.uuid], request: { question: "5% or 20%?" } },
    });

    await expect(editMessage(app.db, chat.id, question.id, asker.agent.uuid, { content: "   " })).rejects.toThrow(
      BadRequestError,
    );
    await expect(
      editMessage(app.db, chat.id, question.id, asker.agent.uuid, { content: "PLACEHOLDER" }),
    ).rejects.toThrow(BadRequestError);
  });
});

describe("open_request_count surfaces in the listMeChats projection (needs_you red-dot source)", () => {
  const getApp = useTestApp();

  it("projects openRequestCount for the human, and clears it after they answer", async () => {
    const app = getApp();
    // The human (caller) and an agent they manage (the asker) — same org, so
    // the chat is scoped to the human's org for listMeChats.
    const admin = await createTestAdmin(app);
    const asker = await createAgent(app.db, {
      name: `oq-proj-asker-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Asker",
      managerId: admin.memberId,
      organizationId: admin.organizationId,
      clientId: undefined,
    });
    const chat = await createChat(app.db, admin.humanAgentUuid, {
      type: "group",
      participantIds: [asker.uuid],
    });

    const { message: question } = await sendMessage(app.db, chat.id, asker.uuid, {
      source: "api",
      format: "request",
      content: "need a decision",
      metadata: { mentions: [admin.humanAgentUuid], request: { question: "ship today?" } },
    });

    // An open request routes the chat into the attention group (not ordinary
    // `rows`), so search every group for it.
    const findChat = (res: Awaited<ReturnType<typeof listMeChats>>) =>
      [...res.priorityRows.attention, ...res.priorityRows.pinned, ...res.rows].find((r) => r.chatId === chat.id);

    const listAfterRaise = await listMeChats(
      app.db,
      admin.humanAgentUuid,
      admin.memberId,
      admin.organizationId,
      {
        limit: 50,
        filter: "all",
        engagement: "all",
      },
      TEST_AVATAR_AUTHORITY_TAG,
    );
    expect(findChat(listAfterRaise)?.openRequestCount).toBe(1);

    // Human answers explicitly (metadata.resolves) → counter clears.
    await sendMessage(
      app.db,
      chat.id,
      admin.humanAgentUuid,
      {
        source: "web",
        format: "text",
        content: "ship today? → yes, ship it",
        inReplyTo: question.id,
        metadata: { resolves: { request: question.id, kind: "answered" } },
      },
      { allowRecipientlessSend: true },
    );

    const listAfterAnswer = await listMeChats(
      app.db,
      admin.humanAgentUuid,
      admin.memberId,
      admin.organizationId,
      {
        limit: 50,
        filter: "all",
        engagement: "all",
      },
      TEST_AVATAR_AUTHORITY_TAG,
    );
    expect(findChat(listAfterAnswer)?.openRequestCount).toBe(0);
  });
});
