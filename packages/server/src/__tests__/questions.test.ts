import type {
  QuestionAnswerMessageContent,
  QuestionMessageContent,
} from "@agent-team-foundation/first-tree-hub-shared";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { agentChatSessions } from "../db/schema/agent-chat-sessions.js";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { messages } from "../db/schema/messages.js";
import { pendingQuestions } from "../db/schema/pending-questions.js";
import { createAgent } from "../services/agent.js";
import { createChat } from "../services/chat.js";
import { claimClient } from "../services/client.js";
import { sendMessage } from "../services/message.js";
import { submitAnswer } from "../services/questions.js";
import { archiveSession, suspendSession } from "../services/session.js";
import { createAdminContext, createTestAdmin, seedClient, useTestApp } from "./helpers.js";

function buildQuestionContent(correlationId: string): QuestionMessageContent {
  return {
    correlationId,
    questions: [
      {
        question: "Should I proceed?",
        header: "Proceed?",
        options: [
          { label: "Yes", description: "Affirmative", preview: null },
          { label: "No", description: "Negative", preview: null },
        ],
        multiSelect: false,
      },
    ],
    previewFormat: null,
    allowFreeText: true,
  };
}

async function seedSessionRow(app: FastifyInstance, agentId: string, chatId: string, state: string) {
  await app.db
    .insert(agentChatSessions)
    .values({ agentId, chatId, state })
    .onConflictDoUpdate({
      target: [agentChatSessions.agentId, agentChatSessions.chatId],
      set: { state, updatedAt: new Date() },
    });
}

async function setupQuestionScenario(app: FastifyInstance, runtimeProvider: "claude-code" | "codex" = "claude-code") {
  const admin = await createAdminContext(app, { username: `q-${crypto.randomUUID().slice(0, 8)}` });
  const peerAgent = await createAgent(
    app.db,
    {
      name: `q-peer-${crypto.randomUUID().slice(0, 6)}`,
      type: "autonomous_agent",
      displayName: "Peer agent",
      managerId: admin.memberId,
      clientId: admin.clientId,
      runtimeProvider,
    },
    { force: true },
  );
  const chat = await createChat(app.db, admin.humanAgentUuid, {
    type: "direct",
    participantIds: [peerAgent.uuid],
  });
  return { admin, peerAgent, chatId: chat.id };
}

describe("recordPendingQuestionFromMessage — sendMessage write hook", () => {
  const getApp = useTestApp();

  it("writes a pending_questions row in the same tx as the question message", async () => {
    const app = getApp();
    const { peerAgent, chatId } = await setupQuestionScenario(app);

    const correlationId = `tu_${crypto.randomUUID().slice(0, 12)}`;
    const result = await sendMessage(app.db, chatId, peerAgent.uuid, {
      format: "question",
      content: buildQuestionContent(correlationId),
    });

    expect(result.message.format).toBe("question");

    const [row] = await app.db.select().from(pendingQuestions).where(eq(pendingQuestions.id, correlationId)).limit(1);
    expect(row).toBeDefined();
    expect(row?.status).toBe("pending");
    expect(row?.agentId).toBe(peerAgent.uuid);
    expect(row?.chatId).toBe(chatId);
    expect(row?.messageId).toBe(result.message.id);
  });

  it("rejects format=question from a codex-runtime sender (403)", async () => {
    const app = getApp();
    const { peerAgent, chatId } = await setupQuestionScenario(app, "codex");

    const correlationId = `tu_${crypto.randomUUID().slice(0, 12)}`;
    await expect(
      sendMessage(app.db, chatId, peerAgent.uuid, {
        format: "question",
        content: buildQuestionContent(correlationId),
      }),
    ).rejects.toThrow(/Codex runtime cannot emit ask-user questions/);

    // No row should have leaked through.
    const [row] = await app.db.select().from(pendingQuestions).where(eq(pendingQuestions.id, correlationId)).limit(1);
    expect(row).toBeUndefined();
  });

  it("rejects malformed question content (missing correlationId)", async () => {
    const app = getApp();
    const { peerAgent, chatId } = await setupQuestionScenario(app);

    await expect(
      sendMessage(app.db, chatId, peerAgent.uuid, {
        format: "question",
        // missing `correlationId`
        content: { questions: [], previewFormat: null, allowFreeText: true },
      }),
    ).rejects.toThrow(/Invalid question message content/);
  });
});

