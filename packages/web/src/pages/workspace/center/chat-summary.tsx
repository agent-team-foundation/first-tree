import { ChevronDown } from "lucide-react";
import {
  Children,
  type CSSProperties,
  type HTMLAttributes,
  isValidElement,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Markdown } from "../../../components/ui/markdown.js";
import { stripInlineMarkdown } from "../../../lib/strip-inline-markdown.js";
import { formatRelative } from "../../../lib/utils.js";

/**
 * Chat summary — the chat's running summary (`chat.description`), surfaced as a
 * pinned, collapsible strip between the chat header and the message stream
 * rather than buried in the right rail. Read-only: the description is the chat
 * `description`, maintained by agents via `chat update --description`; there is
 * deliberately NO edit affordance anywhere here (correcting it means telling an
 * agent in chat). The component preserves the description's authored markdown
 * without inventing sections, fields, or a "stage". When the description follows
 * the current-state contract, its first physical line is promoted into a readable
 * lead and the remaining markdown stays as supporting copy — including when
 * `remarkBreaks` keeps soft-break lines inside one `<p>`. The description is
 * always rendered as one markdown document so document-scoped syntax (reference
 * links, multiline constructs, and definitions) keeps working. Complex
 * block-first markdown falls back to the faithful full-document presentation.
 *
 * The persistent form is a one-line bar in flow between header and stream; the
 * expanded form is a FLOATING CARD portaled over the top of the message area
 * (`overlayContainerRef`), laid out `absolute; top:0` so it never occupies
 * stream space. That is the whole reason this isn't a second in-flow scroll
 * region: a wheel/touch over any visible pixel lands on a real scroll target
 * (card scrolls the card, messages scroll the messages) — no "looks scrollable
 * but isn't" dead zone — and opening/closing never reflows the conversation.
 *
 * Two forms:
 *   - Collapsed bar (default): one line — the description's first meaningful
 *     line (section headings skipped, markdown markers stripped,
 *     ellipsis-truncated), an "Updated" chip when there's an unread change, the
 *     freshness ("9 days ago"), and a quiet chevron. Freshness shows in BOTH
 *     states, so an auto-expanded summary still surfaces when it last changed.
 *   - Expanded card: the bar stays put (label flips to "Current state", chevron up)
 *     while a non-modal overlay floats below it with the description rendered as
 *     markdown — own scroll (`overscroll: contain`), `--shadow-md` + border for
 *     separation, NO scrim (a summary surfacing is awareness, not a modal
 *     interception). Read-only is self-evident (no edit affordance anywhere).
 *
 * Auto behavior: default collapsed; auto-expand once on entry when the update
 * is unread for this viewer, unless they already manually dismissed this exact
 * summary version; while expanded, scrolling the stream folds it back to the bar
 * — re-expanding is then an explicit toggle (scroll never re-opens it), and
 * Escape / a pointer outside the card also dismiss it; a manual toggle always
 * wins and is remembered per chat. Renders nothing when the chat has no
 * description.
 */

// Scroll sticky-collapse threshold (px from the stream top). Moving beyond this
// folds the expanded summary to its one-line bar.
const SCROLL_COLLAPSE_PX = 40;
// When a manual expand happens while already scrolled down, returning near the
// top clears that temporary anchor so later downward movement uses the standard
// collapse threshold. It does not auto-expand a sticky-collapsed summary.
const MANUAL_EXPAND_RESET_PX = 6;

// Per-chat manual expand/collapse preference. Mirrors the localStorage pattern
// used elsewhere in the chat view (private-mode safe, per-chat key suffix).
const MANUAL_PREF_KEY = "first-tree:chat-summary-expanded:v1";
// Per-chat summary version the user has explicitly collapsed while it was
// unread. This suppresses repeat auto-open for the same `descriptionUpdatedAt`
// while still allowing the next summary update to surface.
const DISMISSED_VERSION_KEY = "first-tree:chat-summary-dismissed-version:v1";

function loadManualPref(chatId: string): boolean | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(`${MANUAL_PREF_KEY}:${chatId}`);
    if (raw === null) return null;
    return raw === "1";
  } catch {
    return null;
  }
}

function saveManualPref(chatId: string, expanded: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(`${MANUAL_PREF_KEY}:${chatId}`, expanded ? "1" : "0");
  } catch {
    // localStorage may be unavailable (private mode); ignore.
  }
}

