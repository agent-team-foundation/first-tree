import type { MeChatRow } from "@agent-team-foundation/first-tree-hub-shared";
import { useQuery } from "@tanstack/react-query";
import { Plus, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { listMeChats } from "../../../api/me-chats.js";
import { FilterPill } from "../../../components/ui/filter-pill.js";
import { cn } from "../../../lib/utils.js";

/**
 * Workspace left rail — conversation list. Replaces `AgentRoster`.
 *
 * URL contract: the parent page owns the `?c=` param. The list emits
 * `onSelectChat(chatId)` for an existing conversation and
 * `onSelectChat(DRAFT_CHAT_ID)` for the inline new-chat draft.
 *
 * See docs/chat-first-workspace-product-design.md "Conversation List rules".
 */

export const DRAFT_CHAT_ID = "draft" as const;

type Filter = "all" | "unread" | "watching";

const FILTER_PILLS: { value: Filter; label: string }[] = [
  { value: "all", label: "all" },
  { value: "unread", label: "unread" },
  { value: "watching", label: "watching" },
];

function formatRowTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const now = Date.now();
  const ageMs = now - d.getTime();
  if (ageMs < 60_000) return "now";
  if (ageMs < 60 * 60_000) {
    const m = Math.round(ageMs / 60_000);
    return `${m}m`;
  }
  if (ageMs < 24 * 60 * 60_000) {
    const h = Math.round(ageMs / (60 * 60_000));
    return `${h}h`;
  }
  // Older than 1 day: render `MM/DD HH:mm`.
  const parts = new Intl.DateTimeFormat("en-GB", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("month")}/${get("day")} ${get("hour")}:${get("minute")}`;
}

function buildSubtitle(row: MeChatRow): string {
  // Priority per the design doc: `Watching` > participant summary > preview.
  if (row.membershipKind === "watching") return "Watching";
  if (row.participants.length > 0) {
    const names = row.participants.map((p) => p.displayName).filter((n) => n.length > 0);
    if (names.length > 0) {
      const head = names.slice(0, 2).join(", ");
      const extra = names.length > 2 ? ` +${names.length - 2}` : "";
      return `${head}${extra}`;
    }
  }
  return row.lastMessagePreview ?? "";
}

export function ConversationList({
  selectedChatId,
  onSelectChat,
  onNewChat,
}: {
  selectedChatId: string | null;
  onSelectChat: (chatId: string) => void;
  onNewChat: () => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [extraPages, setExtraPages] = useState<MeChatRow[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["me", "chats", filter] as const,
    queryFn: () => listMeChats({ filter }),
    refetchInterval: 15_000,
  });

  // Reset paginated tail when filter/query change so we don't bleed rows
  // from a different filter into the current view.
  const resetExtras = (): void => {
    if (extraPages.length > 0) setExtraPages([]);
    setMoreError(null);
  };

  const baseRows = data?.rows ?? [];
  const allRows = useMemo(() => [...baseRows, ...extraPages], [baseRows, extraPages]);

  const filteredRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allRows;
    return allRows.filter((row) => {
      const t = row.title.toLowerCase();
      if (t.includes(q)) return true;
      const p = (row.lastMessagePreview ?? "").toLowerCase();
      if (p.includes(q)) return true;
      const names = row.participants.map((x) => x.displayName.toLowerCase()).join(" ");
      return names.includes(q);
    });
  }, [allRows, query]);

  const handleLoadMore = async (): Promise<void> => {
    if (loadingMore) return;
    const cursor = data?.nextCursor;
    if (!cursor) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const next = await listMeChats({ filter, cursor });
      setExtraPages((prev) => [...prev, ...next.rows]);
      // Keep `data.nextCursor` reflecting the freshest tail by appending the
      // next cursor onto the React-Query cache via the data object. We do
      // NOT mutate `data` directly — the simplest local approach is to
      // surface the cursor into a state value.
      setNextCursor(next.nextCursor);
    } catch (err) {
      setMoreError(err instanceof Error ? err.message : "Failed to load more");
    } finally {
      setLoadingMore(false);
    }
  };

  // Track the cursor for follow-up page loads. Mirrored from the latest
  // base-query response: any background refetch resets `nextCursor` so the
  // "Load more" button reflects the freshest tail.
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const baseCursor = data?.nextCursor ?? null;
  useEffect(() => {
    setNextCursor(baseCursor);
  }, [baseCursor]);

  const totalUnread = useMemo(() => allRows.reduce((acc, r) => acc + (r.unreadMentionCount > 0 ? 1 : 0), 0), [allRows]);
  const totalWatching = useMemo(() => allRows.filter((r) => r.membershipKind === "watching").length, [allRows]);

  return (
    <aside
      className="shrink-0 flex flex-col overflow-hidden"
      style={{
        width: 320,
        background: "var(--bg-raised)",
        borderRight: "var(--hairline) solid var(--border)",
      }}
    >
      {/* Header */}
      <div
        className="shrink-0"
        style={{
          padding: "var(--sp-2_5) var(--sp-3) var(--sp-2)",
          borderBottom: "var(--hairline) solid var(--border-faint)",
        }}
      >
        <div className="flex items-center justify-between" style={{ marginBottom: 8 }}>
          <span className="mono uppercase text-eyebrow" style={{ color: "var(--fg-3)" }}>
            Conversations
          </span>
          <button
            type="button"
            onClick={onNewChat}
            className="inline-flex items-center mono text-eyebrow uppercase"
            style={{
              gap: 4,
              padding: "var(--sp-0_5) var(--sp-1_5)",
              border: "var(--hairline) solid var(--border)",
              borderRadius: "var(--radius-input)",
              background: selectedChatId === DRAFT_CHAT_ID ? "var(--bg-active)" : "transparent",
              color: selectedChatId === DRAFT_CHAT_ID ? "var(--accent)" : "var(--fg-2)",
              cursor: "pointer",
            }}
            title="New chat"
          >
            <Plus className="h-3 w-3" />
            New
          </button>
        </div>
        <div className="relative">
          <Search
            className="h-3.5 w-3.5 absolute pointer-events-none"
            style={{
              left: 8,
              top: "50%",
              transform: "translateY(-50%)",
              color: "var(--fg-4)",
            }}
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search…"
            className="w-full outline-none text-body"
            style={{
              padding: "var(--sp-1_25) var(--sp-2) var(--sp-1_25) var(--sp-6_5)",
              background: "var(--bg-sunken)",
              border: "var(--hairline) solid var(--border)",
              borderRadius: "var(--radius-input)",
              color: "var(--fg)",
            }}
          />
        </div>
        <div className="flex gap-1" style={{ marginTop: 8 }}>
          {FILTER_PILLS.map((p) => (
            <FilterPill
              key={p.value}
              active={filter === p.value}
              count={p.value === "unread" ? totalUnread : p.value === "watching" ? totalWatching : allRows.length}
              onClick={() => {
                setFilter(p.value);
                resetExtras();
              }}
            >
              {p.label}
            </FilterPill>
          ))}
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {isLoading && filteredRows.length === 0 && (
          <div className="text-center text-body" style={{ padding: "var(--sp-6) var(--sp-3)", color: "var(--fg-3)" }}>
            Loading…
          </div>
        )}
        {!isLoading && filteredRows.length === 0 && (
          <div className="text-center text-body" style={{ padding: "var(--sp-6) var(--sp-3)", color: "var(--fg-3)" }}>
            {query ? (
              "No matches"
            ) : (
              <>
                <p style={{ margin: 0 }}>No conversations yet.</p>
                <p className="text-label" style={{ margin: "var(--sp-1) 0 0", color: "var(--fg-4)" }}>
                  Start with New chat.
                </p>
              </>
            )}
          </div>
        )}
        {filteredRows.map((row) => {
          const isSelected = selectedChatId === row.chatId;
          const subtitle = buildSubtitle(row);
          const hasUnread = row.unreadMentionCount > 0;
          return (
            <div key={row.chatId} style={{ borderBottom: "var(--hairline) solid var(--border-faint)" }}>
              <button
                type="button"
                onClick={() => onSelectChat(row.chatId)}
                className={cn("w-full text-left transition-colors grid items-center", "hover:bg-[var(--bg-hover)]")}
                style={{
                  gridTemplateColumns: "var(--sp-3) 1fr auto",
                  columnGap: 8,
                  padding: "var(--sp-2) var(--sp-2_5) var(--sp-2) var(--sp-3)",
                  background: isSelected ? "var(--bg-active)" : "transparent",
                  borderLeft: `var(--hairline-bold) solid ${isSelected ? "var(--accent)" : "transparent"}`,
                }}
              >
                <div className="flex items-center justify-center" style={{ width: "var(--sp-3)" }}>
                  {hasUnread ? (
                    <span
                      aria-label={`${row.unreadMentionCount} unread mentions`}
                      role="status"
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        background: "var(--state-error)",
                        display: "inline-block",
                      }}
                    />
                  ) : null}
                </div>
                <div className="min-w-0">
                  <div className="flex items-baseline" style={{ gap: 6 }}>
                    <span
                      className="truncate text-body"
                      style={{
                        color: "var(--fg)",
                        fontWeight: hasUnread ? 600 : 500,
                        flex: 1,
                        minWidth: 0,
                      }}
                    >
                      {row.title}
                    </span>
                    {row.lastMessageAt && (
                      <span className="mono text-caption shrink-0" style={{ color: "var(--fg-4)" }}>
                        {formatRowTime(row.lastMessageAt)}
                      </span>
                    )}
                  </div>
                  <div className="truncate text-body" style={{ color: "var(--fg-3)", marginTop: 1 }}>
                    {subtitle || "—"}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-0.5">
                  {row.membershipKind === "watching" && (
                    <span
                      className="mono uppercase text-eyebrow"
                      style={{
                        padding: "var(--hairline) var(--sp-1_25)",
                        borderRadius: 2,
                        color: "var(--fg-3)",
                        background: "var(--bg-sunken)",
                      }}
                    >
                      watching
                    </span>
                  )}
                </div>
              </button>
            </div>
          );
        })}
        {nextCursor && filteredRows.length > 0 && (
          <div style={{ padding: "var(--sp-2) var(--sp-3)" }}>
            <button
              type="button"
              onClick={handleLoadMore}
              disabled={loadingMore}
              className="w-full text-body mono"
              style={{
                padding: "var(--sp-1_25) var(--sp-2)",
                border: "var(--hairline) solid var(--border)",
                borderRadius: "var(--radius-input)",
                background: "var(--bg-sunken)",
                color: "var(--fg-2)",
                cursor: loadingMore ? "default" : "pointer",
                opacity: loadingMore ? 0.6 : 1,
              }}
            >
              {loadingMore ? "Loading…" : "Load more"}
            </button>
            {moreError && (
              <p className="mono text-caption" style={{ color: "var(--state-error)", marginTop: 4 }}>
                {moreError}
              </p>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
