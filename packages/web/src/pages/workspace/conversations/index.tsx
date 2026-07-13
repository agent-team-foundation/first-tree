import type { ChatEngagementView, ChatSource, MeChatPriorityRows, MeChatRow } from "@first-tree/shared";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Eye, ListTree, Plus, X } from "lucide-react";
import { useMemo, useState } from "react";
import { listMeChats } from "../../../api/me-chats.js";
import { useAuth } from "../../../auth/auth-context.js";
import { ActivityDots } from "../../../components/chat/activity-dots.js";
import { ChatRowAvatar } from "../../../components/chat/chat-row-avatar.js";
import { Button } from "../../../components/ui/button.js";
import { Popover } from "../../../components/ui/popover.js";
import { useParticipantNames } from "../../../lib/participant-name-cache.js";
import { useAgentNameMap } from "../../../lib/use-agent-name-map.js";
import { cn, formatRowTime } from "../../../lib/utils.js";
import { FilterPopover, GROUP_OPTIONS, originLabel } from "./filter-popover.js";
import { type GroupBucket, type GroupMode, groupRows, rowActivityInstant, rowIsFailed } from "./group-rows.js";
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

// Stable identity for the "no priority groups" case so the derived memos below
// don't re-run every render on a fresh object literal.
const EMPTY_PRIORITY: MeChatPriorityRows = { attention: [], pinned: [] };

/**
 * Primary engagement filter — the single-select triad in the header.
 * `all` = every active chat; `unread` = chats with unread mentions;
 * `watching` = chats the user only watches. Maps onto the independent
 * `?unread=` / `?watching=` URL flags via `onRailFilterChange` (one
 * atomic URL write — see `nextParamsForRailFilter` in `workspace/index.tsx`).
 */
