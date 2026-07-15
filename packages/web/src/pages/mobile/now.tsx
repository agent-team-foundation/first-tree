import type { MeChatRow } from "@first-tree/shared";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Plus } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { listMeChats } from "../../api/me-chats.js";
import { useAuth } from "../../auth/auth-context.js";
import { ChatRowAvatar } from "../../components/chat/chat-row-avatar.js";
import { Button } from "../../components/ui/button.js";
import { MobileAskSheet } from "./ask-sheet.js";
import { MobileCardActionsMenu, MobileSwipeCard, useMobileChatActions } from "./chat-card-actions.js";
import { MobilePage, MobileSignalChip, MobileSystemState, mobileAccentColor, mobileCardStyle } from "./components.js";
import {
  formatMobileAge,
  isNowFeedRow,
  mobileChatPreview,
  mobileChatSignal,
  mobileRowsFromList,
  sortMobileChats,
} from "./data.js";

export function MobileNowPage() {
  const { agentId } = useAuth();
  const navigate = useNavigate();
  const [answeringChatId, setAnsweringChatId] = useState<string | null>(null);
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
  const sortedRows = sortMobileChats(mobileRowsFromList(chatsQuery.data)).filter(isNowFeedRow);

  return (
    <>
      <MobilePage className="flex flex-col" padded>
        <div className="flex items-center" style={{ gap: "var(--sp-2)", marginBottom: "var(--sp-4)" }}>
          <div className="min-w-0" style={{ flex: 1 }}>
            <h1 className="text-mobile-title" style={{ color: "var(--fg)", margin: 0 }}>
              Now
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
              <MobileAttentionCard
                key={row.chatId}
                row={row}
                selfAgentId={agentId ?? ""}
                onOpenChat={(chatId) => navigate(`/m/chat?c=${encodeURIComponent(chatId)}`)}
                onOpenAnswer={setAnsweringChatId}
              />
            ))}
          </div>
        )}
      </MobilePage>
      {answeringChatId ? <MobileAskSheet chatId={answeringChatId} onClose={() => setAnsweringChatId(null)} /> : null}
    </>
  );
}

function MobileAttentionCard({
  row,
  selfAgentId,
  onOpenChat,
  onOpenAnswer,
}: {
  row: MeChatRow;
  selfAgentId: string;
  onOpenChat: (chatId: string) => void;
  onOpenAnswer: (chatId: string) => void;
}) {
  const signal = mobileChatSignal(row);
  const preview = mobileChatPreview(row);
  const actionLabel = primaryActionLabel(signal.tone);
  const accent = mobileAccentColor(signal.tone);
  const actions = useMobileChatActions(row);
  const cardStyle = {
    ...mobileCardStyle(actionLabel ? "priorityFeed" : "feed"),
    textDecoration: "none",
    position: "relative" as const,
    // One pre-attentive priority cue: a left-edge accent in the state hue,
    // replacing the avatar red mark + chip + colored button triple-encoding.
    ...(accent ? { boxShadow: `inset var(--hairline-bold) 0 0 0 ${accent}` } : {}),
  };
  const content = (
    <div className="relative flex h-full flex-col" style={{ gap: "var(--sp-3)", zIndex: 1, pointerEvents: "none" }}>
      <div className="flex items-center" style={{ gap: "var(--sp-2)" }}>
        <ChatRowAvatar
          title={row.title}
          type={row.type}
          participants={row.participants}
          selfAgentId={selfAgentId}
          unreadCount={row.unreadMentionCount}
          failed={false}
          needsYou={false}
          size={36}
          muted
          badge={false}
          statusDot
        />
        <div className="min-w-0" style={{ flex: 1 }}>
          <MobileSignalChip signal={signal} />
        </div>
        {row.lastMessageAt ? (
          <span className="mono text-mobile-caption shrink-0" style={{ color: "var(--fg-4)" }}>
            {formatMobileAge(row.lastMessageAt)}
          </span>
        ) : null}
        <span style={{ pointerEvents: "auto" }}>
          <MobileCardActionsMenu actions={actions} title={row.title} />
        </span>
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
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
        }}
        data-mobile-card-preview
      >
        {preview}
      </p>
      {actionLabel ? (
        <div className="flex items-center" style={{ marginTop: "auto", pointerEvents: "auto" }}>
          <Button
            type="button"
            variant="default"
            size="sm"
            data-mobile-primary-action
            onClick={() => {
              if (signal.tone === "needs-you") onOpenAnswer(row.chatId);
              else onOpenChat(row.chatId);
            }}
          >
            {actionLabel}
            <ArrowRight aria-hidden className="h-3.5 w-3.5" />
          </Button>
        </div>
      ) : null}
    </div>
  );

  return (
    <MobileSwipeCard actions={actions}>
      <article style={cardStyle} data-mobile-card="feed">
        <button
          type="button"
          aria-label={`Open ${row.title}`}
          onClick={() => onOpenChat(row.chatId)}
          className="absolute inset-0 cursor-pointer border-0 bg-transparent"
          style={{ zIndex: 0 }}
        />
        {content}
      </article>
    </MobileSwipeCard>
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
