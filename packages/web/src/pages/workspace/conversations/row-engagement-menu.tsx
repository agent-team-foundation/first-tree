import { CHAT_ENGAGEMENT_STATUSES, type ChatEngagementStatus } from "@agent-team-foundation/first-tree-hub-shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { patchChatEngagement } from "../../../api/chats.js";
import { type RowAction, RowActionsMenu } from "../../../components/ui/row-actions-menu.js";

const { ACTIVE, ARCHIVED, DELETED } = CHAT_ENGAGEMENT_STATUSES;

function actionsFor(status: ChatEngagementStatus, run: (next: ChatEngagementStatus) => void): RowAction[] {
  if (status === ACTIVE) {
    return [
      { key: "archive", label: "Archive", onSelect: () => run(ARCHIVED) },
      { key: "delete", label: "Delete", destructive: true, onSelect: () => run(DELETED) },
    ];
  }
  if (status === ARCHIVED) {
    return [
      { key: "unarchive", label: "Unarchive", onSelect: () => run(ACTIVE) },
      { key: "delete", label: "Delete", destructive: true, onSelect: () => run(DELETED) },
    ];
  }
  return [];
}

// Hover-reveal: hidden until the row is hovered or the dropdown is open
// (aria-expanded surfaces via the underlying button). `focus-visible` instead
// of `focus` keeps the trigger from sticking visible after a mouse click.
const TRIGGER_HOVER_REVEAL = "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100";

export function RowEngagementMenu({ chatId, status }: { chatId: string; status: ChatEngagementStatus }) {
  const queryClient = useQueryClient();
  const mut = useMutation({
    mutationFn: (next: ChatEngagementStatus) => patchChatEngagement(chatId, next),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["me", "chats"] });
      queryClient.invalidateQueries({ queryKey: ["chat-detail", chatId] });
    },
  });

  const actions = actionsFor(status, (next) => mut.mutate(next));
  return <RowActionsMenu actions={actions} ariaLabel="Manage chat" triggerClassName={TRIGGER_HOVER_REVEAL} />;
}
