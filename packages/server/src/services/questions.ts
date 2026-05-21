import {
  type QuestionAnswerMessageContent,
  type QuestionMessageContent,
  questionAnswerMessageContentSchema,
  questionMessageContentSchema,
} from "@first-tree/shared";
import { and, eq, inArray } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { messages } from "../db/schema/messages.js";
import { pendingQuestions } from "../db/schema/pending-questions.js";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../errors.js";
import { createLogger } from "../observability/index.js";
import { sendMessage } from "./message.js";
import { type Notifier, notifyRecipients } from "./notifier.js";

const log = createLogger("questions");

type TxLike = Pick<PostgresJsDatabase<Record<string, never>>, "select" | "insert" | "update">;

/**
 * Insert a `pending_questions` row inside the same transaction that wrote a
 * `format=question` message. Caller is `sendMessage` after the message INSERT
 * returns, so a rollback drops both rows together. No-op (returns silently)
 * if the message content is not a valid `QuestionMessageContent` — the caller
 * will already have rejected such input upstream, but we defend in depth so a
 * malformed write never leaves a dangling pending row.
 */
export async function recordPendingQuestionFromMessage(
  tx: TxLike,
  args: { agentId: string; chatId: string; messageId: string; content: unknown },
): Promise<void> {
  const parsed = questionMessageContentSchema.safeParse(args.content);
  if (!parsed.success) {
    throw new BadRequestError("Invalid question message content", {
      "question.parse_error": parsed.error.message.slice(0, 200),
    });
  }
  const { correlationId } = parsed.data;
  await tx.insert(pendingQuestions).values({
    id: correlationId,
    agentId: args.agentId,
    chatId: args.chatId,
    messageId: args.messageId,
    status: "pending",
  });
}

/**
 * Defensive write-side check: codex-runtime agents must never emit
 * `format=question` (Codex SDK 0.125 has no ask-user surface, so any such
 * message would be a runtime regression). Looks up the sender's
 * `runtime_provider` and rejects if it is `codex`. Throws `ForbiddenError`
 * (HTTP 403) so the bug surfaces loudly to the offending writer.
 *
 * Returns the runtime provider for telemetry / further checks (e.g. the
 * caller can attach it to the active span).
 */
export async function assertSenderMayEmitQuestion(tx: TxLike, senderAgentId: string): Promise<string> {
  const [row] = await tx
    .select({ runtimeProvider: agents.runtimeProvider })
    .from(agents)
    .where(eq(agents.uuid, senderAgentId))
    .limit(1);
  if (!row) {
    throw new NotFoundError(`Sender agent "${senderAgentId}" not found`);
  }
  if (row.runtimeProvider === "codex") {
    log.error(
      { agentId: senderAgentId, runtimeProvider: row.runtimeProvider },
      "rejected format=question emit from codex-runtime agent",
    );
    throw new ForbiddenError("Codex runtime cannot emit ask-user questions", {
      "question.codex_emit_attempt": true,
      "agent.id": senderAgentId,
    });
  }
  return row.runtimeProvider;
}

/**
 * User-side answer submission. Atomically:
 *   1. Lock the `pending_questions` row by correlationId.
 *   2. Refuse if status !== "pending" (409 if already-answered, 410-shaped
 *      400 if superseded — both surface as ConflictError so the caller knows
 *      the question is no longer answerable).
 *   3. Validate that the answer keys match the original `questions[]`.
 *   4. Flip status to `answered` INSIDE the lock-tx, before releasing the
 *      row lock. This is the linearisation point: the second concurrent
 *      submitter (waiting on the same row lock) will, on its turn, see
 *      status=answered and exit with ConflictError BEFORE it can write a
 *      second `format=question_answer` message.
 *   5. Send the `format=question_answer` message OUTSIDE the lock-tx
 *      (sendMessage opens its own transaction; nesting wasn't supported by
 *      the existing call site). At this point we hold an exclusive logical
 *      claim — only one submitter ever reaches this step per correlationId.
 *
 * `submitterAgentId` is the human agent on whose behalf the answer is
 * written (it must be a participant of the question's chat). Returns the
 * created `question_answer` message id so the route can include it in the
 * 201 response.
 *
 * Failure semantics: if step 5 (sendMessage) fails after status was flipped,
 * we revert the row to `pending` so the user can retry. This is best-effort —
 * the revert UPDATE is guarded by `status='answered'` to avoid clobbering a
 * supersede that might race in. If the revert itself fails, the row is
 * stranded as `answered` with no answer message; an operator would need to
 * intervene, but a sendMessage failure (local DB tx) is already
 * extraordinarily rare.
 */
