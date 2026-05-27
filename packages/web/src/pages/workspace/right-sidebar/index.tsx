import type { ChatParticipantDetail } from "@first-tree/shared";
import { AttentionsSection } from "./attentions-section.js";
import { GitHubSection } from "./github-section.js";
import { ParticipantsSection } from "./participants-section.js";

/**
 * ChatRightSidebar — chat-scoped detail + management panel mounted inside
 * ChatView. No internal header bar and no in-panel close button: the
 * chat header already owns a "Hide chat details" toggle, so a duplicate
 * × inside the panel was just redundant clutter. Sections kick off
 * straight from the first eyebrow.
 *
 * Sections, top-to-bottom:
 *   1. Attention — chat-scoped NHA summary (open asks targeting this user).
 *   2. Participants — humans + agents with per-agent Suspend (matches the
 *      legacy AgentRow capability).
 *   3. GitHub bindings — read-only list of PRs / Issues bound to this
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
  readOnly,
  width = 320,
}: {
  chatId: string;
  participants: ChatParticipantDetail[];
  participantsLoading: boolean;
  managedByMe: Map<string, boolean>;
  onAdded: () => void;
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
      <div className="flex-1 overflow-y-auto">
        <AttentionsSection chatId={chatId} />
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
