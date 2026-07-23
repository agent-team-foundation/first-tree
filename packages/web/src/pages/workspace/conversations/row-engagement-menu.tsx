import { CHAT_ENGAGEMENT_STATUSES, type ChatEngagementStatus, type ListMeChatsResponse } from "@first-tree/shared";
import { type InfiniteData, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { patchChatEngagement } from "../../../api/chats.js";
import { listChatCronJobs } from "../../../api/cron-jobs.js";
import { markMeChatUnread, pinMeChat } from "../../../api/me-chats.js";
import { Button } from "../../../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog.js";
import { type RowAction, RowActionsMenu } from "../../../components/ui/row-actions-menu.js";
import { useToast } from "../../../components/ui/toast.js";
import { cronJobsQueryKey } from "../right-sidebar/schedules-section.js";
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
  // When set, an Archive/Delete is parked behind the schedule-warning dialog:
  // the target chat turned out to have active cron jobs.
  const [scheduleWarning, setScheduleWarning] = useState<{
    next: ChatEngagementStatus;
    activeCount: number;
  } | null>(null);
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["me", "chats"] });
    queryClient.invalidateQueries({ queryKey: ["chat-detail", chatId] });
  };
  const engagementMut = useMutation({
    mutationFn: (next: ChatEngagementStatus) => patchChatEngagement(chatId, next),
    onSuccess: () => {
      setScheduleWarning(null);
      invalidate();
    },
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
  // The submitted direction is the mutation VARIABLE (`nextPinned`), captured at
  // click time — NOT the live `pinned` prop. `onMutate` flips `pinned` (an
  // Attention row that gets pinned stays in its bucket and rerenders in place),
  // and TanStack Query re-binds the pending mutation's callbacks to the newest
  // render's closures; reading `pinned` in onSuccess/onError would then observe
  // the post-optimistic value and report / revert the WRONG direction.
  const pinMut = useMutation({
    // Serialize pin/unpin of the SAME chat so a rapid pin -> unpin can't reach
    // the server out of order and settle on the stale value; different chats
    // still run concurrently.
    scope: { id: `chat-pin:${chatId}` },
    mutationFn: (nextPinned: boolean) => pinMeChat(chatId, nextPinned),
    onMutate: async (nextPinned: boolean) => {
      // Freeze in-flight me-chats refetches (the list polls every 30s) so a
      // stale response can't clobber the optimistic cache mid-flight.
      await queryClient.cancelQueries({ queryKey: ["me", "chats"] });
      applyPinToCaches(nextPinned);
    },
    onError: (_err, nextPinned) => {
      // Targeted revert of just this chat to its pre-mutation state, then a toast
      // rather than silently leaving the row where the optimistic move put it.
      applyPinToCaches(!nextPinned);
      addToast({
        title: nextPinned ? "Couldn't pin" : "Couldn't unpin",
        description: "The change wasn't saved — try again.",
      });
    },
    onSuccess: (_data, nextPinned) => addToast({ title: nextPinned ? "Pinned" : "Unpinned" }),
    // Reconcile with server truth (exact pinnedAt / ordering, plus the
    // non-infinite palette / mobile caches skipped above) after either outcome.
    onSettled: () => invalidate(),
  });

  // Archive/Delete stay one-click for chats WITHOUT active schedules (the
  // pre-change behavior). When the chat does have active cron jobs the action
  // gets a single warning dialog first, because both actions change schedule
  // behavior: archiving does NOT pause them (the next accepted scheduled
  // message revives the chat view), deleting pauses them (and restoring the
  // chat never auto-resumes). The schedules list rides the same query key as
  // the sidebar section, so for the open chat this is normally a cache read.
  // A failed lookup fails OPEN — the warning is advisory; the Server owns the
  // real pause semantics on delete.
  const runEngagementGuarded = (next: ChatEngagementStatus) => {
    if (next !== ARCHIVED && next !== DELETED) {
      engagementMut.mutate(next);
      return;
    }
    queryClient
      .fetchQuery({
        queryKey: cronJobsQueryKey(chatId),
        queryFn: () => listChatCronJobs(chatId),
        staleTime: 30_000,
      })
      .then((data) => {
        const activeCount = (data?.items ?? []).filter((job) => job.state === "active").length;
        if (activeCount === 0) {
          engagementMut.mutate(next);
        } else {
          setScheduleWarning({ next, activeCount });
        }
      })
      .catch(() => engagementMut.mutate(next));
  };

  const actions = actionsFor({
    status,
    hasUnread,
    pinned,
    runEngagement: runEngagementGuarded,
    runMarkUnread: () => markUnreadMut.mutate(),
    // Capture the target direction at click time (before onMutate flips `pinned`).
    runTogglePin: () => pinMut.mutate(!pinned),
  });
  return (
    <>
      <RowActionsMenu actions={actions} ariaLabel="Manage chat" triggerClassName={TRIGGER_HOVER_REVEAL} />
      <ScheduleEngagementWarning
        warning={scheduleWarning}
        pending={engagementMut.isPending}
        onCancel={() => setScheduleWarning(null)}
        onConfirm={() => {
          if (scheduleWarning) engagementMut.mutate(scheduleWarning.next);
        }}
      />
    </>
  );
}

function ScheduleEngagementWarning({
  warning,
  pending,
  onCancel,
  onConfirm,
}: {
  warning: { next: ChatEngagementStatus; activeCount: number } | null;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const isDelete = warning?.next === DELETED;
  const scheduleNoun = warning?.activeCount === 1 ? "schedule" : "schedules";
  return (
    <Dialog open={warning !== null} onOpenChange={(open) => (!open ? onCancel() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isDelete ? "Delete this chat?" : "Archive this chat?"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <DialogDescription style={{ color: "var(--fg-2)" }}>
            This chat has {warning?.activeCount ?? 0} active {scheduleNoun}.
          </DialogDescription>
          <p className="text-body" style={{ color: "var(--fg-2)" }}>
            {isDelete
              ? "Deleting pauses them first. Restoring the chat later will not resume them — the owner must resume each schedule from the chat details panel."
              : "They keep running while the chat is archived, and the next scheduled message will make the chat visible in your list again."}
          </p>
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button type="button" variant={isDelete ? "destructive" : "default"} onClick={onConfirm} disabled={pending}>
            {isDelete ? (pending ? "Deleting…" : "Delete chat") : pending ? "Archiving…" : "Archive chat"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
