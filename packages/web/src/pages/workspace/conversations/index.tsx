import { type ChatEngagementView, type ChatSource, type MeChatRow, RUNTIME_STALE_MS } from "@first-tree/shared";
import { useQuery } from "@tanstack/react-query";
import { Bell, ChevronDown, ChevronRight, Plus, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { listMeChats } from "../../../api/me-chats.js";
import { useAuth } from "../../../auth/auth-context.js";
import { ActivityDots } from "../../../components/chat/activity-dots.js";
import { ChatRowAvatar } from "../../../components/chat/chat-row-avatar.js";
import { SourceIcon } from "../../../components/chat/source-icon.js";
import { Popover } from "../../../components/ui/popover.js";
import { SegmentedControl } from "../../../components/ui/segmented-control.js";
import { useAgentNameMap } from "../../../lib/use-agent-name-map.js";
import { cn } from "../../../lib/utils.js";
import { FilterPopover, originLabel } from "./filter-popover.js";
import { type GroupMode, groupRows, rowIsFailed, rowNeedsYou, splitAttentionRows } from "./group-rows.js";
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
  { value: "source", label: "Source" },
  { value: "recency", label: "Recency" },
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
  origin,
  onOriginChange,
  participants,
  onParticipantsChange,
  onClearFilters,
  group,
  onGroupChange,
  width = 320,
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
  /** Override the default 20rem aside width. Used by `WorkspacePage`'s
   *  narrow-viewport overlay branch to cap to `min(88vw, 20rem)` so the
   *  inner aside doesn't overflow the wrapper on phones narrower than
   *  ~23rem logical (e.g. compact Android handsets). */
  width?: number | string;
  /**
   * Multi-select origin filter. Phase B's filter popover (forthcoming
   * in the next commit) will mount its checkbox group against this
   * pair; for now they thread through so the URL parser already has a
   * place to land its state.
   */
  origin: ReadonlyArray<ChatSource>;
  onOriginChange: (next: ReadonlyArray<ChatSource>) => void;
  /**
   * Multi-select participants filter. Same staging story as `origin`.
   */
  participants: ReadonlyArray<string>;
  onParticipantsChange: (next: ReadonlyArray<string>) => void;
  /**
   * Clears every filter dimension (`unread`, `watching`, `origin`,
   * `with`) in one URL write. Calling the per-flag setters in sequence
   * inside the Clear handler would race against React-router's stale
   * `searchParams` (see `nextParamsForClearFilters` in `workspace/index.tsx`).
   */
  onClearFilters: () => void;
  group: GroupMode;
  onGroupChange: (next: GroupMode) => void;
}) {
  const { agentId: selfAgentId } = useAuth();
  // Pages loaded via `Load more` carry a `fetchedAt` timestamp so the busy
  // dot can be aged out on those rows. The parent useQuery refetches every
  // 30s and re-discovers stale `runtime_state_at` for the first page, but
  // extraPages bypass react-query entirely — without this stamp, a row from
  // an older page whose agent crashed mid-turn would keep flashing busy
  // forever. The render path drops busyAgentIds on rows from pages older
  // than RUNTIME_STALE_MS (60s) plus one refetchInterval (30s) — total
  // worst-case stuck-busy window ~90s on these rows, vs ≤60s for the first
  // page that refetches directly. No UX disruption from the user's
  // loaded position.
  const [extraPages, setExtraPages] = useState<Array<{ fetchedAt: number; rows: MeChatRow[] }>>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  // Per-bucket collapse override. Absence in the map means "use the
  // bucket's defaultCollapsed". Session-scoped — not worth a URL slot
  // because it's purely a presentation preference and any reload that
  // changes the group basis (e.g. day rollover) invalidates the keys.
  const [bucketCollapse, setBucketCollapse] = useState<Map<string, boolean>>(() => new Map());

  // Phase B: `filter` carries only the unread axis. The `watching`
  // dimension travels as an independent boolean — `unread` and
  // `watching` can compose ("unread chats I'm watching"), which the
  // pre-Phase-B single-enum couldn't express. `origin` and `with` ride
  // through as multi-value filters; the wire serialises them as
  // comma-joined strings (see `me-chats.ts`).
  const filter: "all" | "unread" = unread ? "unread" : "all";
  const watchingParam = watching ? true : undefined;
  const originParam = origin.length > 0 ? [...origin] : undefined;
  const withParam = participants.length > 0 ? [...participants] : undefined;

  const { data, isLoading, dataUpdatedAt } = useQuery({
    // `origin` / `with` are arrays — react-query needs a stable key
    // signature, so we serialise them into the query key the same way
    // the wire does. Empty array collapses to `null` so an unchanged
    // "no filter" state doesn't churn the key.
    queryKey: [
      "me",
      "chats",
      filter,
      engagement,
      watchingParam ?? false,
      originParam ? originParam.join(",") : null,
      withParam ? withParam.join(",") : null,
    ] as const,
    queryFn: () =>
      listMeChats({
        filter,
        engagement,
        watching: watchingParam,
        origin: originParam,
        with: withParam,
      }),
    // Bounded refetch is the safety floor for the per-chat composite
    // signals projected onto each row: `busyAgentIds` lights the chat-list
    // dot for the working / codex-no-events case, and the only way the
    // dot self-heals after a client crash is for a fresh `listMeChats`
    // to discover `runtime_state_at` aged past `RUNTIME_STALE_MS` (60s)
    // — the server emits no notification when staleness is reached
    // passively. Without this interval the dot would stay lit forever
    // until some unrelated invalidation. 30s matches the
    // `chat-agent-status` query, so the first-page stuck-busy window is
    // bounded by RUNTIME_STALE_MS (60s) + one refetch (30s) ≈ 90s upper.
    refetchInterval: 30_000,
  });

  const resetExtras = (): void => {
    if (extraPages.length > 0) setExtraPages([]);
    setMoreError(null);
  };

  // Mirror in an effect so a URL-only change (browser back/forward, deep
  // link, parent-driven toggle) can't bleed previous-view rows into the
  // new list. Identity-only deps; the body doesn't read them.
  //
  // Phase B caveat: `origin` and `participants` are arrays — their object
  // identity changes on every render even when the contents are unchanged,
  // which would re-fire the effect every paint. We collapse each into a
  // stable string key (their canonical URL serialisation) so the effect
  // only fires on actual content changes. Without this dep the new
  // Phase B dimensions could `Load more` on Manual, then switch to PR
  // origin, and the stale Manual tail would still render — same bug as
  // Phase A's filter/engagement dependency was originally added to
  // prevent (see commentary in chat-projection-dispatcher).
  const originKey = origin.join(",");
  const participantsKey = participants.join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: these are triggers, not reads
  useEffect(() => {
    setExtraPages((prev) => (prev.length > 0 ? [] : prev));
    setMoreError(null);
  }, [filter, engagement, watching, originKey, participantsKey]);

  const baseRows = data?.rows ?? [];
  // Render-time staleness sieve for extraPages: any row whose page was
  // fetched > RUNTIME_STALE_MS (60s) ago has its `busyAgentIds` blanked.
  // The check tracks the server's fail-closed window but the recompute
  // cadence is bounded by react-query's refetchInterval (30s), so the
  // real upper bound is `RUNTIME_STALE_MS + refetchInterval` ≈ 90s on
  // extraPage rows specifically (vs ≤60s on the first page, which
  // refetches directly). `dataUpdatedAt` (set on every successful
  // refetch, even when content is structurally identical) is the time
  // anchor — `baseRows` identity can stay stable across refetches when
  // structural sharing kicks in, so depending on it alone would leave
  // a memo that never re-evaluates `Date.now()` and an old extraPage
  // row could keep flashing busy forever. Rationale: see the comment on
  // the `extraPages` declaration.
  // biome-ignore lint/correctness/useExhaustiveDependencies: dataUpdatedAt is the time-tick that drives stale recomputation; not a value read
  const allRows = useMemo(() => {
    const now = Date.now();
    const expanded: MeChatRow[] = [];
    for (const page of extraPages) {
      const stale = now - page.fetchedAt > RUNTIME_STALE_MS;
      for (const row of page.rows) {
        expanded.push(stale && row.busyAgentIds.length > 0 ? { ...row, busyAgentIds: [] } : row);
      }
    }
    return [...baseRows, ...expanded];
  }, [baseRows, extraPages, dataUpdatedAt]);

  // Buckets are recomputed whenever the rows or group mode change.
  // Day-rollover (a chat that was "Today" at 23:59 should drift into
  // "Yesterday" after midnight) is handled implicitly by the 15 s
  // `useQuery` refetch on the parent query — the refetched response
  // changes `data.rows`' identity, which invalidates this memo. A
  // user who leaves the rail open past midnight without a refetch
  // (e.g. an inactive tab the browser throttles) won't see the bucket
  // shift until the next refetch lands; that's an acceptable degree
  // of staleness for a presentational concern.
  // Hoist attention chats (failed + needs-you) into a pinned section at the top
  // WITHOUT touching cursor pagination or reordering the main list: partition
  // them out, group the rest as usual, then prepend a synthetic "Needs
  // attention" bucket (failed pinned above needs-you). A chat appears in
  // exactly one place (pinned OR its normal group), never both.
  const buckets = useMemo(() => {
    const { attention, rest } = splitAttentionRows(allRows);
    if (attention.length === 0) return groupRows(allRows, group);
    return [
      { key: "needs-attention", label: "Needs attention", rows: attention, defaultCollapsed: false },
      ...groupRows(rest, group),
    ];
  }, [allRows, group]);

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
      const next = await listMeChats({
        filter,
        engagement,
        watching: watchingParam,
        origin: originParam,
        with: withParam,
        cursor,
      });
      setExtraPages((prev) => [...prev, { fetchedAt: Date.now(), rows: next.rows }]);
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
    // The functional updater MUST derive the new value from `prev`, not
    // from the outer `bucketCollapse`. Under React 19 concurrent
    // rendering two toggles in the same tick could be batched, and the
    // second one would otherwise compute its `next` from the pre-batch
    // closure state and clobber the first.
    setBucketCollapse((prev) => {
      const current = prev.get(key) ?? defaultCollapsed;
      const next = new Map(prev);
      next.set(key, !current);
      return next;
    });
  };

  // Total active filter dimensions — drives the Filter button badge and
  // the chip-row visibility. Origin / participants count their list
  // length so a multi-select "PR + Issue" shows 2.
  const activeFilterCount = origin.length + participants.length + (unread ? 1 : 0) + (watching ? 1 : 0);
  const hasActiveFilter = activeFilterCount > 0;

  const resolveAgentName = useAgentNameMap();

  const removeOrigin = (src: ChatSource): void => {
    onOriginChange(origin.filter((s) => s !== src));
  };
  const removeParticipant = (id: string): void => {
    onParticipantsChange(participants.filter((p) => p !== id));
  };

  return (
    <aside
      className="shrink-0 flex flex-col overflow-hidden"
      style={{
        width,
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
              !isDraftActive && "hover:bg-[var(--bg-active)]",
            )}
            style={{
              // Slightly larger leading icon than the Unread bell, and
              // both icon + label rendered in `--primary`. The colour
              // delta (primary ink vs Unread's fg-3) is the only thing
              // lifting New chat above the toolbar's other ghost
              // actions — no border, no fill, no size bump.
              gap: "var(--sp-1)",
              padding: "var(--sp-0_5) var(--sp-1_5)",
              border: 0,
              borderRadius: 4,
              background: isDraftActive ? "var(--bg-active)" : "transparent",
              color: "var(--primary)",
            }}
            title="New chat"
          >
            <Plus size={15} strokeWidth={2} />
            <span>New chat</span>
          </button>

          {/* Unread toggle. The two filter entries (Unread + Filter) sit
              on the right of the toolbar opposite New chat so the row
              reads as "primary action ↔ filtering controls". */}
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

          <FilterPopover
            origin={origin}
            onOriginChange={onOriginChange}
            watching={watching}
            onWatchingChange={onWatchingChange}
            onResetAll={onClearFilters}
            activeCount={origin.length + participants.length + (watching ? 1 : 0)}
          />
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
            <div className="inline-flex items-center text-label" style={{ marginLeft: "auto", gap: 4 }}>
              <span style={{ color: "var(--fg-4)" }}>Group</span>
              {/* Custom dropdown built on the shared `Popover` primitive.
                  Phase A used a native `<select>` here; reviewers flagged
                  the OS-theme chrome (browser-rendered border + arrow) as
                  visually inconsistent with the rest of the de-chipped
                  toolbar. The headless replacement matches the ghost-button
                  language and keeps `<select>`-style listbox semantics via
                  `role="listbox" / role="option"`. */}
              <Popover
                align="end"
                panelStyle={{ minWidth: 140, padding: "var(--sp-0_5)" }}
                trigger={({ open, toggle }) => {
                  const current = GROUP_OPTIONS.find((o) => o.value === group);
                  return (
                    <button
                      type="button"
                      onClick={toggle}
                      aria-haspopup="listbox"
                      aria-expanded={open}
                      className="inline-flex items-center text-label cursor-pointer transition-colors hover:bg-[var(--bg-hover)]"
                      style={{
                        gap: 4,
                        padding: "var(--sp-0_5) var(--sp-1)",
                        border: 0,
                        borderRadius: 4,
                        background: open ? "var(--bg-active)" : "transparent",
                        color: "var(--fg-2)",
                      }}
                    >
                      <span>{current?.label ?? "Recency"}</span>
                      <ChevronDown size={12} strokeWidth={1.75} />
                    </button>
                  );
                }}
              >
                {({ close }) => (
                  <div role="listbox" aria-label="Group by" className="flex flex-col">
                    {GROUP_OPTIONS.map((opt) => {
                      const selected = opt.value === group;
                      return (
                        <button
                          key={opt.value}
                          type="button"
                          role="option"
                          aria-selected={selected}
                          onClick={() => {
                            if (!selected) onGroupChange(opt.value);
                            close();
                          }}
                          className="text-label cursor-pointer transition-colors hover:bg-[var(--bg-hover)] text-left"
                          style={{
                            padding: "var(--sp-0_75) var(--sp-1_5)",
                            border: 0,
                            borderRadius: 4,
                            background: selected ? "var(--bg-active)" : "transparent",
                            color: selected ? "var(--fg)" : "var(--fg-2)",
                            minWidth: 110,
                          }}
                        >
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                )}
              </Popover>
            </div>
          </div>

          {/* Filter chip row. Renders one chip per active filter
              dimension. Each chip's × removes only that dimension; the
              trailing "Clear" button strips every filter in a single
              URL write (see `nextParamsForClearFilters`). */}
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
              {origin.map((src) => (
                <FilterChip key={`origin-${src}`} label={originLabel(src)} onClear={() => removeOrigin(src)} />
              ))}
              {participants.map((agentId) => (
                <FilterChip
                  key={`with-${agentId}`}
                  label={`@${resolveAgentName(agentId)}`}
                  onClear={() => removeParticipant(agentId)}
                />
              ))}
              <button
                type="button"
                onClick={onClearFilters}
                className="text-label cursor-pointer"
                style={{
                  marginLeft: "auto",
                  background: "transparent",
                  border: 0,
                  padding: 0,
                  color: "var(--primary)",
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
                  const failed = rowIsFailed(row);
                  const needsYou = rowNeedsYou(row);
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
                          background: isSelected ? "var(--brand-bg)" : "transparent",
                          borderLeft: `var(--hairline-bold) solid ${
                            isSelected
                              ? "var(--brand)"
                              : failed
                                ? "var(--state-error)"
                                : needsYou
                                  ? "var(--state-needs-you)"
                                  : "transparent"
                          }`,
                        }}
                      >
                        <ChatRowAvatar
                          title={row.title}
                          type={row.type}
                          participants={row.participants}
                          selfAgentId={selfAgentId ?? ""}
                          unreadCount={row.unreadMentionCount}
                          needsYou={needsYou}
                          failed={failed}
                        />
                        <div className="flex flex-col" style={{ flex: 1, minWidth: 0 }}>
                          <div className="flex items-center" style={{ gap: 6 }}>
                            <SourceIcon source={row.source} entityType={row.entityType} emphasize={hasUnread} />
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
                              // `busyAgentIds` is the authoritative D-axis
                              // "is anyone working in this chat" signal — it
                              // lights the activity dots even when the
                              // runtime emits no intermediate
                              // `session_events` (codex tools that only
                              // report on turn completion), which the legacy
                              // `liveActivity` freshness proxy alone would
                              // miss.
                              const slot =
                                row.busyAgentIds.length > 0 ? (
                                  <ActivityDots />
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
