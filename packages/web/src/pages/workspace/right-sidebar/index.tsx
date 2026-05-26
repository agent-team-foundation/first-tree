import type { ChatParticipantDetail } from "@first-tree/shared";
import { X } from "lucide-react";
import { GitHubSection } from "./github-section.js";
import { ParticipantsSection } from "./participants-section.js";

/**
 * ChatRightSidebar — chat-scoped detail + management panel mounted inside
 * ChatView. No internal header bar: the surrounding chrome (left column
 * header + this rail's left border) already frames the panel, so an extra
 * "Chat details" title strip was visually redundant. The close affordance
 * floats in the top-right corner instead, and sections kick off straight
 * from the first eyebrow.
 *
 * Sections, top-to-bottom:
 *   1. Participants — humans + agents with per-agent Suspend (matches the
 *      legacy AgentRow capability).
 *   2. GitHub bindings — read-only list of PRs / Issues bound to this
 *      chat. Hidden entirely when there are no bindings.
 *
 * Archive / Delete are intentionally NOT in this rail — the
 * conversation-list row kebab (row-engagement-menu.tsx) is the single
 * canonical entry, so the sidebar copy that used to live here was just
 * duplication.
 */
export function ChatRightSidebar({
  chatId,
  participants,
  participantsLoading,
  managedByMe,
  onAdded,
  onClose,
  readOnly,
  width = 320,
}: {
  chatId: string;
  participants: ChatParticipantDetail[];
  participantsLoading: boolean;
  managedByMe: Map<string, boolean>;
  onAdded: () => void;
  onClose: () => void;
  /** Watcher mode: hide write surfaces. Currently gates the inline
   *  "Add participant" affordance inside ParticipantsSection. */
  readOnly: boolean;
  /** Override the default 20rem width. Used by the narrow-viewport
   *  overlay branch in `ChatView` to cap to `min(88vw, 20rem)` so
   *  the rail doesn't overflow a ~23rem logical viewport. */
  width?: number | string;
}) {
  return (
    <aside
      aria-label="Chat details"
      className="relative flex shrink-0 flex-col overflow-hidden animate-in fade-in slide-in-from-right-4 duration-150"
      style={{
        width,
        background: "var(--bg-raised)",
        borderLeft: "var(--hairline) solid var(--border)",
      }}
    >
      {/* Floating close button. Anchors to the rail's top-right corner so
          it stays consistent regardless of which section is in view. The
          z-index keeps it above the scrollable section list. */}
      <button
        type="button"
        onClick={onClose}
        aria-label="Close chat details"
        title="Close (Esc)"
        className="absolute z-10 inline-flex items-center justify-center transition-colors hover:bg-[var(--bg-hover)]"
        style={{
          top: "var(--sp-1_5)",
          right: "var(--sp-2)",
          width: 28,
          height: 28,
          border: 0,
          background: "transparent",
          borderRadius: "var(--radius-input)",
          color: "var(--fg-3)",
          cursor: "pointer",
        }}
      >
        <X size={16} />
      </button>

      <div className="flex-1 overflow-y-auto">
        <ParticipantsSection
          chatId={chatId}
          participants={participants}
          participantsLoading={participantsLoading}
          managedByMe={managedByMe}
          onAdded={onAdded}
          readOnly={readOnly}
        />
        <GitHubSection chatId={chatId} />
      </div>
    </aside>
  );
}
