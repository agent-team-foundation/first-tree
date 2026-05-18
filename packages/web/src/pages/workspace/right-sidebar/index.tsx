import { X } from "lucide-react";
import type { MentionCandidate } from "../../../components/mention-autocomplete.js";
import { ChatActionsSection } from "./chat-actions-section.js";
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
 *   3. Chat actions — Archive / Delete, reusing the same
 *      `patchChatEngagement` mutation as the conversation-list row menu.
 */
export function ChatRightSidebar({
  chatId,
  addParticipantsCandidates,
  agentIdentity,
  onAdded,
  onClose,
  readOnly,
}: {
  chatId: string;
  addParticipantsCandidates: MentionCandidate[];
  agentIdentity: (uuid: string | null | undefined) => {
    name: string | null;
    displayName: string;
    avatarImageUrl: string | null;
    avatarColorToken: string | null;
  } | null;
  onAdded: () => void;
  onClose: () => void;
  /** Watcher mode: hide write surfaces. Archive / Delete in
   *  ChatActionsSection are per-caller engagement mutations (not
   *  chat-level moderation), so the same `!readOnly` gate the
   *  conversation-list row menu implicitly uses (only speakers see
   *  the kebab) is the right level here too — no separate admin
   *  check, the rail Chat actions stay symmetric with the row menu. */
  readOnly: boolean;
}) {
  return (
    <aside
      aria-label="Chat details"
      className="relative flex shrink-0 flex-col overflow-hidden animate-in fade-in slide-in-from-right-4 duration-150"
      style={{
        width: 320,
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
          addParticipantsCandidates={addParticipantsCandidates}
          agentIdentity={agentIdentity}
          onAdded={onAdded}
          readOnly={readOnly}
        />
        <GitHubSection chatId={chatId} />
        {readOnly ? null : <ChatActionsSection chatId={chatId} />}
      </div>
    </aside>
  );
}
