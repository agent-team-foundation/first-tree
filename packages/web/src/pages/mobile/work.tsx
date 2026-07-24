import type { MeChatRow } from "@first-tree/shared";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { AlertCircle, ArrowRight, CircleHelp, Filter, Pin, Plus, Search, X } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useAuth } from "../../auth/auth-context.js";
import { ChatRowAvatar } from "../../components/chat/chat-row-avatar.js";
import { DocPreviewDrawer } from "../../components/doc-preview-drawer.js";
import { Button } from "../../components/ui/button.js";
import { cn, formatRowTime } from "../../lib/utils.js";
import { CenterPanel } from "../workspace/center/index.js";
import { MobileAskSheet } from "./ask-sheet.js";
import { MobileChatActionsSheet } from "./chat-actions-sheet.js";
import { MobilePage, MobileSystemState, mobileCardStyle } from "./components.js";
import { formatMobileAge, mobileCardContent, mobileChatSignal, mobileRowsFromList, sortMobileChats } from "./data.js";
import { longPressSurfaceStyle, useLongPress } from "./use-long-press.js";
import { type MobileWorkFilters, MobileWorkFiltersSheet } from "./work-filters-sheet.js";
import { mobileWorkListQueryOptions, mobileWorkSourceCountsQueryOptions } from "./work-queries.js";

type MobileWorkQuickView = "all" | "attention" | "unread" | "pinned";

const DEFAULT_FILTERS: MobileWorkFilters = {
  engagement: "active",
  watching: false,
};

export function MobileWorkPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedChatId = searchParams.get("c");

  const selectChat = useCallback(
    (chatId: string) => {
      const next = new URLSearchParams(searchParams);
      next.set("c", chatId);
      setSearchParams(next);
    },
    [searchParams, setSearchParams],
  );

  const clearChat = useCallback(() => {
    const next = new URLSearchParams(searchParams);
    next.delete("c");
    next.delete("with");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  return (
    <>
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
      ) : (
        <MobileWorkList onSelectChat={selectChat} />
      )}
      <DocPreviewDrawer />
    </>
  );
}

