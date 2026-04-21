import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Leaf, MessageSquare, Pause, Play, Send, Square } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { getChat, listChatMessages, type MessageWithDelivery, sendChatMessage } from "../../../api/chats.js";
import {
  asAssistantTextPayload,
  asErrorPayload,
  asToolCallPayload,
  listAgentSessions,
  listSessionEvents,
  resumeSession,
  type SessionEventRow,
  type SessionListItem,
  suspendSession,
  terminateSession,
} from "../../../api/sessions.js";
import { useAuth } from "../../../auth/auth-context.js";
import { StateDot } from "../../../components/ui/state-dot.js";
import { useAgentNameMap } from "../../../lib/use-agent-name-map.js";
import { cn } from "../../../lib/utils.js";
import { resolveAgentState } from "../../../utils/agent-state.js";
import { filterEventsForTimeline } from "../../../utils/session-timeline.js";

function formatClockTime(iso: string): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

function formatDuration(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

function ReadReceipt({ msg, myAgentId }: { msg: MessageWithDelivery; myAgentId: string | null }) {
  if (!myAgentId || msg.senderId !== myAgentId) return null;
  const status = msg.deliveryStatus ?? "sent";
  if (status === "acked") {
    return (
      <span className="mono" style={{ fontSize: 9, color: "var(--accent)" }} title="Agent has started processing">
        ✓✓ read
      </span>
    );
  }
  if (status === "delivered") {
    return (
      <span className="mono" style={{ fontSize: 9, color: "var(--fg-3)" }} title="Delivered to agent inbox">
        ✓✓
      </span>
    );
  }
  return (
    <span className="mono" style={{ fontSize: 9, color: "var(--fg-4)" }} title="Sent">
      ✓ sent
    </span>
  );
}

function SessionControls({
  agentId,
  chatId,
  session,
}: {
  agentId: string;
  chatId: string;
  session: SessionListItem | null;
}) {
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["session", agentId, chatId] });

  const suspendMut = useMutation({ mutationFn: () => suspendSession(agentId, chatId), onSuccess: invalidate });
  const resumeMut = useMutation({ mutationFn: () => resumeSession(agentId, chatId), onSuccess: invalidate });
  const terminateMut = useMutation({ mutationFn: () => terminateSession(agentId, chatId), onSuccess: invalidate });

  const isActive = session?.state === "active";
  const isSuspended = session?.state === "suspended";
  const isEvicted = session?.state === "evicted";

  return (
    <div
      className="inline-flex items-center"
      style={{
        gap: 4,
        padding: 4,
        border: "1px solid var(--border)",
        borderRadius: 6,
        background: "var(--bg-sunken)",
      }}
    >
      {isActive && (
        <button
          type="button"
          onClick={() => suspendMut.mutate()}
          disabled={suspendMut.isPending}
          className="inline-flex items-center transition-colors"
          style={{
            gap: 6,
            padding: "4px 10px",
            fontSize: 11,
            fontWeight: 500,
            color: "var(--fg-2)",
            borderRadius: 4,
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-hover)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        >
          <Pause className="h-3 w-3" /> Suspend
          <span className="kbd" style={{ marginLeft: 2 }}>
            ⌘⇧P
          </span>
        </button>
      )}
      {isSuspended && (
        <button
          type="button"
          onClick={() => resumeMut.mutate()}
          disabled={resumeMut.isPending}
          className="inline-flex items-center transition-colors"
          style={{
            gap: 6,
            padding: "4px 10px",
            fontSize: 11,
            fontWeight: 500,
            color: "var(--fg-2)",
            borderRadius: 4,
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-hover)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        >
          <Play className="h-3 w-3" /> Resume
        </button>
      )}
      {!isEvicted && (
        <>
          <span style={{ width: 1, height: 16, background: "var(--border)" }} />
          <button
            type="button"
            onClick={() => {
              if (window.confirm("Terminate this session?")) {
                terminateMut.mutate();
              }
            }}
            disabled={terminateMut.isPending}
            className="inline-flex items-center transition-colors"
            style={{
              gap: 6,
              padding: "4px 10px",
              fontSize: 11,
              fontWeight: 600,
              color: "var(--state-error)",
              background: "color-mix(in oklch, var(--state-error) 18%, transparent)",
              borderRadius: 4,
            }}
            onMouseEnter={(e) =>
              (e.currentTarget.style.background = "color-mix(in oklch, var(--state-error) 28%, transparent)")
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.background = "color-mix(in oklch, var(--state-error) 18%, transparent)")
            }
          >
            <Square className="h-3 w-3" /> Terminate
          </button>
        </>
      )}
    </div>
  );
}

