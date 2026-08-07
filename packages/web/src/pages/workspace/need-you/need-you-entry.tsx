import { useQuery } from "@tanstack/react-query";
import { ChevronRight, CircleHelp } from "lucide-react";
import { useAuth } from "../../../auth/auth-context.js";
import { needYouQueryOptions } from "./query.js";

export function NeedYouEntry({
  variant,
  onOpen,
}: {
  variant: "desktop" | "mobile";
  /** Open the chat holding the OLDEST open request, with the cross-chat
   *  queue session active — answering there auto-advances to the next
   *  question's chat. There is no separate review page: the ask takeover
   *  over the real conversation is the single answering surface. */
  onOpen: (chatId: string) => void;
}) {
  const { organizationId } = useAuth();
  const queue = useQuery(needYouQueryOptions(organizationId));
  const count = queue.data?.total ?? 0;
  const first = queue.data?.items[0] ?? null;
  // Three distinct "no count" states, never collapsed into one:
  //  - pending: the queue state is UNKNOWN — disabled with loading semantics,
  //    and never announced as "no questions";
  //  - error: the queue is UNAVAILABLE — the entry stays reachable and a
  //    click retries the fetch (there is no review page to recover in);
  //  - success with total=0: a CONFIRMED zero — the only state that disables
  //    the entry as "no questions".
  const enabled = queue.isError || first !== null;
  const handleOpen = () => {
    if (queue.isError) {
      void queue.refetch();
      return;
    }
    if (first) onOpen(first.chat.id);
  };
  // Label keys on `first` (the same predicate that enables the button), not
  // on the raw count: an items-empty-but-total>0 intermediate snapshot must
  // not announce questions on a disabled control.
  const accessibleLabel = queue.isPending
    ? "Need you, loading"
    : queue.isError
      ? "Need you, failed to load, tap to retry"
      : first
        ? `Need you, ${count} ${count === 1 ? "question" : "questions"}`
        : "Need you, no questions";

  if (variant === "mobile") {
    return (
      <button
        type="button"
        disabled={!enabled}
        onClick={handleOpen}
        aria-label={accessibleLabel}
        className="flex min-h-14 w-full items-center text-left transition-colors"
        style={{
          gap: "var(--sp-3)",
          marginBottom: "var(--sp-4)",
          padding: "var(--sp-3) var(--sp-4)",
          border: "var(--hairline) solid var(--border)",
          borderRadius: "var(--radius-panel)",
          background: enabled ? "var(--bg-raised)" : "var(--bg-sunken)",
          color: enabled ? "var(--fg)" : "var(--fg-4)",
          cursor: enabled ? "pointer" : "default",
          opacity: queue.isLoading ? 0.7 : 1,
        }}
      >
        <CircleHelp aria-hidden className="h-5 w-5 shrink-0" />
        <span className="text-mobile-subtitle flex-1">Need you</span>
        {count > 0 ? (
          <span
            className="mono text-mobile-caption inline-flex min-w-6 items-center justify-center"
            style={{
              height: 24,
              padding: "0 var(--sp-1_5)",
              borderRadius: "var(--radius-full)",
              background: "var(--state-needs-you)",
              color: "var(--primary-on)",
            }}
          >
            {count}
          </span>
        ) : null}
        <ChevronRight aria-hidden className="h-4 w-4 shrink-0" />
      </button>
    );
  }

  return (
    <button
      type="button"
      disabled={!enabled}
      onClick={handleOpen}
      aria-label={accessibleLabel}
      className="flex w-full items-center text-left transition-colors"
      style={{
        gap: "var(--sp-2)",
        padding: "var(--sp-2_5) var(--sp-3)",
        border: 0,
        borderBottom: "var(--hairline) solid var(--border-faint)",
        background: "transparent",
        color: enabled ? "var(--fg)" : "var(--fg-4)",
        cursor: enabled ? "pointer" : "default",
      }}
    >
      <CircleHelp aria-hidden size={16} strokeWidth={1.8} />
      <span className="text-subtitle flex-1">Need you</span>
      {count > 0 ? (
        <span
          className="mono text-caption inline-flex min-w-5 items-center justify-center"
          style={{
            height: 20,
            padding: "0 var(--sp-1)",
            borderRadius: "var(--radius-full)",
            background: "var(--state-needs-you)",
            color: "var(--primary-on)",
          }}
        >
          {count}
        </span>
      ) : null}
      <ChevronRight aria-hidden size={14} />
    </button>
  );
}
