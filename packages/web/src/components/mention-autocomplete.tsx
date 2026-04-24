import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../lib/utils.js";

/**
 * Minimal `@mention` autocomplete surfaced as a popover anchored above a
 * textarea. The caller owns the text value and the textarea ref; this
 * component only computes the active query from the cursor position and
 * reports back (a) visibility, (b) the currently highlighted candidate,
 * and (c) the final replacement when the user picks one.
 *
 * See docs/agent-naming-design.md §3.5. Intentionally not a rich
 * editor — we match by typing a `@`, then filtering a static list.
 *
 * Matching policy:
 *   - `displayName` matches by case-insensitive substring (friendly label,
 *     so fuzzy feel is OK).
 *   - `name` matches by case-insensitive prefix (slug is precise, so a
 *     wrong prefix should not surface a match).
 *   - Empty query → show top-N alphabetically by display name.
 *
 * Insertion contract:
 *   - Replace the `@<query>` run under the cursor with `@<name>` followed
 *     by a single trailing space (mirrors Slack/Discord UX: committing a
 *     mention opens a new word for the next chunk of text).
 */

export type MentionCandidate = {
  agentId: string;
  name: string | null;
  displayName: string | null;
};

type ActiveTrigger = {
  /** Text index of the leading `@` (the char at `triggerIndex` is `@`). */
  triggerIndex: number;
  /** The substring between `@` and the cursor, already lowercased. */
  query: string;
};

/**
 * Locate the active `@<query>` trigger given the current text + cursor.
 *
 * Returns null when:
 *   - cursor is inside a word that isn't introduced by `@`
 *   - `@` appears but is preceded by an identifier char (e.g. email address
 *     `alice@example.com`), which would be a false positive
 *   - the query has already accumulated a non-name character (space,
 *     newline, punctuation), meaning the trigger was closed
 */
export function detectMentionTrigger(text: string, cursor: number): ActiveTrigger | null {
  if (cursor <= 0 || cursor > text.length) return null;

  // Walk backward from the cursor until we find `@` or hit a boundary.
  let i = cursor - 1;
  while (i >= 0) {
    const ch = text[i];
    if (ch === undefined) return null;
    if (ch === "@") break;
    // Mention characters mirror `AGENT_NAME_REGEX` body charset plus letters
    // so we don't cut the query short while the user is typing an uppercase
    // letter that will later be lowercased during selection match.
    if (!/[A-Za-z0-9_-]/.test(ch)) return null;
    i--;
  }

  if (i < 0 || text[i] !== "@") return null;

  // Guard against email addresses and double-@ tokens — an `@` directly
  // preceded by an identifier character isn't a mention start.
  if (i > 0) {
    const prev = text[i - 1];
    if (prev !== undefined && /[A-Za-z0-9_.@-]/.test(prev)) return null;
  }

  const query = text.slice(i + 1, cursor).toLowerCase();
  return { triggerIndex: i, query };
}

/**
 * Rank candidates against a lowercased query. Empty query returns every
 * candidate sorted by display name so the popover still shows useful
 * suggestions immediately after typing `@`.
 */
function rankCandidates(candidates: MentionCandidate[], query: string): MentionCandidate[] {
  if (!query) {
    return [...candidates]
      .sort((a, b) => (a.displayName ?? a.name ?? "").localeCompare(b.displayName ?? b.name ?? ""))
      .slice(0, 8);
  }
  const scored: Array<{ c: MentionCandidate; score: number }> = [];
  for (const c of candidates) {
    const lowerName = (c.name ?? "").toLowerCase();
    const lowerDisplay = (c.displayName ?? "").toLowerCase();
    let score = Infinity;
    if (lowerName.startsWith(query)) score = 0;
    else if (lowerDisplay.startsWith(query)) score = 1;
    else if (lowerDisplay.includes(query)) score = 2;
    if (score !== Infinity) scored.push({ c, score });
  }
  scored.sort((a, b) => a.score - b.score || (a.c.displayName ?? "").localeCompare(b.c.displayName ?? ""));
  return scored.slice(0, 8).map((s) => s.c);
}

type MentionInsert = {
  /** New text value after inserting the mention. */
  text: string;
  /** Cursor offset into the new text. */
  cursor: number;
};

/**
 * Build the insertion tuple for a picked candidate. Returns null when the
 * candidate has no `name` — a mention literal requires a slug target.
 */
export function buildMentionInsert(
  source: string,
  trigger: ActiveTrigger,
  cursor: number,
  candidate: MentionCandidate,
): MentionInsert | null {
  if (!candidate.name) return null;
  const before = source.slice(0, trigger.triggerIndex);
  const after = source.slice(cursor);
  const literal = `@${candidate.name}`;
  // Append a trailing space only if the following char isn't already
  // whitespace; avoids doubling the gap when the user already typed one.
  const needsSpace = after.length === 0 || !/\s/.test(after[0] ?? "");
  const tail = needsSpace ? ` ${after}` : after;
  const text = `${before}${literal}${tail}`;
  const cursorOut = before.length + literal.length + (needsSpace ? 1 : 0);
  return { text, cursor: cursorOut };
}

