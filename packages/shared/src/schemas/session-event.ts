import { z } from "zod";

export const sessionEventKind = z.enum([
  "tool_call",
  "error",
  "assistant_text",
  "thinking",
  "turn_end",
  "context_tree_usage",
  "token_usage",
]);
export type SessionEventKind = z.infer<typeof sessionEventKind>;

export const toolFileRefPathKindSchema = z.enum(["file", "directory", "repo"]);
export type ToolFileRefPathKind = z.infer<typeof toolFileRefPathKindSchema>;

export const toolFileRefOriginSchema = z.enum(["tool_arg", "file_change", "runtime_metadata"]);
export type ToolFileRefOrigin = z.infer<typeof toolFileRefOriginSchema>;

export const toolFileRefSchema = z.object({
  localPath: z.string().min(1).optional(),
  repoUrl: z.string().min(1).optional(),
  repoBranch: z.string().min(1).optional(),
  repoRelativePath: z.string().min(1).optional(),
  pathKind: toolFileRefPathKindSchema.optional(),
  origin: toolFileRefOriginSchema,
});
export type ToolFileRef = z.infer<typeof toolFileRefSchema>;

export const toolCallEventPayload = z.object({
  toolUseId: z.string(),
  name: z.string(),
  args: z.unknown(),
  status: z.enum(["pending", "ok", "error"]),
  durationMs: z.number().int().nonnegative().optional(),
  resultPreview: z.string().max(400).optional(),
  toolFileRefs: z.array(toolFileRefSchema).optional(),
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

export const contextTreeUsageEventPayload = z.object({
  purpose: z.literal("design_decision"),
  treeRepoUrl: z.string().nullable(),
  // Tree-root-relative path of the file the agent actually Read (e.g.
  // `members/Gandy2025/NODE.md`). Null when the read target could not be
  // resolved to a node path. Emitted only when a view tool reads a file under
  // the configured Context Tree root — see the client handler's tool-call
  // processor.
  //
  // `.default(null)`: tolerate a pre-P0 client (≤0.14.8) that still emits the
  // old `{ purpose, treeRepoUrl }` payload during a server-ahead-of-client
  // deploy window. There is no client min-version gate, and the server's
  // `appendEvent` strict-parses every inbound event (ws-client.ts) — without
  // the default, a missing `nodePath` would reject the event with an error
  // frame and drop it. The default normalises absence to null instead. New
  // clients always send the field explicitly; the inferred (output) type stays
  // `string | null`, so consumers are unaffected.
  nodePath: z.string().nullable().default(null),
});
export type ContextTreeUsageEventPayload = z.infer<typeof contextTreeUsageEventPayload>;

/**
 * Token usage for one (provider, model) within a single turn. Emitted by the
 * handler right before `turn_end`. A turn may produce multiple `token_usage`
 * events when the underlying SDK runs more than one model in a single turn
 * (e.g. Claude Agent SDK fast-mode). Codex emits at most one.
 *
 * Field semantics — `inputTokens` and `cachedInputTokens` are DISJOINT, so
 * total prompt tokens = inputTokens + cachedInputTokens:
 *   - `inputTokens`: prompt tokens NOT served from cache. For Anthropic this
 *     includes cache-creation tokens (they bill as input). For OpenAI/Codex
 *     `usage.input_tokens` is the TOTAL prompt incl. the cached subset, so the
 *     codex handler subtracts (`input_tokens - cached_input_tokens`) to land
 *     on the non-cached figure this field expects.
 *   - `cachedInputTokens`: prompt tokens served from cache (Anthropic
 *     `cache_read_input_tokens` / OpenAI `cached_input_tokens`).
 *   - `outputTokens`: completion tokens (includes reasoning tokens for o-series
 *     models — we deliberately do not split them out in this minimal schema).
 *
 * All values are PER-TURN deltas. Codex's SDK only surfaces the cumulative
 * thread total, so its handler diffs consecutive turns to recover the delta
 * (see `computePerTurnUsageDelta`); summing these events over a thread is
 * therefore valid for both providers.
 */
export const tokenUsageEventPayload = z.object({
  provider: z.string(),
  model: z.string(),
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative(),
});
export type TokenUsageEventPayload = z.infer<typeof tokenUsageEventPayload>;

/**
 * Chat-wide token usage total — the server's SUM over every `token_usage`
 * event persisted for a chat. Because `token_usage` events are per-turn deltas
 * (see {@link tokenUsageEventPayload}), summing them yields the cumulative
 * consumption of the whole chat. Note the count resets when a session is
 * terminated (its events are cleared), so this is "usage since the current
 * session history began", not an all-time billing figure.
 */
export const chatTokenUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
});
export type ChatTokenUsage = z.infer<typeof chatTokenUsageSchema>;

export const sessionEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("tool_call"), payload: toolCallEventPayload }),
  z.object({ kind: z.literal("error"), payload: errorEventPayload }),
  z.object({ kind: z.literal("assistant_text"), payload: assistantTextEventPayload }),
  z.object({ kind: z.literal("thinking"), payload: thinkingEventPayload }),
  z.object({ kind: z.literal("turn_end"), payload: turnEndEventPayload }),
  z.object({ kind: z.literal("context_tree_usage"), payload: contextTreeUsageEventPayload }),
  z.object({ kind: z.literal("token_usage"), payload: tokenUsageEventPayload }),
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
    contextTreeUsageEventPayload,
    tokenUsageEventPayload,
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
