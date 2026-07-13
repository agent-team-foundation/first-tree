import type { MeChatRow } from "@first-tree/shared";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Plus } from "lucide-react";
import { Link } from "react-router";
import { listMeChats } from "../../api/me-chats.js";
import { useAuth } from "../../auth/auth-context.js";
import { ChatRowAvatar } from "../../components/chat/chat-row-avatar.js";
import { Button } from "../../components/ui/button.js";
import { formatRowTime } from "../../lib/utils.js";
import { MobilePage, MobileSignalChip, MobileSystemState, mobileCardStyle } from "./components.js";
import { isNowFeedRow, mobileChatPreview, mobileChatSignal, mobileFeedReasonLabel, sortMobileChats } from "./data.js";

export function MobileNowPage() {
  const { agentId } = useAuth();
  const chatsQuery = useQuery({
    // Nested under ["me", "chats"] so the shared realtime invalidation
    // (useAdminWs WS events + chat send / ask-answer / new-chat mutations)
    // refreshes Now immediately instead of waiting for the poll.
    queryKey: ["me", "chats", "mobile", "now"],
    queryFn: () => listMeChats({ limit: 50, engagement: "active" }),
    refetchInterval: 30_000,
  });

  // Now is a needs-attention feed, not the full chat list: admit only chats
  // with an AUTHORITATIVE active signal (see isNowFeedRow — failed agent, open
  // request, explicit @me, or an in-flight turn), then keep the canonical
  // attention order. Quiet / watching-only chats live in the Chat tab.
  const sortedRows = sortMobileChats(chatsQuery.data?.rows ?? []).filter(isNowFeedRow);

  return (
    <MobilePage className="flex flex-col" padded>
      <div className="flex items-center" style={{ gap: "var(--sp-2)", marginBottom: "var(--sp-4)" }}>
        <div className="min-w-0" style={{ flex: 1 }}>
          <h1 className="text-mobile-title" style={{ color: "var(--fg)", margin: 0 }}>
            Work feed
          </h1>
        </div>
        <Button asChild variant="cta" size="sm">
          <Link to="/m/chat?c=draft">
            <Plus className="h-3.5 w-3.5" />
            New
          </Link>
        </Button>
      </div>

      {chatsQuery.isLoading && sortedRows.length === 0 ? (
        <MobileSystemState title="Loading work" />
      ) : chatsQuery.error ? (
        <MobileSystemState title="Failed to load work" detail={formatError(chatsQuery.error)} tone="error" />
      ) : sortedRows.length === 0 ? (
        <MobileSystemState
          title="You're all caught up"
          detail="Asks, failures, and updates show up here. Find every chat in Chat."
        />
      ) : (
        <div className="flex flex-col" style={{ gap: "var(--sp-2)" }} data-mobile-feed>
          {sortedRows.map((row) => (
            <MobileAttentionCard key={row.chatId} row={row} selfAgentId={agentId ?? ""} />
          ))}
        </div>
      )}
    </MobilePage>
  );
}

function MobileAttentionCard({ row, selfAgentId }: { row: MeChatRow; selfAgentId: string }) {
  const signal = mobileChatSignal(row);
  const preview = mobileChatPreview(row);
  const actionLabel = primaryActionLabel(signal.tone);
  const reasonLabel = mobileFeedReasonLabel(row);
  const cardStyle = {
    ...mobileCardStyle(actionLabel ? "priorityFeed" : "feed"),
    textDecoration: "none",
  };
  const content = (
    <div className="flex h-full flex-col" style={{ gap: "var(--sp-3)" }}>
      <div className="flex items-center" style={{ gap: "var(--sp-2)" }}>
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
        />
        <div className="min-w-0" style={{ flex: 1 }}>
          <MobileSignalChip signal={signal} label={reasonLabel} />
        </div>
        {row.lastMessageAt ? (
          <span className="mono text-mobile-caption shrink-0" style={{ color: "var(--fg-4)" }}>
            {formatRowTime(row.lastMessageAt)}
          </span>
        ) : null}
      </div>
      <p
        className="text-mobile-title"
        style={{
          color: "var(--fg)",
          margin: 0,
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
        }}
        data-mobile-card-title
      >
        {row.title}
      </p>
      <p
        className="text-mobile-body"
        style={{
          color: "var(--fg-3)",
          margin: 0,
          display: "-webkit-box",
          WebkitLineClamp: 3,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
        }}
        data-mobile-card-preview
      >
        {preview}
      </p>
      {actionLabel ? (
        <div className="flex items-center" style={{ marginTop: "auto" }}>
          <Button asChild variant="cta" size="sm" data-mobile-primary-action>
            <Link to={`/m/chat?c=${encodeURIComponent(row.chatId)}`}>
              {actionLabel}
              <ArrowRight aria-hidden className="h-3.5 w-3.5" />
            </Link>
          </Button>
        </div>
      ) : null}
    </div>
  );

  if (actionLabel) {
    return (
      <article style={cardStyle} data-mobile-card="feed">
        {content}
      </article>
    );
  }

  return (
    <Link
      to={`/m/chat?c=${encodeURIComponent(row.chatId)}`}
      className="block transition-colors hover:bg-[var(--bg-hover)]"
      style={cardStyle}
      data-mobile-card="feed"
    >
      {content}
    </Link>
  );
}

function primaryActionLabel(tone: ReturnType<typeof mobileChatSignal>["tone"]): string | null {
  switch (tone) {
    case "needs-you":
      return "Answer";
    case "error":
      return "Review";
    case "unread":
    case "working":
    case "idle":
      return null;
  }
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
