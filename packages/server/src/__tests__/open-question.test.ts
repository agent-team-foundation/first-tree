import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { chatUserState } from "../db/schema/chat-user-state.js";
import { createAgent } from "../services/agent.js";
import { createChat } from "../services/chat.js";
import { listMeChats } from "../services/me-chat.js";
import { editMessage, sendMessage } from "../services/message.js";
import { createTestAdmin, createTestAgent, useTestApp } from "./helpers.js";

/**
 * Open-question (group-chat-unified-send P4) service-layer contract:
 *
 *   - `format=request` is an "ask" directed at exactly one human (the sole
 *     `metadata.mentions` entry) — enforced at the service layer.
 *   - `chat_user_state.open_request_count` is the answer-cleared counter
 *     behind the `needs_you` red-dot:
 *       +1  a FRESH request (format=request, no inReplyTo) → target human.
 *       -1  the target's FIRST reply (a message with inReplyTo=question);
 *           idempotent and floored at zero.
 *   - A reply that is itself a new request takes NEITHER path (has inReplyTo
 *     ⇒ no +1; sender is the asking agent, not the human target ⇒ no -1).
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

  it("the target's first reply (inReplyTo=question) decrements the count; further replies are no-ops", async () => {
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

    // First answer from the target → -1.
    await sendMessage(
      app.db,
      chat.id,
      human.uuid,
      {
        source: "web",
        format: "text",
        content: "Let's do 5%.",
        inReplyTo: question.id,
      },
      { allowRecipientlessSend: true },
    );
    expect(await openReqCount(app, chat.id, human.uuid)).toBe(0);

    // A second reply to the SAME question must NOT decrement again (idempotent,
    // floored at zero).
    await sendMessage(
      app.db,
      chat.id,
      human.uuid,
      {
        source: "web",
        format: "text",
        content: "...actually still 5%.",
        inReplyTo: question.id,
      },
      { allowRecipientlessSend: true },
    );
    expect(await openReqCount(app, chat.id, human.uuid)).toBe(0);
  });

  it("a normal reply NOT pointing at the question does not change the count", async () => {
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

    // Human chats without inReplyTo — not an answer to the question.
    await sendMessage(
      app.db,
      chat.id,
      human.uuid,
      {
        source: "web",
        format: "text",
        content: "give me a sec",
      },
      { allowRecipientlessSend: true },
    );
    expect(await openReqCount(app, chat.id, human.uuid)).toBe(1);
  });

  it("a replacement request (asker re-asks) nets zero — supersede old, open new", async () => {
    // The asking agent re-asks by replying to its own question with a new
    // request. The new request +1s the target AND supersedes (resolves) the
    // parent it replies to (-1), so for the same target the count nets zero —
    // staying at one open question (now the new one).
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

    // Still exactly 1 — new request +1, parent superseded -1, net zero.
    expect(await openReqCount(app, chat.id, human.uuid)).toBe(1);
  });

  it("the asker's plain-text reply to its own request actively closes it (clears the target's count)", async () => {
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

    // The ASKER (not the target) replies to its own request with a plain text
    // message → active close/withdraw → the target's count clears.
    await sendMessage(
      app.db,
      chat.id,
      asker.agent.uuid,
      {
        source: "api",
        format: "text",
        content: "Never mind — resolved this offline, closing.",
        inReplyTo: question.id,
      },
      { allowRecipientlessSend: true },
    );
    expect(await openReqCount(app, chat.id, human.uuid)).toBe(0);

    // A second close (or any later reply) is a no-op — floored at zero.
    await sendMessage(
      app.db,
      chat.id,
      asker.agent.uuid,
      {
        source: "api",
        format: "text",
        content: "(still closed)",
        inReplyTo: question.id,
      },
      { allowRecipientlessSend: true },
    );
    expect(await openReqCount(app, chat.id, human.uuid)).toBe(0);
  });

  it("a request-shaped reply to an already-resolved request opens a fresh count (+1)", async () => {
    // Review #3: a threaded follow-up question must be independently countable.
    // Raise → target answers (count 0) → asker asks a NEW request replying to
    // the resolved one → it's a new open question, so count must be 1 again
    // (the new request +1; the supersede of the already-resolved parent is a
    // no-op, not a double -1).
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
      { source: "web", format: "text", content: "5%", inReplyTo: q1.id },
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
    const { asker, human, chat } = await setup(app, uid);

    const { message: question } = await sendMessage(app.db, chat.id, asker.agent.uuid, {
      source: "api",
      format: "request",
      content: "ratio?",
      metadata: { mentions: [human.uuid], request: { question: "5% or 20%?" } },
    });
    const { message: plain } = await sendMessage(app.db, chat.id, asker.agent.uuid, {
      source: "api",
      format: "text",
      content: "fyi",
      metadata: { mentions: [human.uuid] },
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

    const listAfterRaise = await listMeChats(app.db, admin.humanAgentUuid, admin.memberId, admin.organizationId, {
      limit: 50,
      filter: "all",
      engagement: "all",
    });
    expect(listAfterRaise.rows.find((r) => r.chatId === chat.id)?.openRequestCount).toBe(1);

    // Human answers (reply threaded to the question) → counter clears.
    await sendMessage(
      app.db,
      chat.id,
      admin.humanAgentUuid,
      {
        source: "web",
        format: "text",
        content: "yes, ship it",
        inReplyTo: question.id,
      },
      { allowRecipientlessSend: true },
    );

    const listAfterAnswer = await listMeChats(app.db, admin.humanAgentUuid, admin.memberId, admin.organizationId, {
      limit: 50,
      filter: "all",
      engagement: "all",
    });
    expect(listAfterAnswer.rows.find((r) => r.chatId === chat.id)?.openRequestCount).toBe(0);
  });
});
