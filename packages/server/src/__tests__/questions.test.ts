import type {
  QuestionAnswerMessageContent,
  QuestionMessageContent,
} from "@agent-team-foundation/first-tree-hub-shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { agentChatSessions } from "../db/schema/agent-chat-sessions.js";
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
    const answerRows = await app.db
      .select()
      .from(messages)
      .where(eq(messages.format, "question_answer"));
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