function loadDismissedVersion(chatId: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(`${DISMISSED_VERSION_KEY}:${chatId}`);
  } catch {
    return null;
  }
}

function saveDismissedVersion(chatId: string, version: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(`${DISMISSED_VERSION_KEY}:${chatId}`, version);
  } catch {
    // localStorage may be unavailable (private mode); ignore.
  }
}

function clearDismissedVersion(chatId: string, version: string): void {
  if (typeof window === "undefined") return;
  try {
    const key = `${DISMISSED_VERSION_KEY}:${chatId}`;
    if (window.localStorage.getItem(key) === version) window.localStorage.removeItem(key);
  } catch {
    // localStorage may be unavailable (private mode); ignore.
  }
}

/**
 * Best-effort single-line preview of a markdown description for the collapsed
 * bar. A leading `## 任务` / `## Goals`-style section heading is a structural
 * label, not the summary itself — the real one-line gist is the prose under it.
 * So this prefers the first NON-heading content line (markdown markers stripped),
 * and falls back to a heading only when the description is nothing but heading(s)
 * (SPEC §七.7: a heading first line degrades to the first content line). Visual
 * truncation is left to CSS; this only removes markup noise. Returns "" when
 * nothing usable is found (the caller shows a fallback).
 */
type DescriptionLead = {
  preview: string;
  promotable: boolean;
  /** 1-based source line of the lead physical line (matches mdast/hast positions). */
  line: number;
};

