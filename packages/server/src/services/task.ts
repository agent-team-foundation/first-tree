import type {
  AdminUpdateTask,
  CreateTask,
  TaskCreatorType,
  TaskHealth,
  TaskHealthSignal,
  TaskListQuery,
  TaskMessageContent,
  TaskStatus,
  UpdateTaskStatus,
} from "@agent-team-foundation/first-tree-hub-shared";
import {
  AGENT_SOURCES,
  AGENT_STATUSES,
  AGENT_TYPES,
  TASK_CREATOR_TYPES,
  TASK_HEALTH_SIGNALS,
  TASK_STATUSES,
  TASK_TERMINAL_STATUSES,
} from "@agent-team-foundation/first-tree-hub-shared";
import { and, asc, desc, eq, lt, ne } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agentChatSessions } from "../db/schema/agent-chat-sessions.js";
import { agents } from "../db/schema/agents.js";
import { chats } from "../db/schema/chats.js";
import { members } from "../db/schema/members.js";
import { messages } from "../db/schema/messages.js";
import { organizations } from "../db/schema/organizations.js";
import { taskChats, tasks } from "../db/schema/tasks.js";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../errors.js";
import { uuidv7 } from "../uuid.js";
import { assertParticipant, findOrCreateDirectChat } from "./chat.js";
import { type SendMessageResult, sendMessage } from "./message.js";

/**
 * Caller identity for service-layer authorization. Agent UUID or admin user ID.
 * Matches the `created_by_type` / `created_by_id` split in the tasks table.
 */
export type TaskActor = { type: "agent"; agentId: string; organizationId: string } | { type: "admin"; adminId: string };

/** Legal status transitions. Service enforces; API maps violations to 400. */
const STATUS_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  pending: ["assigned", "cancelled"],
  assigned: ["working", "cancelled"],
  working: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

function isLegalTransition(from: TaskStatus, to: TaskStatus): boolean {
  return STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

function isTerminal(status: TaskStatus): boolean {
  return TASK_TERMINAL_STATUSES.includes(status);
}

/**
 * Reserved name for the hub-owned task notifier pseudo agent. The `__` prefix
 * is rejected by `createAgent`, so real users cannot squat on this identity.
 */
const SYSTEM_TASKS_AGENT_NAME = "__hub_system_tasks";

/**
 * Ensure a task-notifier pseudo agent exists in the given organization and
 * return its UUID. Used as the sender for task notification messages so they
 * flow through the normal chat/inbox pipeline. Idempotent under concurrent
 * creation via the unique `(organization_id, name)` constraint.
 */
export async function ensureSystemTasksAgent(db: Database, organizationId: string): Promise<string> {
  const [existing] = await db
    .select({ uuid: agents.uuid })
    .from(agents)
    .where(
      and(
        eq(agents.organizationId, organizationId),
        eq(agents.name, SYSTEM_TASKS_AGENT_NAME),
        ne(agents.status, AGENT_STATUSES.DELETED),
      ),
    )
    .limit(1);
  if (existing) return existing.uuid;

  const uuid = uuidv7();
  const inboxId = `inbox_${uuid}`;

  // Pick an admin member as the manager — system agents still need a non-null
  // managerId in the unified-user-token milestone. Falls back loudly if no
  // admin exists in the org.
  const [adminMember] = await db
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.organizationId, organizationId), eq(members.role, "admin")))
    .orderBy(asc(members.createdAt))
    .limit(1);
  if (!adminMember) {
    throw new ConflictError(
      `Cannot create system tasks agent in organization "${organizationId}" — no admin member exists.`,
    );
  }

  try {
    const [created] = await db
      .insert(agents)
      .values({
        uuid,
        name: SYSTEM_TASKS_AGENT_NAME,
        organizationId,
        type: AGENT_TYPES.AUTONOMOUS_AGENT,
        displayName: "System · Tasks",
        inboxId,
        status: AGENT_STATUSES.ACTIVE,
        source: AGENT_SOURCES.ADMIN_API,
        metadata: { system: true, role: "task-notifier" },
        managerId: adminMember.id,
      })
      .returning({ uuid: agents.uuid });
    if (created) return created.uuid;
  } catch (err) {
    const pgCode = (err as { code?: string })?.code ?? (err as { cause?: { code?: string } })?.cause?.code ?? "";
    if (pgCode !== "23505") throw err;
  }
  // Concurrent caller won the INSERT race — reread by the reserved name.
  const [row] = await db
    .select({ uuid: agents.uuid })
    .from(agents)
    .where(and(eq(agents.organizationId, organizationId), eq(agents.name, SYSTEM_TASKS_AGENT_NAME)))
    .limit(1);
  if (!row) throw new Error("ensureSystemTasksAgent: agent missing after conflict");
  return row.uuid;
}

