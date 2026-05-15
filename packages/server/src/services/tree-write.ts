import {
  CONTEXT_TREE_VERIFICATION_STATUSES,
  NOTIFICATION_TYPES,
  type TreeWriteTaskResult,
  type TreeWriteTaskStart,
} from "@agent-team-foundation/first-tree-hub-shared";
import { and, eq, ne, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agentPresence } from "../db/schema/agent-presence.js";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chats } from "../db/schema/chats.js";
import { createLogger } from "../observability/index.js";
import { uuidv7 } from "../uuid.js";
import { createChat } from "./chat.js";
import { hasActiveConnection, sendToAgent } from "./connection-manager.js";
import { createNotification } from "./notification.js";
import { getOrgContextTree } from "./org-settings.js";

const { VERIFIED } = CONTEXT_TREE_VERIFICATION_STATUSES;
const log = createLogger("tree-write");

type ActiveTreeWriteTask = {
  agentId: string;
  sourceChatId: string;
  cleanupTimer: ReturnType<typeof setTimeout>;
};

type PromptMessageRow = {
  sender_id: string;
  format: string;
  content: unknown;
  created_at: Date;
  name: string | null;
  display_name: string | null;
};

const activeTasks = new Map<string, ActiveTreeWriteTask>();
const ACTIVE_TASK_TTL_MS = 24 * 60 * 60 * 1000;

function rememberTask(taskId: string, task: { agentId: string; sourceChatId: string }): void {
  const existing = activeTasks.get(taskId);
  if (existing) clearTimeout(existing.cleanupTimer);
  const cleanupTimer = setTimeout(() => {
    activeTasks.delete(taskId);
  }, ACTIVE_TASK_TTL_MS);
  activeTasks.set(taskId, { ...task, cleanupTimer });
}

function getTask(taskId: string): { agentId: string; sourceChatId: string } | null {
  const task = activeTasks.get(taskId);
  if (!task) return null;
  return { agentId: task.agentId, sourceChatId: task.sourceChatId };
}

function forgetTask(taskId: string): void {
  const task = activeTasks.get(taskId);
  if (!task) return;
  clearTimeout(task.cleanupTimer);
  activeTasks.delete(taskId);
}

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

async function createTreeWriteNotification(
  db: Database,
  sourceChatId: string,
  agentId: string,
  message: string,
  severity: "low" | "medium" = "low",
): Promise<void> {
  const [chat] = await db
    .select({ organizationId: chats.organizationId })
    .from(chats)
    .where(eq(chats.id, sourceChatId))
    .limit(1);
  if (!chat) return;

  await createNotification(db, {
    organizationId: chat.organizationId,
    type: NOTIFICATION_TYPES.TREE_WRITE_COMPLETED,
    severity,
    agentId,
    chatId: sourceChatId,
    message,
  });
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

export async function maybeStartTreeWriteOnArchive(
  db: Database,
  input: {
    sourceChatId: string;
    ownerUserId: string;
    ownerMemberId: string;
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
      "tree-write start skipped: no eligible owning agent",
    );
    return;
  }
  if (candidates.length > 1) {
    log.warn(
      { chatId: input.sourceChatId, ownerMemberId: input.ownerMemberId, candidateCount: candidates.length },
      "tree-write start skipped: multiple eligible owning agents",
    );
    return;
  }

  const candidate = candidates[0];
  if (!candidate) return;

  if (!hasActiveConnection(candidate.agentId)) {
    await createTreeWriteNotification(
      db,
      input.sourceChatId,
      candidate.agentId,
      "Context Tree write skipped: agent_offline",
    );
    return;
  }

  const owner = await resolveOwnerHumanAgentId(db, input.sourceChatId, input.ownerUserId);
  if (!owner) {
    log.warn(
      { chatId: input.sourceChatId, ownerUserId: input.ownerUserId },
      "tree-write start skipped: owner human agent could not be resolved",
    );
    return;
  }

  const orgTree = await getOrgContextTree(db, owner.organizationId);
  const [presence] = await db
    .select({
      contextTreeRepoUrl: agentPresence.contextTreeRepoUrl,
      contextTreeBranch: agentPresence.contextTreeBranch,
      contextTreeVerificationStatus: agentPresence.contextTreeVerificationStatus,
    })
    .from(agentPresence)
    .where(eq(agentPresence.agentId, candidate.agentId))
    .limit(1);

  const expectedBranch = orgTree.branch ?? "main";
  const verified =
    !!orgTree.repo &&
    presence?.contextTreeVerificationStatus === VERIFIED &&
    presence.contextTreeRepoUrl === orgTree.repo &&
    (presence.contextTreeBranch ?? "main") === expectedBranch;

  if (!verified) {
    await createTreeWriteNotification(
      db,
      input.sourceChatId,
      candidate.agentId,
      "Context Tree write skipped: unverified_tree",
    );
    return;
  }

  const taskId = uuidv7();
  const execChatId = await createExecChatForTreeWrite(
    db,
    input.sourceChatId,
    owner.humanAgentId,
    candidate.agentId,
    taskId,
  );
  const prompt = await buildTreeWritePrompt(db, input.sourceChatId);
  const frame: TreeWriteTaskStart = {
    type: "task:tree_write:start",
    taskId,
    execChatId,
    sourceChatId: input.sourceChatId,
    prompt,
  };

  const delivered = sendToAgent(candidate.agentId, frame);
  if (!delivered) {
    await createTreeWriteNotification(
      db,
      input.sourceChatId,
      candidate.agentId,
      "Context Tree write skipped: agent_offline",
    );
    return;
  }

  rememberTask(taskId, { agentId: candidate.agentId, sourceChatId: input.sourceChatId });
}

export async function finalizeTreeWriteTaskResult(
  db: Database,
  agentId: string,
  result: TreeWriteTaskResult,
): Promise<void> {
  const task = getTask(result.taskId);
  if (!task) return;
  if (task.agentId !== agentId) return;
  forgetTask(result.taskId);

  if (result.kind === "done") {
    await createTreeWriteNotification(
      db,
      task.sourceChatId,
      task.agentId,
      `Context Tree write completed: ${result.prUrl}`,
    );
    return;
  }

  if (result.kind === "no_write") {
    await createTreeWriteNotification(
      db,
      task.sourceChatId,
      task.agentId,
      `Context Tree write skipped: ${result.reason.message}`,
    );
    return;
  }

  await createTreeWriteNotification(
    db,
    task.sourceChatId,
    task.agentId,
    `Context Tree write failed: ${result.error.message}`,
    "medium",
  );
}