describe("submitAnswer — POST /api/v1/chats/:chatId/questions/:correlationId/answer", () => {
  const getApp = useTestApp();

  it("happy path: writes question_answer message and flips status", async () => {
    const app = getApp();
    const { admin, peerAgent, chatId } = await setupQuestionScenario(app);

    const correlationId = `tu_${crypto.randomUUID().slice(0, 12)}`;
    const questionMsg = await sendMessage(app.db, chatId, peerAgent.uuid, {
      format: "question",
      content: buildQuestionContent(correlationId),
    });

    // Ensure the human agent is a participant so the user-scoped route can answer.
    // direct chat already includes both; double-check.
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/chats/${chatId}/questions/${correlationId}/answer`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { answers: { "Should I proceed?": "Yes" } },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ correlationId: string; messageId: string }>();
    expect(body.correlationId).toBe(correlationId);

    const [row] = await app.db.select().from(pendingQuestions).where(eq(pendingQuestions.id, correlationId)).limit(1);
    expect(row?.status).toBe("answered");
    expect(row?.answeredAt).toBeTruthy();

    const answerRows = await app.db.select().from(messages).where(eq(messages.id, body.messageId)).limit(1);
    expect(answerRows[0]?.format).toBe("question_answer");
    const content = answerRows[0]?.content as QuestionAnswerMessageContent;
    expect(content.correlationId).toBe(correlationId);
    expect(content.answers).toEqual({ "Should I proceed?": "Yes" });
    expect(answerRows[0]?.inReplyTo).toBe(questionMsg.message.id);
  });

  it("returns 409 when answering an already-answered question", async () => {
    const app = getApp();
    const { admin, peerAgent, chatId } = await setupQuestionScenario(app);

    const correlationId = `tu_${crypto.randomUUID().slice(0, 12)}`;
    await sendMessage(app.db, chatId, peerAgent.uuid, {
      format: "question",
      content: buildQuestionContent(correlationId),
    });

    const first = await app.inject({
      method: "POST",
      url: `/api/v1/chats/${chatId}/questions/${correlationId}/answer`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { answers: { "Should I proceed?": "Yes" } },
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: "POST",
      url: `/api/v1/chats/${chatId}/questions/${correlationId}/answer`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { answers: { "Should I proceed?": "No" } },
    });
    expect(second.statusCode).toBe(409);
  });

  it("returns 404 when the correlationId does not exist", async () => {
    const app = getApp();
    const { admin, chatId } = await setupQuestionScenario(app);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/chats/${chatId}/questions/does-not-exist/answer`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { answers: { foo: "bar" } },
    });
    expect(res.statusCode).toBe(404);
  });

  it("rejects answer keys that don't match the original questions (400)", async () => {
    const app = getApp();
    const { admin, peerAgent, chatId } = await setupQuestionScenario(app);

    const correlationId = `tu_${crypto.randomUUID().slice(0, 12)}`;
    await sendMessage(app.db, chatId, peerAgent.uuid, {
      format: "question",
      content: buildQuestionContent(correlationId),
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/chats/${chatId}/questions/${correlationId}/answer`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { answers: { "Wrong question text?": "Yes" } },
    });
    expect(res.statusCode).toBe(400);
  });

  it("two concurrent submissions: exactly one wins, exactly one question_answer message is written", async () => {
    // Regression test for the "double-write" race we caught in code review.
    // Before the fix, both concurrent submitters would (a) pass the
    // SELECT-FOR-UPDATE + status=pending check serially (because the lock-tx
    // released before sendMessage), (b) call sendMessage(format=question_answer)
    // independently, and (c) only the second UPDATE-WHERE-status=pending
    // would lose the race — but BOTH answer messages had already landed in
    // the inbox. Now: status flip happens INSIDE the lock-tx, so the second
    // submitter sees status=answered and 409s before reaching sendMessage.
    const app = getApp();
    const { admin, peerAgent, chatId } = await setupQuestionScenario(app);

    const correlationId = `tu_${crypto.randomUUID().slice(0, 12)}`;
    await sendMessage(app.db, chatId, peerAgent.uuid, {
      format: "question",
      content: buildQuestionContent(correlationId),
    });

    const [resA, resB] = await Promise.allSettled([
      submitAnswer(app.db, undefined, {
        correlationId,
        chatId,
        submitterAgentId: admin.humanAgentUuid,
        answers: { "Should I proceed?": "Yes" },
      }),
      submitAnswer(app.db, undefined, {
        correlationId,
        chatId,
        submitterAgentId: admin.humanAgentUuid,
        answers: { "Should I proceed?": "No" },
      }),
    ]);

    const fulfilled = [resA, resB].filter((r) => r.status === "fulfilled");
    const rejected = [resA, resB].filter((r) => r.status === "rejected");
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    // The loser must be a 409 (ConflictError), not a 5xx — anything else
    // would mean the race went somewhere unexpected.
    const reason = (rejected[0] as PromiseRejectedResult).reason as Error & { statusCode?: number };
    expect(reason.message).toMatch(/no longer pending|answered concurrently/);

    // CRITICAL: exactly one question_answer message was written. Two would
    // mean the bug came back.
    const answerRows = await app.db.select().from(messages).where(eq(messages.format, "question_answer"));
    const forThisChat = answerRows.filter((m) => m.chatId === chatId);
    expect(forThisChat.length).toBe(1);

    // And the row is `answered`, not `pending`, after the dust settles.
    const [row] = await app.db.select().from(pendingQuestions).where(eq(pendingQuestions.id, correlationId)).limit(1);
    expect(row?.status).toBe("answered");
  });

  it("returns 409 once the question has been superseded", async () => {
    const app = getApp();
    const { admin, peerAgent, chatId } = await setupQuestionScenario(app);

    const correlationId = `tu_${crypto.randomUUID().slice(0, 12)}`;
    await sendMessage(app.db, chatId, peerAgent.uuid, {
      format: "question",
      content: buildQuestionContent(correlationId),
    });

    // Force a supersede via the chat-close path.
    await seedSessionRow(app, peerAgent.uuid, chatId, "suspended");
    await archiveSession(app.db, peerAgent.uuid, chatId, peerAgent.organizationId);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/chats/${chatId}/questions/${correlationId}/answer`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { answers: { "Should I proceed?": "Yes" } },
    });
    expect(res.statusCode).toBe(409);
  });
});