/**
 * Compact, single-line "status indicator" for a tool call. Per the chat-view
 * design, we don't show the tool's full args/result — only a "Using <name>…"
 * pulse while the turn is in progress. When the turn ends, the whole row is
 * hidden by the turn-grouping filter (see `activeSince` below).
 */
function ToolCallStatusRow({ event }: { event: SessionEventRow }) {
  const payload = asToolCallPayload(event.payload);
  if (!payload) return null;
  const isErr = payload.status === "error";
  const isPending = payload.status === "pending";
  const color = isErr ? "var(--state-error)" : isPending ? "var(--state-blocked)" : "var(--fg-3)";
  const verb = isErr ? "failed" : isPending ? "using" : "used";
  return (
    <div
      className="mono flex items-center"
      style={{
        gap: 8,
        fontSize: 11,
        padding: "2px 8px",
        color: "var(--fg-3)",
      }}
    >
      {isPending ? (
        <span
          aria-hidden
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: color,
            animation: "heartbeat-pulse 1.2s ease-in-out infinite",
            flexShrink: 0,
          }}
        />
      ) : (
        <span aria-hidden style={{ color, flexShrink: 0 }}>
          {isErr ? "⚠" : "↳"}
        </span>
      )}
      <span className="truncate" style={{ color: "var(--fg-3)" }}>
        {verb} <span style={{ color: "var(--fg-2)" }}>{payload.name}</span>
        {payload.durationMs !== undefined && !isPending ? (
          <span style={{ color: "var(--fg-4)", marginLeft: 6, fontSize: 10 }}>
            · {formatDuration(payload.durationMs)}
          </span>
        ) : null}
      </span>
    </div>
  );
}

/**
 * Intermediate assistant reply text surfaced while a turn is still running.
 * These rows are hidden by the turn-grouping filter once the turn ends —
 * the final result is delivered as a regular chat message.
 */
function AssistantTextRow({
  event,
  agentNameFn,
  agentId,
}: {
  event: SessionEventRow;
  agentNameFn: (id: string) => string;
  agentId: string;
}) {
  const payload = asAssistantTextPayload(event.payload);
  if (!payload || payload.text.length === 0) return null;
  const senderName = agentNameFn(agentId);
  return (
    <div
      className="grid"
      style={{
        gridTemplateColumns: "20px 1fr",
        columnGap: 8,
        padding: "4px 0",
        opacity: 0.85,
      }}
    >
      <Avatar name={senderName} isSelf={false} />
      <div className="min-w-0">
        <div className="flex items-baseline" style={{ gap: 8 }}>
          <span className="mono" style={{ fontSize: 11, fontWeight: 600, color: "var(--accent)" }}>
            {senderName}
          </span>
          <span className="mono" style={{ fontSize: 10, color: "var(--fg-4)" }}>
            {formatClockTime(event.createdAt)}
          </span>
          <span className="mono" style={{ fontSize: 9, color: "var(--fg-4)" }}>
            · streaming
          </span>
        </div>
        <div
          style={{
            fontSize: 12.5,
            color: "var(--fg-2)",
            whiteSpace: "pre-wrap",
            marginTop: 2,
            lineHeight: 1.55,
          }}
        >
          {payload.text}
        </div>
      </div>
    </div>
  );
}

/**
 * Lightweight "Thinking…" pulse. The actual thinking content is never
 * transmitted — the backend emits a bare marker and we surface it as a
 * single-line status. Hidden once the turn ends.
 */
