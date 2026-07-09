import type { MeChatRow } from "@first-tree/shared";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Plus } from "lucide-react";
import { Link } from "react-router";
import { listMeChats } from "../../api/me-chats.js";
import { useAuth } from "../../auth/auth-context.js";
import { ChatRowAvatar } from "../../components/chat/chat-row-avatar.js";
import { Button } from "../../components/ui/button.js";
import { formatRowTime } from "../../lib/utils.js";
import { MobilePage, MobileSection, MobileSignalChip, MobileSystemState } from "./components.js";
import { mobileChatPreview, mobileChatSignal, sortMobileChats } from "./data.js";

export function MobileTodayPage() {
  const { agentId } = useAuth();
  const chatsQuery = useQuery({
    queryKey: ["mobile", "today"],
    queryFn: () => listMeChats({ limit: 50, engagement: "active" }),
    refetchInterval: 30_000,
  });

  const sortedRows = sortMobileChats(chatsQuery.data?.rows ?? []);
  const attentionRows = sortedRows.filter((row) => mobileChatSignal(row).attention);
  const workingRows = sortedRows.filter((row) => mobileChatSignal(row).tone === "working");
  const recentRows = sortedRows.filter((row) => !mobileChatSignal(row).attention && mobileChatSignal(row).tone !== "working");

  return (
    <MobilePage className="flex flex-col" padded>
      <div className="flex items-center" style={{ gap: "var(--sp-2)", marginBottom: "var(--sp-4)" }}>
        <div className="min-w-0" style={{ flex: 1 }}>
          <p className="text-eyebrow uppercase" style={{ color: "var(--fg-4)", margin: 0 }}>
            Current work
          </p>
          <h1 className="text-title" style={{ color: "var(--fg)", margin: "var(--sp-0_5) 0 0" }}>
            {attentionRows.length > 0 ? `${attentionRows.length} need attention` : "No blockers"}
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
        <MobileSystemState title="Nothing active" detail="Start a chat when you are ready." />
      ) : (
        <div className="flex flex-col" style={{ gap: "var(--sp-5)" }}>
          <MobileSection title="Needs attention" count={attentionRows.length}>
            {attentionRows.length > 0 ? (
              <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
                {attentionRows.map((row) => (
                  <MobileAttentionCard key={row.chatId} row={row} selfAgentId={agentId ?? ""} />
                ))}
              </div>
            ) : (
              <QuietPanel text="All clear." />
            )}
          </MobileSection>

          {workingRows.length > 0 ? (
            <MobileSection title="In progress" count={workingRows.length}>
              <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
                {workingRows.map((row) => (
                  <MobileAttentionCard key={row.chatId} row={row} selfAgentId={agentId ?? ""} />
                ))}
              </div>
            </MobileSection>
          ) : null}

          <MobileSection title="Recent" count={recentRows.length}>
            {recentRows.length > 0 ? (
              <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
                {recentRows.slice(0, 8).map((row) => (
                  <MobileAttentionCard key={row.chatId} row={row} selfAgentId={agentId ?? ""} compact />
                ))}
              </div>
            ) : (
              <QuietPanel text="No recent conversations." />
            )}
          </MobileSection>
        </div>
      )}
    </MobilePage>
  );
}

function MobileAttentionCard({
  row,
  selfAgentId,
  compact = false,
}: {
  row: MeChatRow;
  selfAgentId: string;
  compact?: boolean;
}) {
  const signal = mobileChatSignal(row);
  const preview = mobileChatPreview(row);
  return (
    <Link
      to={`/m/chat?c=${encodeURIComponent(row.chatId)}`}
      className="block transition-colors hover:bg-[var(--bg-hover)]"
      style={{
        minHeight: compact ? "var(--sp-16)" : "calc(var(--sp-16) + var(--sp-2))",
        padding: "var(--sp-3)",
        border: "var(--hairline) solid var(--border)",
        borderRadius: "var(--radius-dialog)",
        background: "var(--bg-raised)",
        textDecoration: "none",
      }}
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
            <p className="text-subtitle truncate" style={{ color: "var(--fg)", margin: 0, flex: 1 }}>
              {row.title}
            </p>
            {row.lastMessageAt ? (
              <span className="mono text-caption shrink-0" style={{ color: "var(--fg-4)" }}>
                {formatRowTime(row.lastMessageAt)}
              </span>
            ) : null}
          </div>
          <div className="flex items-center" style={{ gap: "var(--sp-2)", marginTop: "var(--sp-1)" }}>
            <MobileSignalChip signal={signal} />
            <ArrowRight aria-hidden className="h-3.5 w-3.5" style={{ color: "var(--fg-4)", marginLeft: "auto" }} />
          </div>
          {!compact ? (
            <p
              className="text-body"
              style={{
                color: "var(--fg-3)",
                margin: "var(--sp-2) 0 0",
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }}
            >
              {preview}
            </p>
          ) : null}
        </div>
      </div>
    </Link>
  );
}

function QuietPanel({ text }: { text: string }) {
  return (
    <div
      className="text-body"
      style={{
        padding: "var(--sp-3)",
        border: "var(--hairline) solid var(--border-faint)",
        borderRadius: "var(--radius-panel)",
        color: "var(--fg-3)",
        background: "var(--bg-sunken)",
      }}
    >
      {text}
    </div>
  );
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