export async function submitAnswer(
  db: Database,
  notifier: Notifier | undefined,
  args: {
    correlationId: string;
    chatId: string;
    submitterAgentId: string;
    answers: Record<string, string>;
  },
): Promise<{ messageId: string; recipients: string[] }> {
  // Step 1-4: validate AND flip status inside a SELECT-FOR-UPDATE so two
  // concurrent submissions are linearised by the row lock. Without the flip
  // here, both submitters could pass the status=pending check, both could
  // commit, both could call sendMessage outside the tx, and the inbox would
  // see two answer messages — a bug we hit in field testing.
  const txResult = await db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        id: pendingQuestions.id,
        status: pendingQuestions.status,
        chatId: pendingQuestions.chatId,
        agentId: pendingQuestions.agentId,
        messageId: pendingQuestions.messageId,
      })
      .from(pendingQuestions)
      .where(eq(pendingQuestions.id, args.correlationId))
      .for("update")
      .limit(1);

    if (!row) {
      throw new NotFoundError(`Question "${args.correlationId}" not found`);
    }
    if (row.chatId !== args.chatId) {
      // Chat-id mismatch — caller is asking against the wrong chat URL.
      throw new NotFoundError(`Question "${args.correlationId}" not found in this chat`);
    }
    if (row.status !== "pending") {
      throw new ConflictError(`Question "${args.correlationId}" is no longer pending`, {
        "question.status": row.status,
      });
    }

    // #416: the asker must still be a speaker of this chat. Fan-out is gated
    // on `chat_membership.accessMode = 'speaker'`, so if the asker has been
    // moved out between question publish and answer (manager unjoined, role
    // changed, etc.) the answer would land at no inbox and the SDK's
    // `canUseTool` Promise would hang forever. Flip to `superseded` inside
    // the lock-tx so the terminal state is persisted alongside the row lock;
    // throwing from inside the tx would roll the flip back, so we return a
    // sentinel and let the caller throw outside.
    const [askerMembership] = await tx
      .select({ agentId: chatMembership.agentId })
      .from(chatMembership)
      .where(
        and(
          eq(chatMembership.chatId, row.chatId),
          eq(chatMembership.agentId, row.agentId),
          eq(chatMembership.accessMode, "speaker"),
        ),
      )
      .limit(1);
    if (!askerMembership) {
      await tx
        .update(pendingQuestions)
        .set({ status: "superseded", supersededAt: new Date(), supersededReason: "asker_left_chat" })
        .where(eq(pendingQuestions.id, args.correlationId));
      return { askerLeft: true as const };
    }

    // Cross-check the answers' keys against the original question texts so a
    // malformed payload doesn't leak through to the SDK (the SDK uses
    // questions[i].question as the answer dictionary key).
    const [msg] = await tx
      .select({ content: messages.content })
      .from(messages)
      .where(eq(messages.id, row.messageId))
      .limit(1);
    if (!msg) {
      throw new NotFoundError(`Question message "${row.messageId}" not found`);
    }
    const parsedQuestion = questionMessageContentSchema.safeParse(msg.content);
    if (!parsedQuestion.success) {
      throw new BadRequestError("Stored question content is malformed", {
        "question.parse_error": parsedQuestion.error.message.slice(0, 200),
      });
    }
    const expectedKeys = new Set(parsedQuestion.data.questions.map((q) => q.question));
    for (const key of Object.keys(args.answers)) {
      if (!expectedKeys.has(key)) {
        throw new BadRequestError(`Answer key "${key}" does not match any question`, {
          "question.id": args.correlationId,
        });
      }
    }
    for (const key of expectedKeys) {
      if (!(key in args.answers)) {
        throw new BadRequestError(`Answer missing for question "${key}"`, {
          "question.id": args.correlationId,
        });
      }
    }

    // Step 4: flip status while still holding the row lock.
    await tx
      .update(pendingQuestions)
      .set({ status: "answered", answeredAt: new Date() })
      .where(eq(pendingQuestions.id, args.correlationId));

    return { askerLeft: false as const, row };
  });

  if (txResult.askerLeft) {
    throw new ConflictError(`Question "${args.correlationId}" is no longer pending`, {
      "question.status": "superseded",
      "question.supersede_reason": "asker_left_chat",
    });
  }
  const questionRow = txResult.row;

  // Step 5: send the answer message. By the time we get here we hold an
  // exclusive claim on the row (any concurrent submitter is now seeing
  // status=answered and 409ing in step 1-4 above), so this writes exactly
  // one answer message per question.
  const answerContent: QuestionAnswerMessageContent = {
    correlationId: args.correlationId,
    answers: args.answers,
  };
  // Final parse to surface a clear error if something upstream mutated shape.
  questionAnswerMessageContentSchema.parse(answerContent);

  let result: Awaited<ReturnType<typeof sendMessage>>;
  try {
    result = await sendMessage(
      db,
      args.chatId,
      args.submitterAgentId,
      {
        format: "question_answer",
        content: answerContent,
        inReplyTo: questionRow.messageId,
        source: "web",
      },
      // This `question_answer` is addressed to the asker by construction —
      // the answer's structured content carries no `@<name>` tokens, so
      // without an explicit recipient hint the default fan-out rule would
      // set notify=false for the asker if the chat upgraded `direct → group`
      // between question publish and answer (which re-grades non-human
      // speakers to `mention_only`), leaving the SDK's `canUseTool` Promise
      // dangling forever. See issue #404.
      { addressedToAgentIds: [questionRow.agentId] },
    );
  } catch (err) {
    // Best-effort revert: status was flipped to 'answered' but we never
    // emitted the answer message, so the agent would never see the answer
    // and the user couldn't retry. Roll back to 'pending' so a retry can
    // succeed. Guarded on status='answered' to avoid clobbering a
    // supersede that landed in between.
    log.error(
      { correlationId: args.correlationId, chatId: args.chatId, err: err instanceof Error ? err.message : String(err) },
      "sendMessage failed after status flip; reverting pending_questions row to 'pending'",
    );
    try {
      await db
        .update(pendingQuestions)
        .set({ status: "pending", answeredAt: null })
        .where(and(eq(pendingQuestions.id, args.correlationId), eq(pendingQuestions.status, "answered")));
    } catch (revertErr) {
      log.error(
        {
          correlationId: args.correlationId,
          chatId: args.chatId,
          revertErr: revertErr instanceof Error ? revertErr.message : String(revertErr),
        },
        "revert UPDATE also failed; row may be stranded as 'answered' without an answer message",
      );
    }
    throw err;
  }

  // Notify all recipients of the answer message — same path as a normal user
  // message. The bound agent's client will receive it on the inbox WS frame.
  if (notifier) {
    notifyRecipients(notifier, result.recipients, result.message.id);
  }

  return { messageId: result.message.id, recipients: result.recipients };
}