/**
 * Handle mapped keyboard events from the host textarea so the caller can
 * wire them into its own `onKeyDown`. Returns true when the event was
 * consumed (i.e. caller should `preventDefault`).
 */
export type MentionKeyHandler = (e: { key: string; preventDefault: () => void }) => boolean;

/**
 * Hook form: gives the host textarea a popover + a `handleKey` function so
 * it can keep owning `onChange` and cursor state.
 */
export function useMentionAutocomplete({
  value,
  cursor,
  candidates,
  onSelect,
  disabled,
}: {
  value: string;
  cursor: number;
  candidates: MentionCandidate[];
  onSelect: (update: MentionInsert) => void;
  disabled?: boolean;
}): {
  trigger: ActiveTrigger | null;
  results: MentionCandidate[];
  highlightIndex: number;
  handleKey: MentionKeyHandler;
  pick: (candidate: MentionCandidate) => void;
  dismiss: () => void;
} {
  const [highlightIndex, setHighlightIndex] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);

  const trigger = useMemo(() => {
    if (disabled) return null;
    return detectMentionTrigger(value, cursor);
  }, [value, cursor, disabled]);

  const results = useMemo(() => (trigger ? rankCandidates(candidates, trigger.query) : []), [trigger, candidates]);

  // Reset highlight when the trigger key changes so the user doesn't land
  // on a stale row that no longer matches. The effective trigger key is
  // `${triggerIndex}:${query}` — using a primitive avoids invalidating on
  // every render (which would happen if we depended on `trigger` by
  // reference, since that object is rebuilt each time).
  const triggerKey = trigger ? `${trigger.triggerIndex}:${trigger.query}` : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: triggerKey IS the dep — its value controls when we reset.
  useEffect(() => {
    setHighlightIndex(0);
  }, [triggerKey]);

  // A dismissal is sticky for the current trigger: re-typing inside the
  // same `@query` shouldn't reopen it until the user opens a new trigger.
  const dismissed = dismissedAt !== null && trigger !== null && dismissedAt === trigger.triggerIndex;
  const open = trigger !== null && results.length > 0 && !dismissed;

  function dismiss() {
    setDismissedAt(trigger?.triggerIndex ?? null);
  }

  function pick(candidate: MentionCandidate) {
    if (!trigger) return;
    const insert = buildMentionInsert(value, trigger, cursor, candidate);
    if (!insert) return;
    onSelect(insert);
  }

  const handleKey: MentionKeyHandler = (e) => {
    if (!open || !trigger) return false;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIndex((i) => (results.length === 0 ? 0 : (i + 1) % results.length));
      return true;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIndex((i) => (results.length === 0 ? 0 : (i - 1 + results.length) % results.length));
      return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      const picked = results[highlightIndex] ?? results[0];
      if (!picked) return false;
      e.preventDefault();
      pick(picked);
      return true;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      dismiss();
      return true;
    }
    return false;
  };

  return {
    trigger: open ? trigger : null,
    results: open ? results : [],
    highlightIndex,
    handleKey,
    pick,
    dismiss,
  };
}

/**
 * Popover body. Expects `anchorRef` to point at a textarea so the popover
 * can sit directly above it (the textarea is at the bottom of the chat
 * view; dropping above avoids covering the input while typing).
 */
export function MentionAutocompletePopover({
  trigger,
  results,
  highlightIndex,
  onPick,
  anchorRef,
}: {
  trigger: ActiveTrigger | null;
  results: MentionCandidate[];
  highlightIndex: number;
  onPick: (candidate: MentionCandidate) => void;
  anchorRef: { current: HTMLTextAreaElement | null };
}) {
  const popoverRef = useRef<HTMLDivElement | null>(null);

  // Scroll the active row into view when the highlight changes.
  useEffect(() => {
    const el = popoverRef.current?.querySelector<HTMLElement>(`[data-mention-index="${highlightIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [highlightIndex]);

  if (!trigger || results.length === 0) return null;
  const anchor = anchorRef.current;
  if (!anchor) return null;

  return (
    <div
      ref={popoverRef}
      role="listbox"
      aria-label="Mention suggestions"
      className={cn("absolute z-20 max-h-56 overflow-auto rounded-md border shadow-lg")}
      style={{
        bottom: "calc(100% + var(--sp-1))",
        left: 0,
        right: 0,
        background: "var(--bg-raised)",
        borderColor: "var(--border)",
      }}
    >
      {results.map((c, i) => {
        const active = i === highlightIndex;
        return (
          <button
            key={c.agentId}
            type="button"
            role="option"
            aria-selected={active}
            data-mention-index={i}
            onMouseDown={(e) => {
              // preventDefault keeps the textarea focused so `selectionStart`
              // can still be used to compute the insertion point.
              e.preventDefault();
              onPick(c);
            }}
            className="flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-body"
            style={{
              background: active ? "var(--accent-dim)" : "transparent",
              color: "var(--fg)",
              border: "none",
              cursor: "pointer",
            }}
          >
            <span className="font-medium">{c.displayName ?? (c.name ? `@${c.name}` : "—")}</span>
            {c.name && c.displayName && (
              <span className="mono text-caption" style={{ color: "var(--fg-3)" }}>
                @{c.name}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
