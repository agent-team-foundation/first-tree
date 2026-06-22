import { ChevronRight } from "lucide-react";
import type { RefObject } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "../../../components/ui/markdown.js";
import { StatusGlyph } from "../../../components/ui/status-glyph.js";
import { formatRelative } from "../../../lib/utils.js";

/**
 * Task header — the chat's running summary (`chat.description`), surfaced as a
 * pinned, collapsible strip between the chat header and the message stream
 * rather than buried in the right rail. Read-only: the description is the chat
 * `description`, maintained by agents via `chat update --description`; there is
 * deliberately NO edit affordance anywhere here (correcting it means telling an
 * agent in chat). The component renders the description's markdown faithfully —
 * it never invents sections, fields, or a "stage".
 *
 * Two forms:
 *   - Collapsed (default): one line — an activity dot (green pulse when the
 *     description changed recently, else muted grey — a freshness signal, NOT a
 *     task stage), the description's first line (markdown markers stripped,
 *     ellipsis-truncated), an "Updated" chip when there's an unread change, and
 *     the freshness + updater.
 *   - Expanded: the description rendered as markdown, with a footer carrying the
 *     freshness/updater and the "maintained by agent" read-only note.
 *
 * Auto behavior (SPEC §五): default collapsed; auto-expand once on entry ONLY
 * when the update is unread AND the viewer hasn't looked in a while; while
 * expanded, scrolling the stream folds it to the bar (restores at the top); a
 * manual toggle always wins and is remembered per chat. Renders nothing when
 * the chat has no description.
 */

// Auto-expand "haven't looked in a while" gate: an unread description update
// only pops the header open on entry when the viewer last read this chat at
// least this long ago — or on an earlier calendar day. Long enough that a quick
// tab-away-and-back doesn't re-pop the panel.
const STALE_SINCE_VIEW_MS = 8 * 60 * 60 * 1000;
// Activity-dot freshness window: green + pulse when the description changed
// within this window, muted grey (no pulse) beyond it.
const FRESH_WINDOW_MS = 24 * 60 * 60 * 1000;
// Scroll sticky-collapse thresholds (px from the stream top). The hysteresis
// gap (40 vs 6) debounces the boundary so a hair of scroll doesn't flutter it.
const SCROLL_COLLAPSE_PX = 40;
const SCROLL_RESTORE_PX = 6;

// Per-chat manual expand/collapse preference. Mirrors the localStorage pattern
// used elsewhere in the chat view (private-mode safe, per-chat key suffix).
const MANUAL_PREF_KEY = "first-tree:chat-task-header-expanded:v1";

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
 * bar: the first line with real content, with common leading + inline markdown
 * markers stripped so a `## Heading` or `- bullet` reads as plain text. Visual
 * truncation is left to CSS; this only removes markup noise. Returns "" when
 * nothing usable is found (the caller shows a fallback).
 */