type TaskRow = typeof tasks.$inferSelect;

function resolveCreator(actor: TaskActor): { type: TaskCreatorType; id: string } {
  if (actor.type === "agent") return { type: TASK_CREATOR_TYPES.AGENT, id: actor.agentId };
  return { type: TASK_CREATOR_TYPES.ADMIN, id: actor.adminId };
}

/**
 * Assert the task allows the given agent actor to mutate its chat associations.
 * Only the creator or assignee (for agents) or any admin may do so.
 */
function assertCanMutateTaskChats(task: TaskRow, actor: TaskActor): void {
  if (actor.type === "admin") return;
  const isAssignee = task.assigneeAgentId === actor.agentId;
  const isCreator = task.createdByType === TASK_CREATOR_TYPES.AGENT && task.createdById === actor.agentId;
  if (!isAssignee && !isCreator) {
    throw new ForbiddenError("Only the task creator or assignee may modify its chat associations");
  }
}

async function loadAssigneeOrThrow(
  db: Database,
  assigneeAgentId: string,
  expectedOrgId: string,
): Promise<{ uuid: string; organizationId: string; status: string }> {
  const [assignee] = await db
    .select({ uuid: agents.uuid, organizationId: agents.organizationId, status: agents.status })
    .from(agents)
    .where(eq(agents.uuid, assigneeAgentId))
    .limit(1);
  if (!assignee || assignee.status === AGENT_STATUSES.DELETED) {
    throw new BadRequestError(`Assignee agent "${assigneeAgentId}" not found`);
  }
  if (assignee.organizationId !== expectedOrgId) {
    throw new BadRequestError("Assignee agent belongs to a different organization");
  }
  if (assignee.status === AGENT_STATUSES.SUSPENDED) {
    throw new BadRequestError(`Assignee agent "${assigneeAgentId}" is suspended`);
  }
  return assignee;
}

/** Result of createTask — task + optional system notification that was dispatched. */
export type CreateTaskResult = {
  task: TaskRow;
  /** Present when a task-first notification was sent. Caller should trigger notifier fan-out. */
  notification?: SendMessageResult;
};

type CreateTaskInput = CreateTask & { organizationId: string };

/**
 * Create a task.
 *
 * Initial status is determined by assignee:
 *   - no assignee → "pending"
 *   - assignee is an agent and equals the creator → "working" (work-first; no notification)
 *   - assignee set and differs from creator → "assigned" (task-first; notification dispatched)
 *
 * Task-first notifications go through the regular message+inbox pipeline via a per-org
 * task-notifier pseudo agent. The caller is responsible for triggering notifier fan-out
 * using the returned notification recipients.
 */
