import type { ChatEngagementView, MeChatRow } from "@agent-team-foundation/first-tree-hub-shared";
import { useQuery } from "@tanstack/react-query";
import { Bell, ChevronDown, ChevronRight, Plus, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { listMeChats } from "../../../api/me-chats.js";
import { useAuth } from "../../../auth/auth-context.js";
import { ChatRowAvatar } from "../../../components/chat/chat-row-avatar.js";
import { SourceIcon } from "../../../components/chat/source-icon.js";
import { WorkingChip } from "../../../components/chat/working-chip.js";
import { SegmentedControl } from "../../../components/ui/segmented-control.js";
import { cn } from "../../../lib/utils.js";
import { type GroupMode, groupRows } from "./group-rows.js";
import { RowEngagementMenu } from "./row-engagement-menu.js";

/**
 * Workspace left rail — conversation list. URL contract: the parent
 * page (`WorkspacePage`) owns every visible state — `?c=`, `?engagement=`,
 * `?unread=`, `?watching=`, `?group=` — and threads them down as
 * controlled props. The list itself owns only its in-memory pagination
 * tail and the per-bucket collapse overrides (which are session-only
 * preferences, not worth a URL slot).
 *
 * Phase A scope: the origin (`source`) filter has been removed from the
 * rail header pending the Phase B filter popover. The `source` URL
 * param is currently a no-op on the list — every origin is in scope.
 * See `docs/workspace-sidebar-filter-redesign-design.zh-CN.md`.
 */

export const DRAFT_CHAT_ID = "draft" as const;

const ENGAGEMENT_OPTIONS: ReadonlyArray<{ value: ChatEngagementView; label: string }> = [
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
  { value: "all", label: "All" },
];

const GROUP_OPTIONS: ReadonlyArray<{ value: GroupMode; label: string }> = [
  { value: "recency", label: "Recency" },
  { value: "source", label: "Source" },
  { value: "none", label: "None" },
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
  // ≥ 24h: render `MM/DD` only. Hour:minute is dropped — once a chat
  // slips out of "today", knowing the exact minute is rarely useful and
  // the extra " HH:mm" squeezes the title column for every older row.
  const parts = new Intl.DateTimeFormat("en-GB", {
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("month")}/${get("day")}`;
}

function buildSubtitle(row: MeChatRow): string {
  // Subtitle = the most informative second-line content. Priority:
  // preview > "Watching" marker for watcher rows. Empty string if
  // neither — caller renders an em-dash placeholder.
  if (row.membershipKind === "watching") {
    return row.lastMessagePreview ? `Watching · ${row.lastMessagePreview}` : "Watching";
  }
  return row.lastMessagePreview ?? "";
}

function parseGroupValue(raw: string): GroupMode {
  if (raw === "source" || raw === "none") return raw;
  return "recency";
}

export function ConversationList({
  selectedChatId,
  onSelectChat,
  onNewChat,
  engagement,
  onEngagementChange,
  unread,
  onUnreadChange,
  watching,
  onWatchingChange,
  onClearFilters,
  group,
  onGroupChange,
}: {
  selectedChatId: string | null;
  onSelectChat: (chatId: string) => void;
  onNewChat: () => void;
  engagement: ChatEngagementView;
  onEngagementChange: (view: ChatEngagementView) => void;
  unread: boolean;
  onUnreadChange: (next: boolean) => void;
  watching: boolean;
  onWatchingChange: (next: boolean) => void;
  /**
   * Clears every Phase A filter dimension (`unread`, `watching`) in one
   * URL write. Calling the per-flag setters in sequence inside the Clear
   * handler would race against React-router's stale `searchParams` (see
   * `nextParamsForClearFilters` in `workspace/index.tsx`).
   */
  onClearFilters: () => void;
  group: GroupMode;
  onGroupChange: (next: GroupMode) => void;
}) {
  const { agentId: selfAgentId } = useAuth();
  const [extraPages, setExtraPages] = useState<MeChatRow[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  // Per-bucket collapse override. Absence in the map means "use the
  // bucket's defaultCollapsed". Session-scoped — not worth a URL slot
  // because it's purely a presentation preference and any reload that
  // changes the group basis (e.g. day rollover) invalidates the keys.
  const [bucketCollapse, setBucketCollapse] = useState<Map<string, boolean>>(() => new Map());

  // Server still accepts a single `filter` enum. The URL splits unread /
  // watching into two toggles; collapse them back into the enum for the
  // wire. `setUnread`/`setWatching` in WorkspacePage enforce mutual
  // exclusivity, so the priority here just disambiguates the impossible
  // case if it ever showed up.
  const filter: "all" | "unread" | "watching" = unread ? "unread" : watching ? "watching" : "all";

  const { data, isLoading } = useQuery({
    queryKey: ["me", "chats", filter, engagement] as const,
    queryFn: () => listMeChats({ filter, engagement }),
    refetchInterval: 15_000,
  });

  const resetExtras = (): void => {
    if (extraPages.length > 0) setExtraPages([]);
    setMoreError(null);
  };

  // Mirror in an effect so a URL-only change (browser back/forward, deep
  // link, parent-driven toggle) can't bleed previous-view rows into the
  // new list. Identity-only deps; the body doesn't read them.
  // biome-ignore lint/correctness/useExhaustiveDependencies: filter/engagement are triggers, not reads
  useEffect(() => {
    setExtraPages((prev) => (prev.length > 0 ? [] : prev));
    setMoreError(null);
  }, [filter, engagement]);

  const baseRows = data?.rows ?? [];
  const allRows = useMemo(() => [...baseRows, ...extraPages], [baseRows, extraPages]);

  // Buckets are recomputed whenever the rows or group mode change.
  // Day-rollover (a chat that was "Today" at 23:59 should drift into
  // "Yesterday" after midnight) is handled implicitly by the 15 s
  // `useQuery` refetch on the parent query — the refetched response
  // changes `data.rows`' identity, which invalidates this memo. A
  // user who leaves the rail open past midnight without a refetch
  // (e.g. an inactive tab the browser throttles) won't see the bucket
  // shift until the next refetch lands; that's an acceptable degree
  // of staleness for a presentational concern.
  const buckets = useMemo(() => groupRows(allRows, group), [allRows, group]);

  // Track the cursor for follow-up page loads. Mirrored from the latest
  // base-query response: any background refetch resets `nextCursor` so the
  // "Load more" button reflects the freshest tail.
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const baseCursor = data?.nextCursor ?? null;
  useEffect(() => {
    setNextCursor(baseCursor);
  }, [baseCursor]);

  const handleLoadMore = async (): Promise<void> => {
    if (loadingMore) return;
    const cursor = nextCursor;
    if (!cursor) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const next = await listMeChats({ filter, engagement, cursor });
      setExtraPages((prev) => [...prev, ...next.rows]);
      setNextCursor(next.nextCursor);
    } catch (err) {
      setMoreError(err instanceof Error ? err.message : "Failed to load more");
    } finally {
      setLoadingMore(false);
    }
  };

  const totalUnread = useMemo(() => allRows.reduce((acc, r) => acc + (r.unreadMentionCount > 0 ? 1 : 0), 0), [allRows]);
  const isDraftActive = selectedChatId === DRAFT_CHAT_ID;

  // Auto-recover from the unread-filter dead-end: when the user reads
  // every unread chat, the visible list collapses to zero and there's
  // no signal to switch back. Flip the URL for them instead of leaving
  // an empty rail behind.
  useEffect(() => {
    if (unread && totalUnread === 0 && data && !isLoading) {
      onUnreadChange(false);
    }
  }, [unread, totalUnread, data, isLoading, onUnreadChange]);

  const isBucketCollapsed = (key: string, defaultCollapsed: boolean): boolean => {
    const override = bucketCollapse.get(key);
    return override === undefined ? defaultCollapsed : override;
  };

  const toggleBucket = (key: string, defaultCollapsed: boolean): void => {
    setBucketCollapse((prev) => {
      const next = new Map(prev);
      next.set(key, !isBucketCollapsed(key, defaultCollapsed));
      return next;
    });
  };

  const hasActiveFilter = unread || watching;

  return (
    <aside
      className="shrink-0 flex flex-col overflow-hidden"
      style={{
        width: 320,
        background: "var(--bg-raised)",
        borderRight: "var(--hairline) solid var(--border)",
      }}
    >
      {/* Header — uniform ghost-button toolbar.
          New chat / Unread / (Phase B: Filter) sit on row 1 as equal
          action peers; Scope + Group sit on row 2 as view-mode controls.
          All toolbar controls share the same ghost-button language (no
          static borders, mono only for digits) so the rail reads as a
          navigation strip rather than a chip matrix. */}
      <div className="shrink-0 flex flex-col" style={{ borderBottom: "var(--hairline) solid var(--border-faint)" }}>
        <div className="flex items-center" style={{ gap: "var(--sp-1)", padding: "var(--sp-2_5) var(--sp-3)" }}>
          <button
            type="button"
            onClick={onNewChat}
            aria-current={isDraftActive ? "page" : undefined}
            className={cn(
              "inline-flex items-center text-label font-medium cursor-pointer transition-colors",
              !isDraftActive && "hover:bg-[var(--accent-bg)]",
            )}
            style={{
              // Slightly larger leading icon than the Unread bell, and
              // both icon + label rendered in `--accent`. The colour
              // delta (accent vs Unread's fg-3) is the only thing
              // lifting New chat above the toolbar's other ghost
              // actions — no border, no fill, no size bump.
              gap: "var(--sp-1)",
              padding: "var(--sp-0_5) var(--sp-1_5)",
              border: 0,
              borderRadius: 4,
              background: isDraftActive ? "var(--accent-bg)" : "transparent",
              color: "var(--accent)",
            }}
            title="New chat"
          >
            <Plus size={15} strokeWidth={2} />
            <span>New chat</span>
          </button>

          {/* Unread toggle — right-aligned secondary action (next to Filter
              in Phase B). Sits opposite New chat so the row reads as
              "primary action ↔ filtering controls". */}
          <button
            type="button"
            onClick={() => onUnreadChange(!unread)}
            aria-pressed={unread}
            className={cn(
              "inline-flex items-center text-label cursor-pointer transition-colors",
              !unread && "hover:bg-[var(--bg-hover)]",
            )}
            style={{
              marginLeft: "auto",
              gap: "var(--sp-1)",
              padding: "var(--sp-0_5) var(--sp-1_5)",
              border: 0,
              borderRadius: 4,
              background: unread ? "var(--bg-active)" : "transparent",
              color: unread ? "var(--fg)" : "var(--fg-3)",
            }}
            title={unread ? "Show all chats" : "Filter to unread only"}
          >
            <Bell size={14} strokeWidth={1.75} />
            <span>Unread</span>
            {totalUnread > 0 && (
              <span className="mono" style={{ color: "var(--state-unread)" }}>
                {totalUnread}
              </span>
            )}
          </button>
        </div>

        <div
          className="flex flex-col"
          style={{
            gap: "var(--sp-2)",
            padding: "var(--sp-1) var(--sp-3) var(--sp-2_5)",
          }}
        >
          {/* Scope + Group by share one row. Both are "view mode" controls
            (which pool × how it's arranged), so co-locating them avoids
            implying that Group by is another filter dimension. Group by
            right-aligns via `marginLeft: auto`. */}
          <div className="flex items-center" style={{ gap: "var(--sp-2)" }}>
            <SegmentedControl
              options={ENGAGEMENT_OPTIONS}
              value={engagement}
              onChange={(v) => {
                if (engagement !== v) {
                  onEngagementChange(v);
                  resetExtras();
                }
              }}
            />
            <label
              className="inline-flex items-center text-label"
              style={{ marginLeft: "auto", gap: 4, color: "var(--fg-4)" }}
            >
              <span>Group</span>
              <select
                value={group}
                onChange={(e) => onGroupChange(parseGroupValue(e.target.value))}
                className="text-label cursor-pointer hover:bg-[var(--bg-hover)] transition-colors"
                style={{
                  padding: "var(--sp-0_5) var(--sp-1)",
                  border: 0,
                  borderRadius: 4,
                  background: "transparent",
                  color: "var(--fg-2)",
                }}
              >
                {GROUP_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {/* Filter chip row — only renders when at least one filter is
            active. Phase A only surfaces unread / watching here; Phase B
            will extend it with origin / participants chips. */}
          {hasActiveFilter && (
            <div className="flex items-center flex-wrap" style={{ gap: 4 }}>
              <span className="text-label" style={{ color: "var(--fg-4)" }}>
                Filters
              </span>
              {unread && (
                <FilterChip
                  label={`Unread${totalUnread > 0 ? ` ${totalUnread}` : ""}`}
                  onClear={() => onUnreadChange(false)}
                />
              )}
              {watching && <FilterChip label="Watching" onClear={() => onWatchingChange(false)} />}
              <button
                type="button"
                onClick={onClearFilters}
                className="text-label cursor-pointer"
                style={{
                  marginLeft: "auto",
                  background: "transparent",
                  border: 0,
                  padding: 0,
                  color: "var(--accent)",
                }}
              >
                Clear
              </button>
            </div>
          )}
        </div>
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
        {buckets.map((bucket) => {
          const hasHeader = bucket.label !== null;
          const collapsed = hasHeader && isBucketCollapsed(bucket.key, bucket.defaultCollapsed);
          return (
            <div key={bucket.key}>
              {hasHeader && (
                <button
                  type="button"
                  onClick={() => toggleBucket(bucket.key, bucket.defaultCollapsed)}
                  className="w-full inline-flex items-center text-eyebrow cursor-pointer hover:bg-[var(--bg-hover)] transition-colors"
                  aria-expanded={!collapsed}
                  style={{
                    gap: "var(--sp-1)",
                    padding: "var(--sp-1_25) var(--sp-3) var(--sp-0_5)",
                    background: "transparent",
                    border: 0,
                    color: "var(--fg-4)",
                    textTransform: "uppercase",
                  }}
                >
                  {collapsed ? <ChevronRight size={10} /> : <ChevronDown size={10} />}
                  <span>{bucket.label}</span>
                  <span className="mono font-normal" style={{ color: "var(--fg-4)" }}>
                    {bucket.rows.length}
                  </span>
                </button>
              )}
              {!collapsed &&
                bucket.rows.map((row) => {
                  const isSelected = selectedChatId === row.chatId;
                  const rawSubtitle = buildSubtitle(row);
                  // 1-message chats: title (auto-generated from first
                  // message) == subtitle (last-message preview). Suppress
                  // the duplicate; the em-dash placeholder picks up below.
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
                        className={cn(
                          "w-full text-left transition-colors flex items-center",
                          "hover:bg-[var(--bg-hover)]",
                        )}
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
                          <div className="flex items-center" style={{ gap: 6 }}>
                            <SourceIcon source={row.source} emphasize={hasUnread} />
                            <span
                              className="truncate text-subtitle"
                              style={{
                                // Always render the title at full `--fg`.
                                // Unread state keeps the stronger 700
                                // weight to stay visually distinguishable,
                                // but the read-state title is no longer
                                // dimmed via `--fg-2` — that was making
                                // every "already read" row look greyed out.
                                color: "var(--fg)",
                                fontWeight: hasUnread ? 700 : 600,
                                flex: 1,
                                minWidth: 0,
                              }}
                            >
                              {row.title}
                            </span>
                            {(() => {
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
                        <RowEngagementMenu chatId={row.chatId} status={row.engagementStatus} hasUnread={hasUnread} />
                      </div>
                    </div>
                  );
                })}
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

function FilterChip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <span
      className="inline-flex items-center text-label"
      style={{
        gap: 4,
        padding: "var(--sp-0_5) var(--sp-0_5) var(--sp-0_5) var(--sp-1_5)",
        borderRadius: 4,
        background: "var(--bg-sunken)",
        color: "var(--fg-2)",
      }}
    >
      <span>{label}</span>
      <button
        type="button"
        onClick={onClear}
        className="inline-flex items-center cursor-pointer"
        style={{
          border: 0,
          background: "transparent",
          padding: 2,
          color: "var(--fg-3)",
        }}
        aria-label={`Remove ${label} filter`}
      >
        <X size={12} strokeWidth={2} />
      </button>
    </span>
  );
}
