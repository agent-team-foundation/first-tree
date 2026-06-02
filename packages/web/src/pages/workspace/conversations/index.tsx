import { type ChatEngagementView, type ChatSource, type MeChatRow, RUNTIME_STALE_MS } from "@first-tree/shared";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Eye, ListTree, Plus, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { listMeChats } from "../../../api/me-chats.js";
import { useAuth } from "../../../auth/auth-context.js";
import { ActivityDots } from "../../../components/chat/activity-dots.js";
import { ChatRowAvatar } from "../../../components/chat/chat-row-avatar.js";
import { Popover } from "../../../components/ui/popover.js";
import { useAgentNameMap } from "../../../lib/use-agent-name-map.js";
import { cn } from "../../../lib/utils.js";
import { FilterPopover, GROUP_OPTIONS, originLabel } from "./filter-popover.js";
import { type GroupMode, groupRows, rowIsFailed, splitAttentionRows } from "./group-rows.js";
import { RowEngagementMenu } from "./row-engagement-menu.js";

/**
 * Workspace left rail — conversation list. URL contract: the parent
 * page (`WorkspacePage`) owns every visible state — `?c=`, `?engagement=`,
 * `?unread=`, `?watching=`, `?group=` — and threads them down as
 * controlled props. The list itself owns only its in-memory pagination
 * tail and the per-bucket collapse overrides (which are session-only
 * preferences, not worth a URL slot).
 *
 * Redesign (content-first / near-monochrome): the header is a single
 * row — New chat + the primary `All / Unread / Watching` triad + a `⚙`
 * popover that holds the lower-frequency Status / Source controls.
 * Rows carry exactly one signal per line: the title row + time, and a
 * second line that is *either* an attention state *or* the last-message
 * preview *or* (when there's neither) nothing at all. Colour appears only
 * on attention rows (left border + state line), the selected row (green),
 * and the unread dot — never as decoration. Avatars use the desaturated
 * hue companions so a dense rail stays quiet.
 */

export const DRAFT_CHAT_ID = "draft" as const;

/**
 * Primary engagement filter — the single-select triad in the header.
 * `all` = every active chat; `unread` = chats with unread mentions;
 * `watching` = chats the user only watches. Maps onto the independent
 * `?unread=` / `?watching=` URL flags via `onRailFilterChange` (one
 * atomic URL write — see `nextParamsForRailFilter` in `workspace/index.tsx`).
 */
export type RailFilter = "all" | "unread" | "watching";

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

