import type { MeChatRow } from "@first-tree/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Archive, Mail, MoreHorizontal, Pin } from "lucide-react";
import { type ReactNode, type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { patchChatEngagement } from "../../api/chats.js";
import { markMeChatUnread, pinMeChat } from "../../api/me-chats.js";
import { useToast } from "../../components/ui/toast.js";

export type MobileChatAction = {
  key: "pin" | "mark-unread" | "archive";
  label: string;
  shortLabel: string;
  icon: typeof Pin;
  disabled: boolean;
  onSelect: () => void;
};

/**
 * The deliberately small mobile triage set. Destructive deletion and other
 * desktop management controls stay out of the phone surface; these three
 * reversible actions are the shortcuts approved for Now / Chat cards.
 */
export function useMobileChatActions(row: MeChatRow): MobileChatAction[] {
  const queryClient = useQueryClient();
  const { addToast } = useToast();
  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ["me", "chats"] });
    void queryClient.invalidateQueries({ queryKey: ["chat-detail", row.chatId] });
  };

  const pinMutation = useMutation({
    scope: { id: `mobile-chat-pin:${row.chatId}` },
    mutationFn: (nextPinned: boolean) => pinMeChat(row.chatId, nextPinned),
    onSuccess: (_data, nextPinned) => {
      addToast({ title: nextPinned ? "Pinned" : "Unpinned" });
      invalidate();
    },
    onError: (_error, nextPinned) => {
      addToast({
        title: nextPinned ? "Couldn't pin" : "Couldn't unpin",
        description: "The change wasn't saved — try again.",
      });
    },
  });
  const unreadMutation = useMutation({
    mutationFn: () => markMeChatUnread(row.chatId),
    onSuccess: () => {
      addToast({ title: "Marked as unread" });
      invalidate();
    },
    onError: () => {
      addToast({ title: "Couldn't mark as unread", description: "The change wasn't saved — try again." });
    },
  });
  const archiveMutation = useMutation({
    mutationFn: () => patchChatEngagement(row.chatId, "archived"),
    onSuccess: () => {
      addToast({ title: "Archived" });
      invalidate();
    },
    onError: () => {
      addToast({ title: "Couldn't archive", description: "The change wasn't saved — try again." });
    },
  });

  return useMemo(
    () => [
      {
        key: "pin",
        label: row.pinnedAt ? "Unpin chat" : "Pin chat",
        shortLabel: row.pinnedAt ? "Unpin" : "Pin",
        icon: Pin,
        disabled: pinMutation.isPending,
        onSelect: () => pinMutation.mutate(row.pinnedAt === null),
      },
      {
        key: "mark-unread",
        label: "Mark as unread",
        shortLabel: "Unread",
        icon: Mail,
        disabled: row.unreadMentionCount > 0 || unreadMutation.isPending,
        onSelect: () => unreadMutation.mutate(),
      },
      {
        key: "archive",
        label: "Archive chat",
        shortLabel: "Archive",
        icon: Archive,
        disabled: archiveMutation.isPending,
        onSelect: () => archiveMutation.mutate(),
      },
    ],
    [
      archiveMutation.isPending,
      archiveMutation.mutate,
      pinMutation.isPending,
      pinMutation.mutate,
      row.pinnedAt,
      row.unreadMentionCount,
      unreadMutation.isPending,
      unreadMutation.mutate,
    ],
  );
}

