import { ChevronDown } from "lucide-react";
import type { RefObject } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
 * It belongs to the conversation content, not the header chrome: it shares the
 * message-stream canvas (`--bg`) rather than a fill of its own, is separated
 * from the white header (`--bg-raised`) above by a single hairline + the
 * natural bg step, and lifts on a faint shadow only while the stream scrolls
 * under it.
 *
 * Two forms:
 *   - Collapsed (default): one line — the description's first meaningful line
 *     (section headings skipped, markdown markers stripped, ellipsis-truncated),
 *     an "Updated" chip when there's an unread change, the freshness
 *     ("9 days ago"), and a quiet chevron. Freshness shows in BOTH states, so an
 *     auto-expanded summary still surfaces when it last changed.
 *   - Expanded: just the description rendered as markdown — no footer. Read-only
 *     is self-evident (no edit affordance anywhere); the updater name is not
 *     shown (single-agent maintenance makes it noise — the data stays on the
 *     chat detail).
 *
 * Auto behavior: default collapsed; auto-expand once on entry ONLY when the
 * update is unread AND the viewer hasn't looked in a while; while expanded,
 * scrolling the stream folds it to the bar (restores at the top); a manual
 * toggle always wins and is remembered per chat. Renders nothing when the chat
 * has no description.
 */

// Auto-expand "haven't looked in a while" gate: an unread description update
// only pops the header open on entry when the viewer last read this chat at
// least this long ago — or on an earlier calendar day. Long enough that a quick
// tab-away-and-back doesn't re-pop the panel.
const STALE_SINCE_VIEW_MS = 8 * 60 * 60 * 1000;
// Scroll sticky-collapse thresholds (px from the stream top). The hysteresis
// gap (40 vs 6) debounces the boundary so a hair of scroll doesn't flutter it.
const SCROLL_COLLAPSE_PX = 40;
const SCROLL_RESTORE_PX = 6;

// Per-chat manual expand/collapse preference. Mirrors the localStorage pattern
// used elsewhere in the chat view (private-mode safe, per-chat key suffix).
const MANUAL_PREF_KEY = "first-tree:chat-summary-expanded:v1";

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

function isStaleSinceLastView(lastReadAtMs: number | null, nowMs: number): boolean {
  if (lastReadAtMs === null) return true; // never read this chat → treat as "a while"
  if (nowMs - lastReadAtMs >= STALE_SINCE_VIEW_MS) return true;
  // A different calendar day also counts as "haven't looked in a while".
  return new Date(lastReadAtMs).toDateString() !== new Date(nowMs).toDateString();
}

export function ChatSummary({
  chatId,
  description,
  descriptionUpdatedAt,
  lastReadAt,
  freshnessReady,
  scrollContainerRef,
}: {
  chatId: string;
  description: string | null;
  descriptionUpdatedAt: string | null;
  lastReadAt: string | null;
  /** True once the REAL chat-detail fetch has settled for this chat (not the
   *  list-nav initialData stub, which lacks the freshness fields). The
   *  auto-expand decision waits for this so it reads true unread/last-read. */
  freshnessReady: boolean;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
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

  // Decide the entry state, after the real detail has settled, keyed by chat AND
  // the description's freshness version (`descriptionUpdatedAt`): auto-expand +
  // highlight only when the update is unread AND the viewer hasn't looked in a
  // while; otherwise honor their remembered per-chat preference (default
  // collapsed). Keying on the version (not just chatId) means a NEW description
  // update re-asserts its unread cue / auto-expand even within the same open
  // chat, instead of being suppressed by a once-per-chat guard — while the
  // user's manual collapse/expand preference is still remembered per chat.
  // Manual toggles for the current version always win (see onToggle).
  const decidedForKey = useRef<string | null>(null);
  const entryKey = `${chatId}|${descriptionUpdatedAt ?? ""}`;
  useEffect(() => {
    if (!hasDescription || !freshnessReady) return;
    if (decidedForKey.current === entryKey) return;
    decidedForKey.current = entryKey;
    setScrollCollapsed(false);
    setUnreadCleared(false);
    if (unread && isStaleSinceLastView(lastReadMs, Date.now())) {
      setOpen(true);
      setHighlighted(true);
    } else {
      setOpen(loadManualPref(chatId) ?? false);
      setHighlighted(false);
    }
  }, [entryKey, chatId, hasDescription, freshnessReady, unread, lastReadMs]);

  const onToggle = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      saveManualPref(chatId, next);
      return next;
    });
    setHighlighted(false);
    setUnreadCleared(true);
    setScrollCollapsed(false);
  }, [chatId]);

  // Sticky-collapse: while open, scrolling the message stream down folds the
  // header to its one-line bar; returning to the top restores it. Transient —
  // never persisted — and a manual toggle clears it. Refs keep the scroll
  // handler cheap and free of stale closures.
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
      if (top > SCROLL_COLLAPSE_PX && openRef.current && !scrollCollapsedRef.current) {
        setScrollCollapsed(true);
      } else if (top <= SCROLL_RESTORE_PX && scrollCollapsedRef.current) {
        setScrollCollapsed(false);
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [hasDescription, scrollContainerRef]);

  if (!hasDescription) return null;

  const expanded = open && !scrollCollapsed;
  const firstLine = descriptionFirstLine(trimmed);
  const freshnessText = updatedAtMs !== null ? formatRelative(descriptionUpdatedAt) : null;
  const showAmberChip = unread && !unreadCleared && !expanded;
  const amberActive = highlighted && expanded;

  return (
    <div
      className="shrink-0"
      style={{
        // The summary is conversation content, so it shares the message-stream
        // canvas (`--bg`) — the white header (`--bg-raised`) above gives a
        // natural one-step contrast. Only the header↔summary seam carries a
        // hairline (the header itself has no bottom border); nothing separates
        // the summary from the stream below (same surface). A faint shadow
        // appears only while the stream scrolls under it, reading as "pinned".
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
            color: firstLine ? "var(--fg)" : "var(--fg-3)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            fontStyle: firstLine ? undefined : "italic",
          }}
        >
          {firstLine || "No summary yet"}
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
            // Vertical axis matches the open/close motion: ▼ collapsed (opens
            // downward) → ▲ expanded (collapses up). Kept quiet (muted grey) so
            // the freshness stays the primary right-side signal.
            color: "var(--fg-4)",
            transform: expanded ? "rotate(180deg)" : "none",
            transition: "transform 180ms ease",
          }}
        />
      </button>

      {expanded ? (
        <div style={{ padding: "0 var(--sp-6) var(--sp-3)" }}>
          <div className="text-body" style={{ color: "var(--fg)", maxHeight: "min(46vh, 30rem)", overflowY: "auto" }}>
            {/* Faithful markdown render. Headings are flattened to body size so
                hierarchy is carried by weight + spacing (mirrors the rail's old
                Summary treatment) rather than shouting over the bar above. */}
            <Markdown className="[&_:is(h1,h2,h3,h4,h5,h6)]:text-[length:1em] [&_:is(h1,h2,h3,h4,h5,h6)]:font-semibold [&_:is(h1,h2,h3,h4,h5,h6)]:leading-snug [&_:is(h1,h2,h3,h4,h5,h6)]:mt-3.5 [&_:is(h1,h2,h3,h4,h5,h6)]:mb-1 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_ul]:pl-4 [&_ol]:pl-4">
              {trimmed}
            </Markdown>
          </div>
        </div>
      ) : null}
    </div>
  );
}
