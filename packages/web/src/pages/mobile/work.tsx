import type { MeChatRow } from "@first-tree/shared";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Filter, Pin, Plus, Search, X } from "lucide-react";
import { type RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useAuth } from "../../auth/auth-context.js";
import { isAskAgentNavLocked } from "../../components/chat/ask-agent-nav-lock.js";
import { ChatRowAvatar } from "../../components/chat/chat-row-avatar.js";
import { DocPreviewDrawer } from "../../components/doc-preview-drawer.js";
import { Button } from "../../components/ui/button.js";
import { cn, formatRowTime } from "../../lib/utils.js";
import { CenterPanel } from "../workspace/center/index.js";
import { NeedYouEntry } from "../workspace/need-you/need-you-entry.js";
import { MobileChatActionsSheet } from "./chat-actions-sheet.js";
import { MobilePage, MobileSystemState, mobileCardStyle } from "./components.js";
import { mobileCardContent, mobileChatSignal, mobileRowsFromList, sortMobileChats } from "./data.js";
import { useLongPress } from "./use-long-press.js";
import { type MobileWorkFilters, MobileWorkFiltersSheet } from "./work-filters-sheet.js";
import { mobileWorkListQueryOptions, mobileWorkSourceCountsQueryOptions } from "./work-queries.js";

type MobileWorkQuickView = "all" | "unread" | "pinned";

const DEFAULT_FILTERS: MobileWorkFilters = {
  engagement: "active",
  watching: false,
};

const MOBILE_WORK_INITIAL_RENDER_COUNT = 16;
const MOBILE_WORK_RENDER_BATCH_SIZE = 16;

type ParkedListGeometry = { scrollTop: number; height: number };