function findDescriptionLead(description: string): DescriptionLead | null {
  const lines = description.split(/\r?\n/);
  let headingFallback: { preview: string; line: number } | null = null;
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    // Skip structural-only lines that carry no readable text: thematic breaks
    // (---/***/___) and table delimiter rows (| --- | :--: |).
    if (/^([-*_])\1{2,}$/.test(line)) continue;
    if (/^\|?[\s:|-]+\|?$/.test(line) && line.includes("-")) continue;
    const isHeading = /^#{1,6}\s+/.test(line);
    // Strip leading block markers (heading / bullet / ordered / quote / a
    // leading table pipe), then peel inline emphasis/code/link markers with the
    // shared delimiter-aware helper. Crucially that helper leaves literal
    // underscores inside content intact (e.g. `description_updated_at` stays
    // `description_updated_at`) — it removes markdown noise, never mangles the
    // description's own text.
    const stripped = stripInlineMarkdown(
      line
        .replace(/^#{1,6}\s+/, "")
        .replace(/^[-*+]\s+/, "")
        .replace(/^\d+[.)]\s+/, "")
        .replace(/^>\s?/, "")
        .replace(/^\|\s?/, ""),
    )
      .replace(/\s+/g, " ")
      .trim();
    if (!stripped) continue;
    const sourceLine = index + 1;
    if (isHeading) {
      // Remember the first heading as a fallback, but keep scanning for prose.
      if (!headingFallback) {
        headingFallback = { preview: stripped, line: sourceLine };
      }
      continue;
    }
    const nextLine = lines[index + 1]?.trim() ?? "";
    const startsTable = line.includes("|") && /^\|?[\s:|-]+\|?$/.test(nextLine) && nextLine.includes("-");
    const startsSetextHeading = /^ {0,3}(?:=+|-+)\s*$/.test(lines[index + 1] ?? "");
    const startsComplexBlock =
      /^(?:\t| {4})/.test(rawLine) ||
      /^([-*+]\s+|\d+[.)]\s+|>\s?|\||`{3,}|~{3,})/.test(line) ||
      startsTable ||
      startsSetextHeading;
    return {
      preview: stripped,
      promotable: !startsComplexBlock,
      line: sourceLine,
    };
  }
  if (!headingFallback) return null;
  return {
    preview: headingFallback.preview,
    promotable: false,
    line: headingFallback.line,
  };
}

export function descriptionFirstLine(description: string): string {
  return findDescriptionLead(description)?.preview ?? "";
}

type MarkdownParagraphNode = {
  position?: {
    start?: { line?: number };
    end?: { line?: number };
  };
};

/** Pure: true when this paragraph's source span covers the lead physical line. */
function paragraphContainsLeadLine(node: MarkdownParagraphNode | undefined, leadLine: number): boolean {
  const start = node?.position?.start?.line;
  const end = node?.position?.end?.line;
  if (start == null || end == null) return false;
  return start <= leadLine && leadLine <= end;
}

function isBreakElement(node: ReactNode): boolean {
  return isValidElement(node) && node.type === "br";
}

/** Split a paragraph's React children on soft-break `<br>` nodes. */
function splitChildrenByBreak(children: ReactNode): ReactNode[][] {
  const segments: ReactNode[][] = [[]];
  Children.forEach(children, (child) => {
    if (isBreakElement(child)) {
      segments.push([]);
      return;
    }
    const current = segments[segments.length - 1];
    if (current) current.push(child);
  });
  return segments;
}

/** Join soft-break segments without inventing list keys for stable source order. */
function joinSoftBreakSegments(segments: ReactNode[][]): ReactNode {
  return segments.reduce<ReactNode>((acc, segment, index) => {
    if (index === 0) return <>{segment}</>;
    return (
      <>
        {acc}
        <br />
        {segment}
      </>
    );
  }, null);
}

const LEAD_SPAN_STYLE: CSSProperties = {
  display: "block",
  color: "var(--fg)",
  marginBottom: "var(--sp-3)",
  // Inline measure beats parent `[&_p]:text-body` inheritance/specificity on <p>.
  fontSize: "var(--text-subtitle)",
  fontWeight: "var(--text-subtitle--font-weight)" as CSSProperties["fontWeight"],
  lineHeight: "var(--text-subtitle--line-height)",
  letterSpacing: "var(--text-subtitle--letter-spacing)",
};

function LeadSpan({ children }: { children: ReactNode }) {
  return (
    <span data-summary-part="lead" className="text-subtitle" style={LEAD_SPAN_STYLE}>
      {children}
    </span>
  );
}

/**
 * Promote only the first physical line of the prose paragraph that covers the
 * lead source line. Soft breaks from the writing contract stay in one Markdown
 * `<p>`; the lead is always a child span so `[&_p]:text-body` cannot flatten
 * headline weight back to body. Blank-line paragraphs wrap their sole segment
 * the same way.
 */
function LeadAwareParagraph({
  children,
  promoteLead,
  ...props
}: HTMLAttributes<HTMLParagraphElement> & {
  children?: ReactNode;
  promoteLead: boolean;
}) {
  if (!promoteLead) {
    return <p {...props}>{children}</p>;
  }
  const segments = splitChildrenByBreak(children);
  const nonEmpty = segments.filter((segment) =>
    segment.some((node) => {
      if (typeof node === "string") return node.trim().length > 0;
      return node != null && node !== false;
    }),
  );
  if (nonEmpty.length <= 1) {
    return (
      <p {...props}>
        <LeadSpan>{children}</LeadSpan>
      </p>
    );
  }
  const [lead, ...rest] = nonEmpty;
  return (
    <p {...props}>
      <LeadSpan>{lead}</LeadSpan>
      {joinSoftBreakSegments(rest)}
    </p>
  );
}

export function ChatSummary({
  chatId,
  description,
  descriptionUpdatedAt,
  lastReadAt,
  freshnessReady,
  autoExpandUnread = true,
  restoreManualExpansion = true,
  scrollContainerRef,
  overlayContainerRef,
}: {
  chatId: string;
  description: string | null;
  descriptionUpdatedAt: string | null;
  lastReadAt: string | null;
  /** True once the REAL chat-detail fetch has settled for this chat (not the
   *  list-nav initialData stub, which lacks the freshness fields). The
   *  auto-expand decision waits for this so it reads true unread/last-read. */
  freshnessReady: boolean;
  /** Narrow mobile chat routes keep the summary as an in-flow bar on entry so
   * the floating card does not cover the first messages. Desktop preserves the
   * unread auto-open behavior by default. */
  autoExpandUnread?: boolean;
  /** Mobile chat detail also ignores a desktop-expanded manual preference on
   * entry, so the first messages stay visible. */
  restoreManualExpansion?: boolean;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  /** The message timeline's `relative` wrapper. The expanded summary is
   *  portaled here and floated `absolute; top:0` over the message area. */
  overlayContainerRef: RefObject<HTMLDivElement | null>;
}) {
  const markdownDescription = description ?? "";
  const hasDescription = markdownDescription.trim().length > 0;

  const updatedAtMs = useMemo(() => {
    if (!descriptionUpdatedAt) return null;
    const ms = Date.parse(descriptionUpdatedAt);
    return Number.isNaN(ms) ? null : ms;
  }, [descriptionUpdatedAt]);
  const lastReadMs = useMemo(() => {
    if (!lastReadAt) return null;
    const ms = Date.parse(lastReadAt);
    return Number.isNaN(ms) ? null : ms;
  }, [lastReadAt]);

  // Unread description update = the description changed after the viewer last
  // read this chat (or they have never read it). Derived purely from server
  // data — no invented state.
  const unread = updatedAtMs !== null && (lastReadMs === null || updatedAtMs > lastReadMs);

  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(false);
  const [scrollCollapsed, setScrollCollapsed] = useState(false);
  // Pinned-elevation: true once the stream has scrolled under the bar (drives a
  // faint shadow); flat when the stream is at the top.
  const [scrolled, setScrolled] = useState(false);
  const [unreadCleared, setUnreadCleared] = useState(false);

  // Decide the entry state after the real detail has settled. A newly entered
  // chat auto-opens an unread summary version once; manually collapsing that
  // version suppresses repeat auto-open. If the summary updates while the user
  // is already in the chat, do not suddenly expand the reading pane — show the
  // Updated chip in the collapsed bar instead.
  const decidedForKey = useRef<string | null>(null);
  const entryKey = `${chatId}|${descriptionUpdatedAt ?? ""}`;
  const activeChatIdRef = useRef<string | null>(null);
  // When the user manually expands while already scrolled down, sticky-collapse
  // must not immediately fold the panel on the next scroll event that reports the
  // same scrollTop. Store the expansion point and require a fresh downward move.
  const manualExpandTopRef = useRef<number | null>(null);
  useEffect(() => {
    if (!freshnessReady) return;
    if (decidedForKey.current === entryKey) return;
    const enteringChat = activeChatIdRef.current !== chatId;
    activeChatIdRef.current = chatId;
    decidedForKey.current = entryKey;
    setUnreadCleared(false);
    if (!hasDescription) {
      manualExpandTopRef.current = null;
      setOpen(false);
      setScrollCollapsed(false);
      setHighlighted(false);
      return;
    }
    if (!enteringChat) {
      setHighlighted(false);
      return;
    }
    manualExpandTopRef.current = null;
    setScrollCollapsed(false);
    const dismissedVersion = loadDismissedVersion(chatId);
    if (autoExpandUnread && unread && descriptionUpdatedAt && dismissedVersion !== descriptionUpdatedAt) {
      setOpen(true);
      setHighlighted(true);
    } else {
      setOpen(restoreManualExpansion ? (loadManualPref(chatId) ?? false) : false);
      setHighlighted(false);
    }
  }, [
    autoExpandUnread,
    entryKey,
    chatId,
    descriptionUpdatedAt,
    hasDescription,
    freshnessReady,
    restoreManualExpansion,
    unread,
  ]);

  const onToggle = useCallback(() => {
    setOpen((prev) => {
      const next = scrollCollapsedRef.current ? true : !prev;
      const el = scrollContainerRef.current;
      manualExpandTopRef.current = next && el ? el.scrollTop : null;
      if (descriptionUpdatedAt) {
        if (next) {
          clearDismissedVersion(chatId, descriptionUpdatedAt);
        } else if (unread) {
          saveDismissedVersion(chatId, descriptionUpdatedAt);
        }
      }
      saveManualPref(chatId, next);
      return next;
    });
    setHighlighted(false);
    setUnreadCleared(true);
    setScrollCollapsed(false);
  }, [chatId, descriptionUpdatedAt, scrollContainerRef, unread]);

  // Sticky-collapse: while open, scrolling the message stream down folds the
  // header to its one-line bar. It never auto-expands on scroll; opening again
  // is an explicit toggle. Transient — never persisted — and a manual toggle
  // clears it. Refs keep the scroll handler cheap and free of stale closures.
  const openRef = useRef(open);
  openRef.current = open;
  const scrollCollapsedRef = useRef(scrollCollapsed);
  scrollCollapsedRef.current = scrollCollapsed;
  const scrolledRef = useRef(scrolled);
  scrolledRef.current = scrolled;
  useEffect(() => {
    if (!hasDescription) return;
    const el = scrollContainerRef.current;
    if (!el) return;
    setScrolled(el.scrollTop > 1); // initial elevation state (does not collapse on mount)
    const onScroll = () => {
      const top = el.scrollTop;
      const nextScrolled = top > 1;
      if (nextScrolled !== scrolledRef.current) setScrolled(nextScrolled);
      const manualExpandTop = manualExpandTopRef.current;
      if (top <= MANUAL_EXPAND_RESET_PX) {
        manualExpandTopRef.current = null;
      }
      const collapseTop = manualExpandTop === null ? SCROLL_COLLAPSE_PX : manualExpandTop + SCROLL_COLLAPSE_PX;
      if (top > collapseTop && openRef.current && !scrollCollapsedRef.current) {
        manualExpandTopRef.current = null;
        setScrollCollapsed(true);
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [hasDescription, scrollContainerRef]);

  // The bar stays in flow; the expanded body floats as an overlay (see render),
  // so the only wheel dead zone left is the thin one-line bar itself (shrink-0 inside an
  // overflow-hidden column, no scrollable ancestor). Forward a wheel over the
  // bar to the message stream — trivial, no boundary math: the floating card
  // scrolls itself natively (`overscroll: contain`) and the bar is never a
  // scroll target. (Replaces the PR 1245 expanded-body wheel bridge, which the
  // overlay makes unnecessary.)
  const barRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!hasDescription) return;
    const bar = barRef.current;
    if (!bar) return;
    const onWheel = (e: WheelEvent) => {
      const stream = scrollContainerRef.current;
      if (!stream) return;
      // Leave horizontal/trackpad-pan gestures to the browser.
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.deltaY === 0) return;
      stream.scrollTop += e.deltaY;
      e.preventDefault();
    };
    // Native, non-passive so preventDefault works (React routes onWheel through a
    // passive root listener, where preventDefault is a no-op).
    bar.addEventListener("wheel", onWheel, { passive: false });
    return () => bar.removeEventListener("wheel", onWheel);
  }, [hasDescription, scrollContainerRef]);

  const expanded = open && !scrollCollapsed;

  // Dismiss the floating card explicitly on Escape or a pointer outside it. It is
  // a non-modal overlay (no scrim, no focus trap) so the page stays live; a
  // dismiss collapses to the bar AND remembers the per-version dismissal so the
  // same unread summary does not auto-float again on the next entry.
  const dismiss = useCallback(() => {
    setOpen(false);
    if (descriptionUpdatedAt && unread) saveDismissedVersion(chatId, descriptionUpdatedAt);
    saveManualPref(chatId, false);
    setHighlighted(false);
    setUnreadCleared(true);
    setScrollCollapsed(false);
  }, [chatId, descriptionUpdatedAt, unread]);
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (!t || cardRef.current?.contains(t) || barRef.current?.contains(t)) return;
      dismiss();
    };
    document.addEventListener("keydown", onKey);
    // Capture phase so the outside-press is seen before message-row handlers.
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [expanded, dismiss]);

  const descriptionLead = useMemo(() => findDescriptionLead(markdownDescription), [markdownDescription]);
  const promotesHeadline = descriptionLead?.promotable ?? false;
  const leadSourceLine = promotesHeadline ? (descriptionLead?.line ?? null) : null;
  const summaryMarkdownComponents = useMemo(() => {
    if (leadSourceLine == null) return undefined;
    return {
      p: ({
        node,
        children,
        ...props
      }: HTMLAttributes<HTMLParagraphElement> & {
        node?: MarkdownParagraphNode;
        children?: ReactNode;
      }) => (
        <LeadAwareParagraph promoteLead={paragraphContainsLeadLine(node, leadSourceLine)} {...props}>
          {children}
        </LeadAwareParagraph>
      ),
    };
  }, [leadSourceLine]);

  if (!hasDescription) return null;

  const firstLine = descriptionFirstLine(markdownDescription);
  const freshnessText = updatedAtMs !== null ? formatRelative(descriptionUpdatedAt) : null;
  const showAmberChip = unread && !unreadCleared && !expanded;
  const amberActive = highlighted && expanded;

  const overlayEl = overlayContainerRef.current;

  return (
    <>
      <div
        ref={barRef}
        className="shrink-0"
        style={{
          // The bar shares the message-stream canvas (`--bg`); the white header
          // (`--bg-raised`) above gives a one-step contrast and only the
          // header↔bar seam carries a hairline. A faint shadow appears while the
          // stream scrolls under it, reading as "pinned". The amber tint marks an
          // unread summary that auto-floated (matched on the card below).
          background: amberActive ? "var(--bg-warn-soft)" : "var(--bg)",
          borderTop: `var(--hairline) solid ${amberActive ? "var(--state-blocked-border)" : "var(--border-faint)"}`,
          boxShadow: scrolled ? "var(--shadow-sm)" : "none",
          transition: "background 160ms ease, box-shadow 160ms ease",
        }}
      >
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={expanded ? "Collapse current state" : "Expand current state"}
          className="flex w-full items-center text-left transition-colors hover:bg-[var(--bg-hover)]"
          style={{
            gap: "var(--sp-2)",
            padding: "var(--sp-2) var(--sp-6)",
            border: 0,
            background: "transparent",
            cursor: "pointer",
          }}
        >
          <span
            className="text-body min-w-0 flex-1"
            style={{
              color: expanded || firstLine ? "var(--fg)" : "var(--fg-3)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              fontStyle: !expanded && !firstLine ? "italic" : undefined,
              fontWeight: expanded ? 600 : undefined,
            }}
          >
            {expanded ? "Current state" : firstLine || "No summary yet"}
          </span>
          {showAmberChip ? (
            <span
              className="text-caption inline-flex shrink-0 items-center font-medium"
              style={{
                padding: "var(--sp-0_5) var(--sp-1_5)",
                borderRadius: "var(--radius-full)",
                color: "var(--warning)",
                background: "var(--state-blocked-soft)",
                border: "var(--hairline) solid var(--state-blocked-border)",
              }}
            >
              Updated
            </span>
          ) : null}
          {freshnessText ? (
            <span className="text-caption shrink-0" style={{ color: "var(--fg-3)", whiteSpace: "nowrap" }}>
              {freshnessText}
            </span>
          ) : null}
          <ChevronDown
            size={15}
            strokeWidth={2}
            className="shrink-0"
            style={{
              // ▼ collapsed (opens downward) → ▲ expanded (collapses up). Quiet
              // (muted grey) so freshness stays the primary right-side signal.
              color: "var(--fg-4)",
              transform: expanded ? "rotate(180deg)" : "none",
              transition: "transform 180ms ease",
            }}
          />
        </button>
      </div>

      {/* Expanded body: a non-modal floating card portaled over the top of the
          message area, so it never occupies stream space (no reflow) and always
          has a real scroll target under the cursor. `overscroll: contain` keeps
          its scroll from chaining into the messages behind it; no scrim — the
          shadow + border separate it, and a summary surfacing is awareness, not
          a modal interception. */}
      {expanded && overlayEl
        ? createPortal(
            <section
              ref={cardRef}
              aria-label="Current state"
              className="chat-summary-card-in z-10"
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                // Stretched edge to edge: the card takes the width of the chat
                // header and the collapsed bar it drops from, so the expanded and
                // collapsed forms of the same surface line up. The copy inherits
                // that width — deliberately NO measure of its own, which would
                // both wrap the text early and leave the card wider than its own
                // content.
                right: 0,
                background: amberActive ? "var(--bg-warn-soft)" : "var(--bg-raised)",
                border: `var(--hairline) solid ${amberActive ? "var(--state-blocked-border)" : "var(--border)"}`,
                borderRadius: "var(--radius-dialog)",
                boxShadow: "var(--shadow-md)",
                padding: "var(--sp-4) var(--sp-6) var(--sp-5)",
                maxHeight: "min(46vh, 30rem)",
                overflowY: "auto",
                overscrollBehavior: "contain",
              }}
            >
              <div
                data-summary-part="document"
                data-summary-layout={promotesHeadline ? "lead" : "faithful"}
                className="text-body"
                style={{ color: promotesHeadline ? "var(--fg-2)" : "var(--fg)" }}
              >
                {/* Keep one markdown tree so reference definitions and other
                    document-scoped syntax remain available to every block.
                    The current-state contract promotes the first physical line;
                    a custom first paragraph styles only that line when soft
                    breaks stay inside one <p>. Legacy block-first markdown
                    stays faithful. */}
                <Markdown
                  className={
                    "[&_p]:text-body [&_li]:text-body [&_:is(h1,h2,h3,h4,h5,h6)]:text-[length:1em] [&_:is(h1,h2,h3,h4,h5,h6)]:font-semibold [&_:is(h1,h2,h3,h4,h5,h6)]:leading-snug [&_:is(h1,h2,h3,h4,h5,h6)]:mt-3.5 [&_:is(h1,h2,h3,h4,h5,h6)]:mb-1 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_ul]:pl-4 [&_ol]:pl-4"
                  }
                  components={summaryMarkdownComponents}
                >
                  {markdownDescription}
                </Markdown>
              </div>
            </section>,
            overlayEl,
          )
        : null}
    </>
  );
}
