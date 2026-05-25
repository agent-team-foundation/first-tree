import { CHAT_ENGAGEMENT_STATUSES, type ChatEngagementStatus } from "@first-tree/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { patchChatEngagement } from "../../../api/chats.js";
import { markMeChatUnread } from "../../../api/me-chats.js";
import { type RowAction, RowActionsMenu } from "../../../components/ui/row-actions-menu.js";

const { ACTIVE, ARCHIVED, DELETED } = CHAT_ENGAGEMENT_STATUSES;

type EngagementActionsArgs = {
  status: ChatEngagementStatus;
  hasUnread: boolean;
  runEngagement: (next: ChatEngagementStatus) => void;
  runMarkUnread: () => void;
};

function actionsFor({ status, hasUnread, runEngagement, runMarkUnread }: EngagementActionsArgs): RowAction[] {
  if (status === ACTIVE) {
    return [
      // Mark-as-unread is only offered on ACTIVE rows. ARCHIVED rows intentionally
      // omit it: re-surfacing an archived chat is the Unarchive action's job, and
      // a silent "unread but still hidden under Archived" state would diverge from
      // the existing fan-out path that auto-revives archived → active on a new
      // message.
      { key: "mark-unread", label: "Mark as unread", disabled: hasUnread, onSelect: runMarkUnread },
      { key: "archive", label: "Archive", onSelect: () => runEngagement(ARCHIVED) },
      { key: "delete", label: "Delete", destructive: true, onSelect: () => runEngagement(DELETED) },
    ];
  }
  if (status === ARCHIVED) {
    return [
      { key: "unarchive", label: "Unarchive", onSelect: () => runEngagement(ACTIVE) },
      { key: "delete", label: "Delete", destructive: true, onSelect: () => runEngagement(DELETED) },
    ];
  }
  return [];
}

// Hover-reveal: hidden until the row is hovered or the dropdown is open
// (aria-expanded surfaces via the underlying button). `focus-visible` instead
// of `focus` keeps the trigger from sticking visible after a mouse click.
const TRIGGER_HOVER_REVEAL = "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100";

export function RowEngagementMenu({
  chatId,
  status,
  hasUnread,
}: {
  chatId: string;
  status: ChatEngagementStatus;
  hasUnread: boolean;
}) {
  const queryClient = useQueryClient();
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["me", "chats"] });
    queryClient.invalidateQueries({ queryKey: ["chat-detail", chatId] });
  };
  const engagementMut = useMutation({
    mutationFn: (next: ChatEngagementStatus) => patchChatEngagement(chatId, next),
    onSuccess: invalidate,
  });
  const markUnreadMut = useMutation({
    mutationFn: () => markMeChatUnread(chatId),
    onSuccess: invalidate,
  });

  const actions = actionsFor({
    status,
    hasUnread,
    runEngagement: (next) => engagementMut.mutate(next),
    runMarkUnread: () => markUnreadMut.mutate(),
  });
  return <RowActionsMenu actions={actions} ariaLabel="Manage chat" triggerClassName={TRIGGER_HOVER_REVEAL} />;
}
