import { z } from "zod";

export const sessionEventKind = z.enum(["tool_call", "error", "assistant_text", "thinking", "turn_end"]);
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

/**
 * A text block emitted by the model within an assistant message. These are
 * transient "in-progress" events used to render the assistant's reply body
 * while a turn is still running. The final turn result is forwarded as a
 * regular chat message (not an event); the frontend hides all assistant_text
 * events for turns that have completed (i.e. once `turn_end` has been emitted).
 */
export const assistantTextEventPayload = z.object({
  text: z.string().max(8000),
});
export type AssistantTextEventPayload = z.infer<typeof assistantTextEventPayload>;

/**
 * Marker emitted when the model produces a `thinking` content block.
 * We intentionally do NOT persist the thinking content — only a presence
 * signal so the UI can render a lightweight "Thinking…" status indicator.
 */
export const thinkingEventPayload = z.object({});
export type ThinkingEventPayload = z.infer<typeof thinkingEventPayload>;

/**
 * Turn boundary marker. Emitted once per completed query turn, regardless of
 * success/failure, so the frontend can group events into turns and collapse
 * completed turns to show only the final result message.
 */
export const turnEndEventPayload = z.object({
  status: z.enum(["success", "error"]),
});
export type TurnEndEventPayload = z.infer<typeof turnEndEventPayload>;

export const sessionEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("tool_call"), payload: toolCallEventPayload }),
  z.object({ kind: z.literal("error"), payload: errorEventPayload }),
  z.object({ kind: z.literal("assistant_text"), payload: assistantTextEventPayload }),
  z.object({ kind: z.literal("thinking"), payload: thinkingEventPayload }),
  z.object({ kind: z.literal("turn_end"), payload: turnEndEventPayload }),
]);
export type SessionEvent = z.infer<typeof sessionEventSchema>;

/** Persisted session-event row (as returned by admin API / services). */
export const sessionEventRowSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  chatId: z.string(),
  seq: z.number().int().positive(),
  kind: sessionEventKind,
  payload: z.union([
    toolCallEventPayload,
    errorEventPayload,
    assistantTextEventPayload,
    thinkingEventPayload,
    turnEndEventPayload,
  ]),
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