export async function createTask(db: Database, actor: TaskActor, input: CreateTaskInput): Promise<CreateTaskResult> {
  const [org] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, input.organizationId))
    .limit(1);
  if (!org) throw new NotFoundError(`Organization "${input.organizationId}" not found`);

  if (input.assigneeAgentId) {
    await loadAssigneeOrThrow(db, input.assigneeAgentId, input.organizationId);
  }

  if (actor.type === "agent" && actor.organizationId !== input.organizationId) {
    throw new ForbiddenError("Cannot create tasks in a different organization");
  }

  const creator = resolveCreator(actor);

  const selfAssigned =
    input.assigneeAgentId !== undefined && actor.type === "agent" && input.assigneeAgentId === actor.agentId;
  let initialStatus: TaskStatus;
  if (!input.assigneeAgentId) {
    initialStatus = TASK_STATUSES.PENDING;
  } else if (selfAssigned) {
    initialStatus = TASK_STATUSES.WORKING;
  } else {
    initialStatus = TASK_STATUSES.ASSIGNED;
  }

  const taskId = uuidv7();
  const [task] = await db
    .insert(tasks)
    .values({
      id: taskId,
      organizationId: input.organizationId,
      title: input.title,
      body: input.body ?? "",
      status: initialStatus,
      assigneeAgentId: input.assigneeAgentId ?? null,
      createdByType: creator.type,
      createdById: creator.id,
      originRef: input.originRef ?? null,
      metadata: input.metadata ?? {},
    })
    .returning();
  if (!task) throw new Error("Unexpected: INSERT RETURNING produced no row");

  let notification: SendMessageResult | undefined;
  if (initialStatus === TASK_STATUSES.ASSIGNED && task.assigneeAgentId) {
    notification = await dispatchTaskSystemMessage(db, task, "assigned");
  }

  return { task, notification };
}

/** Compose and send a system message describing a task state change to the assignee's chat. */
async function dispatchTaskSystemMessage(
  db: Database,
  task: TaskRow,
  event: TaskMessageContent["event"],
  fromStatus?: TaskStatus,
): Promise<SendMessageResult | undefined> {
  if (!task.assigneeAgentId) return undefined;
  const systemAgentId = await ensureSystemTasksAgent(db, task.organizationId);
  if (systemAgentId === task.assigneeAgentId) return undefined;

  const chat = await findOrCreateDirectChat(db, systemAgentId, task.assigneeAgentId);
  const content: TaskMessageContent = {
    taskId: task.id,
    event,
    title: task.title,
    body: task.body,
    status: task.status,
    ...(fromStatus ? { fromStatus } : {}),
    originRef: task.originRef,
  };
  return sendMessage(db, chat.id, systemAgentId, {
    format: "task",
    content,
    metadata: { taskId: task.id, event },
  });
}

/**
 * Fetch a task, optionally asserting it belongs to `expectedOrgId`. Cross-org
 * access is reported as NotFound so we don't leak existence across tenants.
 */
export async function getTask(db: Database, taskId: string, expectedOrgId?: string): Promise<TaskRow> {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!task) throw new NotFoundError(`Task "${taskId}" not found`);
  if (expectedOrgId !== undefined && task.organizationId !== expectedOrgId) {
    throw new NotFoundError(`Task "${taskId}" not found`);
  }
  return task;
}

export async function getTaskDetail(db: Database, taskId: string, expectedOrgId?: string) {
  const task = await getTask(db, taskId, expectedOrgId);
  const links = await db.select().from(taskChats).where(eq(taskChats.taskId, taskId));
  return {
    ...task,
    chats: links.map((c) => ({
      taskId: c.taskId,
      chatId: c.chatId,
      linkedByAgentId: c.linkedByAgentId,
      linkedAt: c.linkedAt.toISOString(),
    })),
  };
}

