import { isAgentFinalTextMetadata } from "@first-tree/shared";

type WithMetadata = { metadata: Record<string, unknown> };

/**
 * The single "visible message set" the chat timeline AND every read-state
 * projection derived from it consume — the rendered rows, the unread pill, the
 * high-water mark, the new-message divider, and the saved scroll anchor.
 *
 * When the staging-only hide toggle is active, agent final-text mirror rows are
 * dropped HERE, at the one source those projections share, so the rendered DOM
 * and the projections can never diverge: a hidden row has no DOM node, so it
 * must also be absent from pill/high-water/anchor math (otherwise it drives an
 * un-clearable "N new" pill or an unresolvable scroll anchor). When inactive,
 * the same array is returned unchanged (no copy, stable identity for memo).
 */
export function selectVisibleMessages<T extends WithMetadata>(messages: T[], hideAgentFinalText: boolean): T[] {
  if (!hideAgentFinalText) return messages;
  return messages.filter((m) => !isAgentFinalTextMetadata(m.metadata));
}
