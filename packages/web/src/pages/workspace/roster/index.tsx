import { useMutation, useQuery } from "@tanstack/react-query";
import { Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { getActivityOverview, type RuntimeAgent } from "../../../api/activity.js";
import { createAgentChat } from "../../../api/chats.js";
import { agentSessionsQueryKey, listAgentSessions } from "../../../api/sessions.js";
import { FilterPill } from "../../../components/ui/filter-pill.js";
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
  const pulse = usePulse();
  const [query, setQuery] = useState("");
  const [pill, setPill] = useState<Pill>("all");

  const { data: activity } = useQuery({
    queryKey: ["activity"],
    queryFn: getActivityOverview,
  });

  const { data: sessions } = useQuery({
    queryKey: selectedAgentId ? agentSessionsQueryKey(selectedAgentId) : ["agent-sessions", null],
    queryFn: () => (selectedAgentId ? listAgentSessions(selectedAgentId) : Promise.resolve([])),
    enabled: !!selectedAgentId,
  });

  const newChatMut = useMutation({
    mutationFn: (agentId: string) => createAgentChat(agentId),
    onSuccess: (result, agentId) => {
      // No sessions invalidate here: at chat-creation time the
      // agent_chat_sessions row does NOT yet exist (server only writes it
      // after the user sends a first message — see M plan Step 1b in
      // docs/session-creation-on-first-message.md). The list refresh is
      // therefore moved to chat-view's sendMut.onSuccess.
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
      <div key={agent.agentId} style={{ borderBottom: "var(--hairline) solid var(--border-faint)" }}>
        <button
          type="button"
          onClick={() => onSelectAgent(isSelected ? null : agent.agentId)}
          className={cn("w-full text-left transition-colors grid items-center", "hover:bg-[var(--bg-hover)]")}
          style={{
            gridTemplateColumns: "var(--sp-3_5) 1fr auto",
            columnGap: 8,
            padding: "var(--sp-1_75) var(--sp-2_5) var(--sp-1_75) var(--sp-3)",
            background: isSelected ? "var(--bg-active)" : "transparent",
            borderLeft: `var(--hairline-bold) solid ${isSelected ? "var(--accent)" : "transparent"}`,
          }}
        >
          <StateDot state={state} size={8} />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span
                className="mono truncate text-body font-medium"
                style={{
                  color: "var(--fg)",
                }}
              >
                {agentName(agent.agentId)}
              </span>
              {agent.type === "human" && (
                <span
                  className="mono uppercase text-eyebrow"
                  style={{
                    padding: "var(--hairline) var(--sp-1_25)",
                    borderRadius: 2,
                    color: "var(--accent)",
                    background: "color-mix(in oklch, var(--accent) 15%, transparent)",
                  }}
                >
                  human
                </span>
              )}
            </div>
            <div className="truncate text-body" style={{ color: "var(--fg-3)" }}>
              {state === "offline" ? "disconnected" : host || "\u2014"}
            </div>
          </div>
          <div className="flex flex-col items-end gap-0.5">
            {totalSessions > 0 && (
              <span className="mono tnum text-label" style={{ color: "var(--fg-3)" }}>
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
                className="text-body"
                style={{ padding: "var(--sp-1_75) var(--sp-2_5) var(--sp-1_75) var(--sp-7)", color: "var(--fg-4)" }}
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
                      gridTemplateColumns: "var(--sp-3_5) 1fr",
                      columnGap: 6,
                      padding: "var(--sp-1_75) var(--sp-2_5) var(--sp-1_75) var(--sp-7)",
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
                      className="truncate text-body"
                      style={{ color: s.topic || s.summary ? "var(--fg-2)" : "var(--fg-4)" }}
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
              className="w-full flex items-center text-left transition-colors text-body"
              style={{
                gap: 6,
                padding: "var(--sp-1_75) var(--sp-2_5) var(--sp-1_75) var(--sp-7)",
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
        borderRight: "var(--hairline) solid var(--border)",
      }}
    >
      {/* Header */}
      <div
        className="shrink-0"
        style={{
          padding: "var(--sp-2_5) var(--sp-3) var(--sp-2)",
          borderBottom: "var(--hairline) solid var(--border-faint)",
        }}
      >
        <div style={{ marginBottom: 8 }}>
          <span className="mono uppercase text-eyebrow" style={{ color: "var(--fg-3)" }}>
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
            className="w-full outline-none text-body"
            style={{
              padding: "var(--sp-1_25) var(--sp-2) var(--sp-1_25) var(--sp-6_5)",
              background: "var(--bg-sunken)",
              border: "var(--hairline) solid var(--border)",
              borderRadius: "var(--radius-input)",
              color: "var(--fg)",
            }}
          />
        </div>
        <div className="flex gap-1" style={{ marginTop: 8 }}>
          {pills.map((p) => (
            <FilterPill
              key={p.value}
              active={pill === p.value}
              count={p.count}
              warn={p.warn}
              onClick={() => setPill(p.value)}
            >
              {p.label}
            </FilterPill>
          ))}
        </div>
      </div>

      {/* Pulse */}
      <div
        className="shrink-0"
        style={{
          padding: "var(--sp-2) var(--sp-3)",
          borderBottom: "var(--hairline) solid var(--border-faint)",
        }}
      >
        <div className="flex items-center justify-between" style={{ marginBottom: 4 }}>
          <span className="mono flex items-center gap-1.5 text-eyebrow" style={{ color: "var(--fg-3)" }}>
            <PulseIcon />
            5m
          </span>
          <span className="mono text-body" style={{ color: "var(--fg-4)" }}>
            {pulse.stale ? "stale" : "live"}
          </span>
        </div>
        <PulseBar aggregated={pulse.aggregated} stale={pulse.stale} />
        <div className="flex justify-between text-body" style={{ marginTop: 6 }}>
          <span className="mono" style={{ color: "var(--state-working)" }}>
            {liveCounts.working} working
          </span>
          <span className="mono" style={{ color: "var(--state-blocked)" }}>
            {liveCounts.blocked} blocked
          </span>
          <span className="mono" style={{ color: "var(--state-error)" }}>
            {liveCounts.error} error
          </span>
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {totalVisible === 0 && (
          <div className="text-center text-body" style={{ padding: "var(--sp-6) var(--sp-3)", color: "var(--fg-3)" }}>
            {query || pill !== "all" ? (
              "No matches"
            ) : (
              <>
                <p style={{ margin: 0 }}>No agents</p>
                <p className="text-label" style={{ margin: "var(--sp-1) 0 0", color: "var(--fg-4)" }}>
                  Your first agent will appear here.
                </p>
              </>
            )}
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
    // Inner roster group header (Agents / Humans) — unified with the global
    // SectionHeader via the shared `text-eyebrow` token. Kept as a local
    // component because the sticky-top / background behavior is roster-specific.
    <div
      className="mono uppercase sticky top-0 z-10 text-eyebrow"
      style={{
        padding: "var(--sp-1_25) var(--sp-3)",
        color: "var(--fg-4)",
        background: "var(--bg-raised)",
        borderBottom: "var(--hairline) solid var(--border-faint)",
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
