/**
 * Pure `@<name>` mention extraction. Lives in `@agent-team-foundation/
 * first-tree-hub-shared` so the server (authoritative resolver during
 * fan-out) and client handlers (e.g. auto-forward enrichment) share one
 * implementation — otherwise the two sides drift on corner cases like code
 * fencing or email addresses and cause hard-to-debug routing mismatches.
 *
 * Three defensive gates (see proposals/hub-agent-messaging-reply-and-mentions §4):
 *
 * 1. Strip fenced and inline code regions first, so `@staticmethod`,
 *    `@param`, and markdown code blocks don't produce false hits.
 * 2. Word-boundary lookbehind keeps `alice@example.com` out of the matches.
 * 3. Cross-validate against the actual participant name set — unknown
 *    `@tokens` are dropped by `extractMentions` (and surfaced separately by
 *    `scanMentionTokens` for logging / ops visibility).
 */

/** Minimum participant shape this module needs. */
export type MentionParticipant = {
  agentId: string;
  name: string | null;
};

// `@` is in the lookbehind so `@@alice` doesn't match `@alice` — the leading
// `@` already consumed a char that isn't part of the name, but without this
// the engine still accepts the second `@` as a mention start.
//
// First char must be alphanumeric, matching `AGENT_NAME_REGEX` in
// `schemas/agent.js`. An `@-foo` or `@_foo` token is not a valid mention
// (`-foo` can never be a legal new agent name under the tightened rule).
export const MENTION_REGEX = /(?<![A-Za-z0-9_.@-])@([A-Za-z0-9][A-Za-z0-9_-]{0,63})\b/g;

/**
 * Strip Markdown code regions (fenced + inline) so identifier-shaped
 * tokens inside code (`@param`, `@staticmethod`, etc.) don't get
 * misclassified as mentions. Shared between `extractMentions` (routing)
 * and `extractSummary` (auto-title) so they agree on what counts as a
 * "real" mention vs a code reference.
 */
export function stripCode(content: string): string {
  return content
    .replace(/```[\s\S]*?```/g, "")
    .replace(/~~~[\s\S]*?~~~/g, "")
    .replace(/`[^`\n]+`/g, "");
}

/**
 * Resolve `@<name>` mentions in `content` to a list of participant agentIds.
 * Names match case-insensitively; unknown `@tokens` are dropped.
 */
export function extractMentions(content: string, participants: MentionParticipant[]): string[] {
  const stripped = stripCode(content);

  const nameMap = new Map<string, string>();
  for (const p of participants) {
    if (p.name) nameMap.set(p.name.toLowerCase(), p.agentId);
  }
  if (nameMap.size === 0) return [];

  const hits = new Set<string>();
  for (const m of stripped.matchAll(MENTION_REGEX)) {
    const token = m[1];
    if (!token) continue;
    const id = nameMap.get(token.toLowerCase());
    if (id) hits.add(id);
  }
  return [...hits];
}

/**
 * Return every `@<name>` token that survives the code-stripping / word-
 * boundary gates, regardless of whether it matches a participant. The
 * caller uses this to log unmatched tokens (typos, renamed agents) without
 * polluting the authoritative mention list.
 */
export function scanMentionTokens(content: string): string[] {
  const stripped = stripCode(content);
  const tokens: string[] = [];
  for (const m of stripped.matchAll(MENTION_REGEX)) {
    const token = m[1];
    if (token) tokens.push(token.toLowerCase());
  }
  return tokens;
}
