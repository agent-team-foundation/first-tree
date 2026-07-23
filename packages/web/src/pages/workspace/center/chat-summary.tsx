import { ChevronDown } from "lucide-react";
import type { RefObject } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
 * agent in chat). The component renders the description's markdown faithfully —
 * it never invents sections, fields, or a "stage".
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
 *   - Expanded card: the bar stays put (label flips to "Summary", chevron up)
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
 * Drop every `first-tree:chat-summary-*` localStorage key. Called on logout
 * (SEC-042 / issue 1647): the keys embed chatIds, which are account-linked
 * session data, so they must not survive into the next account on a shared
 * browser. Iterates the prefix so future keys added under it are covered
 * automatically (mirrors `clearOnboardingSessionFlags`).
 */
export function clearChatSummaryPrefs(): void {
  if (typeof window === "undefined") return;
  try {
    const ls = window.localStorage;
    const toRemove: string[] = [];
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (k?.startsWith("first-tree:chat-summary-")) toRemove.push(k);
    }
    for (const k of toRemove) ls.removeItem(k);
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
export function descriptionFirstLine(description: string): string {
  let headingFallback = "";
  for (const rawLine of description.split(/\r?\n/)) {
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
    if (isHeading) {
      // Remember the first heading as a fallback, but keep scanning for prose.
      if (!headingFallback) headingFallback = stripped;
      continue;
    }
    return stripped;
  }
  return headingFallback;
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
  const trimmed = description?.trim() ?? "";
  const hasDescription = trimmed.length > 0;

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

  if (!hasDescription) return null;

  const firstLine = descriptionFirstLine(trimmed);
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
          aria-label={expanded ? "Collapse summary" : "Expand summary"}
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
            {expanded ? "Summary" : firstLine || "No summary yet"}
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
              aria-label="Chat summary"
              className="chat-summary-card-in z-10"
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                background: amberActive ? "var(--bg-warn-soft)" : "var(--bg-raised)",
                border: `var(--hairline) solid ${amberActive ? "var(--state-blocked-border)" : "var(--border)"}`,
                borderRadius: "var(--radius-dialog)",
                boxShadow: "var(--shadow-md)",
                padding: "var(--sp-1) var(--sp-6) var(--sp-3)",
                maxHeight: "min(46vh, 30rem)",
                overflowY: "auto",
                overscrollBehavior: "contain",
              }}
            >
              <div className="text-body" style={{ color: "var(--fg)" }}>
                {/* Faithful markdown render; headings flattened to body size so
                    hierarchy is weight + spacing, not shouting over the bar. */}
                <Markdown className="[&_:is(h1,h2,h3,h4,h5,h6)]:text-[length:1em] [&_:is(h1,h2,h3,h4,h5,h6)]:font-semibold [&_:is(h1,h2,h3,h4,h5,h6)]:leading-snug [&_:is(h1,h2,h3,h4,h5,h6)]:mt-3.5 [&_:is(h1,h2,h3,h4,h5,h6)]:mb-1 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_ul]:pl-4 [&_ol]:pl-4">
                  {trimmed}
                </Markdown>
              </div>
            </section>,
            overlayEl,
          )
        : null}
    </>
  );
}