function ThinkingRow({ event }: { event: SessionEventRow }) {
  return (
    <div
      className="mono flex items-center"
      style={{
        gap: 8,
        fontSize: 11,
        padding: "2px 8px",
        color: "var(--fg-3)",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: "var(--accent)",
          animation: "heartbeat-pulse 1.2s ease-in-out infinite",
          flexShrink: 0,
        }}
      />
      <span style={{ color: "var(--fg-3)" }}>thinking…</span>
      <span className="mono" style={{ fontSize: 10, color: "var(--fg-4)" }}>
        {formatClockTime(event.createdAt)}
      </span>
    </div>
  );
}

function ErrorRow({ event }: { event: SessionEventRow }) {
  const payload = asErrorPayload(event.payload);
  const ts = formatClockTime(event.createdAt);
  return (
    <div
      style={{
        padding: "6px 10px",
        borderLeft: "2px solid var(--state-error)",
        background: "color-mix(in oklch, var(--state-error) 6%, transparent)",
        borderRadius: "0 4px 4px 0",
      }}
    >
      <div
        className="mono uppercase"
        style={{
          fontSize: 10,
          letterSpacing: 0.08,
          color: "var(--state-error)",
        }}
      >
        error · {payload?.source ?? "unknown"} · {ts}
      </div>
      <div
        style={{
          marginTop: 2,
          fontSize: 11.5,
          color: "var(--fg-2)",
          whiteSpace: "pre-wrap",
        }}
      >
        {payload?.message ?? "(invalid error payload)"}
      </div>
    </div>
  );
}

function Avatar({ name, isSelf }: { name: string; isSelf: boolean }) {
  const initials = name.slice(0, 2).toUpperCase();
  return (
    <div
      className="mono"
      style={{
        width: 20,
        height: 20,
        borderRadius: 4,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 9,
        fontWeight: 700,
        flexShrink: 0,
        background: isSelf ? "linear-gradient(135deg, var(--accent), oklch(0.58 0.14 170))" : "var(--bg-active)",
        border: isSelf ? "none" : "1px solid var(--border-strong)",
        color: isSelf ? "oklch(0.14 0.01 150)" : "var(--fg-2)",
      }}
    >
      {isSelf ? initials : <Leaf className="h-3 w-3" style={{ color: "var(--accent)" }} />}
    </div>
  );
}

