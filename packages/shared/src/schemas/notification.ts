import { z } from "zod";

// -- Notification Types --

export const NOTIFICATION_TYPES = {
  AGENT_ERROR: "agent_error",
  SESSION_ERROR: "session_error",
  AGENT_NEEDS_DECISION: "agent_needs_decision",
  AGENT_BLOCKED: "agent_blocked",
  AGENT_STALE: "agent_stale",
  AGENT_CONNECTED: "agent_connected",
  SESSION_COMPLETED: "session_completed",
} as const;

export const notificationTypeSchema = z.enum([
  "agent_error",
  "session_error",
  "agent_needs_decision",
  "agent_blocked",
  "agent_stale",
  "agent_connected",
  "session_completed",
]);
export type NotificationType = z.infer<typeof notificationTypeSchema>;

// -- Notification Severity --

export const NOTIFICATION_SEVERITIES = {
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low",
} as const;

export const notificationSeveritySchema = z.enum(["high", "medium", "low"]);
export type NotificationSeverity = z.infer<typeof notificationSeveritySchema>;

// -- Notification --

export const notificationSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  type: notificationTypeSchema,
  severity: notificationSeveritySchema,
  agentId: z.string().nullable(),
  chatId: z.string().nullable(),
  message: z.string(),
  read: z.boolean(),
  createdAt: z.string(),
});
export type Notification = z.infer<typeof notificationSchema>;

// -- Notification Query --

export const notificationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
  severity: notificationSeveritySchema.optional(),
  read: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  agentId: z.string().optional(),
});
export type NotificationQuery = z.infer<typeof notificationQuerySchema>;
