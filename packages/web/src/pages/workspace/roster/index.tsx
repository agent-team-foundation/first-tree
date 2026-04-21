import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { getActivityOverview, type RuntimeAgent } from "../../../api/activity.js";
import { createAgentChat } from "../../../api/chats.js";
import { agentSessionsQueryKey, listAgentSessions } from "../../../api/sessions.js";
import { StateDot } from "../../../components/ui/state-dot.js";
import { usePulse } from "../../../hooks/pulse-context.js";
import { useAgentNameMap } from "../../../lib/use-agent-name-map.js";
import { useClientMap } from "../../../lib/use-client-map.js";
import { cn } from "../../../lib/utils.js";
import { resolveAgentState } from "../../../utils/agent-state.js";
import { PulseBar } from "./pulse-bar.js";

const RUNTIME_SORT_ORDER: Record<string, number> = { error: 0, blocked: 1, working: 2, idle: 3 };

function runtimeSortKey(state: string | null, clientId: string | null): number {
  if (!clientId) return 5;
  if (!state) return 4;
  return RUNTIME_SORT_ORDER[state] ?? 4;
}

type Pill = "all" | "active" | "attn";

function matchesPill(agent: RuntimeAgent, pill: Pill): boolean {
  if (pill === "all") return true;
  if (pill === "active") return agent.runtimeState === "working";
  return agent.runtimeState === "blocked" || agent.runtimeState === "error";
}