describe("supersede hooks", () => {
  const getApp = useTestApp();

  it("archiveSession marks every pending question on that chat as superseded", async () => {
    const app = getApp();
    const { peerAgent, chatId } = await setupQuestionScenario(app);

    const correlationId = `tu_${crypto.randomUUID().slice(0, 12)}`;
    await sendMessage(app.db, chatId, peerAgent.uuid, {
      format: "question",
      content: buildQuestionContent(correlationId),
    });
    // Archive requires going through suspended first.
    await seedSessionRow(app, peerAgent.uuid, chatId, "active");
    await suspendSession(app.db, peerAgent.uuid, chatId, peerAgent.organizationId);
    await archiveSession(app.db, peerAgent.uuid, chatId, peerAgent.organizationId);

    const [row] = await app.db.select().from(pendingQuestions).where(eq(pendingQuestions.id, correlationId)).limit(1);
    expect(row?.status).toBe("superseded");
    expect(row?.supersededReason).toBe("chat_archived");
  });

  it("claimClient marks every pending question on the unpinned agents as superseded", async () => {
    const app = getApp();
    const { peerAgent, admin, chatId } = await setupQuestionScenario(app);

    const correlationId = `tu_${crypto.randomUUID().slice(0, 12)}`;
    await sendMessage(app.db, chatId, peerAgent.uuid, {
      format: "question",
      content: buildQuestionContent(correlationId),
    });

    // Spin up a second user and claim the client over to them.
    const newOwner = await createTestAdmin(app, { username: `claim-${crypto.randomUUID().slice(0, 6)}` });
    // The new owner needs an unrelated client of their own (for accounting), but
    // the claim itself only flips the existing one. Use seedClient to materialise
    // a client owned by the new owner so the test mirrors a realistic setup.
    await seedClient(app, newOwner.userId, admin.organizationId);

    const result = await claimClient(app.db, admin.clientId, newOwner.userId);
    expect(result.unpinnedAgentIds).toContain(peerAgent.uuid);

    const [row] = await app.db.select().from(pendingQuestions).where(eq(pendingQuestions.id, correlationId)).limit(1);
    expect(row?.status).toBe("superseded");
    expect(row?.supersededReason).toBe("client_claimed");
  });
});

/**
 * Regression: github.com/agent-team-foundation/first-tree-hub#404 — when a
 * `direct → group` upgrade re-grades the asker to `mention_only` AFTER the
 * question is posted, the `format=question_answer` fan-out used to set
 * `notify=false` for the asker (structured content carries no @<name>
 * tokens), leaving the SDK's `canUseTool` Promise dangling forever. The
 * fix forces notify=true for the asker via `addressedToAgentIds`.
 */
