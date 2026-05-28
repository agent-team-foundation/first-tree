import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../lib/utils.js";

/**
 * Minimal `@mention` autocomplete surfaced as a popover anchored above a
 * textarea. The caller owns the text value and the textarea ref; this
 * component only computes the active query from the cursor position and
 * reports back (a) visibility, (b) the currently highlighted candidate,
 * and (c) the final replacement when the user picks one.
 *
 * See first-tree-context:agent-hub/agent-naming.md §3.5. Intentionally not a rich
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
  /** True iff the caller's member is this agent's `managerId`. Drives
   *  participant-picker grouping (mine first, then teammates') and the
   *  empty-query branch of mention autocomplete so the user's own agents
   *  always surface first. Derived client-side by callers from the
   *  agent row's `managerId` against the caller's `memberId` (see
   *  `useAuth`); callers that can't determine it should pass `false`
   *  rather than omitting — there's no "unknown" state. */
  managedByMe: boolean;
};

/**
 * Compute the set of `displayName`s that appear more than once in the
 * visible candidate list. Used by the picker UIs to decide whether to
 * surface the secondary `@<name>` line for disambiguation. Candidates
 * with no `displayName` are ignored — they fall back to `@<name>`
 * already and don't need a secondary label.
 */
export function ambiguousDisplayNames(candidates: MentionCandidate[]): Set<string> {
  const counts = new Map<string, number>();
  for (const c of candidates) {
    if (!c.displayName) continue;
    counts.set(c.displayName, (counts.get(c.displayName) ?? 0) + 1);
  }
  const out = new Set<string>();
  for (const [k, n] of counts) {
    if (n > 1) out.add(k);
  }
  return out;
}

/**
 * Should the candidate row render the secondary `@<name>` label?
 *
 * Yes when:
 *   - `displayName` differs from `name` (e.g. friendly title "Alice's
 *     assistant" vs handle "alice-assistant"), OR
 *   - another visible candidate shares the same `displayName` (collision).
 *
 * In all other cases the handle is identical to the rendered display
 * name, so showing it twice is pure noise. Hover always discloses the
 * handle via the row's `title` attribute regardless.
 */
export function shouldShowHandle(c: MentionCandidate, ambiguous: Set<string>): boolean {
  if (!c.name || !c.displayName) return false;
  if (c.displayName !== c.name) return true;
  return ambiguous.has(c.displayName);
}

/**
 * Single-line candidate label used by every mention-style picker
 * (autocomplete popover, ParticipantsHeader [+] dropdown, NewChatDraft
 * chip-add dropdown). Centralizes the display-name + conditional
 * `@<handle>` rendering so the format only needs to change in one
 * place.
 *
 * Caller is responsible for the surrounding `<button>` / wrapper
 * (click handlers, `title` attribute, hover/active state) — the label
 * intentionally stays presentational.
 */
export function MentionLabel({ candidate, ambiguous }: { candidate: MentionCandidate; ambiguous: Set<string> }) {
  const fallback = candidate.name ? `@${candidate.name}` : "—";
  return (
    <>
      <span className="font-medium">{candidate.displayName ?? fallback}</span>
      {shouldShowHandle(candidate, ambiguous) && (
        <span className="mono text-caption" style={{ color: "var(--fg-3)" }}>
          @{candidate.name}
        </span>
      )}
    </>
  );
}

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
    // Accept the same charset as the mention regex body, plus uppercase —
    // the user may type upper-case while searching, and we lowercase the
    // accumulated query before matching.
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

/** Alphabetical comparator over a candidate's user-visible label. */
function byDisplayName(a: MentionCandidate, b: MentionCandidate): number {
  return (a.displayName ?? a.name ?? "").localeCompare(b.displayName ?? b.name ?? "");
}

/**
 * Marker emitted by {@link groupAndSortCandidates} between the
 * my-managed group and the others group. Renderers should detect it
 * via `"divider" in item` and emit a separator instead of a list row.
 */
export type CandidateDivider = { divider: true };

/**
 * Group candidates into "mine first, others second" with each group
 * sorted alphabetically by display name, and insert a divider marker
 * between groups iff both are non-empty.
 *
 * Used by participant pickers (`[+]` dropdown in new-chat draft and in
 * existing chats' ParticipantsHeader) so the user can scan their own
 * agents at the top without reading any header text — the gap speaks
 * for itself. Both pickers share this helper so the visual contract
 * stays identical across the app.
 */
export function groupAndSortCandidates(candidates: MentionCandidate[]): Array<MentionCandidate | CandidateDivider> {
  const mine = candidates.filter((c) => c.managedByMe).sort(byDisplayName);
  const others = candidates.filter((c) => !c.managedByMe).sort(byDisplayName);
  if (mine.length > 0 && others.length > 0) {
    return [...mine, { divider: true }, ...others];
  }
  return [...mine, ...others];
}

