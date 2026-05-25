import { z } from "zod";

// -- Notification Types --

export const NOTIFICATION_TYPES = {
  AGENT_ERROR: "agent_error",
  AGENT_BLOCKED: "agent_blocked",
  AGENT_STALE: "agent_stale",
} as const;

export const notificationTypeSchema = z.enum(["agent_error", "agent_blocked", "agent_stale"]);
export type NotificationType = z.infer<typeof notificationTypeSchema>;

// -- Notification Severity --

export const NOTIFICATION_SEVERITIES = {
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low",
} as const;

export const notificationSeveritySchema = z.enum(["high", "medium", "low"]);
export type NotificationSeverity = z.infer<typeof notificationSeveritySchema>;