export async function listTasks(db: Database, organizationId: string, query: TaskListQuery) {
  const conditions = [eq(tasks.organizationId, organizationId)];
  if (query.status) conditions.push(eq(tasks.status, query.status));
  if (query.assigneeAgentId) conditions.push(eq(tasks.assigneeAgentId, query.assigneeAgentId));
  if (query.originRef) conditions.push(eq(tasks.originRef, query.originRef));
  if (query.cursor) conditions.push(lt(tasks.createdAt, new Date(query.cursor)));

  const rows = await db
    .select()
    .from(tasks)
    .where(and(...conditions))
    .orderBy(desc(tasks.createdAt))
    .limit(query.limit + 1);

  const hasMore = rows.length > query.limit;
  const items = hasMore ? rows.slice(0, query.limit) : rows;
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? last.createdAt.toISOString() : null;
  return { items, nextCursor };
}

/** Agent self-report: working / completed / failed. */
export async function updateTaskStatus(
  db: Database,
  taskId: string,
  actor: TaskActor,
  data: UpdateTaskStatus,
): Promise<{ task: TaskRow }> {
  const existing = await getTask(db, taskId);
  if (actor.type !== "agent") {
    throw new ForbiddenError("updateTaskStatus is for agent self-report; use adminUpdateTask for admin actions");
  }
  if (existing.assigneeAgentId !== actor.agentId) {
    throw new ForbiddenError("Only the assignee may update this task");
  }
  const from = existing.status;
  const to = data.status;
  if (!isLegalTransition(from, to)) {
    throw new BadRequestError(`Illegal status transition: ${from} → ${to}`);
  }
  if (to === TASK_STATUSES.COMPLETED && data.result === undefined) {
    // Allow empty-string result but not undefined — completion requires explicit closure
    throw new BadRequestError("Completion requires a result (may be an empty string)");
  }

  const updates: Partial<typeof tasks.$inferInsert> = {
    status: to,
    updatedAt: new Date(),
  };
  if (data.result !== undefined) updates.result = data.result;

  const [updated] = await db.update(tasks).set(updates).where(eq(tasks.id, taskId)).returning();
  if (!updated) throw new Error("Unexpected: UPDATE RETURNING produced no row");
  return { task: updated };
}

/** Admin-facing update: may re-assign while pending, or force a status transition (still gated by state machine). */
export async function adminUpdateTask(
  db: Database,
  taskId: string,
  actor: TaskActor,
  data: AdminUpdateTask,
): Promise<{ task: TaskRow; notification?: SendMessageResult }> {
  if (actor.type !== "admin") {
    throw new ForbiddenError("adminUpdateTask requires admin actor");
  }
  const existing = await getTask(db, taskId);

  // Route cancellation through cancelTask so audit columns + notification stay consistent.
  if (data.status === TASK_STATUSES.CANCELLED) {
    if (isTerminal(existing.status)) {
      throw new ConflictError(`Task is already in terminal state "${existing.status}"`);
    }
    return cancelTask(db, taskId, actor);
  }

  const updates: Partial<typeof tasks.$inferInsert> = { updatedAt: new Date() };
  let notify = false;

  // Re-assignment is only legal on pending tasks (prevents hijacking in-flight work).
  if (data.assigneeAgentId !== undefined) {
    if (existing.status !== TASK_STATUSES.PENDING && data.assigneeAgentId !== existing.assigneeAgentId) {
      throw new BadRequestError("Cannot reassign a task that is not pending");
    }
    if (data.assigneeAgentId !== null) {
      await loadAssigneeOrThrow(db, data.assigneeAgentId, existing.organizationId);
      updates.assigneeAgentId = data.assigneeAgentId;
      updates.status = TASK_STATUSES.ASSIGNED;
      notify = true;
    } else {
      updates.assigneeAgentId = null;
      updates.status = TASK_STATUSES.PENDING;
    }
  }

  if (data.status !== undefined && data.status !== existing.status) {
    const from = updates.status ?? existing.status;
    if (!isLegalTransition(from, data.status)) {
      throw new BadRequestError(`Illegal status transition: ${from} → ${data.status}`);
    }
    updates.status = data.status;
  }

  if (data.result !== undefined) updates.result = data.result;

  // Guard against "assigned" without an assignee — the state machine allows the
  // transition but the combination is unreachable for any agent.
  const resolvedStatus = updates.status ?? existing.status;
  const resolvedAssignee = updates.assigneeAgentId === undefined ? existing.assigneeAgentId : updates.assigneeAgentId;
  if (resolvedStatus === TASK_STATUSES.ASSIGNED && !resolvedAssignee) {
    throw new BadRequestError('Cannot set status to "assigned" without an assignee');
  }

  const [updated] = await db.update(tasks).set(updates).where(eq(tasks.id, taskId)).returning();
  if (!updated) throw new Error("Unexpected: UPDATE RETURNING produced no row");

  let notification: SendMessageResult | undefined;
  if (notify && updated.assigneeAgentId) {
    notification = await dispatchTaskSystemMessage(db, updated, "assigned");
  }
  return { task: updated, notification };
}

