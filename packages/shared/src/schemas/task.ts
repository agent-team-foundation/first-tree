import { z } from "zod";

/** Fixed 5-state machine. No custom statuses. */
export const TASK_STATUSES = {
  PENDING: "pending",
  ASSIGNED: "assigned",
  WORKING: "working",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
} as const;

export const taskStatusSchema = z.enum(["pending", "assigned", "working", "completed", "failed", "cancelled"]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

/** Terminal statuses — once reached, no further transitions allowed. */
export const TASK_TERMINAL_STATUSES: readonly TaskStatus[] = ["completed", "failed", "cancelled"] as const;

/** Creator type discriminator. */
export const TASK_CREATOR_TYPES = {
  AGENT: "agent",
  ADMIN: "admin",
} as const;
export const taskCreatorTypeSchema = z.enum(["agent", "admin"]);
export type TaskCreatorType = z.infer<typeof taskCreatorTypeSchema>;

/** Content shape for a message whose format === "task". System-generated; never sent by agents directly. */
export const TASK_MESSAGE_EVENTS = {
  ASSIGNED: "assigned",
  STATUS_CHANGED: "status_changed",
  CANCELLED: "cancelled",
} as const;
export const taskMessageEventSchema = z.enum(["assigned", "status_changed", "cancelled"]);
export type TaskMessageEvent = z.infer<typeof taskMessageEventSchema>;

export const taskMessageContentSchema = z.object({
  taskId: z.string(),
  event: taskMessageEventSchema,
  title: z.string(),
  body: z.string().default(""),
  status: taskStatusSchema,
  fromStatus: taskStatusSchema.optional(),
  originRef: z.string().nullable().optional(),
});
export type TaskMessageContent = z.infer<typeof taskMessageContentSchema>;

/** Create task input. Used by both agent API and admin API. */
export const createTaskSchema = z.object({
  title: z.string().min(1).max(500),
  body: z.string().optional(),
  assigneeAgentId: z.string().optional(),
  originRef: z.string().max(500).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type CreateTask = z.infer<typeof createTaskSchema>;

/** Admin-only create: allows passing an explicit organizationId. */
export const adminCreateTaskSchema = createTaskSchema.extend({
  organizationId: z.string().optional(),
});
export type AdminCreateTask = z.infer<typeof adminCreateTaskSchema>;

/**
 * Agent-facing status update. Agents may only self-report working/completed/failed.
 * Cancellation goes through the dedicated cancel endpoint.
 */
export const updateTaskStatusSchema = z.object({
  status: z.enum(["working", "completed", "failed"]),
  result: z.string().optional(),
});
export type UpdateTaskStatus = z.infer<typeof updateTaskStatusSchema>;

/** Admin-facing update — may re-assign or re-target status (within legal transitions). */
export const adminUpdateTaskSchema = z.object({
  assigneeAgentId: z.string().nullable().optional(),
  status: taskStatusSchema.optional(),
  result: z.string().optional(),
});
export type AdminUpdateTask = z.infer<typeof adminUpdateTaskSchema>;

export const linkTaskChatSchema = z.object({
  chatId: z.string().min(1),
});
export type LinkTaskChat = z.infer<typeof linkTaskChatSchema>;

export const taskSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  title: z.string(),
  body: z.string(),
  status: taskStatusSchema,
  assigneeAgentId: z.string().nullable(),
  createdByType: taskCreatorTypeSchema,
  createdById: z.string(),
  originRef: z.string().nullable(),
  result: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string(),
  cancelledAt: z.string().nullable(),
  cancelledByType: taskCreatorTypeSchema.nullable(),
  cancelledById: z.string().nullable(),
});
export type Task = z.infer<typeof taskSchema>;

export const taskChatLinkSchema = z.object({
  taskId: z.string(),
  chatId: z.string(),
  linkedByAgentId: z.string().nullable(),
  linkedAt: z.string(),
});
export type TaskChatLink = z.infer<typeof taskChatLinkSchema>;

export const taskDetailSchema = taskSchema.extend({
  chats: z.array(taskChatLinkSchema),
});
export type TaskDetail = z.infer<typeof taskDetailSchema>;

export const taskListQuerySchema = z.object({
  status: taskStatusSchema.optional(),
  assigneeAgentId: z.string().optional(),
  originRef: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});
export type TaskListQuery = z.infer<typeof taskListQuerySchema>;

/**
 * Task health signals derived from associated chats' session state + recent messages.
 * See hub-task-design Section 9.
 */
export const TASK_HEALTH_SIGNALS = {
  NORMAL: "normal",
  IDLE_ISLAND: "idle_island",
  AWAITING_REPLY: "awaiting_reply",
  NO_CHAT: "no_chat",
  NOT_APPLICABLE: "not_applicable",
} as const;
export const taskHealthSignalSchema = z.enum(["normal", "idle_island", "awaiting_reply", "no_chat", "not_applicable"]);
export type TaskHealthSignal = z.infer<typeof taskHealthSignalSchema>;

export const taskHealthSchema = z.object({
  taskId: z.string(),
  signal: taskHealthSignalSchema,
  reason: z.string(),
});
export type TaskHealth = z.infer<typeof taskHealthSchema>;
