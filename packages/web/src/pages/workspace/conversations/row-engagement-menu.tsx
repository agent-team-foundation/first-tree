import { CHAT_ENGAGEMENT_STATUSES, type ChatEngagementStatus, type ListMeChatsResponse } from "@first-tree/shared";
import { type InfiniteData, useMutation, useQueryClient } from "@tanstack/react-query";
import { patchChatEngagement } from "../../../api/chats.js";
import { markMeChatUnread, pinMeChat } from "../../../api/me-chats.js";
import { type RowAction, RowActionsMenu } from "../../../components/ui/row-actions-menu.js";
import { useToast } from "../../../components/ui/toast.js";
import { applyOptimisticPin } from "./optimistic-pin.js";

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

// Hover-reveal on fine (mouse) pointers: hidden until the row is hovered or the
// dropdown is open (aria-expanded surfaces via the underlying button).
// `focus-visible` instead of `focus` keeps the trigger from sticking visible
// after a mouse click. On COARSE (touch) pointers there is no hover and a tap
// rarely fires `focus-visible`, so hover-only would leave the kebab — the only
// Pin entry point — permanently invisible and untappable on phones and the
// narrow-overlay rail; `pointer-coarse:opacity-100` keeps it always shown there.
const TRIGGER_HOVER_REVEAL =
  "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100 pointer-coarse:opacity-100";

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
  // Pinned group. The row moves OPTIMISTICALLY (`applyOptimisticPin` reorders
  // the cached list into / out of the Pinned group) so the regroup is instant
  // instead of waiting on the round-trip + refetch. On failure the SAME helper
  // re-applies the ORIGINAL state — a targeted revert of just this chat rather
  // than a whole-cache snapshot restore, so a concurrent pin of a *different*
  // chat isn't clobbered — and the trailing invalidate reconciles exact ordering.
  //
  // The `["me","chats"]` prefix also matches NON-infinite caches: the command
  // palette (`["me","chats","palette"]`) and the mobile lists store a bare
  // `ListMeChatsResponse` (no `pages`). Skip those here — feeding one to the
  // InfiniteData transform would throw on `data.pages` — and let the trailing
  // invalidate refetch them. Mirrors the shape guard in `chat-by-id.tsx`.
  const applyPinToCaches = (nextPinned: boolean): void => {
    const nowIso = new Date().toISOString();
    queryClient.setQueriesData<InfiniteData<ListMeChatsResponse> | ListMeChatsResponse>(
      { queryKey: ["me", "chats"] },
      (old) => (old && "pages" in old ? applyOptimisticPin(old, chatId, nextPinned, nowIso) : old),
    );
  };
  const pinMut = useMutation({
    // Serialize pin/unpin of the SAME chat so a rapid pin -> unpin can't reach
    // the server out of order and settle on the stale value; different chats
    // still run concurrently.
    scope: { id: `chat-pin:${chatId}` },
    mutationFn: () => pinMeChat(chatId, !pinned),
    onMutate: async () => {
      // Freeze in-flight me-chats refetches (the list polls every 30s) so a
      // stale response can't clobber the optimistic cache mid-flight.
      await queryClient.cancelQueries({ queryKey: ["me", "chats"] });
      applyPinToCaches(!pinned);
    },
    onError: () => {
      // Targeted revert of just this chat (see above), then surface a toast
      // rather than silently leaving the row where the optimistic move put it.
      applyPinToCaches(pinned);
      addToast({
        title: pinned ? "Couldn't unpin" : "Couldn't pin",
        description: "The change wasn't saved — try again.",
      });
    },
    onSuccess: () => addToast({ title: pinned ? "Unpinned" : "Pinned" }),
    // Reconcile with server truth (exact pinnedAt / ordering, plus the
    // non-infinite palette / mobile caches skipped above) after either outcome.
    onSettled: () => invalidate(),
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
