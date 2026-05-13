import type { ChatEngagementView, MeChatRow } from "@agent-team-foundation/first-tree-hub-shared";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { listMeChats } from "../../../api/me-chats.js";
import { useAuth } from "../../../auth/auth-context.js";
import { ChatRowAvatar } from "../../../components/chat/chat-row-avatar.js";
import { FilterPill } from "../../../components/ui/filter-pill.js";
import { cn } from "../../../lib/utils.js";
import { RowEngagementMenu } from "./row-engagement-menu.js";

/**
 * Workspace left rail — conversation list. Replaces `AgentRoster`.
 *
 * URL contract: the parent page owns the `?c=` and `?engagement=` params.
 * The list emits `onSelectChat(chatId)` for an existing conversation and
 * `onSelectChat(DRAFT_CHAT_ID)` for the inline new-chat draft.
 *
 * See docs/chat-first-workspace-product-design.md "Conversation List rules".
 */

export const DRAFT_CHAT_ID = "draft" as const;

type Filter = "all" | "unread" | "watching";

const ENGAGEMENT_TABS: ReadonlyArray<{ value: ChatEngagementView; label: string }> = [
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
  { value: "all", label: "All" },
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
  // Subtitle = the most informative second-line content. The title row
  // already shows participant names (when no topic), so duplicating them
  // here is wasted vertical space. Priority: preview > "Watching"
  // marker for watcher rows. Empty string if neither — caller renders
  // an em-dash placeholder.
  if (row.membershipKind === "watching") {
    return row.lastMessagePreview ? `Watching · ${row.lastMessagePreview}` : "Watching";
  }
  return row.lastMessagePreview ?? "";
}

