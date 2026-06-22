/**
 * Pure `@<name>` mention extraction. Lives in `@agent-team-foundation/
 * first-tree-shared` so the server (the authoritative resolver during
 * fan-out) and every other reader share one implementation — otherwise the
 * sides drift on corner cases like code fencing or email addresses and cause
 * hard-to-debug routing mismatches.
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
//
// Trailing `(?![A-Za-z0-9_\/-])` replaces a plain `\b`: it forbids the token
// being followed by `/`, so npm scoped package names (`@scope/pkg`) don't
// surface as a `scope` mention — the bare `\b` accepts `/` as a boundary and
// would otherwise (with backtracking) match a truncated prefix like
// `agent-team-` from `first-tree-shared`.
export const MENTION_REGEX = /(?<![A-Za-z0-9_.@-])@([A-Za-z0-9][A-Za-z0-9_-]{0,63})(?![A-Za-z0-9_/-])/g;

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

/** One slice of a message body in source order. `mention` segments
 *  carry the resolved agentId so renderers can avatar / link the chip. */
export type MentionSegment =
  | { kind: "text"; value: string }
  | { kind: "mention"; value: string; name: string; agentId: string };

/**
 * Collect the byte ranges of Markdown code regions (fenced ```, fenced
 * ~~~, and inline `…`). Returned ranges are `[start, endExclusive)` into
 * the ORIGINAL content — unlike {@link stripCode}, this version keeps
 * offsets so callers (notably {@link segmentMentions}) can preserve the
 * raw text byte-for-byte while still suppressing matches inside code.
 *
 * Patterns are scanned independently and then merged so overlapping
 * regions (e.g. an inline backtick span surrounding a fenced block)
 * collapse to a single skip range. This matches the visible outcome of
 * `stripCode`'s three sequential `replace` passes: a `@token` is in code
 * iff it would have been stripped by any pass.
 */
function codeRanges(content: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const patterns = [/```[\s\S]*?```/g, /~~~[\s\S]*?~~~/g, /`[^`\n]+`/g];
  for (const re of patterns) {
    for (const m of content.matchAll(re)) {
      if (m.index === undefined) continue;
      ranges.push([m.index, m.index + m[0].length]);
    }
  }
  if (ranges.length <= 1) return ranges;
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const next of ranges) {
    const last = merged[merged.length - 1];
    if (last && next[0] <= last[1]) {
      last[1] = Math.max(last[1], next[1]);
    } else {
      merged.push(next);
    }
  }
  return merged;
}

function isInCodeRange(index: number, ranges: Array<[number, number]>): boolean {
  // Linear scan — ranges are typically tiny (typical chat draft has 0–2).
  // Bail early thanks to the sort + merge in `codeRanges`.
  for (const [start, end] of ranges) {
    if (index < start) return false;
    if (index < end) return true;
  }
  return false;
}

/**
 * Split `content` into ordered text / mention segments. The segmenter
 * keeps the original `@<token>` substring (case preserved) in
 * `segment.value` so renderers don't re-typeset what the user wrote and
 * preserve byte-for-byte fidelity with the source text — critical for the
 * composer mirror overlay, where character positions must match the
 * underlying textarea exactly.
 *
 * Defensive gates mirror {@link extractMentions}:
 *   - Word-boundary lookbehind / lookahead from `MENTION_REGEX` keeps
 *     `alice@example.com`, `@scope/pkg`, `@@alice` out.
 *   - Code regions (fenced ```, fenced ~~~, inline `…`) suppress chip
 *     emission while keeping the raw `@token` inside the surrounding
 *     text segment. Without this, the composer overlay would chip a
 *     token that the server-side `extractMentions` resolver would
 *     drop — breaking the "chip ⇔ valid mention" contract that drives
 *     the send-button gate (`draftMentions === [] → disabled`).
 *
 * Unresolved `@<token>` tokens (typos, outsiders, npm package names the
 * regex didn't filter out) stay inside the surrounding text segment —
 * the UI's "valid mention" signal is exactly "did this token get a chip
 * or not", so callers don't need a separate "invalid mention" type.
 */
export function segmentMentions(content: string, participants: MentionParticipant[]): MentionSegment[] {
  if (content.length === 0) return [];
  const nameMap = new Map<string, { name: string; agentId: string }>();
  for (const p of participants) {
    if (p.name) nameMap.set(p.name.toLowerCase(), { name: p.name, agentId: p.agentId });
  }
  if (nameMap.size === 0) return [{ kind: "text", value: content }];

  const skipRanges = codeRanges(content);

  const out: MentionSegment[] = [];
  let cursor = 0;
  for (const m of content.matchAll(MENTION_REGEX)) {
    const token = m[1];
    if (token === undefined || m.index === undefined) continue;
    if (isInCodeRange(m.index, skipRanges)) continue;
    const resolved = nameMap.get(token.toLowerCase());
    if (!resolved) continue;
    if (m.index > cursor) {
      out.push({ kind: "text", value: content.slice(cursor, m.index) });
    }
    out.push({
      kind: "mention",
      value: m[0],
      name: resolved.name,
      agentId: resolved.agentId,
    });
    cursor = m.index + m[0].length;
  }
  if (cursor < content.length) {
    out.push({ kind: "text", value: content.slice(cursor) });
  }
  return out;
}
