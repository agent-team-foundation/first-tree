import {
  CONTEXT_TREE_VERIFICATION_STATUSES,
  NOTIFICATION_TYPES,
  TREE_WRITE_TASK_STATES,
  type TreeWriteTaskResult,
  type TreeWriteTaskStart,
} from "@agent-team-foundation/first-tree-hub-shared";
import { and, eq, ne, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agentPresence } from "../db/schema/agent-presence.js";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chats } from "../db/schema/chats.js";
import { treeWriteTasks } from "../db/schema/tree-write-tasks.js";
import { createLogger } from "../observability/index.js";
import { uuidv7 } from "../uuid.js";
import { createChat } from "./chat.js";
import { hasActiveConnection, sendToAgent } from "./connection-manager.js";
import { createNotification } from "./notification.js";
import { getOrgContextTree } from "./org-settings.js";

const { VERIFIED } = CONTEXT_TREE_VERIFICATION_STATUSES;
const { PENDING, RUNNING, DONE, NO_WRITE, FAILED } = TREE_WRITE_TASK_STATES;
const log = createLogger("tree-write");

const TREE_WRITE_MAX_ATTEMPTS = 3;
const TREE_WRITE_RETRY_BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000] as const;
const TREE_WRITE_LEASE_SQL = sql`NOW() + INTERVAL '15 minutes'`;
const TREE_WRITE_LEASE_REFRESH_SQL = sql`NOW() + INTERVAL '15 minutes'`;

type TreeWriteClaimRow = {
  id: string;
  source_chat_id: string;
  owner_user_id: string;
  archive_seq: number;
  agent_id: string;
  exec_chat_id: string | null;
  attempt_count: number;
};

type PromptMessageRow = {
  sender_id: string;
  format: string;
  content: unknown;
  created_at: Date;
  name: string | null;
  display_name: string | null;
};

