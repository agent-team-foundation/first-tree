import { X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Avatar } from "./avatar.js";

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
  /** Manager-selected avatar color token (the agent row's
   *  `avatarColorToken`); drives the identicon hue when no image is set.
   *  Optional — callers that don't have it omit it and {@link Avatar}
   *  falls back to a deterministic hash of the seed. */
  avatarColorToken?: string | null;
  /** Resolved avatar image URL (the agent row's `avatarImageUrl`),
   *  rendered as a circle when present. Optional for the same reason as
   *  `avatarColorToken`. */
  avatarImageUrl?: string | null;
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
 * Overflow contract: both halves are single-line. The display name
 * truncates with an ellipsis (it shrinks, never wraps — a wrapped or
 * panel-stretching row is worse than a cut label); the `@<handle>` keeps
 * its natural width up to 45% of the row, then truncates — it must never
 * break mid-token. Hover discloses the full label via the row `title`
 * (see {@link mentionOptionTitle}).
 *
 * Caller is responsible for the surrounding `<button>` / wrapper
 * (click handlers, `title` attribute, hover/active state) — the label
 * intentionally stays presentational.
 */
export function MentionLabel({ candidate, ambiguous }: { candidate: MentionCandidate; ambiguous: Set<string> }) {
  const fallback = candidate.name ? `@${candidate.name}` : "—";
  return (
    <>
      <span className="min-w-0 truncate font-medium">{candidate.displayName ?? fallback}</span>
      {shouldShowHandle(candidate, ambiguous) && (
        <span className="mono text-caption shrink-0 truncate" style={{ color: "var(--fg-3)", maxWidth: "45%" }}>
          @{candidate.name}
        </span>
      )}
    </>
  );
}

/**
 * Hover `title` for a candidate row: the full untruncated identity. Rows
 * truncate long labels (see {@link MentionLabel}), so the tooltip carries
 * whichever parts got cut — `displayName (@name)` when the two differ,
 * `@name` alone when they're identical or the display name is missing.
 */
export function mentionOptionTitle(candidate: Pick<MentionCandidate, "name" | "displayName">): string | undefined {
  const hasName = typeof candidate.name === "string" && candidate.name.length > 0;
  const hasDisplay = typeof candidate.displayName === "string" && candidate.displayName.length > 0;
  if (hasName && hasDisplay && candidate.displayName !== candidate.name) {
    return `${candidate.displayName} (@${candidate.name})`;
  }
  if (hasName) return `@${candidate.name}`;
  return hasDisplay ? (candidate.displayName ?? undefined) : undefined;
}

/**
 * Candidate row atom: circle avatar + {@link MentionLabel}, with an
 * optional trailing slot (e.g. a ✓ for already-in-chat rows). This is the
 * single candidate-row renderer shared by every agent picker — the
 * composer / ask `@` popover, the add-participant dropdown, and the
 * new-chat `[+]` recipient picker — so the avatar and the
 * display-name/`@handle` format stay pixel-identical across surfaces
 * (before this atom the popover had no avatar at all and each dropdown
 * hand-rolled its own `<Avatar> + label`).
 *
 * Presentational only: the caller still owns the surrounding
 * `<button>`/wrapper, click handlers, hover/active background, and the
 * `title` attribute. Wraps `MentionLabel` rather than re-implementing it
 * so there stays exactly one label renderer.
 */
export function AgentOption({
  candidate,
  ambiguous,
  avatarSize = 28,
  trailing,
}: {
  candidate: MentionCandidate;
  ambiguous: Set<string>;
  avatarSize?: number;
  trailing?: ReactNode;
}) {
  const fallback = candidate.displayName ?? candidate.name ?? candidate.agentId.slice(0, 8);
  return (
    <span className="flex min-w-0 flex-1 items-center" style={{ gap: "var(--sp-2_5)" }}>
      <Avatar
        src={candidate.avatarImageUrl ?? null}
        name={fallback}
        seed={candidate.agentId}
        colorToken={candidate.avatarColorToken ?? null}
        size={avatarSize}
      />
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <MentionLabel candidate={candidate} ambiguous={ambiguous} />
      </span>
      {trailing != null && <span className="flex shrink-0 items-center">{trailing}</span>}
    </span>
  );
}