export async function cancelTask(
  db: Database,
  taskId: string,
  actor: TaskActor,
): Promise<{ task: TaskRow; notification?: SendMessageResult }> {
  const existing = await getTask(db, taskId);
  if (isTerminal(existing.status)) {
    throw new ConflictError(`Task is already in terminal state "${existing.status}"`);
  }
  // Agents may only cancel their own tasks; admins may cancel anything.
  if (actor.type === "agent") {
    const isAssignee = existing.assigneeAgentId === actor.agentId;
    const isCreator = existing.createdByType === TASK_CREATOR_TYPES.AGENT && existing.createdById === actor.agentId;
    if (!isAssignee && !isCreator) {
      throw new ForbiddenError("Only the assignee or creator may cancel this task");
    }
  }

  const now = new Date();
  const { type: cancelType, id: cancelId } = resolveCreator(actor);
  const [updated] = await db
    .update(tasks)
    .set({
      status: TASK_STATUSES.CANCELLED,
      cancelledAt: now,
      cancelledByType: cancelType,
      cancelledById: cancelId,
      updatedAt: now,
    })
    .where(eq(tasks.id, taskId))
    .returning();
  if (!updated) throw new Error("Unexpected: UPDATE RETURNING produced no row");

  let notification: SendMessageResult | undefined;
  if (updated.assigneeAgentId && !(actor.type === "agent" && actor.agentId === updated.assigneeAgentId)) {
    notification = await dispatchTaskSystemMessage(db, updated, "cancelled", existing.status);
  }
  return { task: updated, notification };
}

export async function linkChatToTask(db: Database, taskId: string, chatId: string, actor: TaskActor): Promise<void> {
  const task = await getTask(db, taskId);
  if (actor.type === "agent" && task.organizationId !== actor.organizationId) {
    throw new NotFoundError(`Task "${taskId}" not found`);
  }
  assertCanMutateTaskChats(task, actor);

  const [chat] = await db
    .select({ organizationId: chats.organizationId })
    .from(chats)
    .where(eq(chats.id, chatId))
    .limit(1);
  if (!chat) {
    throw new NotFoundError(`Chat "${chatId}" not found`);
  }
  if (chat.organizationId !== task.organizationId) {
    throw new BadRequestError("Chat belongs to a different organization");
  }
  if (actor.type === "agent") {
    await assertParticipant(db, chatId, actor.agentId);
  }

  const linkedBy = actor.type === "agent" ? actor.agentId : null;
  await db.insert(taskChats).values({ taskId, chatId, linkedByAgentId: linkedBy }).onConflictDoNothing();
}

export async function unlinkChatFromTask(
  db: Database,
  taskId: string,
  chatId: string,
  actor: TaskActor,
): Promise<void> {
  const task = await getTask(db, taskId);
  if (actor.type === "agent" && task.organizationId !== actor.organizationId) {
    throw new NotFoundError(`Task "${taskId}" not found`);
  }
  assertCanMutateTaskChats(task, actor);

  const result = await db
    .delete(taskChats)
    .where(and(eq(taskChats.taskId, taskId), eq(taskChats.chatId, chatId)))
    .returning({ chatId: taskChats.chatId });
  if (result.length === 0) {
    throw new NotFoundError(`Chat "${chatId}" is not linked to task "${taskId}"`);
  }
}