/**
 * Mark every pending row whose chat is `chatId` as superseded. Used when a
 * chat session is archived — the agent runtime that emitted the question
 * may already be gone, so leaving the row pending would block forever.
 */
export async function markSupersededByChat(tx: TxLike, chatId: string, reason = "chat_archived"): Promise<number> {
  const rows = await tx
    .update(pendingQuestions)
    .set({ status: "superseded", supersededAt: new Date(), supersededReason: reason })
    .where(and(eq(pendingQuestions.chatId, chatId), eq(pendingQuestions.status, "pending")))
    .returning({ id: pendingQuestions.id });
  return rows.length;
}

/**
 * Mark every pending row owned by any of `agentIds` as superseded. Used when
 * the client carrying these agents is claimed by a new user — the previous
 * owner's runtime is detached and cannot deliver an answer back.
 */
export async function markSupersededByAgents(
  tx: TxLike,
  agentIds: string[],
  reason = "client_claimed",
): Promise<number> {
  if (agentIds.length === 0) return 0;
  const rows = await tx
    .update(pendingQuestions)
    .set({ status: "superseded", supersededAt: new Date(), supersededReason: reason })
    .where(and(inArray(pendingQuestions.agentId, agentIds), eq(pendingQuestions.status, "pending")))
    .returning({ id: pendingQuestions.id });
  return rows.length;
}

/**
 * Read-only helper for routes / tests. Returns null if not found.
 */
export async function getPendingQuestion(db: Database, correlationId: string) {
  const [row] = await db.select().from(pendingQuestions).where(eq(pendingQuestions.id, correlationId)).limit(1);
  return row ?? null;
}

/** Re-export for tests / callers that want the type without depending on shared. */
export type { QuestionMessageContent };
