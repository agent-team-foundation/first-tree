import { CHAT_ENGAGEMENT_STATUSES, type ChatEngagementStatus } from "@agent-team-foundation/first-tree-hub-shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Archive, Loader2, Trash2 } from "lucide-react";
import { useState } from "react";
import { patchChatEngagement } from "../../../api/chats.js";
import { useToast } from "../../../components/ui/toast.js";

const { ARCHIVED, DELETED } = CHAT_ENGAGEMENT_STATUSES;

/**
 * Chat actions section — Archive / Delete the chat itself. Reuses the
 * same `patchChatEngagement` mutation as the conversation-list row menu
 * (see row-engagement-menu.tsx) so the two surfaces share semantics:
 * Archive is reversible (Unarchive lives on the row menu under the
 * Archived filter), Delete is reversible too (the chat lingers in the
 * Deleted view with a Restore banner) but feels more permanent to the
 * user, hence the confirm step.
 *
 * Caller is responsible for hiding this section when the user lacks
 * permission to manage engagement (admin-only in v1).
 */
export function ChatActionsSection({ chatId }: { chatId: string }) {
  const queryClient = useQueryClient();
  const { addToast } = useToast();
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const engagementMut = useMutation({
    mutationFn: (next: ChatEngagementStatus) => patchChatEngagement(chatId, next),
    onSuccess: (_data, next) => {
      queryClient.invalidateQueries({ queryKey: ["me", "chats"] });
      queryClient.invalidateQueries({ queryKey: ["chat-detail", chatId] });
      setConfirmingDelete(false);
      // The chat disappears from the active list once status changes, so
      // a toast is the only confirmation the user gets that the action
      // landed. Action: switch the conversation list to the matching
      // engagement view so the user can find (and restore) the chat.
      if (next === ARCHIVED) {
        addToast({
          title: "Chat archived",
          description: "Find it in the Archived view to restore.",
        });
      } else if (next === DELETED) {
        addToast({
          title: "Chat deleted",
          description: "Find it in the Deleted view to restore.",
        });
      }
    },
    onError: (err) => {
      addToast({
        title: "Action failed",
        description: err instanceof Error ? err.message : "Try again in a moment.",
      });
    },
  });

  const busy = engagementMut.isPending;

  return (
    <section>
      <div style={{ padding: "var(--sp-2_5) var(--sp-3) var(--sp-1)" }}>
        <div className="text-eyebrow" style={{ color: "var(--fg-4)" }}>
          Chat actions
        </div>
      </div>
      <div className="flex flex-col" style={{ padding: "0 var(--sp-2) var(--sp-3)", gap: 2 }}>
        <ActionButton
          icon={<Archive size={14} aria-hidden="true" />}
          label={busy && engagementMut.variables === ARCHIVED ? "Archiving…" : "Archive this chat"}
          disabled={busy}
          onClick={() => engagementMut.mutate(ARCHIVED)}
        />
        {confirmingDelete ? (
          <div
            className="flex flex-col"
            style={{
              gap: "var(--sp-1_5)",
              padding: "var(--sp-2)",
              border: "var(--hairline) solid var(--state-error)",
              borderRadius: "var(--radius-input)",
              background: "var(--bg-error-soft)",
            }}
          >
            <div className="text-body" style={{ color: "var(--fg-2)" }}>
              Delete this chat? It will move to the Deleted view and stop appearing in your conversation list.
            </div>
            <div className="flex items-center" style={{ gap: "var(--sp-1_5)" }}>
              <button
                type="button"
                onClick={() => engagementMut.mutate(DELETED)}
                disabled={busy}
                className="text-body inline-flex items-center transition-opacity"
                style={{
                  gap: "var(--sp-1)",
                  padding: "var(--sp-0_5) var(--sp-2_25)",
                  border: 0,
                  borderRadius: "var(--radius-input)",
                  background: "var(--state-error)",
                  color: "var(--bg-raised)",
                  cursor: busy ? "default" : "pointer",
                  opacity: busy ? 0.6 : 1,
                }}
              >
                {busy && engagementMut.variables === DELETED ? (
                  <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                ) : null}
                Delete
              </button>
              <button
                type="button"
                onClick={() => setConfirmingDelete(false)}
                disabled={busy}
                className="text-body inline-flex items-center"
                style={{
                  padding: "var(--sp-0_5) var(--sp-2_25)",
                  border: "var(--hairline) solid var(--border)",
                  borderRadius: "var(--radius-input)",
                  background: "var(--bg-raised)",
                  color: "var(--fg-2)",
                  cursor: busy ? "default" : "pointer",
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <ActionButton
            icon={<Trash2 size={14} aria-hidden="true" />}
            label="Delete this chat"
            disabled={busy}
            destructive
            onClick={() => setConfirmingDelete(true)}
          />
        )}
      </div>
    </section>
  );
}

function ActionButton({
  icon,
  label,
  disabled,
  destructive,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  disabled?: boolean;
  destructive?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex w-full items-center text-left transition-colors hover:bg-[var(--bg-hover)]"
      style={{
        gap: "var(--sp-2)",
        padding: "var(--sp-1_75) var(--sp-2)",
        border: 0,
        background: "transparent",
        borderRadius: "var(--radius-input)",
        color: destructive ? "var(--state-error)" : "var(--fg-2)",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <span className="shrink-0">{icon}</span>
      <span className="text-body">{label}</span>
    </button>
  );
}
