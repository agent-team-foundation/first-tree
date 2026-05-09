import {
  type QuestionAnswerMessageContent,
  type QuestionMessageContent,
  questionAnswerMessageContentSchema,
  questionMessageContentSchema,
} from "@agent-team-foundation/first-tree-hub-shared";
import { and, eq, inArray } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
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
 *   4. Send a `format=question_answer` message via the regular message
 *      pipeline (so fan-out, NOTIFY and inbox delivery happen unchanged).
 *   5. Flip status to `answered`.
 *
 * `submitterAgentId` is the human agent on whose behalf the answer is
 * written (it must be a participant of the question's chat). Returns the
 * created `question_answer` message id so the route can include it in the
 * 201 response.
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
  // Step 1+2+3: validate inside a SELECT-FOR-UPDATE so two concurrent
  // submissions race cleanly (the second sees status=answered and 409s).
  const { questionRow } = await db.transaction(async (tx) => {
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

    return { questionRow: row };
  });

  // Step 4: send the answer message. We do this OUTSIDE the lock-tx because
  // sendMessage opens its own transaction (fan-out + chat-projection); nesting
  // would deadlock. The narrow window between unlock and the final UPDATE
  // below is bounded by the unique-PK on `pending_questions.id`, so a parallel
  // submitAnswer on the same correlationId would still see status=pending
  // here, but its UPDATE-with-WHERE-status=pending in step 5 will lose the
  // race and bail out with ConflictError.
  const answerContent: QuestionAnswerMessageContent = {
    correlationId: args.correlationId,
    answers: args.answers,
  };
  // Final parse to surface a clear error if something upstream mutated shape.
  questionAnswerMessageContentSchema.parse(answerContent);

  const result = await sendMessage(db, args.chatId, args.submitterAgentId, {
    format: "question_answer",
    content: answerContent,
    inReplyTo: questionRow.messageId,
    source: "hub_ui",
  });

  // Step 5: flip status — guarded by `WHERE status='pending'` so a concurrent
  // submitAnswer (rare; would have to race past the lock-tx) still produces
  // exactly one answered row.
  const flipped = await db
    .update(pendingQuestions)
    .set({ status: "answered", answeredAt: new Date() })
    .where(and(eq(pendingQuestions.id, args.correlationId), eq(pendingQuestions.status, "pending")))
    .returning({ id: pendingQuestions.id });

  if (flipped.length === 0) {
    // Lost the race — another submitter committed first. The answer message
    // we just emitted is still valid (the agent learns that a duplicate
    // arrived); but signal the conflict to the caller.
    log.warn(
      { correlationId: args.correlationId, chatId: args.chatId },
      "submitAnswer lost the race; status was already flipped",
    );
    throw new ConflictError(`Question "${args.correlationId}" was answered concurrently`);
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