export function AgentRoster({
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
  const pulse = usePulse();
  const [query, setQuery] = useState("");
  const [pill, setPill] = useState<Pill>("all");

  const { data: activity } = useQuery({
    queryKey: ["activity"],
    queryFn: getActivityOverview,
    refetchInterval: 10_000,
  });

  const { data: sessions } = useQuery({
    queryKey: selectedAgentId ? agentSessionsQueryKey(selectedAgentId) : ["agent-sessions", null],
    queryFn: () => (selectedAgentId ? listAgentSessions(selectedAgentId) : Promise.resolve([])),
    enabled: !!selectedAgentId,
    refetchInterval: 10_000,
  });

  const newChatMut = useMutation({
    mutationFn: (agentId: string) => createAgentChat(agentId),
    onSuccess: (result, agentId) => {
      queryClient.invalidateQueries({ queryKey: agentSessionsQueryKey(agentId) });
      onSelectChat(agentId, result.id);
    },
  });

  const { humans, agents, totalAll } = useMemo(() => {
    const all = activity?.agents ?? [];
    const q = query.trim().toLowerCase();
    const filtered = all.filter((a) => {
      if (!matchesPill(a, pill)) return false;
      if (!q) return true;
      const name = agentName(a.agentId).toLowerCase();
      const host = a.clientId ? (resolveClient(a.clientId)?.hostname ?? "").toLowerCase() : "";
      return name.includes(q) || host.includes(q) || a.agentId.toLowerCase().includes(q);
    });
    const sortKey = (a: RuntimeAgent) => runtimeSortKey(a.runtimeState, a.clientId);
    const humans: RuntimeAgent[] = [];
    const agents: RuntimeAgent[] = [];
    for (const a of filtered) (a.type === "human" ? humans : agents).push(a);
    humans.sort((a, b) => sortKey(a) - sortKey(b));
    agents.sort((a, b) => sortKey(a) - sortKey(b));
    return { humans, agents, totalAll: all.length };
  }, [activity, query, pill, agentName, resolveClient]);

  const liveCounts = useMemo(() => {
    const all = activity?.agents ?? [];
    return {
      working: all.filter((a) => a.runtimeState === "working").length,
      blocked: all.filter((a) => a.runtimeState === "blocked").length,
      error: all.filter((a) => a.runtimeState === "error").length,
    };
  }, [activity]);

  const pills: { value: Pill; label: string; count: number; warn?: boolean }[] = [
    { value: "all", label: "all", count: totalAll },
    { value: "active", label: "active", count: liveCounts.working },
    {
      value: "attn",
      label: "attn",
      count: liveCounts.blocked + liveCounts.error,
      warn: liveCounts.blocked + liveCounts.error > 0,
    },
  ];

  const renderRow = (agent: RuntimeAgent) => {
    const isSelected = selectedAgentId === agent.agentId;
    const state = resolveAgentState(agent.runtimeState, agent.clientId);
    const host = agent.clientId ? (resolveClient(agent.clientId)?.hostname ?? agent.clientId.slice(0, 8)) : null;
    const activeSessions = agent.activeSessions ?? 0;
    const totalSessions = agent.totalSessions ?? 0;

    return (
      <div key={agent.agentId} style={{ borderBottom: "1px solid var(--border-faint)" }}>
        <button
          type="button"
          onClick={() => onSelectAgent(isSelected ? null : agent.agentId)}
          className={cn("w-full text-left transition-colors grid items-center", "hover:bg-[var(--bg-hover)]")}
          style={{
            gridTemplateColumns: "14px 1fr auto",
            columnGap: 8,
            padding: "7px 10px 7px 12px",
            background: isSelected ? "var(--bg-active)" : "transparent",
            borderLeft: `2px solid ${isSelected ? "var(--accent)" : "transparent"}`,
          }}
        >
          <StateDot state={state} size={8} />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span
                className="mono truncate"
                style={{
                  fontSize: 12,
                  fontWeight: 500,
                  color: "var(--fg)",
                  letterSpacing: -0.1,
                }}
              >
                {agentName(agent.agentId)}
              </span>
              {agent.type === "human" && (
                <span
                  className="mono"
                  style={{
                    fontSize: 9,
                    padding: "1px 5px",
                    borderRadius: 2,
                    textTransform: "uppercase",
                    letterSpacing: 0.08,
                    color: "var(--accent)",
                    background: "color-mix(in oklch, var(--accent) 15%, transparent)",
                  }}
                >
                  human
                </span>
              )}
            </div>
            <div className="truncate" style={{ fontSize: 10.5, color: "var(--fg-3)" }}>
              {state === "offline" ? "disconnected" : host || "\u2014"}
            </div>
          </div>
          <div className="flex flex-col items-end gap-0.5">
            {totalSessions > 0 && (
              <span className="mono tnum" style={{ fontSize: 9, color: "var(--fg-3)" }}>
                {activeSessions}
                <span style={{ color: "var(--fg-4)" }}> / {totalSessions}</span>
              </span>
            )}
          </div>
        </button>

        {isSelected && (
          <div style={{ background: "var(--bg-sunken)", paddingBottom: 4 }}>
            {(!sessions || sessions.length === 0) && (
              <div
                style={{
                  padding: "4px 10px 4px 28px",
                  fontSize: 10.5,
                  color: "var(--fg-4)",
                }}
              >
                No sessions yet
              </div>
            )}
            {sessions
              ?.filter((s) => s.state !== "evicted")
              .map((s) => {
                const runtime = s.state === "active" ? "working" : "idle";
                return (
                  <button
                    key={s.chatId}
                    type="button"
                    onClick={() => onSelectChat(agent.agentId, s.chatId)}
                    className="w-full grid items-center text-left transition-colors"
                    style={{
                      gridTemplateColumns: "14px 1fr",
                      columnGap: 6,
                      padding: "4px 10px 4px 28px",
                      background: selectedChatId === s.chatId ? "var(--bg-hover)" : "transparent",
                      color: s.state === "active" ? "var(--fg-2)" : "var(--fg-3)",
                    }}
                    onMouseEnter={(e) => {
                      if (selectedChatId !== s.chatId) e.currentTarget.style.background = "var(--bg-hover)";
                    }}
                    onMouseLeave={(e) => {
                      if (selectedChatId !== s.chatId) e.currentTarget.style.background = "transparent";
                    }}
                  >
                    <StateDot state={runtime} size={6} />
                    <span
                      className="truncate"
                      style={{ fontSize: 11, color: s.topic || s.summary ? "var(--fg-2)" : "var(--fg-4)" }}
                    >
                      {s.topic || s.summary || `Chat · ${s.chatId.slice(0, 8)}`}
                    </span>
                  </button>
                );
              })}
            <button
              type="button"
              onClick={() => newChatMut.mutate(agent.agentId)}
              disabled={newChatMut.isPending}
              className="w-full flex items-center text-left transition-colors"
              style={{
                gap: 6,
                padding: "4px 10px 4px 28px",
                fontSize: 10.5,
                color: "var(--fg-3)",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--bg-hover)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "transparent";
              }}
            >
              <Plus className="h-3 w-3" />
              New chat
            </button>
          </div>
        )}
      </div>
    );
  };

  const totalVisible = humans.length + agents.length;

  return (
    <aside
      className="shrink-0 flex flex-col overflow-hidden"
      style={{
        width: 268,
        background: "var(--bg-raised)",
        borderRight: "1px solid var(--border)",
      }}
    >
      {/* Header */}
      <div
        className="shrink-0"
        style={{
          padding: "10px 12px 8px",
          borderBottom: "1px solid var(--border-faint)",
        }}
      >
        <div style={{ marginBottom: 8 }}>
          <span
            className="mono uppercase"
            style={{
              fontSize: 10,
              color: "var(--fg-3)",
              letterSpacing: 0.08,
            }}
          >
            {totalAll} members
          </span>
        </div>
        <div className="relative">
          <Search
            className="h-3.5 w-3.5 absolute pointer-events-none"
            style={{
              left: 8,
              top: "50%",
              transform: "translateY(-50%)",
              color: "var(--fg-4)",
            }}
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter…"
            className="w-full outline-none"
            style={{
              padding: "5px 8px 5px 26px",
              fontSize: 12,
              background: "var(--bg-sunken)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              color: "var(--fg)",
            }}
          />
        </div>
        <div className="flex gap-1" style={{ marginTop: 8 }}>
          {pills.map((p) => {
            const active = pill === p.value;
            return (
              <button
                key={p.value}
                type="button"
                onClick={() => setPill(p.value)}
                className="inline-flex items-center"
                style={{
                  fontSize: 10,
                  padding: "3px 7px",
                  borderRadius: 3,
                  gap: 4,
                  color: active ? "var(--fg)" : "var(--fg-3)",
                  background: active ? "var(--bg-active)" : "transparent",
                  border: `1px solid ${active ? "var(--border-strong)" : "var(--border)"}`,
                }}
              >
                {p.label}
                <span
                  className="mono"
                  style={{
                    color: p.warn && p.count > 0 ? "var(--state-error)" : "var(--fg-4)",
                  }}
                >
                  {p.count}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Pulse */}
      <div
        className="shrink-0"
        style={{
          padding: "8px 12px",
          borderBottom: "1px solid var(--border-faint)",
        }}
      >
        <div className="flex items-center justify-between" style={{ marginBottom: 4 }}>
          <span
            className="mono uppercase flex items-center gap-1.5"
            style={{ fontSize: 10, color: "var(--fg-3)", letterSpacing: 0.08 }}
          >
            <PulseIcon />
            Pulse · 5m
          </span>
          <span className="mono" style={{ fontSize: 10, color: "var(--fg-4)" }}>
            {pulse.stale ? "stale" : "live"}
          </span>
        </div>
        <PulseBar aggregated={pulse.aggregated} stale={pulse.stale} />
        <div className="flex" style={{ gap: 10, marginTop: 6, fontSize: 10 }}>
          <span className="mono" style={{ color: "var(--state-working)" }}>
            ●{liveCounts.working} working
          </span>
          <span className="mono" style={{ color: "var(--state-blocked)" }}>
            ●{liveCounts.blocked} blocked
          </span>
          <span className="mono" style={{ color: "var(--state-error)" }}>
            ●{liveCounts.error} error
          </span>
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {totalVisible === 0 && (
          <div className="text-center" style={{ padding: "24px 12px", fontSize: 12, color: "var(--fg-3)" }}>
            {query || pill !== "all" ? "No matches" : "No agents"}
          </div>
        )}
        {agents.length > 0 && (
          <div>
            <SectionHeader label="Agents" count={agents.length} />
            {agents.map(renderRow)}
          </div>
        )}
        {humans.length > 0 && (
          <div>
            <SectionHeader label="Humans" count={humans.length} />
            {humans.map(renderRow)}
          </div>
        )}
      </div>
    </aside>
  );
}

function SectionHeader({ label, count }: { label: string; count: number }) {
  return (
    <div
      className="mono uppercase sticky top-0 z-10"
      style={{
        padding: "5px 12px",
        fontSize: 9,
        letterSpacing: 0.12,
        color: "var(--fg-4)",
        background: "var(--bg-raised)",
        borderBottom: "1px solid var(--border-faint)",
      }}
    >
      {label} · {count}
    </div>
  );
}

function PulseIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      focusable="false"
      style={{ color: "var(--accent)" }}
    >
      <title>pulse</title>
      <path
        d="M1 8 h3 l1.5 -4 l3 8 l2 -4 h4.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