describe("submitAnswer — group chat with mention_only asker (#404)", () => {
  const getApp = useTestApp();

  async function setMode(app: FastifyInstance, chatId: string, agentUuid: string, mode: "full" | "mention_only") {
    await app.db
      .update(chatMembership)
      .set({ mode })
      .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.agentId, agentUuid)));
  }

  async function inboxIdOf(app: FastifyInstance, agentUuid: string): Promise<string> {
    const [row] = await app.db
      .select({ inboxId: agents.inboxId })
      .from(agents)
      .where(eq(agents.uuid, agentUuid))
      .limit(1);
    if (!row?.inboxId) throw new Error(`No inbox for agent ${agentUuid}`);
    return row.inboxId;
  }

  it("forces notify=true on the asker's inbox row even when their mode is mention_only", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `q-grp-${crypto.randomUUID().slice(0, 8)}` });
    const asker = await createAgent(
      app.db,
      {
        name: `q-asker-${crypto.randomUUID().slice(0, 6)}`,
        type: "autonomous_agent",
        displayName: "Asker",
        managerId: admin.memberId,
        clientId: admin.clientId,
        runtimeProvider: "claude-code",
      },
      { force: true },
    );
    const bystander = await createAgent(
      app.db,
      {
        name: `q-bystander-${crypto.randomUUID().slice(0, 6)}`,
        type: "autonomous_agent",
        displayName: "Bystander",
        managerId: admin.memberId,
        clientId: admin.clientId,
        runtimeProvider: "claude-code",
      },
      { force: true },
    );
    const chat = await createChat(app.db, admin.humanAgentUuid, {
      type: "group",
      participantIds: [asker.uuid, bystander.uuid],
    });

    // Mirror the production state that produced the bug: a `direct → group`
    // upgrade demoted the asker to `mention_only` between question publish
    // and answer. Force both non-human speakers to `mention_only` here.
    await setMode(app, chat.id, asker.uuid, "mention_only");
    await setMode(app, chat.id, bystander.uuid, "mention_only");

    const correlationId = `tu_${crypto.randomUUID().slice(0, 12)}`;
    await sendMessage(app.db, chat.id, asker.uuid, {
      format: "question",
      content: buildQuestionContent(correlationId),
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/chats/${chat.id}/questions/${correlationId}/answer`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { answers: { "Should I proceed?": "Yes" } },
    });
    expect(res.statusCode).toBe(201);
    const answerMessageId = res.json<{ messageId: string }>().messageId;

    // Asker MUST receive notify=true so their client's WS push wakes the
    // SDK's `canUseTool` waiter — this is the regression the fix targets.
    const askerInboxId = await inboxIdOf(app, asker.uuid);
    const [askerEntry] = await app.db
      .select({ notify: inboxEntries.notify })
      .from(inboxEntries)
      .where(and(eq(inboxEntries.inboxId, askerInboxId), eq(inboxEntries.messageId, answerMessageId)))
      .limit(1);
    expect(askerEntry?.notify).toBe(true);

    // Uninvolved mention_only bystanders must stay silent — the answer is
    // directed at the asker, not a group broadcast. notify=true here would
    // re-introduce the old "agent courtesy loop" wake (migration 0029).
    const bystanderInboxId = await inboxIdOf(app, bystander.uuid);
    const [bystanderEntry] = await app.db
      .select({ notify: inboxEntries.notify })
      .from(inboxEntries)
      .where(and(eq(inboxEntries.inboxId, bystanderInboxId), eq(inboxEntries.messageId, answerMessageId)))
      .limit(1);
    expect(bystanderEntry?.notify).toBe(false);
  });
});

/**
 * Regression: #416 — the asker must still be a speaker of the chat at
 * answer time. fan-out is gated on `chat_membership.accessMode = 'speaker'`;
 * if the asker has been moved out between question publish and answer the
 * `addressedToAgentIds` widening can't bring them back, so we short-circuit
 * upstream in `submitAnswer` and convert to a supersede.
 */
describe("submitAnswer — asker left chat between publish and answer (#416)", () => {
  const getApp = useTestApp();

  it("flips the pending row to superseded(asker_left_chat) and returns ConflictError", async () => {
    const app = getApp();
    const { admin, peerAgent, chatId } = await setupQuestionScenario(app);

    const correlationId = `tu_${crypto.randomUUID().slice(0, 12)}`;
    await sendMessage(app.db, chatId, peerAgent.uuid, {
      format: "question",
      content: buildQuestionContent(correlationId),
    });

    // Simulate the asker (peerAgent) being moved out of the chat after the
    // question was posted but before the human submits the answer. Use a
    // direct DELETE on chat_membership to model any path that removes a
    // speaker — leaveChat, role demotion, admin removal, etc.
    await app.db
      .delete(chatMembership)
      .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.agentId, peerAgent.uuid)));

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/chats/${chatId}/questions/${correlationId}/answer`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { answers: { "Should I proceed?": "Yes" } },
    });
    expect(res.statusCode).toBe(409);

    const [row] = await app.db.select().from(pendingQuestions).where(eq(pendingQuestions.id, correlationId)).limit(1);
    expect(row?.status).toBe("superseded");
    expect(row?.supersededReason).toBe("asker_left_chat");

    // No answer message was emitted — chat history stays consistent with
    // the supersede semantics used elsewhere.
    const answerRows = await app.db
      .select()
      .from(messages)
      .where(and(eq(messages.chatId, chatId), eq(messages.format, "question_answer")));
    expect(answerRows).toHaveLength(0);
  });
});