/**
 * Two-section picker layout used by both `AddParticipantDropdown` and
 * the new-chat `ParticipantChips` picker:
 *
 *   head    = mine-first / others (with internal divider) over `addable`
 *   tail    = already-in-chat agents, alphabetical, separator above
 *   items   = head + (optional separator + tail)
 *   selectable = the addable rows in head order, divider stripped
 *
 * Critical invariant: `selectable` is derived from `headItems` (the
 * grouped + sorted view, NOT the caller's raw `addable` array). The
 * dropdown renders rows by walking `items`; the keyboard highlight +
 * Enter commit walks `selectable`. Pre-issue-494 the picker derived
 * `selectable` straight from `addable` (server `desc(createdAt)`
 * order), so the visible highlight could drift from the row actually
 * committed on Enter — a wrong-recipient hazard the third Codex / human
 * review of PR 556 caught before merge. Going through `headItems` is
 * the fix and the reason this lives in shared code: two pickers,
 * one invariant.
 *
 * Already-in rows do NOT enter `selectable`. They render as display-
 * only ✓ markers (the caller paints them differently); arrow / Enter
 * skip past them.
 */
export function buildPickerSections(
  addable: MentionCandidate[],
  alreadyIn: MentionCandidate[],
): {
  items: Array<MentionCandidate | CandidateDivider>;
  selectable: MentionCandidate[];
} {
  const headItems = groupAndSortCandidates(addable);
  const selectable = headItems.filter((it): it is MentionCandidate => !("divider" in it));
  const items =
    alreadyIn.length === 0
      ? headItems
      : ([...headItems, { divider: true } as CandidateDivider, ...alreadyIn] as Array<
          MentionCandidate | CandidateDivider
        >);
  return { items, selectable };
}

/**
 * Rank candidates against a lowercased query. Empty query returns every
 * candidate sorted my-managed-first, then alphabetically within each
 * group, so the popover surfaces the caller's own agents immediately
 * after typing `@`. With a query, matches are scored by match position
 * (name prefix > displayName prefix > displayName contains > name
 * contains) and ties are still broken alphabetically — managedByMe is
 * intentionally NOT a scoring signal once the user has typed something,
 * because at that point they're targeting a specific name and we
 * shouldn't reorder matches under them.
 *
 * Name-substring (score 3) is the fallback added in issue 494 — without
 * it, typing `@agent-110` against a slug like `picker-agent-110` would
 * return nothing (name not a prefix, displayName "Picker Agent 110"
 * doesn't contain the literal "agent-110" with hyphen), and the
 * autocomplete would feel broken relative to the `[+]` picker (which
 * does substring on the same field). Substring is the floor, not the
 * ceiling: prefix-on-name still wins so an exact-prefix match floats to
 * the top.
 */
export function rankCandidates(candidates: MentionCandidate[], query: string): MentionCandidate[] {
  if (!query) {
    // Reuse the picker's grouping logic, strip the divider marker, and
    // cap at 8. Keeping the empty-query path in lockstep with the
    // picker means changing one (mine-first, alpha) tomorrow won't
    // silently leave the other behind.
    return groupAndSortCandidates(candidates)
      .filter((item): item is MentionCandidate => !("divider" in item))
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
    else if (lowerName.includes(query)) score = 3;
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
 *
 * Keyboard hijack is cursor-driven: whenever `detectMentionTrigger`
 * resolves an active `@` near the caret (typed now, pasted, or pre-existing
 * in the draft), `handleKey` intercepts Enter / Tab / Arrows / Escape so
 * the popover drives selection. Move the caret away from the `@` and the
 * trigger disappears, restoring Enter-to-send. Matches slash-command
 * popover semantics so both autocompletes feel the same.
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

  // Clear the dismissal flag whenever the active trigger disappears —
  // otherwise, deleting an `@` and opening a fresh one at the same buffer
  // offset (common flow when the user retries a mention) would silently
  // keep the popover suppressed because `triggerIndex` alone collides.
  useEffect(() => {
    if (trigger === null && dismissedAt !== null) setDismissedAt(null);
  }, [trigger, dismissedAt]);

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
        minWidth: 240,
        maxWidth: 360,
        background: "var(--bg-raised)",
        borderColor: "var(--border)",
      }}
    >
      {(() => {
        const ambiguous = ambiguousDisplayNames(results);
        return results.map((c, i) => {
          const active = i === highlightIndex;
          return (
            <button
              key={c.agentId}
              type="button"
              role="option"
              aria-selected={active}
              data-mention-index={i}
              title={c.name ? `@${c.name}` : undefined}
              onMouseDown={(e) => {
                // preventDefault keeps the textarea focused so `selectionStart`
                // can still be used to compute the insertion point.
                e.preventDefault();
                onPick(c);
              }}
              className="flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-body"
              style={{
                background: active ? "var(--bg-hover)" : "transparent",
                color: "var(--fg)",
                border: "none",
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              <MentionLabel candidate={c} ambiguous={ambiguous} />
            </button>
          );
        });
      })()}
    </div>
  );
}
