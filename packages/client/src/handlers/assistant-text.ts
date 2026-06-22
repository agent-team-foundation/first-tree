/**
 * Per-event size cap for an `assistant_text` session event. MUST stay in sync
 * with the `assistantTextEventPayload.text` `.max(...)` cap in
 * `@first-tree/shared` (`schemas/session-event.ts`) — the server strict-parses
 * every inbound event, so a chunk over the cap would be rejected and dropped.
 */
export const ASSISTANT_TEXT_EVENT_LIMIT = 8000;

/**
 * Split an assistant message's text into consecutive chunks that each fit the
 * per-event cap, so the FULL text is preserved across one or more
 * `assistant_text` session events.
 *
 * This matters now that the per-turn final-text chat mirror is retired: the
 * agent's output is no longer delivered as a (non-truncated) chat message, so
 * the persisted `assistant_text` events are the durable troubleshooting record
 * of what the agent actually said. A single `slice(0, LIMIT)` would silently
 * drop everything past the cap; chunking keeps the whole thing recoverable.
 *
 * Returns `[]` for whitespace-only input (callers skip empty assistant blocks).
 */
export function chunkAssistantText(text: string, limit: number = ASSISTANT_TEXT_EVENT_LIMIT): string[] {
  if (!text.trim()) return [];
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += limit) {
    chunks.push(text.slice(i, i + limit));
  }
  return chunks;
}