export function descriptionFirstLine(description: string): string {
  for (const rawLine of description.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    // Skip structural-only lines that carry no readable text: thematic breaks
    // (---/***/___) and table delimiter rows (| --- | :--: |).
    if (/^([-*_])\1{2,}$/.test(line)) continue;
    if (/^\|?[\s:|-]+\|?$/.test(line) && line.includes("-")) continue;
    const stripped = line
      // Leading block markers: heading hashes, list bullets, ordered markers,
      // blockquote, a leading table pipe.
      .replace(/^#{1,6}\s+/, "")
      .replace(/^[-*+]\s+/, "")
      .replace(/^\d+[.)]\s+/, "")
      .replace(/^>\s?/, "")
      .replace(/^\|\s?/, "")
      // Inline: links/images -> their text; then drop emphasis / code ticks.
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[*_`~]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (stripped) return stripped;
  }
  return "";
}

function isStaleSinceLastView(lastReadAtMs: number | null, nowMs: number): boolean {
  if (lastReadAtMs === null) return true; // never read this chat → treat as "a while"
  if (nowMs - lastReadAtMs >= STALE_SINCE_VIEW_MS) return true;
  // A different calendar day also counts as "haven't looked in a while".
  return new Date(lastReadAtMs).toDateString() !== new Date(nowMs).toDateString();
}

export function TaskHeader({
  chatId,
  description,
  descriptionUpdatedAt,
  descriptionUpdatedByName,
  lastReadAt,
  freshnessReady,
  scrollContainerRef,
}: {
  chatId: string;
  description: string | null;
  descriptionUpdatedAt: string | null;
  descriptionUpdatedByName: string | null;
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
  const [unreadCleared, setUnreadCleared] = useState(false);

  // Decide the entry state once per chat, after the real detail has settled:
  // auto-expand + highlight only when the update is unread AND the viewer hasn't
  // looked in a while; otherwise honor their remembered per-chat preference
  // (default collapsed). Manual toggles afterward always win (see onToggle).
  const decidedForChat = useRef<string | null>(null);
  useEffect(() => {
    if (!hasDescription || !freshnessReady) return;
    if (decidedForChat.current === chatId) return;
    decidedForChat.current = chatId;
    setScrollCollapsed(false);
    setUnreadCleared(false);
    if (unread && isStaleSinceLastView(lastReadMs, Date.now())) {
      setOpen(true);
      setHighlighted(true);
    } else {
      setOpen(loadManualPref(chatId) ?? false);
      setHighlighted(false);
    }
  }, [chatId, hasDescription, freshnessReady, unread, lastReadMs]);

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
  useEffect(() => {
    if (!hasDescription) return;
    const el = scrollContainerRef.current;
    if (!el) return;
    const onScroll = () => {
      const top = el.scrollTop;
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
  const fresh = updatedAtMs !== null && Date.now() - updatedAtMs < FRESH_WINDOW_MS;
  const firstLine = descriptionFirstLine(trimmed);
  const freshnessText =
    updatedAtMs !== null
      ? `${formatRelative(descriptionUpdatedAt)}${descriptionUpdatedByName ? ` · ${descriptionUpdatedByName}` : ""}`
      : null;
  const showAmberChip = unread && !unreadCleared && !expanded;
  const amberActive = highlighted && expanded;

  return (
    <div
      className="shrink-0"
      style={{
        background: amberActive ? "var(--bg-warn-soft)" : "var(--bg-raised)",
        borderBottom: `var(--hairline) solid ${amberActive ? "var(--state-blocked-border)" : "var(--border-faint)"}`,
        transition: "background 160ms ease",
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-label={expanded ? "Collapse task summary" : "Expand task summary"}
        className="flex w-full items-center text-left transition-colors hover:bg-[var(--bg-hover)]"
        style={{
          gap: "var(--sp-2)",
          padding: "var(--sp-2) var(--sp-6)",
          border: 0,
          background: "transparent",
          cursor: "pointer",
        }}
      >
        <StatusGlyph
          colorVar={fresh ? "var(--success)" : "var(--fg-4)"}
          shape="dot"
          pulse={fresh ? "working" : null}
          size={8}
          ariaLabel={fresh ? "Recently updated" : "No recent update"}
        />
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
        {!expanded && freshnessText ? (
          <span className="text-caption shrink-0" style={{ color: "var(--fg-3)", whiteSpace: "nowrap" }}>
            {freshnessText}
          </span>
        ) : null}
        <ChevronRight
          size={15}
          strokeWidth={2.25}
          className="shrink-0"
          style={{
            color: "var(--fg-4)",
            transform: expanded ? "rotate(90deg)" : "none",
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
          <div
            className="text-caption flex items-center"
            style={{
              gap: "var(--sp-2)",
              marginTop: "var(--sp-2)",
              paddingTop: "var(--sp-1_5)",
              borderTop: "var(--hairline) dashed var(--border-faint)",
              color: "var(--fg-4)",
            }}
          >
            <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {freshnessText ? `Updated ${freshnessText}` : "No update recorded yet"}
            </span>
            <span
              className="inline-flex shrink-0 items-center"
              style={{ gap: "var(--sp-1)" }}
              title="The summary is the chat description — agents keep it current. To correct it, tell an agent in the chat."
            >
              <span aria-hidden="true">↻</span> Maintained by agent
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