export function MobileWorkPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [quickView, setQuickView] = useState<MobileWorkQuickView>("all");
  const [filters, setFilters] = useState<MobileWorkFilters>(DEFAULT_FILTERS);
  const selectedChatId = searchParams.get("c");
  const listScrollerRef = useRef<HTMLDivElement>(null);
  const parkedListRef = useRef<ParkedListGeometry | null>(null);

  const snapshotListScroll = useCallback(() => {
    if (parkedListRef.current) return;
    const scroller = listScrollerRef.current;
    if (!scroller) return;
    parkedListRef.current = { scrollTop: scroller.scrollTop, height: scroller.clientHeight };
  }, []);

  const selectChat = useCallback(
    (chatId: string) => {
      // Unmounts a pending Ask agent's owning surface — refuse while locked.
      if (isAskAgentNavLocked()) return;
      snapshotListScroll();
      const next = new URLSearchParams(searchParams);
      next.set("c", chatId);
      next.delete("review");
      next.delete("showAsk");
      next.delete("focus");
      next.delete("focusMsg");
      next.delete("nq");
      setSearchParams(next);
    },
    [searchParams, setSearchParams, snapshotListScroll],
  );

  const clearChat = useCallback(() => {
    // Unmounts a pending Ask agent's owning surface — refuse while locked.
    if (isAskAgentNavLocked()) return;
    const next = new URLSearchParams(searchParams);
    next.delete("c");
    next.delete("with");
    next.delete("showAsk");
    next.delete("focus");
    next.delete("focusMsg");
    next.delete("nq");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  // Need you entry: open the oldest open request's chat with the cross-chat
  // queue session (`?nq=1`) active; chat-view auto-advances to the next
  // question's chat on each resolution. Ordinary selection paths delete `nq`.
  const openNeedYouChat = useCallback(
    (chatId: string) => {
      if (isAskAgentNavLocked()) return;
      snapshotListScroll();
      const next = new URLSearchParams(searchParams);
      next.set("c", chatId);
      next.set("nq", "1");
      next.delete("review");
      next.delete("showAsk");
      next.delete("focus");
      next.delete("focusMsg");
      setSearchParams(next);
    },
    [searchParams, setSearchParams, snapshotListScroll],
  );

  const viewingChat = selectedChatId !== null;
  const parkedGeometry = viewingChat ? parkedListRef.current : null;

  useLayoutEffect(() => {
    if (viewingChat) return;
    const parked = parkedListRef.current;
    const scroller = listScrollerRef.current;
    if (!parked || !scroller) return;
    scroller.scrollTop = parked.scrollTop;
    parkedListRef.current = null;
  }, [viewingChat]);

  return (
    <>
      <div className="relative h-full min-h-0">
        {/* Keep the list mounted under detail so back restores the same
            scroll offset, rendered window, search, and filter chrome.
            Freeze the parked pane at list-mode height: hiding the shell tab
            bar grows `<main>`, and stretching the list with it would clamp
            a near-max scrollTop that does not come back with the tabs. */}
        <div
          className={cn("h-full min-h-0", viewingChat && "pointer-events-none invisible absolute top-0 right-0 left-0")}
          style={parkedGeometry ? { height: parkedGeometry.height } : undefined}
          aria-hidden={viewingChat}
          inert={viewingChat || undefined}
          data-mobile-work-list-pane={viewingChat ? "parked" : "active"}
        >
          <MobileWorkList
            scrollerRef={listScrollerRef}
            onSelectChat={selectChat}
            onParkList={snapshotListScroll}
            quickView={quickView}
            onQuickViewChange={setQuickView}
            filters={filters}
            onFiltersChange={setFilters}
            onOpenNeedYou={openNeedYouChat}
          />
        </div>
        {selectedChatId !== null ? (
          <div className="flex h-full min-h-0 overflow-hidden">
            <CenterPanel
              selectedChatId={selectedChatId}
              onSelectChat={selectChat}
              onClearChat={clearChat}
              narrow
              onShowConversations={clearChat}
              initialParticipantIds={parseParticipantList(searchParams)}
              presentation="mobile"
            />
          </div>
        ) : null}
      </div>
      <DocPreviewDrawer />
    </>
  );
}

function MobileWorkList({
  scrollerRef,
  onSelectChat,
  onParkList,
  quickView,
  onQuickViewChange,
  filters,
  onFiltersChange,
  onOpenNeedYou,
}: {
  scrollerRef: RefObject<HTMLDivElement | null>;
  onSelectChat: (chatId: string) => void;
  onParkList: () => void;
  quickView: MobileWorkQuickView;
  onQuickViewChange: (quickView: MobileWorkQuickView) => void;
  filters: MobileWorkFilters;
  onFiltersChange: (filters: MobileWorkFilters) => void;
  onOpenNeedYou: (chatId: string) => void;
}) {
  const { agentId, organizationId } = useAuth();
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [actionsRow, setActionsRow] = useState<MeChatRow | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [renderedRowCount, setRenderedRowCount] = useState(MOBILE_WORK_INITIAL_RENDER_COUNT);
  const renderSentinelRef = useRef<HTMLDivElement>(null);

  const queryScope = {
    organizationId: organizationId ?? null,
    engagement: filters.engagement,
    watching: filters.watching,
  };
  const allChatsQuery = useInfiniteQuery(mobileWorkListQueryOptions({ ...queryScope, filter: "all" }));
  const unreadChatsQuery = useInfiniteQuery({
    ...mobileWorkListQueryOptions({ ...queryScope, filter: "unread" }),
    enabled: quickView === "unread",
  });
  const sourceCountsQuery = useQuery(mobileWorkSourceCountsQueryOptions(queryScope));
  const chatsQuery = quickView === "unread" ? unreadChatsQuery : allChatsQuery;

  const allRows = useMemo(() => {
    const seen = new Set<string>();
    const rows: MeChatRow[] = [];
    for (const page of chatsQuery.data?.pages ?? []) {
      for (const row of mobileRowsFromList(page)) {
        if (seen.has(row.chatId)) continue;
        seen.add(row.chatId);
        rows.push(row);
      }
    }
    return sortMobileChats(rows);
  }, [chatsQuery.data?.pages]);

  const visibleRows = useMemo(() => {
    let rows = allRows;
    if (quickView === "pinned") rows = rows.filter((row) => row.pinnedAt !== null);
    else if (quickView === "unread") rows = rows.filter((row) => row.unreadMentionCount > 0);

    const needle = search.trim().toLocaleLowerCase();
    if (!needle) return rows;
    return rows.filter((row) =>
      [row.title, row.description, row.lastMessagePreview]
        .filter((value): value is string => typeof value === "string")
        .some((value) => value.toLocaleLowerCase().includes(needle)),
    );
  }, [allRows, quickView, search]);

  const orderedRows = visibleRows;

  const priorityRows = allChatsQuery.data?.pages[0]?.priorityRows;
  const pinnedCount = priorityRows?.pinned.length ?? 0;
  const unreadCount = Object.values(sourceCountsQuery.data?.counts ?? {}).reduce(
    (count, source) => count + source.unreadChatCount,
    0,
  );
  const narrowed = filters.engagement !== "active" || filters.watching;
  const renderedRows = orderedRows.slice(0, renderedRowCount);
  const hasBufferedRows = renderedRows.length < orderedRows.length;
  const mayLoadNextPage = (quickView === "all" || quickView === "unread") && chatsQuery.hasNextPage;

  useEffect(() => {
    const target = renderSentinelRef.current;
    if (!target || !hasBufferedRows) return;
    if (typeof IntersectionObserver === "undefined") {
      setRenderedRowCount(orderedRows.length);
      return;
    }

    // Bind one observer to one rendered batch. React can replace the unkeyed
    // sentinel when keyed cards are inserted ahead of it, so the rendered-row
    // dependency deliberately disconnects the old node and observes the
    // current sentinel after every append.
    const nextRenderedRowCount = Math.min(renderedRows.length + MOBILE_WORK_RENDER_BATCH_SIZE, orderedRows.length);
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setRenderedRowCount((count) => Math.max(count, nextRenderedRowCount));
      },
      { rootMargin: "50% 0%" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasBufferedRows, orderedRows.length, renderedRows.length]);

  const toggleQuickView = (next: Exclude<MobileWorkQuickView, "all">): void => {
    setRenderedRowCount(MOBILE_WORK_INITIAL_RENDER_COUNT);
    onQuickViewChange(quickView === next ? "all" : next);
  };

  return (
    <>
      <MobilePage className="flex flex-col" padded scrollerRef={scrollerRef}>
        <div className="flex items-center" style={{ gap: "var(--sp-2)", marginBottom: "var(--sp-3)" }}>
          <h1 className="text-mobile-title min-w-0 flex-1" style={{ color: "var(--fg)", margin: 0 }}>
            Chat
          </h1>
          <button
            type="button"
            aria-label={searchOpen ? "Close Chat search" : "Search Chat"}
            aria-expanded={searchOpen}
            onClick={() => {
              setSearchOpen((open) => !open);
              if (searchOpen) {
                setSearch("");
                setRenderedRowCount(MOBILE_WORK_INITIAL_RENDER_COUNT);
              }
            }}
            className="inline-flex h-11 w-11 items-center justify-center rounded-[var(--radius-full)] transition-colors hover:bg-[var(--bg-hover)]"
            style={{ border: 0, background: "transparent", color: "var(--fg)" }}
          >
            {searchOpen ? <X aria-hidden className="h-5 w-5" /> : <Search aria-hidden className="h-5 w-5" />}
          </button>
          <Link
            to="/m/chat?c=draft"
            aria-label="Start new chat"
            onClick={onParkList}
            className="inline-flex h-11 w-11 items-center justify-center rounded-[var(--radius-full)]"
            style={{ background: "var(--bg-active)", color: "var(--fg)", textDecoration: "none" }}
          >
            <Plus aria-hidden className="h-5 w-5" />
          </Link>
        </div>

        {searchOpen ? (
          <div style={{ marginBottom: "var(--sp-3)" }}>
            <input
              type="search"
              value={search}
              onChange={(event) => {
                setSearch(event.currentTarget.value);
                setRenderedRowCount(MOBILE_WORK_INITIAL_RENDER_COUNT);
              }}
              placeholder="Search chats"
              aria-label="Search chats"
              className="text-mobile-body h-11 w-full rounded-[var(--radius-input)] border bg-[var(--bg-raised)] px-3 outline-none focus:border-ring"
              style={{ borderColor: "var(--border)", color: "var(--fg)" }}
            />
          </div>
        ) : null}

        <NeedYouEntry variant="mobile" onOpen={onOpenNeedYou} />

        <div
          className="flex shrink-0 items-center"
          style={{ gap: "var(--sp-2)", marginBottom: "var(--sp-5)", paddingBottom: "var(--sp-0_5)" }}
          data-mobile-work-quick-views
        >
          <div className="flex min-w-0 flex-1 items-center overflow-x-auto" style={{ gap: "var(--sp-2)" }}>
            <QuickViewChip
              label="Unread"
              count={unreadCount}
              active={quickView === "unread"}
              onClick={() => toggleQuickView("unread")}
            />
            <QuickViewChip
              label="Pinned"
              count={pinnedCount}
              active={quickView === "pinned"}
              onClick={() => toggleQuickView("pinned")}
            />
          </div>
          <button
            type="button"
            aria-label="Filter Chat"
            aria-pressed={narrowed}
            onClick={() => setFiltersOpen(true)}
            className="relative inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--radius-input)] transition-colors hover:bg-[var(--bg-hover)]"
            style={{
              border: "var(--hairline) solid var(--border)",
              background: narrowed ? "var(--bg-active)" : "var(--bg-raised)",
              color: "var(--fg)",
            }}
          >
            <Filter aria-hidden className="h-4 w-4" />
            {narrowed ? (
              <span
                aria-hidden
                className="absolute"
                style={{
                  width: "var(--sp-1_5)",
                  height: "var(--sp-1_5)",
                  right: "var(--sp-1)",
                  top: "var(--sp-1)",
                  borderRadius: "var(--radius-full)",
                  background: "var(--state-needs-you)",
                }}
              />
            ) : null}
          </button>
        </div>

        {chatsQuery.isLoading && allRows.length === 0 ? (
          <MobileSystemState title="Loading chats" />
        ) : chatsQuery.isLoadingError ? (
          <MobileSystemState title="Failed to load chats" detail={formatError(chatsQuery.error)} tone="error" />
        ) : visibleRows.length === 0 ? (
          <MobileSystemState
            title={search.trim() ? "No matching chats" : emptyTitle(quickView, filters)}
            detail={search.trim() ? "Try another search." : "Change a quick view or filter to see more chats."}
          />
        ) : (
          <div
            className="flex flex-col"
            style={{ gap: "var(--sp-2)" }}
            data-mobile-work-list
            data-mobile-work-rendered={renderedRows.length}
            data-mobile-work-total={orderedRows.length}
          >
            {renderedRows.map((row) => (
              <MobileWorkRow
                key={row.chatId}
                row={row}
                selfAgentId={agentId ?? ""}
                onSelect={onSelectChat}
                onActions={setActionsRow}
              />
            ))}
            {hasBufferedRows ? (
              <div
                ref={renderSentinelRef}
                aria-hidden
                style={{ minHeight: "var(--sp-1)" }}
                data-mobile-work-render-sentinel
              />
            ) : null}
          </div>
        )}

        {mayLoadNextPage ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={chatsQuery.isFetchingNextPage}
            onClick={() => void chatsQuery.fetchNextPage()}
            style={{ marginTop: "var(--sp-4)", alignSelf: "center" }}
          >
            {chatsQuery.isFetchingNextPage ? "Loading…" : chatsQuery.isFetchNextPageError ? "Retry" : "Load more"}
          </Button>
        ) : null}
        {chatsQuery.isFetchNextPageError ? (
          <p role="alert" className="text-mobile-caption" style={{ color: "var(--state-error)", textAlign: "center" }}>
            More chats could not be loaded. Try again.
          </p>
        ) : null}
      </MobilePage>

      {actionsRow ? <MobileChatActionsSheet row={actionsRow} onClose={() => setActionsRow(null)} /> : null}
      {filtersOpen ? (
        <MobileWorkFiltersSheet
          value={filters}
          onChange={(next) => {
            setRenderedRowCount(MOBILE_WORK_INITIAL_RENDER_COUNT);
            onFiltersChange(next);
          }}
          onClose={() => setFiltersOpen(false)}
        />
      ) : null}
    </>
  );
}

function QuickViewChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className="text-mobile-body inline-flex h-11 shrink-0 items-center rounded-[var(--radius-input)] transition-colors hover:bg-[var(--bg-hover)]"
      style={{
        gap: "var(--sp-2)",
        padding: "0 var(--sp-3)",
        border: "var(--hairline) solid var(--border)",
        background: active ? "var(--bg-active)" : "var(--bg-raised)",
        color: "var(--fg)",
      }}
    >
      <span>{label}</span>
      <span className="mono text-mobile-caption" style={{ color: active ? "var(--fg)" : "var(--fg-3)" }}>
        {count > 99 ? "99+" : count}
      </span>
    </button>
  );
}

function MobileWorkRow({
  row,
  selfAgentId,
  onSelect,
  onActions,
}: {
  row: MeChatRow;
  selfAgentId: string;
  onSelect: (chatId: string) => void;
  onActions: (row: MeChatRow) => void;
}) {
  const content = mobileCardContent(row);
  const longPress = useLongPress(
    () => onActions(row),
    () => onSelect(row.chatId),
  );
  return (
    <button
      type="button"
      {...longPress}
      className="w-full text-left transition-colors hover:bg-[var(--bg-hover)]"
      style={{
        ...mobileCardStyle("list"),
        minHeight: "calc(var(--sp-20) + var(--sp-8))",
        ...longPress.style,
      }}
      data-mobile-card="work"
    >
      <div className="flex items-start" style={{ gap: "var(--sp-3)" }}>
        <ChatRowAvatar
          title={row.title}
          type={row.type}
          participants={row.participants}
          selfAgentId={selfAgentId}
          unreadCount={row.unreadMentionCount}
          failed={row.failedAgentIds.length > 0}
          needsYou={row.openRequestCount > 0}
          size={36}
          muted
          badge={false}
          statusDot
          imageLoading="lazy"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center" style={{ gap: "var(--sp-2)" }}>
            <span className="text-mobile-subtitle truncate" style={{ color: "var(--fg)", flex: 1 }}>
              {row.title}
            </span>
            {(row.activityAt ?? row.lastMessageAt) ? (
              <span className="mono text-mobile-caption shrink-0" style={{ color: "var(--fg-4)" }}>
                {formatRowTime(row.activityAt ?? row.lastMessageAt)}
              </span>
            ) : null}
            {row.pinnedAt ? (
              <Pin aria-label="Pinned" className="h-4 w-4 shrink-0" style={{ color: "var(--fg-3)" }} />
            ) : null}
          </div>
          <p
            className={cn("text-mobile-body", content.kind === "dynamic" && "truncate")}
            style={{
              color: "var(--fg-3)",
              margin: "var(--sp-2) 0 0",
              ...(content.kind === "dynamic"
                ? undefined
                : {
                    display: "-webkit-box",
                    WebkitLineClamp: 3,
                    WebkitBoxOrient: "vertical",
                    overflow: "hidden",
                  }),
            }}
            data-mobile-card-preview
            data-line-clamp={content.kind === "dynamic" ? 1 : 3}
          >
            {content.primary}
          </p>
          {content.secondary ? (
            <p
              className="text-mobile-caption truncate"
              style={{
                color: mobileChatSignal(row).tone === "working" ? "var(--fg-success-strong)" : "var(--fg-3)",
                margin: "var(--sp-1) 0 0",
              }}
              data-mobile-card-dynamic
            >
              {content.secondary}
            </p>
          ) : null}
        </div>
      </div>
    </button>
  );
}

function emptyTitle(quickView: MobileWorkQuickView, filters: MobileWorkFilters): string {
  if (quickView === "unread") return "No unread chats";
  if (quickView === "pinned") return "No pinned chats";
  if (filters.engagement === "archived") return "No archived chats";
  return "No active chats";
}

function parseParticipantList(params: URLSearchParams): string[] {
  const raw = params.get("with");
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of raw.split(",")) {
    const value = token.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