/**
 * Derive a health signal for a task. Only meaningful for `working` tasks.
 * See hub-task-design Section 9 for the rules this implements.
 *
 * Algorithm (per linked chat for the assignee):
 *   1. No session row OR state != 'active' → idle_island candidate
 *   2. Session active, last message from assignee → awaiting_reply candidate
 *   3. Session active, last message from other → normal candidate
 * Across all linked chats, normal wins over awaiting_reply, which wins over idle_island.
 */
export async function getTaskHealth(db: Database, taskId: string, expectedOrgId?: string): Promise<TaskHealth> {
  const task = await getTask(db, taskId, expectedOrgId);
  if (task.status !== TASK_STATUSES.WORKING) {
    return {
      taskId,
      signal: TASK_HEALTH_SIGNALS.NOT_APPLICABLE,
      reason: `Task status is "${task.status}" — health is only computed for working tasks`,
    };
  }
  if (!task.assigneeAgentId) {
    return {
      taskId,
      signal: TASK_HEALTH_SIGNALS.NO_CHAT,
      reason: "Task has no assignee",
    };
  }

  const linked = await db
    .select({
      chatId: taskChats.chatId,
      sessionState: agentChatSessions.state,
    })
    .from(taskChats)
    .leftJoin(
      agentChatSessions,
      and(eq(agentChatSessions.chatId, taskChats.chatId), eq(agentChatSessions.agentId, task.assigneeAgentId)),
    )
    .where(eq(taskChats.taskId, taskId));

  if (linked.length === 0) {
    return {
      taskId,
      signal: TASK_HEALTH_SIGNALS.NO_CHAT,
      reason: "Task has no linked chats",
    };
  }

  const chatSignals: TaskHealthSignal[] = [];
  for (const row of linked) {
    if (row.sessionState !== "active") {
      chatSignals.push(TASK_HEALTH_SIGNALS.IDLE_ISLAND);
      continue;
    }
    const [last] = await db
      .select({ senderId: messages.senderId })
      .from(messages)
      .where(eq(messages.chatId, row.chatId))
      .orderBy(desc(messages.createdAt))
      .limit(1);
    if (!last) {
      chatSignals.push(TASK_HEALTH_SIGNALS.IDLE_ISLAND);
      continue;
    }
    if (last.senderId === task.assigneeAgentId) {
      chatSignals.push(TASK_HEALTH_SIGNALS.AWAITING_REPLY);
    } else {
      chatSignals.push(TASK_HEALTH_SIGNALS.NORMAL);
    }
  }

  // Ranking: NORMAL > AWAITING_REPLY > IDLE_ISLAND. Pick the best.
  if (chatSignals.includes(TASK_HEALTH_SIGNALS.NORMAL)) {
    return { taskId, signal: TASK_HEALTH_SIGNALS.NORMAL, reason: "At least one linked chat is actively progressing" };
  }
  if (chatSignals.includes(TASK_HEALTH_SIGNALS.AWAITING_REPLY)) {
    return {
      taskId,
      signal: TASK_HEALTH_SIGNALS.AWAITING_REPLY,
      reason: "Assignee sent the last message and is waiting for a reply",
    };
  }
  return {
    taskId,
    signal: TASK_HEALTH_SIGNALS.IDLE_ISLAND,
    reason: "No active session found for the assignee in any linked chat",
  };
}

/** Serialize a task row for API output. */
export function serializeTask(task: TaskRow) {
  return {
    ...task,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
    cancelledAt: task.cancelledAt ? task.cancelledAt.toISOString() : null,
  };
}