export type RailFilter = "all" | "unread" | "watching";

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

  const {
    data,
    dataUpdatedAt,
    isLoading,
    isLoadingError,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
  } = useInfiniteQuery({
    // `origin` / `with` are arrays — react-query needs a stable key
    // signature, so we serialise them into the query key the same way
    // the wire does. Empty array collapses to `null` so an unchanged
    // "no filter" state doesn't churn the key. A filter change swaps the
    // whole query (with its own page list) atomically — react-query
    // isolates cache entries by key, so a superseded response can never
    // bleed into the new filter's list.
    queryKey: [
      "me",
      "chats",
      filter,
      engagement,
      watchingParam ?? false,
      originParam ? originParam.join(",") : null,
      withParam ? withParam.join(",") : null,
    ] as const,
    queryFn: ({ pageParam, signal }) =>
      listMeChats(
        {
          filter,
          engagement,
          watching: watchingParam,
          origin: originParam,
          with: withParam,
          cursor: pageParam,
        },
        { signal },
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    // Bounded refetch is the safety floor for the per-chat composite
    // signals projected onto each row: `busyAgentIds` lights the chat-list
    // dot for the working / codex-no-events case, and the only way the
    // dot self-heals after a client crash is for a fresh `listMeChats` to
    // discover `runtime_state_at` aged past `RUNTIME_STALE_MS` (60s) — the
    // server emits no notification when staleness is reached passively. An
    // infinite query refetches every loaded page on each interval, so every
    // row (not just the first page) self-heals within `RUNTIME_STALE_MS` +
    // one refetch (~90s). 30s matches the `chat-agent-status` query.
    refetchInterval: 30_000,
  });

  // Flatten every loaded page into one list, de-duplicating by chatId. A
  // background refetch can pull a chat from a later page onto page 1 when it
  // gets fresh activity, briefly leaving the same chatId on two pages until
  // the tail refetches; keeping the first occurrence yields a duplicate-free
  // list and a stable React key. No per-page staleness sieve is needed — the
  // infinite query refetches every loaded page on `refetchInterval`, so each
  // row's `busyAgentIds` is refreshed on the same cadence.
  // The server supplies the whole-matching-set priority groups on the FIRST
  // page (attention + pinned); later pages carry them empty. `rows` is additive
  // — a priority chat is repeated in the ordinary stream — so we de-duplicate the
  // recency list against the priority ids and render each chat exactly once.
  const priorityRows = data?.pages[0]?.priorityRows ?? EMPTY_PRIORITY;
  const priorityIds = useMemo(
    () => new Set([...priorityRows.attention, ...priorityRows.pinned].map((r) => r.chatId)),
    [priorityRows],
  );

  // Flatten every loaded page into the ordinary recency list, de-duplicating by
  // chatId AND dropping any chat already shown in a priority group. A background
  // refetch can briefly leave a chatId on two pages until the tail refetches;
  // keeping the first occurrence yields a duplicate-free list and a stable key.
  const allRows = useMemo(() => {
    const seen = new Set<string>();
    const rows: MeChatRow[] = [];
    for (const page of data?.pages ?? []) {
      for (const chatRow of page.rows) {
        if (seen.has(chatRow.chatId) || priorityIds.has(chatRow.chatId)) continue;
        seen.add(chatRow.chatId);
        rows.push(chatRow);
      }
    }
    return rows;
  }, [data, priorityIds]);

  // Render order: Needs attention → Pinned → the recency groups. Attention and
  // Pinned come straight from the server projection (viewer-scoped failed / open
  // request, and the viewer's private pins — both extracted across the whole
  // MATCHING set, not just the loaded page), so a low-activity pin or a failure
  // deep in history still surfaces at the top. An empty group is omitted; a plain
  // unread mention still never pins. Row meta (`formatRowTime`) and the Today /
  // Yesterday buckets are clock-derived, so they must re-evaluate on the 30s
  // refetch cadence — TanStack Query structurally shares an identical successful
  // response, so `dataUpdatedAt` (a tracked field advancing on every successful
  // refetch) is the dep that both re-renders the clock-derived times and re-runs
  // this memo with a fresh `now`.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `dataUpdatedAt` is the successful-refetch time tick — it re-runs this memo with a fresh `now` (and re-renders the clock-derived row times) even when the payload is structurally identical.
  const buckets = useMemo<GroupBucket[]>(() => {
    const now = new Date();
    const groups: GroupBucket[] = [];
    if (priorityRows.attention.length > 0) {
      groups.push({
        key: "needs-attention",
        label: "Needs attention",
        rows: priorityRows.attention,
        defaultCollapsed: false,
      });
    }
    if (priorityRows.pinned.length > 0) {
      groups.push({ key: "pinned", label: "Pinned", rows: priorityRows.pinned, defaultCollapsed: false });
    }
    groups.push(...groupRows(allRows, group, now));
    return groups;
  }, [allRows, priorityRows, group, dataUpdatedAt]);

  // Whether ANY row renders — an ordinary recency row OR a server priority-group
  // row (Needs attention / Pinned). The empty / loading / load-more gates key off
  // THIS, not `allRows.length`: `rows` is additive and every priority chat is
  // de-duplicated OUT of `allRows`, so an all-priority list (a new user whose one
  // chat is pinned or has a failed agent) has `allRows.length === 0` while the
  // rail is NOT empty. Gating the empty state on `allRows.length` there would
  // paint "No conversations yet" directly above a populated Pinned /
  // Needs-attention group, and hide "Load more" when the whole first page is
  // priority rows but more ordinary chats wait on the next page. `.some(rows>0)`
  // (not `buckets.length`) because `groupRows([])` returns a single label-less
  // zero-row spacer bucket, so the bucket count is never 0.
  const hasAnyRow = buckets.some((b) => b.rows.length > 0);

  // Page-local unread count across every rendered chat (priority groups +
  // ordinary rows). The global server aggregate is deferred to a later PR.
  const totalUnread = useMemo(
    () =>
      [...priorityRows.attention, ...priorityRows.pinned, ...allRows].reduce(
        (acc, r) => acc + (r.unreadMentionCount > 0 ? 1 : 0),
        0,
      ),
    [priorityRows, allRows],
  );
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

  // The `⚙` popover badge counts the *secondary* filter DIMENSIONS it hides
  // from the header: Source (any narrowing), Participants (any selection), and a
  // non-default Status. It counts dimensions, NOT selected values, so it stays
  // monotonic — narrowing Source from three sources to one must not make the
  // badge fall from 3 to 1, and an all-sources selection normalizes to the
  // unrestricted wire so it correctly reads 0. The primary triad (unread /
  // watching) lives in the header and is not counted here.
  const popoverFilterCount =
    (origin.length > 0 ? 1 : 0) + (participants.length > 0 ? 1 : 0) + (engagement !== "active" ? 1 : 0);

  const resolveAgentName = useAgentNameMap();
  // Names learned from participant search cover identities past the 100-row
  // identity-map cap. The authoritative map wins (a rename refreshes it); the
  // search-fed cache only fills the gap for ids it still can't resolve.
  const cachedName = useParticipantNames();
  const participantChipName = (id: string): string => {
    const authoritative = resolveAgentName(id);
    return authoritative !== id ? authoritative : (cachedName(id) ?? id);
  };

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
      {/* Header — New chat (brand-green CTA) on the left, the All / Unread /
          Watching triad pushed right, and the `⚙` popover (Scope / Origin /
          Group) at the far right. The optional chip row (active origin /
          participants) sits below.

          New chat uses the brand-green `cta` Button variant: per DESIGN.md
          ("Neutral primary, green hero"), the CTA hue is reserved for the
          one creation moment per surface — and starting a new conversation
          is exactly that for the workspace surface. Sized `xs` (h-7, chip
          radius) so the colour does the prominence work without the chip
          itself eating vertical rhythm — keeps it close to the height of
          the neighbouring `⚙` filter trigger and avoids dominating a
          dense rail. Label is bumped one tier from xs's default
          `text-label` to `text-body` so the CTA reads decisively even at
          the compact height. */}
      <div className="shrink-0 flex flex-col" style={{ borderBottom: "var(--hairline) solid var(--border-faint)" }}>
        {/* Row 1 — primary action (New chat) + filter entry (⚙). Kept on
            its own line so it never crowds against the filter triad. */}
        <div className="flex items-center" style={{ gap: "var(--sp-1)", padding: "var(--sp-2_5) var(--sp-3)" }}>
          <Button
            type="button"
            variant="cta"
            size="xs"
            className="text-body"
            onClick={onNewChat}
            aria-current={isDraftActive ? "page" : undefined}
            title="New chat"
          >
            <Plus size={14} strokeWidth={2} />
            <span>New chat</span>
          </Button>

          <span style={{ marginLeft: "auto" }} />

          <FilterPopover
            origin={origin}
            onOriginChange={onOriginChange}
            engagement={engagement}
            onEngagementChange={onEngagementChange}
            participants={participants}
            onParticipantsChange={onParticipantsChange}
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
                label={`@${participantChipName(agentId)}`}
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
        {isLoading && !hasAnyRow && (
          <div className="text-center text-body" style={{ padding: "var(--sp-6) var(--sp-3)", color: "var(--fg-3)" }}>
            Loading…
          </div>
        )}
        {/* A failed FIRST load (error with no data) surfaces an error + retry,
            never falling through to the "No conversations yet" empty state.
            `isLoadingError` (not `isError`) is deliberate: a failed background
            refetch keeps the prior data, so gating on `isError` would flip a
            legitimately-empty list into an error on a transient 30s-refetch blip. */}
        {isLoadingError && !hasAnyRow && (
          <div className="text-center text-body" style={{ padding: "var(--sp-6) var(--sp-3)", color: "var(--fg-3)" }}>
            <p style={{ margin: 0 }}>{"Couldn't load conversations."}</p>
            <button
              type="button"
              onClick={() => refetch()}
              className="text-label cursor-pointer hover:bg-[var(--bg-hover)] transition-colors"
              style={{
                marginTop: "var(--sp-2)",
                padding: "var(--sp-0_5) var(--sp-2)",
                border: "var(--hairline) solid var(--border)",
                borderRadius: "var(--radius-input)",
                background: "var(--bg-sunken)",
                color: "var(--fg-2)",
              }}
            >
              Retry
            </button>
          </div>
        )}
        {!isLoading && !isLoadingError && !hasAnyRow && (
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
                  // Show the "recent activity" instant (activityAt — includes a
                  // genuine description change), the same key the row is grouped
                  // and server-sorted by, so a Today-activity chat never displays
                  // a stale message age. Falls back to lastMessageAt for skew.
                  const rowTime = rowActivityInstant(row);
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
                          needsYou={row.openRequestCount > 0}
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
                          ) : rowTime ? (
                            <span className="mono text-caption" style={{ color: "var(--fg-4)" }}>
                              {formatRowTime(rowTime)}
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
                        <RowEngagementMenu
                          chatId={row.chatId}
                          status={row.engagementStatus}
                          hasUnread={hasUnread}
                          pinned={row.pinnedAt !== null}
                        />
                      </div>
                    </div>
                  );
                })}
            </div>
          );
        })}
        {hasNextPage && hasAnyRow && (
          <div style={{ padding: "var(--sp-2) var(--sp-3)" }}>
            <button
              type="button"
              onClick={() => fetchNextPage()}
              disabled={isFetchingNextPage}
              className="w-full text-body mono"
              style={{
                padding: "var(--sp-1_25) var(--sp-2)",
                border: "var(--hairline) solid var(--border)",
                borderRadius: "var(--radius-input)",
                background: "var(--bg-sunken)",
                color: "var(--fg-2)",
                cursor: isFetchingNextPage ? "default" : "pointer",
                opacity: isFetchingNextPage ? 0.6 : 1,
              }}
            >
              {isFetchingNextPage ? "Loading…" : "Load more"}
            </button>
            {isFetchNextPageError && (
              <p className="mono text-caption" style={{ color: "var(--state-error)", marginTop: 4 }}>
                {"Couldn't load more. "}
                <button
                  type="button"
                  onClick={() => fetchNextPage()}
                  className="cursor-pointer"
                  style={{ border: 0, background: "transparent", padding: 0, color: "var(--primary)" }}
                >
                  Retry
                </button>
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