/** A touch-minimum kebab that opens a thumb-reachable action sheet, not a tiny popover. */
export function MobileCardActionsMenu({ actions, title }: { actions: MobileChatAction[]; title: string }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      requestAnimationFrame(() => triggerRef.current?.focus());
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={`Manage ${title}`}
        aria-haspopup="menu"
        aria-expanded={open}
        data-mobile-card-menu
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
        className="inline-flex shrink-0 items-center justify-center transition-colors active:translate-y-px"
        style={{
          width: 44,
          height: 44,
          margin: "calc(var(--sp-2) * -1)",
          border: 0,
          borderRadius: "var(--radius-input)",
          background: "transparent",
          color: "var(--fg-3)",
        }}
      >
        <MoreHorizontal aria-hidden className="h-5 w-5" />
      </button>
      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              role="presentation"
              className="fixed inset-0"
              style={{ zIndex: 80, background: "color-mix(in oklch, var(--fg) 10%, transparent)" }}
              onPointerDown={(event) => {
                if (event.target !== event.currentTarget) return;
                setOpen(false);
                requestAnimationFrame(() => triggerRef.current?.focus());
              }}
            >
              <div
                role="menu"
                aria-label={`Manage ${title}`}
                className="absolute left-0 right-0"
                style={{
                  bottom: 0,
                  padding: "var(--sp-2) var(--sp-3) calc(var(--sp-3) + env(safe-area-inset-bottom))",
                  background: "var(--bg-raised)",
                  borderTop: "var(--hairline) solid var(--border)",
                  borderRadius: "var(--radius-dialog) var(--radius-dialog) 0 0",
                  boxShadow: "var(--shadow-md)",
                }}
              >
                <p
                  className="text-mobile-caption truncate"
                  style={{ margin: "0 var(--sp-2) var(--sp-2)", color: "var(--fg-4)" }}
                >
                  {title}
                </p>
                {actions.map((action) => (
                  <button
                    key={action.key}
                    type="button"
                    role="menuitem"
                    disabled={action.disabled}
                    onClick={() => {
                      setOpen(false);
                      action.onSelect();
                    }}
                    className="flex w-full items-center text-left transition-colors active:translate-y-px disabled:opacity-50"
                    style={{
                      minHeight: 48,
                      gap: "var(--sp-3)",
                      padding: "0 var(--sp-3)",
                      border: 0,
                      borderRadius: "var(--radius-input)",
                      background: "transparent",
                      color: "var(--fg)",
                    }}
                  >
                    <action.icon aria-hidden className="h-4 w-4" />
                    <span className="text-mobile-body">{action.label}</span>
                  </button>
                ))}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

const SWIPE_ACTION_WIDTH = 68;
const SWIPE_OPEN_THRESHOLD = 40;

/**
 * Progressive shortcut for repeat users: a horizontal swipe exposes the same
 * three actions as the kebab. Vertical scrolling keeps browser ownership via
 * `touchAction: pan-y`; a completed swipe suppresses the synthetic card click.
 */
export function MobileSwipeCard({ actions, children }: { actions: MobileChatAction[]; children: ReactNode }) {
  const trayWidth = actions.length * SWIPE_ACTION_WIDTH;
  const [open, setOpen] = useState(false);
  const [dragOffset, setDragOffset] = useState<number | null>(null);
  const gestureRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startOffset: number;
    lastOffset: number;
    horizontal: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const offset = dragOffset ?? (open ? -trayWidth : 0);

  const finishGesture = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (gesture.horizontal) {
      const moved = gesture.lastOffset - gesture.startOffset;
      setOpen(moved < -SWIPE_OPEN_THRESHOLD || (gesture.startOffset < 0 && moved < SWIPE_OPEN_THRESHOLD));
      suppressClickRef.current = Math.abs(moved) > 8;
    }
    setDragOffset(null);
    gestureRef.current = null;
  };

  return (
    <div className="relative" style={{ borderRadius: "var(--radius-dialog)", overflow: "hidden" }}>
      <div className="absolute inset-y-0 right-0 flex" aria-hidden={!open}>
        {actions.map((action) => (
          <button
            key={action.key}
            type="button"
            tabIndex={open ? 0 : -1}
            disabled={action.disabled}
            aria-label={action.label}
            onClick={() => {
              setOpen(false);
              action.onSelect();
            }}
            className="flex flex-col items-center justify-center disabled:opacity-50"
            style={{
              width: SWIPE_ACTION_WIDTH,
              gap: "var(--sp-1)",
              border: 0,
              borderLeft: "var(--hairline) solid var(--border-faint)",
              background: "var(--bg-active)",
              color: "var(--fg-2)",
            }}
          >
            <action.icon aria-hidden className="h-4 w-4" />
            <span className="text-mobile-caption">{action.shortLabel}</span>
          </button>
        ))}
      </div>
      <div
        data-mobile-swipe-surface
        onPointerDown={(event) => {
          if (event.pointerType === "mouse" && event.button !== 0) return;
          gestureRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            startOffset: open ? -trayWidth : 0,
            lastOffset: open ? -trayWidth : 0,
            horizontal: false,
          };
        }}
        onPointerMove={(event) => {
          const gesture = gestureRef.current;
          if (!gesture || gesture.pointerId !== event.pointerId) return;
          const dx = event.clientX - gesture.startX;
          const dy = event.clientY - gesture.startY;
          if (!gesture.horizontal) {
            if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
            if (Math.abs(dy) >= Math.abs(dx)) {
              gestureRef.current = null;
              return;
            }
            gesture.horizontal = true;
            event.currentTarget.setPointerCapture(event.pointerId);
          }
          event.preventDefault();
          const nextOffset = Math.max(-trayWidth, Math.min(0, gesture.startOffset + dx));
          gesture.lastOffset = nextOffset;
          setDragOffset(nextOffset);
        }}
        onPointerUp={finishGesture}
        onPointerCancel={finishGesture}
        onClickCapture={(event) => {
          if (suppressClickRef.current) {
            event.preventDefault();
            event.stopPropagation();
            suppressClickRef.current = false;
            return;
          }
          if (open) {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
          }
        }}
        style={{
          position: "relative",
          zIndex: 1,
          transform: `translate3d(${offset}px, 0, 0)`,
          transition: dragOffset === null ? "transform 180ms ease-out" : "none",
          touchAction: "pan-y",
        }}
      >
        {children}
      </div>
    </div>
  );
}