/**
 * Selected-agent chip atom: compact avatar + label + optional remove
 * button. The single "a chosen agent" visual — used by the new-chat
 * recipient chips today, and any future single/multi-select field — so a
 * picked agent looks the same everywhere (the new-chat chip was a bare
 * `<span>` label with no avatar before this). Hover reveals the remove
 * `X`; omit `onRemove` for a read-only token.
 *
 * A long label truncates on one line (capped at `--sp-60` and at the
 * host row's width) instead of stretching the chip across — or past —
 * the composer; hover discloses the full identity via `title`.
 */
export function AgentToken({ candidate, onRemove }: { candidate: MentionCandidate; onRemove?: () => void }) {
  const label = candidate.displayName ?? candidate.name ?? candidate.agentId.slice(0, 8);
  return (
    <span
      className="group inline-flex items-center text-label"
      title={mentionOptionTitle(candidate) ?? label}
      style={{
        gap: "var(--sp-1)",
        padding: "var(--sp-0_5) var(--sp-1_5)",
        borderRadius: "var(--radius-chip)",
        background: "var(--bg-sunken)",
        color: "var(--fg)",
        maxWidth: "min(var(--sp-60), 100%)",
      }}
    >
      <Avatar
        src={candidate.avatarImageUrl ?? null}
        name={label}
        seed={candidate.agentId}
        colorToken={candidate.avatarColorToken ?? null}
        size={16}
      />
      <span className="min-w-0 truncate">{label}</span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          title="Remove participant"
          className="opacity-0 transition-opacity group-hover:opacity-100"
          style={{
            display: "inline-flex",
            alignItems: "center",
            border: "none",
            background: "none",
            padding: 0,
            cursor: "pointer",
            color: "var(--fg-3)",
          }}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
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
    // Reuse the picker's grouping logic and strip the divider marker.
    // Keeping the empty-query path in lockstep with the picker means
    // changing one (mine-first, alpha) tomorrow won't silently leave the
    // other behind — and that lockstep now includes "no cap": the `[+]`
    // picker lists every addable agent, so the `@` popover does too. The
    // popover is height-capped + scrollable (`max-h-56 overflow-auto`), so
    // a long roster scrolls rather than hiding agents past an arbitrary
    // cut. A prior hard `.slice(0, 8)` dropped the 9th+ addressable agent
    // from the empty-`@` view with no "more" affordance, so the list read
    // as broken/incomplete the moment an org had more than eight.
    return groupAndSortCandidates(candidates).filter((item): item is MentionCandidate => !("divider" in item));
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
  // No cap here either: every scored match surfaces, scrolling inside the
  // popover. Capping the typed path would hide later matches behind a
  // query the user can't refine further (the substring is already as
  // narrow as they typed). The candidate pool is bounded upstream by the
  // server's 100-row fetch — see useOrgAgentsSearch / issue 494.
  return scored.map((s) => s.c);
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
 * Whether a composer host should enter its phone "welded" state — i.e. flatten
 * its top corners because a picker panel is actually docked flush above it.
 *
 * True only when a panel is *visible*. Trial composers keep the mention/slash
 * hooks live (so `@`/`/` still drive keyboard handling) but intentionally render
 * no panel, so a trial trigger must NOT weld the host — that would square the
 * input's top corners with nothing docked above them. A shared predicate so a
 * welding host's open-state can't drift from its panel render guard (the chat
 * composer today; other hosts when they adopt the dock).
 */
export function composerPickerVisible(opts: { isTrial: boolean; mentionOpen: boolean; slashOpen: boolean }): boolean {
  if (opts.isTrial) return false;
  return opts.mentionOpen || opts.slashOpen;
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
 * True when `field` is fully outside `port` on the vertical axis — the field has
 * scrolled past its clipping scrollport, so a panel glued above it would float
 * over unrelated content (or off-screen). The portal picker uses this to
 * dismiss (not just hide) so an invisible panel is never keyboard-selectable.
 */
export function fieldOutOfScrollport(
  field: { top: number; bottom: number },
  port: { top: number; bottom: number },
): boolean {
  return field.bottom <= port.top || field.top >= port.bottom;
}

/** One `.mention-option` row (`min-height: 2.875rem` = 46). */
const PORTAL_MIN_PANEL = 46;
/** Portal panel height cap (`.mention-popover--portal max-height: 16rem`). */
const PORTAL_MAX_PANEL = 256;

/**
 * Placement for the upward-docked portal panel, or `null` to dismiss. The panel
 * welds its bottom to the field top and grows upward, so it must be clamped to
 * the space above the field within the visible viewport — otherwise its top
 * (first/active, Enter-selected) rows render above the viewport top, off-screen
 * yet selectable. Dismiss when the field is out of its scrollport, or when there
 * isn't room above it for even the active row (a hidden active row is worse than
 * no picker). Pure so the geometry is unit-testable without layout.
 */
export function portalPanelPlacement(opts: {
  field: { top: number; bottom: number };
  port: { top: number; bottom: number };
  viewportTop: number;
}): { maxHeight: number } | null {
  const { field, port, viewportTop } = opts;
  if (fieldOutOfScrollport(field, port)) return null;
  const available = field.top - viewportTop;
  if (available < PORTAL_MIN_PANEL) return null;
  return { maxHeight: Math.min(available, PORTAL_MAX_PANEL) };
}

/**
 * Nearest scrolling ancestor of `el` — the element whose `overflow` clips an
 * in-flow descendant. Used by the portal picker to bound visibility to the
 * actual clipping scrollport rather than the layout viewport.
 */
function nearestScrollableAncestor(el: HTMLElement): HTMLElement | null {
  let node = el.parentElement;
  while (node) {
    const oy = getComputedStyle(node).overflowY;
    if (oy === "auto" || oy === "scroll") return node;
    node = node.parentElement;
  }
  return null;
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
  portal = false,
  onDismiss,
}: {
  trigger: ActiveTrigger | null;
  results: MentionCandidate[];
  highlightIndex: number;
  onPick: (candidate: MentionCandidate) => void;
  anchorRef: { current: HTMLTextAreaElement | null };
  /** Render into a `document.body` portal with fixed positioning so the panel
   *  escapes an ancestor's overflow clip. AskTakeover's answer field lives in a
   *  scrolling card that clips an in-flow panel docked above it (hiding the
   *  first / active candidates — a wrong-selection hazard). Only hosts inside a
   *  clipping scroller pass this; the panel is positioned flush above the field
   *  and re-measures every frame while open. See `.mention-popover--portal` in
   *  index.css. Same idiom as `ui/popover.tsx` / `ui/hover-card.tsx`. */
  portal?: boolean;
  /** Portal only: called when the field scrolls fully out of its clipping
   *  scrollport. The host dismisses the trigger so a panel the user can no
   *  longer see is never keyboard-selectable (visibility atomic with the
   *  active-row selection). Wire to the mention hook's `dismiss`. */
  onDismiss?: () => void;
}) {
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [fixedRect, setFixedRect] = useState<{
    left: number;
    width: number;
    bottom: number;
    maxHeight: number;
  } | null>(null);
  // Keep the latest onDismiss without re-running the positioning effect (the
  // host passes a fresh closure each render).
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  const open = trigger != null && results.length > 0 && anchorRef.current != null;

  // Scroll the active row into view when the highlight changes — and also when
  // the portal clamp shrinks the panel (`fixedRect.maxHeight`), which can push a
  // previously-visible highlighted row below the smaller viewport while the
  // highlight index is unchanged, hiding an Enter-selectable active row.
  // `useLayoutEffect` so it re-establishes visibility before paint (no flash of
  // the hidden active row); the `maxHeight` dep runs it only on a committed
  // clamp change, not on every rAF frame.
  // biome-ignore lint/correctness/useExhaustiveDependencies: fixedRect.maxHeight IS the trigger — re-run on a committed clamp shrink to re-scroll the active row, even though the body reads the row via the DOM, not the value.
  useLayoutEffect(() => {
    const el = popoverRef.current?.querySelector<HTMLElement>(`[data-mention-index="${highlightIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [highlightIndex, fixedRect?.maxHeight]);

  // Portal positioning: keep the fixed panel flush above the anchor's field. A
  // requestAnimationFrame loop re-measures every frame while open, so the panel
  // stays glued through ANY anchor movement — inner-scroller scroll, keyboard,
  // resize, and in-card reflow that moves the field without a scroll/resize
  // event or a field size change (which scroll listeners + ResizeObserver miss).
  // The field is the anchor textarea's parent (popover + textarea are siblings
  // inside it) — measuring the field welds the panel to its outer edge. setState
  // bails when the rect is unchanged, so idle frames don't re-render.
  useLayoutEffect(() => {
    if (!portal || !open) {
      setFixedRect(null);
      return;
    }
    const anchor = anchorRef.current;
    if (!anchor) return;
    const field = anchor.parentElement ?? anchor;
    // Boundary = the clipping scrollport (the ancestor whose overflow does the
    // clipping), not the window: the field can scroll out of the card's scroller
    // while still inside the layout viewport.
    const scrollport = nearestScrollableAncestor(field);
    let raf = 0;
    let dismissed = false;
    const measure = () => {
      const r = field.getBoundingClientRect();
      const portRect = scrollport ? scrollport.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
      // Top of the visible viewport (shifts under pinch-zoom; 0 normally).
      const viewportTop = window.visualViewport ? window.visualViewport.offsetTop : 0;
      // null → dismiss: the field left its scrollport, or there isn't room above
      // it (within the viewport) for even the active row. Otherwise the panel is
      // height-clamped so its top (first/active) rows never render above the
      // viewport — off-screen but still Enter-selectable.
      const placement = portalPanelPlacement({ field: r, port: portRect, viewportTop });
      if (!placement) {
        setFixedRect(null);
        if (!dismissed) {
          dismissed = true;
          onDismissRef.current?.();
        }
        return;
      }
      setFixedRect((prev) => {
        const next = {
          left: r.left,
          width: r.width,
          bottom: window.innerHeight - r.top,
          maxHeight: placement.maxHeight,
        };
        return prev &&
          prev.left === next.left &&
          prev.width === next.width &&
          prev.bottom === next.bottom &&
          prev.maxHeight === next.maxHeight
          ? prev
          : next;
      });
    };
    const tick = () => {
      measure();
      raf = requestAnimationFrame(tick);
    };
    measure(); // sync first measure so the panel never paints at (0,0)
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [portal, open, anchorRef]);

  if (!trigger || results.length === 0) return null;
  const anchor = anchorRef.current;
  if (!anchor) return null;

  const ambiguous = ambiguousDisplayNames(results);
  const rows = results.map((c, i) => {
    const active = i === highlightIndex;
    return (
      <button
        key={c.agentId}
        type="button"
        role="option"
        aria-selected={active}
        data-mention-index={i}
        title={mentionOptionTitle(c)}
        onMouseDown={(e) => {
          // preventDefault keeps the textarea focused so `selectionStart`
          // can still be used to compute the insertion point.
          e.preventDefault();
          onPick(c);
        }}
        className="mention-option flex w-full items-center px-3 py-1.5 text-left text-body"
        style={{
          background: active ? "var(--bg-hover)" : "transparent",
          color: "var(--fg)",
          border: "none",
          cursor: "pointer",
        }}
      >
        <AgentOption candidate={c} ambiguous={ambiguous} />
      </button>
    );
  });

  if (portal) {
    // Skip the first paint until measured (avoids a flash at 0,0).
    if (!fixedRect) return null;
    return createPortal(
      <div
        ref={popoverRef}
        role="listbox"
        aria-label="Mention suggestions"
        className="mention-popover mention-popover--portal"
        style={{
          left: fixedRect.left,
          width: fixedRect.width,
          bottom: fixedRect.bottom,
          maxHeight: fixedRect.maxHeight,
        }}
      >
        {rows}
      </div>,
      document.body,
    );
  }

  return (
    <div ref={popoverRef} role="listbox" aria-label="Mention suggestions" className="mention-popover">
      {rows}
    </div>
  );
}