export function ConversationList({
  selectedChatId,
  onSelectChat,
  onNewChat,
  engagement,
  onEngagementChange,
}: {
  selectedChatId: string | null;
  onSelectChat: (chatId: string) => void;
  onNewChat: () => void;
  engagement: ChatEngagementView;
  onEngagementChange: (view: ChatEngagementView) => void;
}) {
  const { agentId: selfAgentId } = useAuth();
  const [filter, setFilter] = useState<Filter>("all");
  const [extraPages, setExtraPages] = useState<MeChatRow[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["me", "chats", filter, engagement] as const,
    queryFn: () => listMeChats({ filter, engagement }),
    refetchInterval: 15_000,
  });

  // Reset paginated tail when filter / engagement change so we don't
  // bleed rows from a different view into the current one.
  const resetExtras = (): void => {
    if (extraPages.length > 0) setExtraPages([]);
    setMoreError(null);
  };

  const baseRows = data?.rows ?? [];
  const allRows = useMemo(() => [...baseRows, ...extraPages], [baseRows, extraPages]);

  const handleLoadMore = async (): Promise<void> => {
    if (loadingMore) return;
    const cursor = data?.nextCursor;
    if (!cursor) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const next = await listMeChats({ filter, engagement, cursor });
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

  return (
    <aside
      className="shrink-0 flex flex-col overflow-hidden"
      style={{
        width: 320,
        background: "var(--bg-raised)",
        borderRight: "var(--hairline) solid var(--border)",
      }}
    >
      {/* Header. Two stacked rows by semantic grouping:
          (1) creation action — `+ New chat`, gets a full-width hero
              button so its primacy is signaled by position and width.
          (2) engagement tabs + filter pills. Search lives in the
              unified topbar `Jump to…` palette, not here. Filter
              pills auto-hide when they have nothing to count. */}
      <div
        className="shrink-0 flex flex-col"
        style={{
          gap: 6,
          padding: "var(--sp-2_5) var(--sp-3) var(--sp-2)",
          borderBottom: "var(--hairline) solid var(--border-faint)",
        }}
      >
        <button
          type="button"
          onClick={onNewChat}
          className="w-full inline-flex items-center transition-colors text-body hover:bg-[var(--bg-hover)]"
          style={{
            gap: 6,
            padding: "var(--sp-1_25) var(--sp-2)",
            border: "var(--hairline) solid var(--border)",
            borderRadius: "var(--radius-input)",
            background: selectedChatId === DRAFT_CHAT_ID ? "var(--bg-active)" : "transparent",
            color: selectedChatId === DRAFT_CHAT_ID ? "var(--accent)" : "var(--fg)",
            cursor: "pointer",
            fontWeight: 500,
          }}
          title="New chat"
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={2} />
          New chat
        </button>
        {/* Engagement tabs: Active (default) / Archived / All. URL-backed in
            the parent via `?engagement=` so refresh & deep-links preserve the
            user's view. `deleted` is intentionally not a tab — restoring a
            deleted chat happens via the banner on the chat detail page. */}
        <div className="flex items-center" style={{ gap: 4 }}>
          {ENGAGEMENT_TABS.map((tab) => (
            <FilterPill
              key={tab.value}
              active={engagement === tab.value}
              onClick={() => {
                if (engagement !== tab.value) {
                  onEngagementChange(tab.value);
                  resetExtras();
                }
              }}
            >
              {tab.label}
            </FilterPill>
          ))}
        </div>
        {/* Filter pills. Only `unread` is exposed: `all` is the
            default state (no UI affordance needed) and `watching`
            is a niche power-user concept that's better surfaced
            implicitly through the row's `Watching · ...` subtitle.
            The unread pill itself only shows up when there's
            something to filter to — clicking the active pill
            toggles back to `all`. The whole row collapses when
            there's nothing to show. */}
        {totalUnread > 0 && (
          <div className="flex items-center gap-1 shrink-0">
            <FilterPill
              active={filter === "unread"}
              count={totalUnread}
              onClick={() => {
                setFilter(filter === "unread" ? "all" : "unread");
                resetExtras();
              }}
            >
              unread
            </FilterPill>
          </div>
        )}
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {isLoading && allRows.length === 0 && (
          <div className="text-center text-body" style={{ padding: "var(--sp-6) var(--sp-3)", color: "var(--fg-3)" }}>
            Loading…
          </div>
        )}
        {!isLoading && allRows.length === 0 && (
          <div className="text-center text-body" style={{ padding: "var(--sp-6) var(--sp-3)", color: "var(--fg-3)" }}>
            <p style={{ margin: 0 }}>No conversations yet.</p>
            <p className="text-label" style={{ margin: "var(--sp-1) 0 0", color: "var(--fg-4)" }}>
              Start with New chat.
            </p>
          </div>
        )}
        {allRows.map((row) => {
          const isSelected = selectedChatId === row.chatId;
          const rawSubtitle = buildSubtitle(row);
          // 1-message chats have `firstMessagePreview === lastMessagePreview`,
          // which makes the row's title (auto-titled from first message) and
          // subtitle (last message preview) identical. Suppress the subtitle
          // in that case — duplicating the same string twice on a row reads
          // as a bug. Falls back to the em-dash placeholder below.
          const subtitle = rawSubtitle && rawSubtitle !== row.title ? rawSubtitle : "";
          const hasUnread = row.unreadMentionCount > 0;
          return (
            <div
              key={row.chatId}
              className="group relative"
              style={{ borderBottom: "var(--hairline) solid var(--border-faint)" }}
            >
              <button
                type="button"
                onClick={() => onSelectChat(row.chatId)}
                className={cn("w-full text-left transition-colors flex items-center", "hover:bg-[var(--bg-hover)]")}
                style={{
                  padding: "var(--sp-2) var(--sp-3)",
                  gap: "var(--sp-2_5)",
                  background: isSelected ? "var(--bg-active)" : "transparent",
                  borderLeft: `var(--hairline-bold) solid ${isSelected ? "var(--accent)" : "transparent"}`,
                }}
              >
                <ChatRowAvatar
                  title={row.title}
                  type={row.type}
                  participants={row.participants}
                  selfAgentId={selfAgentId ?? ""}
                  workingAgentIds={row.workingAgentIds}
                  unreadCount={row.unreadMentionCount}
                />
                <div className="flex flex-col" style={{ flex: 1, minWidth: 0 }}>
                  <div className="flex items-baseline" style={{ gap: 6 }}>
                    <span
                      className="truncate text-subtitle"
                      style={{
                        color: hasUnread ? "var(--fg)" : "var(--fg-2)",
                        fontWeight: hasUnread ? 700 : 500,
                        flex: 1,
                        minWidth: 0,
                      }}
                    >
                      {row.title}
                    </span>
                    {row.lastMessageAt && (
                      // Time vacates its right-anchor slot so the ⋯ trigger can
                      // take over on hover or while the menu is open (Gmail-style swap).
                      <span
                        className="mono text-caption shrink-0 transition-opacity group-hover:opacity-0 group-has-aria-expanded:opacity-0"
                        style={{ color: "var(--fg-4)" }}
                      >
                        {formatRowTime(row.lastMessageAt)}
                      </span>
                    )}
                  </div>
                  <div
                    className="truncate text-body"
                    style={{
                      color: hasUnread ? "var(--fg-2)" : "var(--fg-3)",
                      marginTop: 2,
                    }}
                  >
                    {subtitle || "—"}
                  </div>
                </div>
              </button>
              <div
                className="absolute"
                style={{
                  top: "var(--sp-2)",
                  right: "var(--sp-3)",
                }}
              >
                <RowEngagementMenu chatId={row.chatId} status={row.engagementStatus} />
              </div>
            </div>
          );
        })}
        {nextCursor && allRows.length > 0 && (
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