function MobileWorkList({ onSelectChat }: { onSelectChat: (chatId: string) => void }) {
  const { agentId, organizationId } = useAuth();
  const [quickView, setQuickView] = useState<MobileWorkQuickView>("all");
  const [filters, setFilters] = useState<MobileWorkFilters>(DEFAULT_FILTERS);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [answeringChatId, setAnsweringChatId] = useState<string | null>(null);
  const [actionsRow, setActionsRow] = useState<MeChatRow | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);

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
    if (quickView === "attention") rows = rows.filter((row) => mobileChatSignal(row).attention);
    else if (quickView === "pinned") rows = rows.filter((row) => row.pinnedAt !== null);
    else if (quickView === "unread") rows = rows.filter((row) => row.unreadMentionCount > 0);

    const needle = search.trim().toLocaleLowerCase();
    if (!needle) return rows;
    return rows.filter((row) =>
      [row.title, row.description, row.lastMessagePreview]
        .filter((value): value is string => typeof value === "string")
        .some((value) => value.toLocaleLowerCase().includes(needle)),
    );
  }, [allRows, quickView, search]);

  const orderedRows = useMemo(() => {
    const attention: MeChatRow[] = [];
    const pinned: MeChatRow[] = [];
    const recent: MeChatRow[] = [];
    for (const row of visibleRows) {
      if (mobileChatSignal(row).attention) attention.push(row);
      else if (row.pinnedAt !== null) pinned.push(row);
      else recent.push(row);
    }
    return [...attention, ...pinned, ...recent];
  }, [visibleRows]);

  const priorityRows = allChatsQuery.data?.pages[0]?.priorityRows;
  const attentionCount = priorityRows?.attention.length ?? 0;
  const pinnedCount = new Set(
    [...(priorityRows?.attention ?? []), ...(priorityRows?.pinned ?? [])]
      .filter((row) => row.pinnedAt !== null)
      .map((row) => row.chatId),
  ).size;
  const unreadCount = Object.values(sourceCountsQuery.data?.counts ?? {}).reduce(
    (count, source) => count + source.unreadChatCount,
    0,
  );
  const narrowed = filters.engagement !== "active" || filters.watching;

  const toggleQuickView = (next: Exclude<MobileWorkQuickView, "all">): void => {
    setQuickView((current) => (current === next ? "all" : next));
  };

  return (
    <>
      <MobilePage className="flex flex-col" padded>
        <div className="flex items-center" style={{ gap: "var(--sp-2)", marginBottom: "var(--sp-3)" }}>
          <h1 className="text-mobile-title min-w-0 flex-1" style={{ color: "var(--fg)", margin: 0 }}>
            Work
          </h1>
          <button
            type="button"
            aria-label={searchOpen ? "Close Work search" : "Search Work"}
            aria-expanded={searchOpen}
            onClick={() => {
              setSearchOpen((open) => !open);
              if (searchOpen) setSearch("");
            }}
            className="inline-flex h-11 w-11 items-center justify-center rounded-[var(--radius-full)] transition-colors hover:bg-[var(--bg-hover)]"
            style={{ border: 0, background: "transparent", color: "var(--fg)" }}
          >
            {searchOpen ? <X aria-hidden className="h-5 w-5" /> : <Search aria-hidden className="h-5 w-5" />}
          </button>
          <Link
            to="/m/work?c=draft"
            aria-label="Start new work"
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
              onChange={(event) => setSearch(event.currentTarget.value)}
              placeholder="Search work"
              aria-label="Search work"
              className="text-mobile-body h-11 w-full rounded-[var(--radius-input)] border bg-[var(--bg-raised)] px-3 outline-none focus:border-ring"
              style={{ borderColor: "var(--border)", color: "var(--fg)" }}
            />
          </div>
        ) : null}

        <div
          className="flex shrink-0 items-center"
          style={{ gap: "var(--sp-2)", marginBottom: "var(--sp-5)", paddingBottom: "var(--sp-0_5)" }}
          data-mobile-work-quick-views
        >
          <div className="flex min-w-0 flex-1 items-center overflow-x-auto" style={{ gap: "var(--sp-2)" }}>
            <QuickViewChip
              label="Need you"
              count={attentionCount}
              active={quickView === "attention"}
              onClick={() => toggleQuickView("attention")}
            />
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
            aria-label="Filter Work"
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
          <MobileSystemState title="Loading work" />
        ) : chatsQuery.isLoadingError ? (
          <MobileSystemState title="Failed to load work" detail={formatError(chatsQuery.error)} tone="error" />
        ) : visibleRows.length === 0 ? (
          <MobileSystemState
            title={search.trim() ? "No matching work" : emptyTitle(quickView, filters)}
            detail={search.trim() ? "Try another search." : "Change a quick view or filter to see more work."}
          />
        ) : (
          <div className="flex flex-col" style={{ gap: "var(--sp-2)" }} data-mobile-work-list>
            {orderedRows.map((row) =>
              mobileChatSignal(row).attention ? (
                <MobileActionCard
                  key={row.chatId}
                  row={row}
                  onSelect={onSelectChat}
                  onAnswer={setAnsweringChatId}
                  onActions={setActionsRow}
                />
              ) : (
                <MobileWorkRow
                  key={row.chatId}
                  row={row}
                  selfAgentId={agentId ?? ""}
                  onSelect={onSelectChat}
                  onActions={setActionsRow}
                />
              ),
            )}
          </div>
        )}

        {(quickView === "all" || quickView === "unread") && chatsQuery.hasNextPage ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={chatsQuery.isFetchingNextPage}
            onClick={() => void chatsQuery.fetchNextPage()}
            style={{ marginTop: "var(--sp-4)", alignSelf: "center" }}
          >
            {chatsQuery.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        ) : null}
        {chatsQuery.isFetchNextPageError ? (
          <p role="alert" className="text-mobile-caption" style={{ color: "var(--state-error)", textAlign: "center" }}>
            More work could not be loaded. Try again.
          </p>
        ) : null}
      </MobilePage>

      {answeringChatId ? <MobileAskSheet chatId={answeringChatId} onClose={() => setAnsweringChatId(null)} /> : null}
      {actionsRow ? <MobileChatActionsSheet row={actionsRow} onClose={() => setActionsRow(null)} /> : null}
      {filtersOpen ? (
        <MobileWorkFiltersSheet value={filters} onChange={setFilters} onClose={() => setFiltersOpen(false)} />
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

function MobileActionCard({
  row,
  onSelect,
  onAnswer,
  onActions,
}: {
  row: MeChatRow;
  onSelect: (chatId: string) => void;
  onAnswer: (chatId: string) => void;
  onActions: (row: MeChatRow) => void;
}) {
  const signal = mobileChatSignal(row);
  const content = mobileCardContent(row);
  const actionLabel = signal.tone === "needs-you" ? "Answer" : "Review";
  const longPress = useLongPress(
    () => onActions(row),
    () => onSelect(row.chatId),
  );

  return (
    <article
      style={{
        ...mobileCardStyle("priorityFeed"),
        ...longPressSurfaceStyle,
        position: "relative",
      }}
      data-mobile-card="action"
    >
      <button
        type="button"
        aria-label={`Open ${row.title}`}
        {...longPress}
        className="absolute inset-0 cursor-pointer border-0 bg-transparent"
        style={{ zIndex: 0, ...longPress.style }}
      />
      <div className="relative flex h-full flex-col" style={{ gap: "var(--sp-2)", zIndex: 1, pointerEvents: "none" }}>
        <div className="flex items-center" style={{ gap: "var(--sp-2)" }}>
          {signal.tone === "error" ? (
            <AlertCircle aria-hidden className="h-4 w-4" style={{ color: "var(--state-error)" }} />
          ) : (
            <CircleHelp aria-hidden className="h-4 w-4" style={{ color: "var(--state-needs-you)" }} />
          )}
          <span
            className="text-mobile-subtitle min-w-0 flex-1"
            style={{ color: signal.tone === "error" ? "var(--state-error)" : "var(--fg-needs-you-strong)" }}
          >
            {signal.label}
          </span>
          {(row.activityAt ?? row.lastMessageAt) ? (
            <span className="mono text-mobile-caption shrink-0" style={{ color: "var(--fg-4)" }}>
              {formatMobileAge(row.activityAt ?? row.lastMessageAt)}
            </span>
          ) : null}
        </div>
        <h3 className="text-mobile-title" style={{ color: "var(--fg)", margin: 0 }}>
          {row.title}
        </h3>
        <p
          className="text-mobile-body"
          style={{
            color: "var(--fg-3)",
            margin: 0,
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
          data-mobile-card-preview
        >
          {content.primary}
        </p>
        <div className="flex justify-end" style={{ marginTop: "auto", pointerEvents: "auto" }}>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-11"
            onClick={() => {
              if (signal.tone === "needs-you") onAnswer(row.chatId);
              else onSelect(row.chatId);
            }}
            data-mobile-primary-action
          >
            {actionLabel}
            <ArrowRight aria-hidden className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </article>
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
          unreadCount={0}
          failed={false}
          needsYou={false}
          size={36}
          muted
          badge={false}
          statusDot={false}
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
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: "vertical",
                    overflow: "hidden",
                  }),
            }}
            data-mobile-card-preview
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
  if (quickView === "attention") return "Nothing needs you";
  if (quickView === "unread") return "No unread work";
  if (quickView === "pinned") return "No pinned work";
  if (filters.engagement === "archived") return "No archived work";
  return "No active work";
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