function renderMessageContentForPrompt(content: unknown): string {
  if (typeof content === "string") return content;
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function trimToByteBudget(values: string[], byteBudget: number): string[] {
  const picked: string[] = [];
  let used = 0;
  for (const value of values) {
    const bytes = Buffer.byteLength(value, "utf8");
    if (used + bytes > byteBudget) break;
    picked.push(value);
    used += bytes;
  }
  return picked;
}

function pickTailWithinBudget(values: string[], byteBudget: number): string[] {
  const reversed: string[] = [];
  let used = 0;
  for (let idx = values.length - 1; idx >= 0; idx--) {
    const value = values[idx];
    if (!value) continue;
    const bytes = Buffer.byteLength(value, "utf8");
    if (used + bytes > byteBudget) break;
    reversed.push(value);
    used += bytes;
  }
  reversed.reverse();
  return reversed;
}

async function createExecChatForTreeWrite(
  db: Database,
  sourceChatId: string,
  ownerHumanAgentId: string,
  agentId: string,
  taskId: string,
): Promise<string> {
  const created = await createChat(db, ownerHumanAgentId, {
    type: "direct",
    participantIds: [agentId],
    metadata: {},
  });

  await db
    .update(chats)
    .set({
      parentChatId: sourceChatId,
      lifecyclePolicy: "tree_write_background",
      metadata: {
        source: "tree_write_background",
        sourceChatId,
        taskId,
      },
      updatedAt: new Date(),
    })
    .where(eq(chats.id, created.id));

  return created.id;
}

async function buildTreeWritePrompt(db: Database, sourceChatId: string): Promise<string> {
  const rows = (await db.execute<PromptMessageRow>(sql`
    SELECT
      m.id,
      m.sender_id,
      m.format,
      m.content,
      m.created_at,
      a.name,
      a.display_name
    FROM messages m
    LEFT JOIN agents a ON a.uuid = m.sender_id
    WHERE m.chat_id = ${sourceChatId}
    ORDER BY m.created_at ASC, m.id ASC
  `)) as PromptMessageRow[];

  const totalMessages = rows.length;
  const headRows = rows.slice(0, 20);
  const tailStart = Math.max(headRows.length, rows.length - 180);
  const tailRows = rows.slice(tailStart);

  const headLines = headRows.map((row) => {
    const label = row.name ?? row.display_name ?? row.sender_id;
    return `[${row.created_at.toISOString()}] ${label} (${row.format})\n${renderMessageContentForPrompt(row.content)}`;
  });
  const tailLines = tailRows.map((row) => {
    const label = row.name ?? row.display_name ?? row.sender_id;
    return `[${row.created_at.toISOString()}] ${label} (${row.format})\n${renderMessageContentForPrompt(row.content)}`;
  });

  const includedHeadLines = trimToByteBudget(headLines, 120_000);
  const remainingBudget = Math.max(
    0,
    120_000 - Buffer.byteLength(includedHeadLines.join("\n\n"), "utf8") - (includedHeadLines.length > 0 ? 2 : 0),
  );
  const includedTailLines = pickTailWithinBudget(tailLines, remainingBudget);
  const includedLines = [...includedHeadLines, ...includedTailLines];
  const truncated =
    includedHeadLines.length !== headLines.length ||
    includedTailLines.length !== tailLines.length ||
    includedLines.length !== totalMessages;

  return [
    "You are running a background Context Tree write task for an archived chat.",
    "Default to NO_WRITE. Only open a Context Tree PR if the conversation produced a durable decision or cross-domain context update worth preserving.",
    "When you finish, output EXACTLY one JSON object and nothing else.",
    "",
    "Allowed result shapes:",
    '{"kind":"done","prUrl":"https://github.com/agent-team-foundation/first-tree-context/pull/999"}',
    '{"kind":"no_write","reason":{"code":"no_durable_decision","message":"Why no tree update is needed."}}',
    '{"kind":"failed","error":{"code":"tree_write_tool_error","message":"Why execution failed."}}',
    "",
    "Rules:",
    "- If the transcript window is insufficient, return no_write with code `insufficient_context`.",
    "- If no durable decision emerged, return no_write with code `no_durable_decision`.",
    "- Do not include markdown fences or explanatory text outside the JSON object.",
    "",
    `Source chat: ${sourceChatId}`,
    `Transcript window: ${JSON.stringify({
      totalMessages,
      includedHead: includedHeadLines.length,
      includedTail: includedTailLines.length,
      truncated,
    })}`,
    "",
    "Transcript:",
    includedLines.join("\n\n"),
  ].join("\n");
}

async function finalizeTreeWriteNotification(
  db: Database,
  task: { sourceChatId: string; agentId: string },
  input:
    | { state: typeof DONE; message: string }
    | { state: typeof NO_WRITE; message: string }
    | { state: typeof FAILED; message: string },
): Promise<void> {
  const [chat] = await db
    .select({ organizationId: chats.organizationId })
    .from(chats)
    .where(eq(chats.id, task.sourceChatId))
    .limit(1);
  if (!chat) return;

  await createNotification(db, {
    organizationId: chat.organizationId,
    type: NOTIFICATION_TYPES.TREE_WRITE_COMPLETED,
    severity: input.state === FAILED ? "medium" : "low",
    agentId: task.agentId,
    chatId: task.sourceChatId,
    message: input.message,
  });
}

function retryDelayMsForAttempt(attemptCount: number): number {
  const index = Math.max(0, Math.min(attemptCount - 1, TREE_WRITE_RETRY_BACKOFF_MS.length - 1));
  const delay = TREE_WRITE_RETRY_BACKOFF_MS[index];
  if (delay !== undefined) return delay;
  return 30 * 60_000;
}

async function scheduleRetryOrFail(db: Database, task: TreeWriteClaimRow, errorMessage: string): Promise<void> {
  if (task.attempt_count >= TREE_WRITE_MAX_ATTEMPTS) {
    await db
      .update(treeWriteTasks)
      .set({
        state: FAILED,
        leaseExpiresAt: null,
        lastError: errorMessage,
        updatedAt: new Date(),
      })
      .where(eq(treeWriteTasks.id, task.id));
    await finalizeTreeWriteNotification(
      db,
      { sourceChatId: task.source_chat_id, agentId: task.agent_id },
      { state: FAILED, message: `Context Tree write failed after retries: ${errorMessage}` },
    );
    return;
  }

  await db
    .update(treeWriteTasks)
    .set({
      state: PENDING,
      leaseExpiresAt: null,
      nextAttemptAt: new Date(Date.now() + retryDelayMsForAttempt(task.attempt_count)),
      lastError: errorMessage,
      updatedAt: new Date(),
    })
    .where(eq(treeWriteTasks.id, task.id));
}

async function finalizeNoWrite(
  db: Database,
  taskId: string,
  sourceChatId: string,
  agentId: string,
  reason: { code: string; message: string },
): Promise<void> {
  await db
    .update(treeWriteTasks)
    .set({
      state: NO_WRITE,
      execChatId: null,
      leaseExpiresAt: null,
      resultKind: NO_WRITE,
      resultPayload: { reason },
      lastError: null,
      updatedAt: new Date(),
    })
    .where(eq(treeWriteTasks.id, taskId));
  await finalizeTreeWriteNotification(
    db,
    { sourceChatId, agentId },
    { state: NO_WRITE, message: `Context Tree write skipped: ${reason.message}` },
  );
}

async function resolveOwnerHumanAgentId(
  db: Database,
  sourceChatId: string,
  ownerUserId: string,
): Promise<{ humanAgentId: string; organizationId: string } | null> {
  const rows = await db.execute<{ agent_id: string; organization_id: string }>(sql`
    SELECT m.agent_id, c.organization_id
    FROM chats c
    INNER JOIN members m
      ON m.organization_id = c.organization_id
     AND m.user_id = ${ownerUserId}
     AND m.status = 'active'
    WHERE c.id = ${sourceChatId}
    LIMIT 1
  `);
  const row = rows[0];
  if (!row) return null;
  return { humanAgentId: row.agent_id, organizationId: row.organization_id };
}

export async function maybeEnqueueTreeWriteTask(
  db: Database,
  input: {
    sourceChatId: string;
    ownerUserId: string;
    ownerMemberId: string;
    archiveSeq: number;
  },
): Promise<void> {
  const candidates = await db
    .select({
      agentId: agents.uuid,
      treeWriteOnArchive: agents.treeWriteOnArchive,
    })
    .from(chatMembership)
    .innerJoin(agents, eq(chatMembership.agentId, agents.uuid))
    .where(
      and(
        eq(chatMembership.chatId, input.sourceChatId),
        eq(chatMembership.accessMode, "speaker"),
        eq(agents.managerId, input.ownerMemberId),
        ne(agents.type, "human"),
        ne(agents.status, "deleted"),
        eq(agents.treeWriteOnArchive, true),
      ),
    );

  if (candidates.length === 0) {
    log.debug(
      { chatId: input.sourceChatId, ownerMemberId: input.ownerMemberId },
      "tree-write enqueue skipped: no eligible owning agent",
    );
    return;
  }
  if (candidates.length !== 1) {
    log.warn(
      { chatId: input.sourceChatId, ownerMemberId: input.ownerMemberId, candidateCount: candidates.length },
      "tree-write enqueue skipped: multiple eligible owning agents",
    );
    return;
  }
  const candidate = candidates[0];
  if (!candidate) return;

  await db
    .insert(treeWriteTasks)
    .values({
      id: uuidv7(),
      sourceChatId: input.sourceChatId,
      ownerUserId: input.ownerUserId,
      archiveSeq: input.archiveSeq,
      agentId: candidate.agentId,
      state: PENDING,
      nextAttemptAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoNothing();
}

export async function claimReadyTreeWriteTasks(db: Database, limit = 1): Promise<TreeWriteClaimRow[]> {
  return db.execute<TreeWriteClaimRow>(sql`
    UPDATE tree_write_tasks
       SET state = ${RUNNING},
           attempt_count = attempt_count + 1,
           lease_expires_at = ${TREE_WRITE_LEASE_SQL},
           updated_at = NOW()
     WHERE id IN (
       SELECT id
         FROM tree_write_tasks
        WHERE state = ${PENDING}
          AND next_attempt_at <= NOW()
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
     )
     RETURNING
       id,
       source_chat_id,
       owner_user_id,
       archive_seq,
       agent_id,
       exec_chat_id,
       attempt_count
  `);
}

export async function renewTreeWriteLease(
  db: Database,
  taskId: string,
  agentId: string,
  attemptCount: number,
): Promise<void> {
  await db
    .update(treeWriteTasks)
    .set({ state: RUNNING, leaseExpiresAt: TREE_WRITE_LEASE_REFRESH_SQL, updatedAt: new Date() })
    .where(
      and(
        eq(treeWriteTasks.id, taskId),
        eq(treeWriteTasks.agentId, agentId),
        eq(treeWriteTasks.attemptCount, attemptCount),
        sql`${treeWriteTasks.state} IN (${RUNNING}, ${PENDING})`,
      ),
    );
}

export async function sweepExpiredTreeWriteTasks(db: Database): Promise<void> {
  const expired = await db.execute<TreeWriteClaimRow>(sql`
    SELECT
      id,
      source_chat_id,
      owner_user_id,
      archive_seq,
      agent_id,
      exec_chat_id,
      attempt_count
    FROM tree_write_tasks
    WHERE state = ${RUNNING}
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at <= NOW()
  `);

  for (const task of expired) {
    await scheduleRetryOrFail(db, task, "tree-write lease expired before a terminal result arrived");
  }
}

export async function dispatchTreeWriteTask(db: Database, task: TreeWriteClaimRow): Promise<void> {
  try {
    if (!hasActiveConnection(task.agent_id)) {
      await scheduleRetryOrFail(db, task, "target agent is currently offline");
      return;
    }

    const owner = await resolveOwnerHumanAgentId(db, task.source_chat_id, task.owner_user_id);
    if (!owner) {
      await scheduleRetryOrFail(db, task, "owner human agent could not be resolved for the archived chat");
      return;
    }

    const orgTree = await getOrgContextTree(db, owner.organizationId);
    const [presence] = await db
      .select({
        clientId: agentPresence.clientId,
        contextTreeRepoUrl: agentPresence.contextTreeRepoUrl,
        contextTreeBranch: agentPresence.contextTreeBranch,
        contextTreeVerificationStatus: agentPresence.contextTreeVerificationStatus,
      })
      .from(agentPresence)
      .where(eq(agentPresence.agentId, task.agent_id))
      .limit(1);

    if (!presence?.clientId) {
      await scheduleRetryOrFail(
        db,
        task,
        "target agent presence is offline while waiting for a verified context tree binding",
      );
      return;
    }

    const expectedBranch = orgTree.branch ?? "main";
    const verified =
      !!orgTree.repo &&
      presence?.contextTreeVerificationStatus === VERIFIED &&
      presence.contextTreeRepoUrl === orgTree.repo &&
      (presence.contextTreeBranch ?? "main") === expectedBranch;

    if (!verified) {
      await finalizeNoWrite(db, task.id, task.source_chat_id, task.agent_id, {
        code: "unverified_tree",
        message: "Resolved Context Tree binding is missing, stale, or not verified on the running client.",
      });
      return;
    }

    const execChatId =
      task.exec_chat_id ??
      (await createExecChatForTreeWrite(db, task.source_chat_id, owner.humanAgentId, task.agent_id, task.id));

    if (!task.exec_chat_id) {
      await db.update(treeWriteTasks).set({ execChatId, updatedAt: new Date() }).where(eq(treeWriteTasks.id, task.id));
    }

    const prompt = await buildTreeWritePrompt(db, task.source_chat_id);
    const frame: TreeWriteTaskStart = {
      type: "task:tree_write:start",
      taskId: task.id,
      attemptCount: task.attempt_count,
      execChatId,
      sourceChatId: task.source_chat_id,
      prompt,
    };

    const delivered = sendToAgent(task.agent_id, frame);
    if (!delivered) {
      await scheduleRetryOrFail(db, task, "target agent is not currently connected to the hub");
      return;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await scheduleRetryOrFail(db, task, message);
  }
}

export async function finalizeTreeWriteTaskResult(
  db: Database,
  agentId: string,
  result: TreeWriteTaskResult,
): Promise<void> {
  if (result.kind === "done") {
    const [task] = await db
      .update(treeWriteTasks)
      .set({
        state: DONE,
        leaseExpiresAt: null,
        resultKind: DONE,
        resultPayload: { prUrl: result.prUrl },
        lastError: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(treeWriteTasks.id, result.taskId),
          eq(treeWriteTasks.agentId, agentId),
          eq(treeWriteTasks.attemptCount, result.attemptCount),
          sql`${treeWriteTasks.state} IN (${RUNNING}, ${PENDING})`,
        ),
      )
      .returning({ sourceChatId: treeWriteTasks.sourceChatId, agentId: treeWriteTasks.agentId });
    if (!task) return;
    await finalizeTreeWriteNotification(
      db,
      { sourceChatId: task.sourceChatId, agentId: task.agentId },
      { state: DONE, message: `Context Tree write completed: ${result.prUrl}` },
    );
    return;
  }

  if (result.kind === "no_write") {
    const [task] = await db
      .update(treeWriteTasks)
      .set({
        state: NO_WRITE,
        leaseExpiresAt: null,
        resultKind: NO_WRITE,
        resultPayload: { reason: result.reason },
        lastError: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(treeWriteTasks.id, result.taskId),
          eq(treeWriteTasks.agentId, agentId),
          eq(treeWriteTasks.attemptCount, result.attemptCount),
          sql`${treeWriteTasks.state} IN (${RUNNING}, ${PENDING})`,
        ),
      )
      .returning({ sourceChatId: treeWriteTasks.sourceChatId, agentId: treeWriteTasks.agentId });
    if (!task) return;
    await finalizeTreeWriteNotification(
      db,
      { sourceChatId: task.sourceChatId, agentId: task.agentId },
      { state: NO_WRITE, message: `Context Tree write skipped: ${result.reason.message}` },
    );
    return;
  }

  const [task] = await db
    .update(treeWriteTasks)
    .set({
      state: FAILED,
      leaseExpiresAt: null,
      resultKind: FAILED,
      resultPayload: { error: result.error },
      lastError: result.error.message,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(treeWriteTasks.id, result.taskId),
        eq(treeWriteTasks.agentId, agentId),
        eq(treeWriteTasks.attemptCount, result.attemptCount),
        sql`${treeWriteTasks.state} IN (${RUNNING}, ${PENDING})`,
      ),
    )
    .returning({ sourceChatId: treeWriteTasks.sourceChatId, agentId: treeWriteTasks.agentId });
  if (!task) return;
  await finalizeTreeWriteNotification(
    db,
    { sourceChatId: task.sourceChatId, agentId: task.agentId },
    { state: FAILED, message: `Context Tree write failed: ${result.error.message}` },
  );
}
