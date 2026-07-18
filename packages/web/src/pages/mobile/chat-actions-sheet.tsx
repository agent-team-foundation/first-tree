import type { MeChatRow } from "@first-tree/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Archive, ArchiveRestore, Check, Mail, MailOpen, Pin, PinOff, X } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { patchChatEngagement } from "../../api/chats.js";
import { markMeChatRead, markMeChatUnread, pinMeChat } from "../../api/me-chats.js";
import { useToast } from "../../components/ui/toast.js";

export function MobileChatActionsSheet({ row, onClose }: { row: MeChatRow; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { addToast } = useToast();
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const archived = row.engagementStatus === "archived";
  const pinned = row.pinnedAt !== null;
  const unread = row.unreadMentionCount > 0;
  const archiveBlocker = archiveBlockerFor(row);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => previousFocus?.focus();
  }, []);

  const invalidate = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["me", "chats"] }),
      queryClient.invalidateQueries({ queryKey: ["chat-detail", row.chatId] }),
    ]);
  };

  const run = async (key: string, operation: () => Promise<unknown>, successTitle: string | null): Promise<boolean> => {
    if (pending) return false;
    setPending(key);
    setError(null);
    try {
      await operation();
      void invalidate();
      if (successTitle) addToast({ title: successTitle });
      onClose();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The change could not be saved.");
      setPending(null);
      return false;
    }
  };

  const archive = async (): Promise<void> => {
    if (archiveBlocker) return;
    const succeeded = await run("archive", () => patchChatEngagement(row.chatId, "archived"), null);
    if (!succeeded) return;
    addToast({
      title: "Chat moved to Archived",
      action: {
        label: "Undo",
        onClick: () => {
          void patchChatEngagement(row.chatId, "active")
            .then(invalidate)
            .then(() => addToast({ title: "Archive undone" }))
            .catch(() =>
              addToast({ title: "Couldn't undo archive", description: "Open Archived to restore the chat." }),
            );
        },
      },
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const items = dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
    );
    if (!items || items.length === 0) return;
    const first = items.item(0);
    const last = items.item(items.length - 1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="fixed inset-0 flex items-end" style={{ zIndex: 70 }} data-mobile-chat-actions-root>
      <button
        type="button"
        aria-label="Close chat actions"
        onClick={onClose}
        className="absolute inset-0 border-0"
        style={{ background: "var(--overlay-scrim)" }}
      />
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Actions for ${row.title}`}
        onKeyDown={onKeyDown}
        className="relative z-10 w-full border-t animate-in fade-in slide-in-from-bottom-4 duration-150"
        style={{
          borderColor: "var(--border)",
          borderRadius: "var(--radius-dialog) var(--radius-dialog) 0 0",
          background: "var(--bg-raised)",
          boxShadow: "var(--shadow-md)",
          padding: "var(--sp-3) var(--sp-3) calc(var(--sp-3) + env(safe-area-inset-bottom))",
        }}
        data-mobile-chat-actions
      >
        <div className="flex justify-end" style={{ padding: "0 var(--sp-1) var(--sp-1)" }}>
          <button
            ref={closeRef}
            type="button"
            aria-label="Close chat actions"
            onClick={onClose}
            className="inline-flex h-11 w-11 items-center justify-center rounded-[var(--radius-input)] border"
            style={{ borderColor: "var(--border)", color: "var(--fg-3)" }}
          >
            <X aria-hidden className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-col" style={{ gap: "var(--sp-1)" }}>
          <ActionButton
            icon={pinned ? <PinOff /> : <Pin />}
            label={pinned ? "Unpin" : "Pin"}
            pending={pending === "pin"}
            disabled={pending !== null}
            onClick={() => void run("pin", () => pinMeChat(row.chatId, !pinned), pinned ? "Unpinned" : "Pinned")}
          />
          {!archived ? (
            <ActionButton
              icon={unread ? <MailOpen /> : <Mail />}
              label={unread ? "Mark as read" : "Mark as unread"}
              pending={pending === "read"}
              disabled={pending !== null}
              onClick={() =>
                void run(
                  "read",
                  () => (unread ? markMeChatRead(row.chatId) : markMeChatUnread(row.chatId)),
                  unread ? "Marked as read" : "Marked as unread",
                )
              }
            />
          ) : null}
          {archived ? (
            <ActionButton
              icon={<ArchiveRestore />}
              label="Unarchive"
              pending={pending === "unarchive"}
              disabled={pending !== null}
              onClick={() =>
                void run("unarchive", () => patchChatEngagement(row.chatId, "active"), "Moved back to Chats")
              }
            />
          ) : (
            <>
              <ActionButton
                icon={<Archive />}
                label="Archive"
                pending={pending === "archive"}
                disabled={pending !== null || archiveBlocker !== null}
                onClick={() => void archive()}
              />
              {archiveBlocker ? (
                <p
                  className="text-mobile-caption"
                  style={{ color: "var(--fg-4)", margin: "0 var(--sp-3) var(--sp-1)" }}
                >
                  {archiveBlocker}
                </p>
              ) : null}
            </>
          )}
        </div>
        {error ? (
          <p
            role="alert"
            className="text-mobile-caption"
            style={{ color: "var(--state-error)", margin: "var(--sp-2) var(--sp-3) 0" }}
          >
            {error}
          </p>
        ) : null}
      </section>
    </div>
  );
}

function ActionButton({
  icon,
  label,
  pending,
  disabled,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  pending: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-center rounded-[var(--radius-input)] text-left transition-colors hover:bg-[var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-45"
      style={{ minHeight: 48, gap: "var(--sp-3)", padding: "var(--sp-2) var(--sp-3)", color: "var(--fg)" }}
    >
      <span aria-hidden className="inline-flex h-6 w-6 items-center justify-center [&>svg]:h-4 [&>svg]:w-4">
        {pending ? <Check /> : icon}
      </span>
      <span className="text-mobile-body">{pending ? `${label}…` : label}</span>
    </button>
  );
}

export function archiveBlockerFor(row: MeChatRow): string | null {
  if (row.openRequestCount > 0) return "Answer or skip the open question before archiving.";
  if (row.failedAgentIds.length > 0) return "Review the failed agent before archiving.";
  if (row.busyAgentIds.length > 0) return "Wait for the active turn to finish before archiving.";
  return null;
}
