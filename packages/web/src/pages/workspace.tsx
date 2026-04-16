import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  ChevronRight,
  MessageSquare,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Send,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { getActivityOverview, type RuntimeAgent } from "../api/activity.js";
import { createAgentChat, listChatMessages, type MessageWithDelivery, sendChatMessage } from "../api/chats.js";
import { listNotifications, markNotificationRead } from "../api/notifications.js";
import { getOverview } from "../api/overview.js";
import { listAgentSessions, resumeSession, suspendSession, terminateSession } from "../api/sessions.js";
import { useAuth } from "../auth/auth-context.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { useAdminWs } from "../hooks/use-admin-ws.js";
import { useAgentNameMap } from "../lib/use-agent-name-map.js";
import { useClientMap } from "../lib/use-client-map.js";
import { cn, formatDate } from "../lib/utils.js";

// ---------------------------------------------------------------------------
// Workspace Page — Three-panel layout
// ---------------------------------------------------------------------------

export function WorkspacePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedAgentId = searchParams.get("a");
  const selectedChatId = searchParams.get("c");
  const [contextPanelOpen, setContextPanelOpen] = useState(true);

  useAdminWs();

  const selectAgent = useCallback(
    (agentId: string | null) => {
      if (!agentId) {
        setSearchParams({});
      } else {
        setSearchParams({ a: agentId });
      }
    },
    [setSearchParams],
  );

  const selectChat = useCallback(
    (agentId: string, chatId: string) => {
      setSearchParams({ a: agentId, c: chatId });
    },
    [setSearchParams],
  );

  const clearChat = useCallback(() => {
    if (selectedAgentId) {
      setSearchParams({ a: selectedAgentId });
    }
  }, [selectedAgentId, setSearchParams]);

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Left: Agent Roster */}
      <AgentRoster
        selectedAgentId={selectedAgentId}
        selectedChatId={selectedChatId}
        onSelectAgent={selectAgent}
        onSelectChat={selectChat}
      />

      {/* Center Panel */}
      <div className="flex-1 flex flex-col overflow-hidden border-x border-border">
        <CenterPanel
          selectedAgentId={selectedAgentId}
          selectedChatId={selectedChatId}
          onSelectChat={selectChat}
          onClearChat={clearChat}
        />
      </div>

      {/* Right: Context Panel */}
      {contextPanelOpen ? (
        <div className="w-80 shrink-0 flex flex-col overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 border-b border-border">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              {selectedChatId ? "Session" : selectedAgentId ? "Agent Info" : "Dashboard"}
            </span>
            <button
              type="button"
              onClick={() => setContextPanelOpen(false)}
              className="text-muted-foreground hover:text-foreground"
            >
              <PanelRightClose className="h-4 w-4" />
            </button>
          </div>
          <ContextPanel selectedAgentId={selectedAgentId} selectedChatId={selectedChatId} />
        </div>
      ) : (
        <div className="shrink-0 border-l border-border flex items-start pt-2 px-1">
          <button
            type="button"
            onClick={() => setContextPanelOpen(true)}
            className="text-muted-foreground hover:text-foreground p-1"
          >
            <PanelRightOpen className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agent Roster (Left Panel)
// ---------------------------------------------------------------------------

const RUNTIME_SORT_ORDER: Record<string, number> = { error: 0, blocked: 1, working: 2, idle: 3 };

function runtimeSortKey(state: string | null, clientId: string | null): number {
  if (!clientId) return 5; // offline
  if (!state) return 4;
  return RUNTIME_SORT_ORDER[state] ?? 4;
}

const HEARTBEAT_COLORS: Record<string, string> = {
  idle: "bg-green-500",
  working: "bg-green-500 animate-pulse",
  blocked: "bg-yellow-500",
  error: "bg-red-500",
};

function HeartbeatDot({ runtimeState, clientId }: { runtimeState: string | null; clientId: string | null }) {
  if (!clientId || !runtimeState) {
    return <span className="h-2 w-2 rounded-full bg-gray-400 shrink-0 mt-1.5" />;
  }
  const color = HEARTBEAT_COLORS[runtimeState] ?? "bg-gray-400";
  return <span className={`h-2 w-2 rounded-full ${color} shrink-0 mt-1.5`} />;
}

function RuntimeBadge({ state }: { state: string | null }) {
  if (!state) return <span className="text-xs text-muted-foreground">offline</span>;
  const colors: Record<string, string> = {
    idle: "text-green-600",
    working: "text-blue-600",
    blocked: "text-yellow-600",
    error: "text-red-600",
  };
  return <span className={cn("text-xs font-medium", colors[state] ?? "text-muted-foreground")}>{state}</span>;
}

function SessionStateBadge({ state }: { state: string }) {
  const variants: Record<string, string> = {
    active: "border-green-500/50 text-green-600 bg-green-500/10",
    suspended: "border-yellow-500/50 text-yellow-600 bg-yellow-500/10",
    evicted: "border-muted text-muted-foreground",
  };
  return (
    <Badge variant="outline" className={cn("text-xs", variants[state])}>
      {state}
    </Badge>
  );
}

function ReadReceipt({ msg, myAgentId }: { msg: MessageWithDelivery; myAgentId: string | null }) {
  // Only show receipt for messages sent by the current user
  if (!myAgentId || msg.senderId !== myAgentId) return null;

  const status = msg.deliveryStatus ?? "sent";

  if (status === "acked") {
    // Double check, blue = read/processing
    return (
      <span className="text-blue-500 text-xs ml-1" title="Agent has started processing">
        {"✓✓"}
      </span>
    );
  }
  if (status === "delivered") {
    // Double check, gray = delivered but not yet processed
    return (
      <span className="text-muted-foreground text-xs ml-1" title="Delivered to agent inbox">
        {"✓✓"}
      </span>
    );
  }
  // sent/pending
  return (
    <span className="text-muted-foreground text-xs ml-1" title="Sent">
      {"✓"}
    </span>
  );
}

function AgentRoster({
  selectedAgentId,
  selectedChatId,
  onSelectAgent,
  onSelectChat,
}: {
  selectedAgentId: string | null;
  selectedChatId: string | null;
  onSelectAgent: (id: string | null) => void;
  onSelectChat: (agentId: string, chatId: string) => void;
}) {
  const agentName = useAgentNameMap();
  const { resolve: resolveClient } = useClientMap();
  const queryClient = useQueryClient();

  const { data: activity } = useQuery({
    queryKey: ["activity"],
    queryFn: getActivityOverview,
    refetchInterval: 10_000,
  });

  const agents = [...(activity?.agents ?? [])].sort(
    (a, b) => runtimeSortKey(a.runtimeState, a.clientId) - runtimeSortKey(b.runtimeState, b.clientId),
  );

  const { data: sessions } = useQuery({
    queryKey: ["agent-sessions", selectedAgentId],
    queryFn: () => (selectedAgentId ? listAgentSessions(selectedAgentId) : Promise.resolve([])),
    enabled: !!selectedAgentId,
    refetchInterval: 10_000,
  });

  const newChatMut = useMutation({
    mutationFn: (agentId: string) => createAgentChat(agentId),
    onSuccess: (result, agentId) => {
      queryClient.invalidateQueries({ queryKey: ["agent-sessions", agentId] });
      onSelectChat(agentId, result.id);
    },
  });

  return (
    <aside className="w-60 shrink-0 flex flex-col overflow-y-auto bg-card">
      <div className="px-3 py-2 border-b border-border">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Agents</span>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {agents.length === 0 && <div className="px-3 py-6 text-sm text-muted-foreground text-center">No agents</div>}
        {agents.map((agent) => {
          const isSelected = selectedAgentId === agent.agentId;
          return (
            <div key={agent.agentId}>
              <button
                type="button"
                onClick={() => onSelectAgent(isSelected ? null : agent.agentId)}
                className={cn(
                  "w-full flex items-start gap-2 px-3 py-1.5 text-left transition-colors",
                  isSelected ? "bg-accent" : "hover:bg-accent/50",
                )}
              >
                <HeartbeatDot runtimeState={agent.runtimeState} clientId={agent.clientId} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium truncate flex-1">{agentName(agent.agentId)}</span>
                    <RuntimeBadge state={agent.runtimeState} />
                  </div>
                  <span className="text-xs text-muted-foreground truncate block">
                    {agent.clientId
                      ? (resolveClient(agent.clientId)?.hostname ?? agent.clientId.slice(0, 8))
                      : "disconnected"}
                  </span>
                </div>
              </button>

              {/* Expanded: active conversations */}
              {isSelected && (
                <div className="pl-5 pr-2 py-1 space-y-0.5">
                  {(!sessions || sessions.length === 0) && (
                    <div className="text-xs text-muted-foreground py-1 pl-2">No active sessions</div>
                  )}
                  {sessions?.map((s) => (
                    <button
                      key={s.chatId}
                      type="button"
                      onClick={() => onSelectChat(agent.agentId, s.chatId)}
                      className={cn(
                        "w-full flex items-center gap-1.5 px-2 py-1 rounded text-left text-xs transition-colors",
                        selectedChatId === s.chatId
                          ? "bg-primary/10 text-foreground"
                          : "text-muted-foreground hover:bg-accent/50",
                      )}
                    >
                      <ChevronRight className="h-3 w-3 shrink-0" />
                      <span className="truncate flex-1">{s.chatId.slice(0, 8)}...</span>
                      <span
                        className={cn(
                          "h-1.5 w-1.5 rounded-full shrink-0",
                          s.state === "active" && "bg-green-500",
                          s.state === "suspended" && "bg-yellow-500",
                          s.state === "evicted" && "bg-gray-400",
                        )}
                        title={s.state}
                      />
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => newChatMut.mutate(agent.agentId)}
                    disabled={newChatMut.isPending}
                    className="w-full flex items-center gap-1.5 px-2 py-1 rounded text-xs text-muted-foreground hover:bg-accent/50 transition-colors"
                  >
                    <Plus className="h-3 w-3" />
                    New Chat
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Center Panel — Three states
// ---------------------------------------------------------------------------

function CenterPanel({
  selectedAgentId,
  selectedChatId,
  onSelectChat,
  onClearChat,
}: {
  selectedAgentId: string | null;
  selectedChatId: string | null;
  onSelectChat: (agentId: string, chatId: string) => void;
  onClearChat: () => void;
}) {
  if (selectedChatId && selectedAgentId) {
    return <ChatView agentId={selectedAgentId} chatId={selectedChatId} onBack={onClearChat} />;
  }
  if (selectedAgentId) {
    return <AgentSummary agentId={selectedAgentId} onSelectChat={onSelectChat} />;
  }
  return <ActivityFeed />;
}

// --- Activity Feed ---

function ActivityFeed() {
  const agentName = useAgentNameMap();

  const { data: overview } = useQuery({
    queryKey: ["overview"],
    queryFn: getOverview,
    refetchInterval: 30_000,
  });

  const { data: activity } = useQuery({
    queryKey: ["activity"],
    queryFn: getActivityOverview,
    refetchInterval: 10_000,
  });

  const { data: notifications } = useQuery({
    queryKey: ["notifications", "feed"],
    queryFn: () => listNotifications({ limit: 20 }),
    refetchInterval: 10_000,
  });

  return (
    <div className="flex-1 overflow-y-auto p-4">
      <h2 className="text-lg font-semibold mb-4">Activity</h2>

      {/* Quick stats */}
      <div className="grid grid-cols-4 gap-3 mb-6">
        {[
          { label: "Agents", value: overview?.agents ?? 0 },
          { label: "Online", value: overview?.onlineAgents ?? 0 },
          { label: "Working", value: activity?.byState.working ?? 0 },
          { label: "Blocked", value: activity?.byState.blocked ?? 0 },
        ].map((s) => (
          <div key={s.label} className="rounded-lg border border-border p-3">
            <div className="text-xs text-muted-foreground">{s.label}</div>
            <div className="text-xl font-bold">{s.value}</div>
          </div>
        ))}
      </div>

      {/* Notification-based activity feed */}
      <div className="space-y-1">
        {(!notifications?.items || notifications.items.length === 0) && (
          <div className="text-sm text-muted-foreground text-center py-8">No recent activity</div>
        )}
        {notifications?.items.map((n) => (
          <div
            key={n.id}
            className={cn("flex items-start gap-2 px-3 py-2 rounded-md text-sm", !n.read && "bg-accent/20")}
          >
            <AlertTriangle
              className={cn(
                "h-4 w-4 mt-0.5 shrink-0",
                n.severity === "high" && "text-red-500",
                n.severity === "medium" && "text-yellow-500",
                n.severity === "low" && "text-muted-foreground",
              )}
            />
            <div className="min-w-0 flex-1">
              <span className="font-medium">{n.agentId ? agentName(n.agentId) : ""}</span>{" "}
              <span className="text-muted-foreground">{n.message}</span>
            </div>
            <span className="text-xs text-muted-foreground shrink-0">{formatDate(n.createdAt)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// --- Agent Summary ---

function AgentSummary({
  agentId,
  onSelectChat,
}: {
  agentId: string;
  onSelectChat: (agentId: string, chatId: string) => void;
}) {
  const agentName = useAgentNameMap();

  const { data: sessions } = useQuery({
    queryKey: ["agent-sessions-all", agentId],
    queryFn: () => listAgentSessions(agentId),
    refetchInterval: 10_000,
  });

  const activeSessions = sessions?.filter((s) => s.state === "active") ?? [];
  const totalSessions = sessions?.length ?? 0;
  const errorSessions = sessions?.filter((s) => s.runtimeState === "error") ?? [];

  return (
    <div className="flex-1 overflow-y-auto p-4">
      <h2 className="text-lg font-semibold mb-1">{agentName(agentId)}</h2>
      <p className="text-sm text-muted-foreground mb-4 font-mono">{agentId}</p>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        <div className="rounded-lg border border-border p-3">
          <div className="text-xs text-muted-foreground">Active</div>
          <div className="text-xl font-bold">{activeSessions.length}</div>
        </div>
        <div className="rounded-lg border border-border p-3">
          <div className="text-xs text-muted-foreground">Total</div>
          <div className="text-xl font-bold">{totalSessions}</div>
        </div>
        <div className="rounded-lg border border-border p-3">
          <div className="text-xs text-muted-foreground">Error</div>
          <div className="text-xl font-bold text-red-600">{errorSessions.length}</div>
        </div>
      </div>

      {/* All Sessions table */}
      <h3 className="text-sm font-medium mb-2">All Sessions</h3>
      <div className="border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">Chat</th>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">State</th>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">Messages</th>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">Last Active</th>
            </tr>
          </thead>
          <tbody>
            {(!sessions || sessions.length === 0) && (
              <tr>
                <td colSpan={4} className="px-3 py-6 text-center text-muted-foreground">
                  No sessions
                </td>
              </tr>
            )}
            {sessions?.map((s) => (
              <tr
                key={s.chatId}
                className="border-b border-border last:border-0 cursor-pointer hover:bg-accent/50 transition-colors"
                onClick={() => onSelectChat(agentId, s.chatId)}
              >
                <td className="px-3 py-2 font-mono text-xs">{s.chatId.slice(0, 12)}...</td>
                <td className="px-3 py-2">
                  <SessionStateBadge state={s.state} />
                </td>
                <td className="px-3 py-2 text-muted-foreground text-xs">{s.messageCount}</td>
                <td className="px-3 py-2 text-muted-foreground text-xs">{formatDate(s.lastActivityAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// --- Chat View ---

function ChatView({ agentId, chatId, onBack }: { agentId: string; chatId: string; onBack: () => void }) {
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

  // Auto-scroll to bottom on new messages
  const messageCount = messagesData?.items?.length ?? 0;
  useEffect(() => {
    if (messageCount > 0) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messageCount]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border shrink-0">
        <button type="button" onClick={onBack} className="text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
        </button>
        <span className="text-sm font-medium">{agentName(agentId)}</span>
        <span className="text-xs text-muted-foreground font-mono">{chatId.slice(0, 8)}...</span>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {(!messagesData?.items || messagesData.items.length === 0) && (
          <div className="text-sm text-muted-foreground text-center py-8">
            <MessageSquare className="h-8 w-8 mx-auto mb-2 opacity-30" />
            Send a message to start the conversation
          </div>
        )}
        {[...(messagesData?.items ?? [])].reverse().map((msg) => (
          <div key={msg.id} className="rounded-md border border-border p-3">
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{agentName(msg.senderId)}</span>
                {msg.source && (
                  <Badge variant="outline" className="text-[10px] opacity-70 px-1 py-0">
                    {msg.source}
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-1">
                <span className="text-xs text-muted-foreground">{formatDate(msg.createdAt)}</span>
                <ReadReceipt msg={msg} myAgentId={myAgentId} />
              </div>
            </div>
            <div className="text-sm">
              {msg.format === "text" ? (
                <p className="whitespace-pre-wrap">
                  {typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)}
                </p>
              ) : (
                <pre className="text-xs bg-muted p-2 rounded overflow-auto max-h-40">
                  {JSON.stringify(msg.content, null, 2)}
                </pre>
              )}
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="shrink-0 border-t border-border p-3 flex gap-2">
        <Input
          placeholder="Type a message..."
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          disabled={sendMut.isPending}
        />
        <Button size="icon" onClick={handleSend} disabled={sendMut.isPending || !draft.trim()}>
          <Send className="h-4 w-4" />
        </Button>
      </div>
      {sendMut.isError && (
        <p className="text-destructive text-xs px-3 pb-2">
          {sendMut.error instanceof Error ? sendMut.error.message : "Failed to send"}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Context Panel (Right Panel) — Three states
// ---------------------------------------------------------------------------

function ContextPanel({
  selectedAgentId,
  selectedChatId,
}: {
  selectedAgentId: string | null;
  selectedChatId: string | null;
}) {
  if (selectedChatId && selectedAgentId) {
    return <SessionContext agentId={selectedAgentId} chatId={selectedChatId} />;
  }
  if (selectedAgentId) {
    return <AgentContext agentId={selectedAgentId} />;
  }
  return <DashboardContext />;
}

// --- Dashboard Context ---

function DashboardContext() {
  const agentName = useAgentNameMap();

  const { data: overview } = useQuery({
    queryKey: ["overview"],
    queryFn: getOverview,
    refetchInterval: 30_000,
  });

  const { data: activity } = useQuery({
    queryKey: ["activity"],
    queryFn: getActivityOverview,
    refetchInterval: 10_000,
  });

  const { data: notifications } = useQuery({
    queryKey: ["notifications", "context"],
    queryFn: () => listNotifications({ limit: 5 }),
    refetchInterval: 30_000,
  });

  return (
    <div className="flex-1 overflow-y-auto p-3 space-y-4">
      <div className="space-y-2">
        {[
          { label: "Clients", value: activity?.clients ?? 0 },
          { label: "Agents", value: overview?.agents ?? 0 },
          { label: "Online", value: overview?.onlineAgents ?? 0 },
          { label: "Working", value: activity?.byState.working ?? 0 },
          { label: "Idle", value: activity?.byState.idle ?? 0 },
          { label: "Blocked", value: activity?.byState.blocked ?? 0 },
          { label: "Error", value: activity?.byState.error ?? 0 },
        ].map((s) => (
          <div key={s.label} className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">{s.label}</span>
            <span className="font-medium">{s.value}</span>
          </div>
        ))}
      </div>

      <div className="border-t border-border pt-3">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Notifications</div>
        {!notifications?.items || notifications.items.length === 0 ? (
          <div className="text-xs text-muted-foreground text-center py-3">No notifications</div>
        ) : (
          <div className="space-y-2">
            {notifications.items.map((n) => (
              <div key={n.id} className={cn("text-xs", !n.read && "font-medium")}>
                <span
                  className={cn(n.severity === "high" && "text-red-500", n.severity === "medium" && "text-yellow-500")}
                >
                  {n.agentId ? agentName(n.agentId) : "System"}
                </span>{" "}
                <span className="text-muted-foreground">{n.message}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// --- Agent Context ---

function formatDuration(connectedAt: string | null): string {
  if (!connectedAt) return "\u2014";
  const ms = Date.now() - new Date(connectedAt).getTime();
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

const NOTIFICATION_TYPE_LABELS: Record<string, string> = {
  agent_error: "Error",
  session_error: "Error",
  agent_blocked: "Blocked",
  agent_stale: "Stale",
  agent_disconnected: "Disconnected",
  agent_connected: "Connected",
  agent_needs_decision: "Decision",
  session_completed: "Completed",
};

function NotificationList({
  notifications,
  agentId,
}: {
  notifications: Array<{
    id: string;
    type: string;
    severity: string;
    message: string;
    read: boolean;
    chatId: string | null;
    createdAt: string;
  }>;
  agentId: string;
}) {
  const [, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();

  const markReadMut = useMutation({
    mutationFn: (id: string) => markNotificationRead(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["notifications", "agent", agentId] });
    },
  });

  return (
    <div className="space-y-1">
      {notifications.map((n) => {
        const hasChatLink = !!n.chatId;
        const label = NOTIFICATION_TYPE_LABELS[n.type] ?? n.type;
        return (
          <button
            key={n.id}
            type="button"
            className={cn(
              "w-full flex items-start gap-1.5 px-2 py-1.5 rounded text-xs text-left transition-colors",
              !n.read && "bg-accent/30",
              hasChatLink && "cursor-pointer hover:bg-accent/50",
            )}
            onClick={() => {
              if (!n.read) markReadMut.mutate(n.id);
              if (hasChatLink) {
                setSearchParams({ a: agentId, c: n.chatId as string });
              }
            }}
          >
            <span className={cn("h-1.5 w-1.5 rounded-full mt-1 shrink-0", !n.read ? "bg-primary" : "bg-transparent")} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1">
                <span
                  className={cn(
                    "font-medium",
                    n.severity === "high" && "text-red-500",
                    n.severity === "medium" && "text-yellow-600",
                    n.severity === "low" && "text-muted-foreground",
                  )}
                >
                  {label}
                </span>
                <span className="text-muted-foreground ml-auto shrink-0">{formatDate(n.createdAt)}</span>
              </div>
              <span className="text-muted-foreground line-clamp-2">{n.message}</span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

function AgentContext({ agentId }: { agentId: string }) {
  const agentName = useAgentNameMap();
  const { resolve: resolveClient } = useClientMap();

  const { data: activity } = useQuery({
    queryKey: ["activity"],
    queryFn: getActivityOverview,
    refetchInterval: 10_000,
  });

  const agent = activity?.agents?.find((a: RuntimeAgent) => a.agentId === agentId);
  const client = resolveClient(agent?.clientId);

  const { data: notifications } = useQuery({
    queryKey: ["notifications", "agent", agentId],
    queryFn: () => listNotifications({ agentId, limit: 5 }),
    refetchInterval: 30_000,
  });

  return (
    <div className="flex-1 overflow-y-auto p-3 space-y-4">
      {/* Agent info */}
      <div className="space-y-2">
        {[
          { label: "Name", value: agentName(agentId) },
          { label: "Status", value: agent?.runtimeState ?? "offline" },
          { label: "Runtime", value: agent?.runtimeType ?? "\u2014" },
          { label: "Active", value: String(agent?.activeSessions ?? 0) },
          { label: "Total", value: String(agent?.totalSessions ?? 0) },
        ].map((s) => (
          <div key={s.label} className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">{s.label}</span>
            <span className="font-medium">{s.value}</span>
          </div>
        ))}
      </div>

      {/* Client info block */}
      <div className="border-t border-border pt-3">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Client</div>
        {client ? (
          <div className="space-y-2">
            {[
              { label: "Hostname", value: client.hostname ?? "\u2014" },
              { label: "OS", value: client.os ?? "\u2014" },
              { label: "SDK", value: client.sdkVersion ?? "\u2014" },
              { label: "Connected", value: formatDuration(client.connectedAt) },
            ].map((s) => (
              <div key={s.label} className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{s.label}</span>
                <span className="font-medium">{s.value}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-xs text-muted-foreground">disconnected</div>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <a href={`/agents/${agentId}`} className="text-xs text-primary hover:underline">
          Manage Agent &rarr;
        </a>
        <a href="/admin#clients" className="text-xs text-primary hover:underline">
          Admin: Clients &rarr;
        </a>
      </div>

      <div className="border-t border-border pt-3">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Notifications</div>
        {!notifications?.items || notifications.items.length === 0 ? (
          <div className="text-xs text-muted-foreground text-center py-3">No notifications for this agent</div>
        ) : (
          <NotificationList notifications={notifications.items} agentId={agentId} />
        )}
      </div>
    </div>
  );
}

// --- Session Context ---

function SessionContext({ agentId, chatId }: { agentId: string; chatId: string }) {
  const queryClient = useQueryClient();

  const { data: session } = useQuery({
    queryKey: ["session", agentId, chatId],
    queryFn: () => listAgentSessions(agentId).then((sessions) => sessions.find((s) => s.chatId === chatId) ?? null),
    refetchInterval: 5_000,
  });

  const suspendMut = useMutation({
    mutationFn: () => suspendSession(agentId, chatId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["session", agentId, chatId] }),
  });

  const resumeMut = useMutation({
    mutationFn: () => resumeSession(agentId, chatId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["session", agentId, chatId] }),
  });

  const terminateMut = useMutation({
    mutationFn: () => terminateSession(agentId, chatId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["session", agentId, chatId] }),
  });

  const isActive = session?.state === "active";
  const isSuspended = session?.state === "suspended";
  const isEvicted = session?.state === "evicted";

  const startedAt = session?.startedAt ? new Date(session.startedAt) : null;
  const duration = startedAt ? Math.floor((Date.now() - startedAt.getTime()) / 60_000) : null;

  return (
    <div className="flex-1 flex flex-col overflow-hidden p-3">
      {/* Session metadata */}
      <div className="space-y-2 mb-3">
        {[
          { label: "State", value: session?.state ?? "—" },
          { label: "Runtime", value: session?.runtimeState ?? "—" },
          { label: "Started", value: session?.startedAt ? formatDate(session.startedAt) : "—" },
          { label: "Duration", value: duration !== null ? `${duration} min` : "—" },
          { label: "Messages", value: String(session?.messageCount ?? 0) },
        ].map((s) => (
          <div key={s.label} className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">{s.label}</span>
            <span className="font-medium">{s.value}</span>
          </div>
        ))}
      </div>

      {/* Control buttons */}
      <div className="flex gap-2 mb-3">
        {isActive && (
          <Button variant="outline" size="sm" onClick={() => suspendMut.mutate()} disabled={suspendMut.isPending}>
            Suspend
          </Button>
        )}
        {isSuspended && (
          <Button variant="outline" size="sm" onClick={() => resumeMut.mutate()} disabled={resumeMut.isPending}>
            Resume
          </Button>
        )}
        {!isEvicted && (
          <Button
            variant="destructive"
            size="sm"
            onClick={() => {
              if (window.confirm("Terminate this session?")) {
                terminateMut.mutate();
              }
            }}
            disabled={terminateMut.isPending}
          >
            Terminate
          </Button>
        )}
      </div>

      {/* Agent notifications for this session */}
      <div className="border-t border-border pt-3 flex-1 overflow-y-auto">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Session Info</div>
        <div className="text-xs text-muted-foreground">
          Chat ID: <span className="font-mono">{chatId.slice(0, 12)}...</span>
        </div>
      </div>
    </div>
  );
}