/**
 * Direct unit-level coverage of the `addressedToAgentIds` option on
 * `sendMessage`. The #404 case above verifies the end-to-end path through
 * `submitAnswer`; these tests pin the option's own contract so future
 * refactors of `sendMessage` cannot quietly invert the short-circuit order.
 */
describe("sendMessage — addressedToAgentIds option", () => {
  const getApp = useTestApp();

  async function inboxIdOf(app: FastifyInstance, agentUuid: string): Promise<string> {
    const [row] = await app.db
      .select({ inboxId: agents.inboxId })
      .from(agents)
      .where(eq(agents.uuid, agentUuid))
      .limit(1);
    if (!row?.inboxId) throw new Error(`No inbox for agent ${agentUuid}`);
    return row.inboxId;
  }

  it("isSilentSend wins over addressedToAgentIds — silence contract is unconditional", async () => {
    // The silent-send guard (`message.ts` step 2e: content empty after
    // stripping `@<name>` tokens) is a chat-wide silence contract that must
    // not be overridable by per-recipient routing intent. Otherwise an
    // empty-content addressed message would wake the addressee, breaking
    // the L4 form guard that migration 0029 was built on top of.
    const app = getApp();
    const { admin, peerAgent, chatId } = await setupQuestionScenario(app);

    const result = await sendMessage(
      app.db,
      chatId,
      admin.humanAgentUuid,
      { format: "text", content: "" },
      { addressedToAgentIds: [peerAgent.uuid] },
    );

    // No notify=true recipients despite the explicit address.
    expect(result.recipients).toEqual([]);

    const inboxId = await inboxIdOf(app, peerAgent.uuid);
    const [entry] = await app.db
      .select({ notify: inboxEntries.notify })
      .from(inboxEntries)
      .where(and(eq(inboxEntries.inboxId, inboxId), eq(inboxEntries.messageId, result.message.id)))
      .limit(1);
    // Row is still written for history replay, but notify=false.
    expect(entry?.notify).toBe(false);
  });

  it("addressedToAgentIds containing a non-participant is a silent no-op", async () => {
    // Defensive: forwarding a stale or wrong-chat agentId must not crash
    // sendMessage and must not somehow promote any unrelated row to
    // notify=true. The participants query already filters by chat
    // membership, so a non-participant id falls out at the fan-out stage.
    const app = getApp();
    const { admin, peerAgent, chatId } = await setupQuestionScenario(app);

    // Build an agent that is NOT a participant of this chat.
    const outsider = await createAgent(
      app.db,
      {
        name: `q-outsider-${crypto.randomUUID().slice(0, 6)}`,
        type: "autonomous_agent",
        displayName: "Outsider",
        managerId: admin.memberId,
        clientId: admin.clientId,
        runtimeProvider: "claude-code",
      },
      { force: true },
    );

    const result = await sendMessage(
      app.db,
      chatId,
      admin.humanAgentUuid,
      { format: "text", content: "hello" },
      { addressedToAgentIds: [outsider.uuid] },
    );

    // The chat's actual peer (peerAgent, mode=full in a direct chat) still
    // got notified — `addressedToAgentIds` only adds, never subtracts.
    const peerInboxId = await inboxIdOf(app, peerAgent.uuid);
    const [peerEntry] = await app.db
      .select({ notify: inboxEntries.notify })
      .from(inboxEntries)
      .where(and(eq(inboxEntries.inboxId, peerInboxId), eq(inboxEntries.messageId, result.message.id)))
      .limit(1);
    expect(peerEntry?.notify).toBe(true);

    // The outsider has no inbox row for this message at all — they're not
    // a chat participant, so fan-out skips them entirely.
    const outsiderInboxId = await inboxIdOf(app, outsider.uuid);
    const outsiderEntries = await app.db
      .select({ id: inboxEntries.id })
      .from(inboxEntries)
      .where(and(eq(inboxEntries.inboxId, outsiderInboxId), eq(inboxEntries.messageId, result.message.id)));
    expect(outsiderEntries).toHaveLength(0);
  });
});
