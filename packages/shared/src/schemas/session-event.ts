import { z } from "zod";

export const sessionEventKind = z.enum(["tool_call", "error"]);
export type SessionEventKind = z.infer<typeof sessionEventKind>;

export const toolCallEventPayload = z.object({
  toolUseId: z.string(),
  name: z.string(),
  args: z.unknown(),
  status: z.enum(["pending", "ok", "error"]),
  durationMs: z.number().int().nonnegative().optional(),
  resultPreview: z.string().max(400).optional(),
});
export type ToolCallEventPayload = z.infer<typeof toolCallEventPayload>;

export const errorEventPayload = z.object({
  source: z.enum(["sdk", "runtime", "tool"]),
  message: z.string().max(2000),
});
export type ErrorEventPayload = z.infer<typeof errorEventPayload>;

export const sessionEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("tool_call"), payload: toolCallEventPayload }),
  z.object({ kind: z.literal("error"), payload: errorEventPayload }),
]);
export type SessionEvent = z.infer<typeof sessionEventSchema>;

/** Persisted session-event row (as returned by admin API / services). */
export const sessionEventRowSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  chatId: z.string(),
  seq: z.number().int().positive(),
  kind: sessionEventKind,
  payload: z.union([toolCallEventPayload, errorEventPayload]),
  createdAt: z.string(),
});
export type SessionEventRow = z.infer<typeof sessionEventRowSchema>;

/** WS message: client reports a session event (tool_call / error) to the server. */
export const sessionEventMessageSchema = z.object({
  agentId: z.string(),
  chatId: z.string(),
  event: sessionEventSchema,
});
export type SessionEventMessage = z.infer<typeof sessionEventMessageSchema>;

/**
 * WS control message: client signals that a query completed end-to-end.
 * Decoupled from `session:event` so the `session_completed` notification
 * fires on actual result forwarding, not on incidental tool activity.
 */
export const sessionCompletionMessageSchema = z.object({
  agentId: z.string(),
  chatId: z.string(),
});
export type SessionCompletionMessage = z.infer<typeof sessionCompletionMessageSchema>;
