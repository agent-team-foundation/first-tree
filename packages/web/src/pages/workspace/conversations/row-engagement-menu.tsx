import { CHAT_ENGAGEMENT_STATUSES, type ChatEngagementStatus } from "@first-tree/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { patchChatEngagement } from "../../../api/chats.js";
import { markMeChatUnread, pinMeChat } from "../../../api/me-chats.js";
import { type RowAction, RowActionsMenu } from "../../../components/ui/row-actions-menu.js";
import { useToast } from "../../../components/ui/toast.js";

const { ACTIVE, ARCHIVED, DELETED } = CHAT_ENGAGEMENT_STATUSES;

type EngagementActionsArgs = {
  status: ChatEngagementStatus;
  hasUnread: boolean;
  pinned: boolean;
  runEngagement: (next: ChatEngagementStatus) => void;
  runMarkUnread: () => void;
  runTogglePin: () => void;
};

function actionsFor({
  status,
  hasUnread,
  pinned,
  runEngagement,
  runMarkUnread,
  runTogglePin,
}: EngagementActionsArgs): RowAction[] {
  // Pin/Unpin leads the menu on any non-deleted row — it is private per-user
  // state independent of engagement, so an archived chat can still be pinned.
  const pinAction: RowAction = { key: "pin", label: pinned ? "Unpin" : "Pin", onSelect: runTogglePin };
  if (status === ACTIVE) {
    return [
      pinAction,
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
      pinAction,
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
  pinned,
}: {
  chatId: string;
  status: ChatEngagementStatus;
  hasUnread: boolean;
  pinned: boolean;
}) {
  const queryClient = useQueryClient();
  const { addToast } = useToast();
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
  // Pin toggles the caller's private `pinned_at`; the server re-projects the
  // Pinned group, so we invalidate to pick up the regrouping. Because the row
  // only visibly regroups after that refetch lands (a plain invalidate, not an
  // optimistic move — the optimistic reorder is PR5), a success toast confirms
  // the write so the delayed regroup never reads as a no-op. A failed write
  // surfaces its own toast rather than silently leaving the row where it was.
  const pinMut = useMutation({
    mutationFn: () => pinMeChat(chatId, !pinned),
    onSuccess: () => {
      invalidate();
      addToast({ title: pinned ? "Unpinned" : "Pinned" });
    },
    onError: () =>
      addToast({
        title: pinned ? "Couldn't unpin" : "Couldn't pin",
        description: "The change wasn't saved — try again.",
      }),
  });

  const actions = actionsFor({
    status,
    hasUnread,
    pinned,
    runEngagement: (next) => engagementMut.mutate(next),
    runMarkUnread: () => markUnreadMut.mutate(),
    runTogglePin: () => pinMut.mutate(),
  });
  return <RowActionsMenu actions={actions} ariaLabel="Manage chat" triggerClassName={TRIGGER_HOVER_REVEAL} />;
}