export function ConversationList({
  selectedChatId,
  onSelectChat,
  onNewChat,
  engagement,
  onEngagementChange,
  unread,
  watching,
  onRailFilterChange,
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
  watching: boolean;
  /** Set the primary triad. Writes `?unread=` / `?watching=` atomically. */
  onRailFilterChange: (view: RailFilter) => void;
  /** Override the default 20rem aside width. Used by `WorkspacePage`'s
   *  narrow-viewport overlay branch to cap to `min(88vw, 20rem)` so the
   *  inner aside doesn't overflow the wrapper on phones narrower than
   *  ~23rem logical (e.g. compact Android handsets). */
  width?: number | string;
  /**
   * Multi-select origin filter, surfaced inside the `⚙` popover.
   */
  origin: ReadonlyArray<ChatSource>;
  onOriginChange: (next: ReadonlyArray<ChatSource>) => void;
  /**
   * Multi-select participants filter. The picker UI is a follow-up; the
   * wire + chip rendering are live so a hand-typed `?with=` narrows the
   * rail and shows removable chips.
   */
  participants: ReadonlyArray<string>;
  onParticipantsChange: (next: ReadonlyArray<string>) => void;
  /**
   * Clears the chip-row filter dimensions (`unread`, `watching`, `origin`,
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

  // The header triad is single-select. Derive one `railFilter` from the
  // (canonicalized) `unread` / `watching` props, then build the query
  // STRICTLY from it — so the applied filter always matches the highlighted
  // mode. Deriving `watchingParam` off the raw `watching` prop instead would
  // let a stale `?unread=1&watching=1` URL silently filter by both while the
  // triad only highlights Unread (parseUnreadWatching already canonicalizes,
  // but tying the query to railFilter keeps the component self-consistent).
  const railFilter: RailFilter = unread ? "unread" : watching ? "watching" : "all";
  const filter: "all" | "unread" = railFilter === "unread" ? "unread" : "all";
  const watchingParam = railFilter === "watching" ? true : undefined;
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

  // Mirror in an effect so a URL-only change (browser back/forward, deep
  // link, parent-driven toggle) can't bleed previous-view rows into the
  // new list. Identity-only deps; the body doesn't read them.
  //
  // `origin` and `participants` are arrays — their object identity changes
  // on every render even when the contents are unchanged, which would
  // re-fire the effect every paint. We collapse each into a stable string
  // key (their canonical URL serialisation) so the effect only fires on
  // actual content changes.
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
  // Hoist attention chats (failed + mention) into a pinned section at the top
  // WITHOUT touching cursor pagination or reordering the main list: partition
  // them out, group the rest as usual, then prepend a synthetic "Needs
  // attention" bucket (failed pinned above mention). A chat appears in
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
  // The chip row mirrors only origin + participants (the removable
  // multi-selects). Scope is surfaced by the popover badge, not a chip.
  const hasActiveChips = origin.length > 0 || participants.length > 0;
  const emptyCopy = (() => {
    if (railFilter === "unread") {
      return { title: "No unread conversations.", detail: "All caught up." };
    }
    if (railFilter === "watching") {
      return { title: "No watched conversations.", detail: "Switch to All to see active conversations." };
    }
    if (hasActiveChips || engagement !== "active") {
      return { title: "No matching conversations.", detail: "Clear filters to see more conversations." };
    }
    return { title: "No conversations yet.", detail: "Start with New chat." };
  })();

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

  // The `⚙` popover badge counts the *secondary* filters it hides from the
  // header: origin, participants, and a non-default scope. The primary
  // triad (unread / watching) lives in the header and is not counted here.
  const popoverFilterCount = origin.length + participants.length + (engagement !== "active" ? 1 : 0);

  const resolveAgentName = useAgentNameMap();

  const removeOrigin = (src: ChatSource): void => {
    onOriginChange(origin.filter((s) => s !== src));
  };
  const removeParticipant = (id: string): void => {
    onParticipantsChange(participants.filter((p) => p !== id));
  };

  const TRIAD: ReadonlyArray<{ value: RailFilter; label: string }> = [
    { value: "all", label: "All" },
    { value: "unread", label: "Unread" },
    { value: "watching", label: "Watching" },
  ];

  return (
    <aside
      className="shrink-0 flex flex-col overflow-hidden"
      style={{
        width,
        background: "var(--bg-raised)",
        borderRight: "var(--hairline) solid var(--border)",
      }}
    >
      {/* Header — a single ghost-button row: New chat (primary ink) on the
          left, the All / Unread / Watching triad pushed right, and the `⚙`
          popover (Scope / Origin / Group) at the far right. The optional
          chip row (active origin / participants) sits below. */}
      <div className="shrink-0 flex flex-col" style={{ borderBottom: "var(--hairline) solid var(--border-faint)" }}>
        {/* Row 1 — primary action (New chat) + filter entry (⚙). Kept on
            its own line so it never crowds against the filter triad. */}
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

          <span style={{ marginLeft: "auto" }} />

          <FilterPopover
            origin={origin}
            onOriginChange={onOriginChange}
            engagement={engagement}
            onEngagementChange={onEngagementChange}
            onResetAll={onClearFilters}
            activeCount={popoverFilterCount}
          />
        </div>

        {/* Row 2 — primary triad (All / Unread / Watching). Single-select; the
            active view gets the active-bg + full ink, the rest stay tertiary. */}
        <div className="flex items-center" style={{ padding: "0 var(--sp-3) var(--sp-2_5)" }}>
          <div className="inline-flex items-center" style={{ gap: 2 }}>
            {TRIAD.map((opt) => {
              const active = railFilter === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => onRailFilterChange(opt.value)}
                  aria-pressed={active}
                  className={cn(
                    "inline-flex items-center text-label cursor-pointer transition-colors",
                    !active && "hover:bg-[var(--bg-hover)]",
                  )}
                  style={{
                    gap: "var(--sp-1)",
                    padding: "var(--sp-0_5) var(--sp-1_5)",
                    border: 0,
                    borderRadius: 4,
                    background: active ? "var(--bg-active)" : "transparent",
                    color: active ? "var(--fg)" : "var(--fg-3)",
                  }}
                >
                  <span>{opt.label}</span>
                  {opt.value === "unread" && totalUnread > 0 && (
                    <span className="mono" style={{ color: "var(--state-unread)" }}>
                      {totalUnread}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          <div style={{ marginLeft: "auto" }}>
            <GroupDropdown group={group} onGroupChange={onGroupChange} />
          </div>
        </div>

        {/* Filter chip row — one chip per active origin / participant.
            Each chip's × removes only that dimension; the trailing "Clear"
            strips them in a single URL write. */}
        {hasActiveChips && (
          <div className="flex items-center flex-wrap" style={{ gap: 4, padding: "0 var(--sp-3) var(--sp-2_5)" }}>
            <span className="text-label" style={{ color: "var(--fg-4)" }}>
              Filters
            </span>
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

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {isLoading && allRows.length === 0 && (
          <div className="text-center text-body" style={{ padding: "var(--sp-6) var(--sp-3)", color: "var(--fg-3)" }}>
            Loading…
          </div>
        )}
        {!isLoading && allRows.length === 0 && (
          <div className="text-center text-body" style={{ padding: "var(--sp-6) var(--sp-3)", color: "var(--fg-3)" }}>
            <p style={{ margin: 0 }}>{emptyCopy.title}</p>
            <p className="text-label" style={{ margin: "var(--sp-1) 0 0", color: "var(--fg-4)" }}>
              {emptyCopy.detail}
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
                  const hasUnread = row.unreadMentionCount > 0;
                  const failed = rowIsFailed(row);
                  const isWatching = row.membershipKind === "watching";
                  // Density "C": single-line rows. Attention is carried by the
                  // avatar corner mark, while the left bar remains the selected
                  // affordance only.
                  return (
                    <div key={row.chatId} className="group relative">
                      <button
                        type="button"
                        onClick={() => onSelectChat(row.chatId)}
                        className={cn(
                          "w-full text-left transition-colors flex items-center",
                          "hover:bg-[var(--bg-hover)]",
                        )}
                        style={{
                          // Single-line rows tuned for desktop-inbox density:
                          // tightened vertical padding (--sp-2) now that the
                          // preview subtitle line is gone, so more conversations
                          // fit per screen without reading as a dense wall.
                          padding: "var(--sp-2) var(--sp-3)",
                          gap: "var(--sp-2)",
                          background: isSelected ? "var(--brand-bg)" : "transparent",
                          // Left bar is the SELECTED affordance only (DESIGN.md:
                          // selected = green left-rail + tint). Attention no longer
                          // doubles up here; it reads from the avatar corner mark.
                          borderLeft: `var(--hairline-bold) solid ${isSelected ? "var(--brand)" : "transparent"}`,
                        }}
                      >
                        <ChatRowAvatar
                          title={row.title}
                          type={row.type}
                          participants={row.participants}
                          selfAgentId={selfAgentId ?? ""}
                          unreadCount={row.unreadMentionCount}
                          failed={failed}
                          size={26}
                          muted
                          badge={false}
                          statusDot
                        />
                        <span
                          className="truncate text-subtitle"
                          style={{
                            color: hasUnread || isSelected ? "var(--fg)" : "var(--fg-2)",
                            fontWeight: hasUnread ? 700 : 500,
                            flex: 1,
                            minWidth: 0,
                          }}
                        >
                          {row.title}
                        </span>
                        {/* Right meta cluster — single line. Hidden on hover so
                            the row's engagement menu can take the corner. */}
                        <span
                          className="shrink-0 inline-flex items-center transition-opacity group-hover:opacity-0 group-has-aria-expanded:opacity-0"
                          style={{ gap: 6 }}
                        >
                          {isWatching && (
                            <Eye size={12} strokeWidth={1.75} style={{ color: "var(--fg-4)" }} aria-label="watching" />
                          )}
                          {row.busyAgentIds.length > 0 ? (
                            <ActivityDots />
                          ) : row.lastMessageAt ? (
                            <span className="mono text-caption" style={{ color: "var(--fg-4)" }}>
                              {formatRowTime(row.lastMessageAt)}
                            </span>
                          ) : null}
                        </span>
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

/**
 * Header Group-by dropdown on the filter row (`Time` / `Source`).
 * Group-by is a visible header control — more discoverable, and doubles as a
 * soft filter via grouping — so the `⚙` popover holds only Status + Source.
 * Headless `Popover` + listbox semantics, matching the rail's de-chipped
 * ghost language.
 */
function GroupDropdown({ group, onGroupChange }: { group: GroupMode; onGroupChange: (next: GroupMode) => void }) {
  const current = GROUP_OPTIONS.find((o) => o.value === group);
  return (
    <Popover
      align="end"
      panelStyle={{ minWidth: 140, padding: "var(--sp-0_5)" }}
      trigger={({ open, toggle }) => (
        <button
          type="button"
          onClick={toggle}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label="Group by"
          title="Group by"
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
          {/* Grouping-mode icon carries the "group by" affordance; the visible
              label stays compact (`Time` / `Source`) for the narrow rail. */}
          <ListTree size={13} strokeWidth={1.75} style={{ color: "var(--fg-4)" }} aria-hidden />
          <span>{current?.label ?? "Time"}</span>
          <ChevronDown size={12} strokeWidth={1.75} />
        </button>
      )}
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