function TextRow({
  msg,
  myAgentId,
  agentNameFn,
}: {
  msg: MessageWithDelivery;
  myAgentId: string | null;
  agentNameFn: (id: string) => string;
}) {
  const senderName = agentNameFn(msg.senderId);
  const isSelf = myAgentId === msg.senderId;

  return (
    <div
      className="grid"
      style={{
        gridTemplateColumns: "20px 1fr",
        columnGap: 8,
        padding: "6px 0",
      }}
    >
      <Avatar name={senderName} isSelf={isSelf} />
      <div className="min-w-0">
        <div className="flex items-baseline" style={{ gap: 8 }}>
          <span
            className="mono"
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: isSelf ? "var(--fg)" : "var(--accent)",
            }}
          >
            {senderName}
          </span>
          <span className="mono" style={{ fontSize: 10, color: "var(--fg-4)" }}>
            {formatClockTime(msg.createdAt)}
          </span>
          <span style={{ marginLeft: "auto" }}>
            <ReadReceipt msg={msg} myAgentId={myAgentId} />
          </span>
        </div>
        <div
          style={{
            fontSize: 12.5,
            color: "var(--fg)",
            whiteSpace: "pre-wrap",
            marginTop: 2,
            lineHeight: 1.55,
          }}
        >
          {msg.format === "text" ? (
            typeof msg.content === "string" ? (
              msg.content
            ) : (
              JSON.stringify(msg.content)
            )
          ) : (
            <pre
              className="mono"
              style={{
                fontSize: 11,
                background: "var(--bg-sunken)",
                padding: 8,
                borderRadius: 4,
                overflow: "auto",
                maxHeight: 160,
              }}
            >
              {JSON.stringify(msg.content, null, 2)}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

type TimelineItem =
  | { kind: "message"; at: string; key: string; data: MessageWithDelivery }
  | { kind: "event"; at: string; key: string; data: SessionEventRow };

export function ChatView({ agentId, chatId }: { agentId: string; chatId: string }) {
  const queryClient = useQueryClient();
  const agentName = useAgentNameMap();
  const { agentId: myAgentId } = useAuth();
  const [draft, setDraft] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const { data: messagesData } = useQuery({
    queryKey: ["chat-messages", chatId],
    queryFn: () => listChatMessages(chatId, { limit: 50 }),
    refetchInterval: 5_000,
  });

  // Fetch newest events first so the turn-grouping filter always sees the
  // latest `turn_end` even in chats with thousands of total events. The
  // timeline renderer later sorts by timestamp, so the fetch order is moot
  // for display — only the contents of the window matter.
  const { data: eventsData } = useQuery({
    queryKey: ["session-events", agentId, chatId],
    queryFn: () => listSessionEvents(agentId, chatId, { limit: 200, direction: "desc" }),
    refetchInterval: 5_000,
  });

  const { data: session } = useQuery({
    queryKey: ["session", agentId, chatId],
    queryFn: () => listAgentSessions(agentId).then((sessions) => sessions.find((s) => s.chatId === chatId) ?? null),
    refetchInterval: 5_000,
  });

  const { data: chatDetail } = useQuery({
    queryKey: ["chat-detail", chatId],
    queryFn: () => getChat(chatId),
    enabled: !!chatId,
  });

  const sendMut = useMutation({
    mutationFn: (content: string) => sendChatMessage(chatId, content),
    onSuccess: () => {
      setDraft("");
      queryClient.invalidateQueries({ queryKey: ["chat-messages", chatId] });
    },
  });

  const handleSend = () => {
    const text = draft.trim();
    if (!text) return;
    sendMut.mutate(text);
  };

  /**
   * Timeline composition: messages (real chat rows, including the forwarded
   * final result) are always visible; transient events go through the
   * turn-grouping filter so completed turns collapse to just their result
   * message. See `filterEventsForTimeline` for the full rules.
   */
  const items: TimelineItem[] = useMemo(() => {
    const msgs = messagesData?.items ?? [];
    const visibleEvents = filterEventsForTimeline(eventsData?.items ?? []);

    const out: TimelineItem[] = [
      ...msgs.map((m) => ({ kind: "message" as const, at: m.createdAt, key: `m-${m.id}`, data: m })),
      ...visibleEvents.map((e) => ({ kind: "event" as const, at: e.createdAt, key: `e-${e.id}`, data: e })),
    ];
    out.sort((a, b) => a.at.localeCompare(b.at));
    return out;
  }, [messagesData, eventsData]);

  const itemCount = items.length;
  useEffect(() => {
    if (itemCount > 0) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [itemCount]);

  const participantsLabel = chatDetail?.participants
    ? chatDetail.participants
        .map((p) => {
          const name = agentName(p.agentId);
          return `@${name.length > 20 ? `${name.slice(0, 17)}…` : name}`;
        })
        .join(" ")
    : `@${agentName(agentId)}`;
  const displayName = agentName(agentId);
  const runtimeLabel = session?.runtimeState ?? "idle";
  const runtimeState = resolveAgentState(session?.runtimeState ?? null, agentId ? "connected" : null);
  const msgCount = session?.messageCount ?? messagesData?.items?.length ?? 0;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Chat header */}
      <div
        className="grid items-center shrink-0"
        style={{
          gridTemplateColumns: "1fr auto",
          gap: 10,
          padding: "10px 14px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <div className="min-w-0">
          <div className="flex items-center" style={{ gap: 8 }}>
            <StateDot state={runtimeState} size={8} />
            <span className="truncate" style={{ fontSize: 13, fontWeight: 600, color: "var(--fg)" }}>
              {session?.summary || `Chat · ${chatId.slice(0, 8)}`}
            </span>
            <span
              className="mono"
              style={{
                fontSize: 10,
                color: "var(--fg-4)",
                padding: "1px 5px",
                border: "1px solid var(--border)",
                borderRadius: 2,
              }}
            >
              {chatId}
            </span>
          </div>
          <div
            className="flex items-center"
            style={{
              fontSize: 10.5,
              color: "var(--fg-3)",
              marginTop: 4,
              gap: 10,
            }}
          >
            <span className="mono">{participantsLabel}</span>
            <span>·</span>
            <span>started {formatRelative(session?.startedAt ?? null)}</span>
            <span>·</span>
            <span>{msgCount} msgs</span>
            <span>·</span>
            <span>
              runtime{" "}
              <span
                className="mono"
                style={{
                  color:
                    runtimeState === "error"
                      ? "var(--state-error)"
                      : runtimeState === "working"
                        ? "var(--fg-2)"
                        : "var(--fg-2)",
                }}
              >
                {runtimeLabel}
              </span>
            </span>
          </div>
        </div>
        <SessionControls agentId={agentId} chatId={chatId} session={session ?? null} />
      </div>

      {/* Timeline */}
      <div className="flex-1 overflow-y-auto" style={{ padding: "10px 14px" }}>
        {itemCount === 0 && (
          <div
            className="flex flex-col items-center"
            style={{ color: "var(--fg-3)", fontSize: 13, padding: "32px 0", gap: 6 }}
          >
            <MessageSquare className="h-8 w-8" style={{ opacity: 0.3 }} />
            Send a message to start the conversation
          </div>
        )}
        <div className="flex flex-col" style={{ gap: 4 }}>
          {items.map((item) => {
            if (item.kind === "event") {
              const ev = item.data;
              switch (ev.kind) {
                case "tool_call":
                  return <ToolCallStatusRow key={item.key} event={ev} />;
                case "assistant_text":
                  return <AssistantTextRow key={item.key} event={ev} agentId={agentId} agentNameFn={agentName} />;
                case "thinking":
                  return <ThinkingRow key={item.key} event={ev} />;
                case "error":
                  return <ErrorRow key={item.key} event={ev} />;
                default:
                  // turn_end is filtered upstream; any unknown kind is dropped.
                  return null;
              }
            }
            return <TextRow key={item.key} msg={item.data} myAgentId={myAgentId} agentNameFn={agentName} />;
          })}
        </div>
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div
        className="shrink-0"
        style={{
          padding: "10px 14px",
          borderTop: "1px solid var(--border)",
        }}
      >
        <div
          style={{
            position: "relative",
            border: "1px solid var(--border)",
            borderRadius: 6,
            background: "var(--bg-sunken)",
          }}
        >
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={`Message @${displayName}  ·  / for commands  ·  @ to mention`}
            rows={2}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            disabled={sendMut.isPending}
            className="w-full outline-none"
            style={{
              padding: "9px 12px 30px",
              fontSize: 12.5,
              background: "transparent",
              border: "none",
              resize: "none",
              fontFamily: "var(--font-sans)",
              color: "var(--fg)",
            }}
          />
          <div
            className="flex items-center justify-between"
            style={{
              position: "absolute",
              bottom: 6,
              left: 10,
              right: 10,
              fontSize: 10,
              color: "var(--fg-4)",
            }}
          >
            <span className="mono flex" style={{ gap: 8 }}>
              <span>/suspend</span>
              <span>/resume</span>
              <span>/branch</span>
              <span>/promote</span>
            </span>
            <span className="flex items-center" style={{ gap: 8 }}>
              <span>
                <span className="kbd">⏎</span> send <span className="kbd">⇧⏎</span> new line
              </span>
              <button
                type="button"
                onClick={handleSend}
                disabled={sendMut.isPending || !draft.trim()}
                className={cn(
                  "inline-flex items-center transition-colors",
                  (sendMut.isPending || !draft.trim()) && "opacity-50 cursor-not-allowed",
                )}
                style={{
                  gap: 6,
                  padding: "4px 10px",
                  fontSize: 11,
                  fontWeight: 600,
                  color: "oklch(0.14 0.01 150)",
                  background: "var(--accent)",
                  border: "1px solid var(--accent)",
                  borderRadius: 5,
                }}
              >
                <Send className="h-3 w-3" /> Send
              </button>
            </span>
          </div>
        </div>
        {sendMut.isError && (
          <p
            className="mono"
            style={{
              fontSize: 11,
              color: "var(--state-error)",
              padding: "6px 2px 0",
            }}
          >
            {sendMut.error instanceof Error ? sendMut.error.message : "Failed to send"}
          </p>
        )}
      </div>
    </div>
  );
}
