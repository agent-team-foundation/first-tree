import type { ChatParticipantDetail } from "@first-tree/shared";
import { useCallback, useState } from "react";
import { GitHubSection } from "./github-section.js";
import { GitLabSection } from "./gitlab-section.js";
import { ParticipantsSection } from "./participants-section.js";
import { SidebarResizeHandle } from "./resize-handle.js";
import { SchedulesSection } from "./schedules-section.js";

/** Resizable inline-rail width (px). Default is a touch wider than the legacy
 *  320 so markdown descriptions breathe; the user can drag wider for long
 *  content. Persisted globally (a reading preference, not per-chat). */
const WIDTH_STORAGE_KEY = "first-tree:chat-right-sidebar:width:v1";
const DEFAULT_WIDTH = 360;
const MIN_WIDTH = 300;
const MAX_WIDTH = 600;

/** Clamp to the fixed [MIN, MAX] band. A single source of clamping shared with
 *  the drag handle (which is handed the same MIN/MAX), so the live drag value,
 *  the committed value, and the persisted value never disagree. The center
 *  conversation stays usable because the shell switches to the overlay variant
 *  below the narrow breakpoint; in inline mode the user owns the trade and can
 *  double-click the handle to reset. */
function clampWidth(width: number): number {
  return Math.min(Math.max(Math.round(width), MIN_WIDTH), MAX_WIDTH);
}

function loadWidth(): number {
  if (typeof window === "undefined") return DEFAULT_WIDTH;
  try {
    const raw = window.localStorage.getItem(WIDTH_STORAGE_KEY);
    if (raw === null) return DEFAULT_WIDTH;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? clampWidth(parsed) : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}

function saveWidth(width: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(WIDTH_STORAGE_KEY, String(width));
  } catch {
    // localStorage may be unavailable (private mode); ignore.
  }
}

/**
 * ChatRightSidebar — chat-scoped detail + management panel mounted inside
 * ChatView. No internal header bar and no in-panel close button: the
 * chat header already owns a "Hide chat details" toggle, so a duplicate
 * × inside the panel was just redundant clutter.
 *
 * The chat's running summary (the `description`) is NOT here — it lives in the
 * pinned ChatSummary above the message stream. This rail carries only the
 * secondary "who + what's bound" context:
 *   1. Participants — humans + agents (agents first, since their live status
 *      is the glanceable pulse). Caps the visible roster; rest behind
 *      "Show all".
 *   2. Schedules — the chat's cron jobs: read facts for every reader,
 *      pause/resume/delete for the owning member. Hidden when the chat has
 *      none.
 *   3. Provider bindings — read-only GitHub and GitLab entities bound to this
 *      chat. Each provider section is hidden when it has no bindings.
 *
 * Width: the inline rail is drag-resizable (left-edge handle) and remembers
 * its width globally. The narrow-viewport overlay passes a fixed `width` and
 * gets no handle.
 *
 * Archive / Delete are intentionally NOT in this rail — the
 * conversation-list row kebab (row-engagement-menu.tsx) is the single
 * canonical entry.
 */
export function ChatRightSidebar({
  chatId,
  participants,
  participantsLoading,
  managedByMe,
  onAdded,
  readOnly,
  width,
}: {
  chatId: string;
  participants: ChatParticipantDetail[];
  participantsLoading: boolean;
  managedByMe: Map<string, boolean>;
  onAdded: () => void;
  /** Watcher mode: hide write surfaces. Currently gates the inline
   *  "Add participant" affordance inside ParticipantsSection. */
  readOnly: boolean;
  /** When set, pins the rail to a fixed width and disables resize. Used by the
   *  narrow-viewport overlay branch in `ChatView` (`min(88vw, 20rem)`). When
   *  omitted, the rail is drag-resizable and restores its persisted width. */
  width?: number | string;
}) {
  const isFixed = width !== undefined;
  const [resizableWidth, setResizableWidth] = useState<number>(loadWidth);

  const handleWidthChange = useCallback((next: number) => setResizableWidth(clampWidth(next)), []);
  const handleCommit = useCallback((next: number) => saveWidth(clampWidth(next)), []);
  const handleReset = useCallback(() => {
    setResizableWidth(DEFAULT_WIDTH);
    saveWidth(DEFAULT_WIDTH);
  }, []);

  return (
    <aside
      aria-label="Chat details"
      className="relative flex shrink-0 flex-col overflow-hidden animate-in fade-in slide-in-from-right-4 duration-150"
      style={{
        width: isFixed ? width : resizableWidth,
        background: "var(--bg-raised)",
        borderLeft: "var(--hairline) solid var(--border)",
      }}
    >
      {isFixed ? null : (
        <SidebarResizeHandle
          width={resizableWidth}
          min={MIN_WIDTH}
          max={MAX_WIDTH}
          onWidthChange={handleWidthChange}
          onCommit={handleCommit}
          onReset={handleReset}
        />
      )}
      {/* Key the Participants section (its "Show all" fold state) by chatId so
          it resets on chat switch — ChatView is NOT remounted on switch, it
          refetches by chatId. The rail shell itself is intentionally NOT keyed:
          its width is a global preference. */}
      <div className="flex-1 overflow-y-auto">
        <ParticipantsSection
          key={`participants:${chatId}`}
          chatId={chatId}
          participants={participants}
          participantsLoading={participantsLoading}
          managedByMe={managedByMe}
          onAdded={onAdded}
          readOnly={readOnly}
        />
        {/* Keyed like Participants: row expansion and any open dialog are
            per-chat state that must reset on chat switch, and a pending
            mutation must never target the newly-selected chat. */}
        <SchedulesSection key={`schedules:${chatId}`} chatId={chatId} participants={participants} />
        <GitHubSection chatId={chatId} />
        <GitLabSection chatId={chatId} />
      </div>
    </aside>
  );
}
