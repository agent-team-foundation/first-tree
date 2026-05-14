import type { ChatEngagementView, ChatSource, MeChatRow } from "@agent-team-foundation/first-tree-hub-shared";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { listMeChatSourceCounts, listMeChats } from "../../../api/me-chats.js";
import { useAuth } from "../../../auth/auth-context.js";
import { ChatRowAvatar } from "../../../components/chat/chat-row-avatar.js";
import { WorkingChip } from "../../../components/chat/working-chip.js";
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

/**
 * Source tag-bar order. `manual` is the default tab and always renders; the
 * GitHub / Feishu tags render only when the workspace has at least one chat
 * for that source (driven by `listMeChatSourceCounts`).
 */
const SOURCE_TABS: ReadonlyArray<{ value: ChatSource; label: string }> = [
  { value: "manual", label: "Manual" },
  { value: "github_pull_request", label: "PR" },
  { value: "github_issue", label: "Issue" },
  { value: "github_discussion", label: "Discussion" },
  { value: "github_commit", label: "Commit" },
  { value: "feishu", label: "Feishu" },
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
  source,
  onSourceChange,
}: {
  selectedChatId: string | null;
  onSelectChat: (chatId: string) => void;
  onNewChat: () => void;
  engagement: ChatEngagementView;
  onEngagementChange: (view: ChatEngagementView) => void;
  source: ChatSource;
  onSourceChange: (source: ChatSource) => void;
}) {
  const { agentId: selfAgentId } = useAuth();
  const [filter, setFilter] = useState<Filter>("all");
  const [extraPages, setExtraPages] = useState<MeChatRow[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["me", "chats", filter, engagement, source] as const,
    queryFn: () => listMeChats({ filter, engagement, source }),
    refetchInterval: 15_000,
  });

  // Per-source aggregate drives the tag bar. Lives on its own poll so the
  // list query stays cheap when the user is just clicking between tags —
  // tags only need to re-evaluate at the same cadence as the list itself.
  // The query key intentionally omits `filter` and `source`: the badge
  // semantics are workspace-wide ("how many chats of each source have unread
  // mentions"), not filtered by the user's current `unread`/`watching`
  // selection or the tab they're standing on.
  const { data: sourceCounts } = useQuery({
    queryKey: ["me", "chats", "source-counts", engagement] as const,
    queryFn: () => listMeChatSourceCounts({ engagement }),
    refetchInterval: 15_000,
  });

  // Reset paginated tail when filter / engagement / source change so we don't
  // bleed rows from a different view into the current one.
  const resetExtras = (): void => {
    if (extraPages.length > 0) setExtraPages([]);
    setMoreError(null);
  };

  // `resetExtras` covers in-component tab clicks, but both `source` and
  // `engagement` can also flip via the URL (browser back/forward, deep link,
  // parent-driven `setSource`/`setEngagement`). Mirror the reset in an
  // effect so a URL-only change can't bleed previous-tab rows into the new
  // list. The body doesn't read either value (only their identities drive
  // the effect), so we suppress biome's exhaustive-deps complaint here.
  // biome-ignore lint/correctness/useExhaustiveDependencies: source/engagement are triggers, not reads
  useEffect(() => {
    setExtraPages((prev) => (prev.length > 0 ? [] : prev));
    setMoreError(null);
  }, [source, engagement]);

  const baseRows = data?.rows ?? [];
  const allRows = useMemo(() => [...baseRows, ...extraPages], [baseRows, extraPages]);

  const handleLoadMore = async (): Promise<void> => {
    if (loadingMore) return;
    const cursor = data?.nextCursor;
    if (!cursor) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const next = await listMeChats({ filter, engagement, cursor, source });
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
  // The new-chat hero button is "active" when the inline draft is the current
  // selection. Centralized so the four conditional style branches stay in sync.
  const isDraftActive = selectedChatId === DRAFT_CHAT_ID;
  const isUnreadFilter = filter === "unread";

  // Auto-recover from the unread-filter dead-end: when the user finishes
  // reading every unread chat, `totalUnread` drops to 0 → the meta row (and
  // its toggle) collapses → there's no on-screen affordance to switch back
  // to `all`. Flip the filter for them instead of stranding an empty list.
  useEffect(() => {
    if (isUnreadFilter && totalUnread === 0) {
      setFilter("all");
    }
  }, [isUnreadFilter, totalUnread]);

  return (
    <aside
      className="shrink-0 flex flex-col overflow-hidden"
      style={{
        width: 320,
        background: "var(--bg-raised)",
        borderRight: "var(--hairline) solid var(--border)",
      }}
    >
      {/* Header. The hero block elevates `+ New chat` as the primary action via a
          radial accent gradient backdrop, an accent stripe on the button, and
          a soft-tinted plus square. Below it sit the existing source/engagement
          FilterPill rows. A condensed `mono` meta row at the bottom surfaces
          unread state when (and only when) there is something to surface. */}
      <div
        className="shrink-0 flex flex-col"
        style={{
          gap: "var(--sp-2)",
          padding: "var(--sp-2_5) var(--sp-3) var(--sp-2)",
          borderBottom: "var(--hairline) solid var(--border-faint)",
          background: "radial-gradient(140% 80% at 0% 0%, var(--accent-bg) 0%, transparent 60%)",
        }}
      >
        <button
          type="button"
          onClick={onNewChat}
          aria-current={isDraftActive ? "page" : undefined}
          className={cn(
            "group relative w-full inline-flex items-center transition-colors text-body cursor-pointer font-semibold",
            // Hover affordance only when not already on the draft — otherwise
            // `bg-hover` would wash out the active `accent-bg` tint.
            !isDraftActive && "hover:bg-[var(--bg-hover)] hover:border-[var(--border-strong)]",
            "focus-visible:outline-none focus-visible:border-[var(--accent-dim)]",
          )}
          style={{
            gap: "var(--sp-2)",
            padding: "var(--sp-1_75) var(--sp-2) var(--sp-1_75) var(--sp-2_5)",
            // Border is split into width/style/color rather than the `border:`
            // shorthand so the Tailwind `hover:border-[…]` / `focus-visible:
            // border-[…]` classes (specificity 10) can override just the color
            // — the shorthand would set all three sub-properties at inline-style
            // priority (1000) and silently block both interactions.
            borderWidth: "var(--hairline)",
            borderStyle: "solid",
            borderColor: isDraftActive ? "var(--accent-dim)" : "var(--border)",
            borderRadius: "var(--radius-panel)",
            background: isDraftActive ? "var(--accent-bg)" : "var(--bg-raised)",
            color: isDraftActive ? "var(--accent)" : "var(--fg)",
          }}
          title="New chat"
        >
          {/* Accent stripe — the visual anchor for the primary entry point.
              Sits a hair outside the border so it cleanly abuts the rounded edge.
              Width is a design parameter without a matching `--sp-*` token
              (`--hairline` / `--hairline-bold` are both too thin); the number
              literal sidesteps the px-token lint by design. */}
          <span
            aria-hidden
            className="absolute pointer-events-none"
            style={{
              left: -1,
              top: -1,
              bottom: -1,
              width: 3,
              background: "var(--accent)",
              borderRadius: "var(--radius-panel) 0 0 var(--radius-panel)",
            }}
          />
          {/* Plus square sized at a fixed touch-target dimension that the
              `--sp-*` scale does not provide; the number literals dodge the
              px-token lint by the same `Npx` grep loophole the stripe relies
              on. Consistent with the stripe comment above so the deviation
              reads as intentional. */}
          <span
            aria-hidden
            className="inline-flex items-center justify-center shrink-0 transition-colors group-hover:bg-[var(--accent)] group-hover:text-[var(--fg-on-vivid)]"
            style={{
              width: 20,
              height: 20,
              borderRadius: "var(--radius-chip)",
              background: isDraftActive ? "var(--accent)" : "var(--accent-bg)",
              color: isDraftActive ? "var(--fg-on-vivid)" : "var(--accent)",
            }}
          >
            <Plus className="h-3 w-3" strokeWidth={2} />
          </span>
          <span className="flex-1 text-left">New chat</span>
        </button>
        {/* Source tag bar. Splits the workspace by chat origin (Manual / PR /
            Issue / Discussion / Commit / Feishu). `manual` is always rendered
            as the default tab; the rest are hidden when the workspace has
            zero chats for that source so the rail doesn't fill up with empty
            tags. Each tag shows the source's aggregate unread mention count,
            mirroring the row-level unread badge. URL-backed via `?source=`. */}
        <div className="flex items-center flex-wrap" style={{ gap: 4 }}>
          {SOURCE_TABS.map((tab) => {
            const counts = sourceCounts?.counts[tab.value];
            // Manual is the default tab and always rendered; other tags only
            // surface when the workspace actually has chats for them.
            if (tab.value !== "manual" && (!counts || counts.chatCount === 0)) {
              return null;
            }
            const unread = counts?.unreadChatCount ?? 0;
            return (
              <FilterPill
                key={tab.value}
                active={source === tab.value}
                count={unread > 0 ? unread : undefined}
                warn={unread > 0}
                onClick={() => {
                  if (source !== tab.value) {
                    onSourceChange(tab.value);
                    resetExtras();
                  }
                }}
              >
                {tab.label}
              </FilterPill>
            );
          })}
        </div>
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
        {/* Meta row. Replaces the standalone `unread` FilterPill: surfaces
            the unread count (and toggles the unread filter on click) and the
            total chats in the current view. Entire row collapses when there
            is nothing to surface — `all` is the implicit default and needs no
            affordance, and `watching` is exposed via the row's subtitle. */}
        {totalUnread > 0 && (
          <div
            className="mono flex items-center justify-between text-caption"
            style={{
              padding: "0 var(--sp-0_5)",
              color: "var(--fg-4)",
            }}
          >
            <button
              type="button"
              onClick={() => {
                setFilter(isUnreadFilter ? "all" : "unread");
                resetExtras();
              }}
              aria-pressed={isUnreadFilter}
              className="mono cursor-pointer bg-transparent border-0 p-0 text-caption transition-opacity hover:opacity-80"
              style={{
                color: "var(--state-unread)",
                textDecoration: isUnreadFilter ? "underline" : "none",
                textUnderlineOffset: 2,
              }}
              title={isUnreadFilter ? "Show all chats" : "Filter to unread only"}
            >
              {totalUnread} unread
            </button>
            {/* Suppress the total-chats label when the unread filter is on —
                it would just echo `{totalUnread} unread` on the other side. */}
            {!isUnreadFilter && (
              <span>
                {allRows.length} {allRows.length === 1 ? "chat" : "chats"} · workspace
              </span>
            )}
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
                  engagedAgentIds={row.engagedAgentIds}
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
                    {(() => {
                      // Right-anchor slot vacates on hover so the ⋯ trigger can
                      // take over (Gmail-style swap). When the chat has a live
                      // activity (agent actively working on a turn), we render
                      // a pulsing WorkingChip in this slot; otherwise the
                      // static lastMessageAt timestamp. The chip is naturally
                      // self-clearing — server returns null once the latest
                      // session_event is `turn_end` or older than 60s.
                      const slot = row.liveActivity ? (
                        <WorkingChip activity={row.liveActivity} />
                      ) : row.lastMessageAt ? (
                        <span className="mono text-caption shrink-0" style={{ color: "var(--fg-4)" }}>
                          {formatRowTime(row.lastMessageAt)}
                        </span>
                      ) : null;
                      return slot ? (
                        <span className="shrink-0 transition-opacity group-hover:opacity-0 group-has-aria-expanded:opacity-0">
                          {slot}
                        </span>
                      ) : null;
                    })()}
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
