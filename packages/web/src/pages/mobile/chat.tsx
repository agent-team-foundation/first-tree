import type { MeChatRow } from "@first-tree/shared";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useCallback, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { listMeChats } from "../../api/me-chats.js";
import { useAuth } from "../../auth/auth-context.js";
import { ActivityDots } from "../../components/chat/activity-dots.js";
import { ChatRowAvatar } from "../../components/chat/chat-row-avatar.js";
import { DocPreviewDrawer } from "../../components/doc-preview-drawer.js";
import { Button } from "../../components/ui/button.js";
import { formatRowTime } from "../../lib/utils.js";
import { CenterPanel } from "../workspace/center/index.js";
import {
  MobilePage,
  MobileSegmentedControl,
  MobileSignalChip,
  MobileSystemState,
  mobileCardStyle,
} from "./components.js";
import { mobileChatListSignal, mobileChatPreview, mobileRowsFromList, sortMobileChats } from "./data.js";

type MobileChatView = "all" | "unread" | "watching";

export function MobileChatPage() {
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
    // Back semantics: replace the detail URL with the list rather than pushing,
    // so the browser Back button / swipe does not reopen the chat detail the
    // user just exited via the back arrow.
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
        <MobileChatList onSelectChat={selectChat} />
      )}
      {/* Mobile document-evidence surface: a captured `attachment:` link in the
          chat timeline sets docChat/docMsg/docAttachment params; the drawer
          (fixed inset-0 on mobile) consumes them so the doc opens instead of
          the click being a no-op. Renders null when no doc ref is set. */}
      <DocPreviewDrawer />
    </>
  );
}

function MobileChatList({ onSelectChat }: { onSelectChat: (chatId: string) => void }) {
  const { agentId } = useAuth();
  const [view, setView] = useState<MobileChatView>("all");
  const chatsQuery = useQuery({
    // Nested under ["me", "chats"] so the shared realtime invalidation keeps
    // the mobile chat list live instead of poll-only.
    queryKey: ["me", "chats", "mobile", "chats", view],
    queryFn: () =>
      listMeChats({
        limit: 80,
        engagement: "active",
        filter: view === "unread" ? "unread" : "all",
        watching: view === "watching" ? true : undefined,
      }),
    refetchInterval: 30_000,
  });
  const rows = sortMobileChats(mobileRowsFromList(chatsQuery.data));

  return (
    <MobilePage className="flex flex-col" padded>
      <div className="flex items-center" style={{ gap: "var(--sp-2)", marginBottom: "var(--sp-4)" }}>
        <MobileSegmentedControl
          value={view}
          onChange={setView}
          options={[
            { value: "all", label: "All" },
            { value: "unread", label: "Unread" },
            { value: "watching", label: "Watching" },
          ]}
        />
        <span style={{ marginLeft: "auto" }} />
        <Button asChild variant="cta" size="sm">
          <Link to="/m/chat?c=draft">
            <Plus className="h-3.5 w-3.5" />
            New
          </Link>
        </Button>
      </div>

      {chatsQuery.isLoading && rows.length === 0 ? (
        <MobileSystemState title="Loading chats" />
      ) : chatsQuery.error ? (
        <MobileSystemState title="Failed to load chats" detail={formatError(chatsQuery.error)} tone="error" />
      ) : rows.length === 0 ? (
        <MobileSystemState title="No chats" detail={view === "all" ? "Start a new chat." : "Nothing in this view."} />
      ) : (
        <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
          {rows.map((row) => (
            <MobileChatRow key={row.chatId} row={row} selfAgentId={agentId ?? ""} onSelect={onSelectChat} />
          ))}
        </div>
      )}
    </MobilePage>
  );
}

function MobileChatRow({
  row,
  selfAgentId,
  onSelect,
}: {
  row: MeChatRow;
  selfAgentId: string;
  onSelect: (chatId: string) => void;
}) {
  const signal = mobileChatListSignal(row);
  return (
    <button
      type="button"
      onClick={() => onSelect(row.chatId)}
      className="w-full text-left transition-colors hover:bg-[var(--bg-hover)]"
      style={mobileCardStyle("list")}
      data-mobile-card="list"
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
          size={34}
          muted
          badge={false}
          statusDot
        />
        <div className="min-w-0" style={{ flex: 1 }}>
          <div className="flex items-center" style={{ gap: "var(--sp-2)" }}>
            <span
              className="text-mobile-subtitle truncate"
              style={{ color: "var(--fg)", flex: 1 }}
              data-mobile-card-title
            >
              {row.title}
            </span>
            {row.busyAgentIds.length > 0 ? (
              <ActivityDots />
            ) : row.lastMessageAt ? (
              <span className="mono text-mobile-caption shrink-0" style={{ color: "var(--fg-4)" }}>
                {formatRowTime(row.lastMessageAt)}
              </span>
            ) : null}
          </div>
          <div className="flex items-center" style={{ gap: "var(--sp-2)", marginTop: "var(--sp-1)" }}>
            <MobileSignalChip signal={signal} />
          </div>
          <p
            className="text-mobile-body"
            style={{
              color: "var(--fg-3)",
              margin: "var(--sp-2) 0 0",
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}
            data-mobile-card-preview
          >
            {mobileChatPreview(row)}
          </p>
        </div>
      </div>
    </button>
  );
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
