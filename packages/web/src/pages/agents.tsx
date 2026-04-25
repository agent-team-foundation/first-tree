import type { Agent } from "@agent-team-foundation/first-tree-hub-shared";
import { AGENT_TYPES } from "@agent-team-foundation/first-tree-hub-shared";
import { useQuery } from "@tanstack/react-query";
import { Plus, Search } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { getActivityOverview, type RuntimeAgent } from "../api/activity.js";
import { listAgents } from "../api/agents.js";
import { useAuth } from "../auth/auth-context.js";
import { LastStepModal } from "../components/last-step-modal.js";
import { NewAgentDialog } from "../components/new-agent-dialog.js";
import { Button } from "../components/ui/button.js";
import { DenseBadge } from "../components/ui/dense-badge.js";
import {
  DenseTable,
  DenseTableBody,
  DenseTableCell,
  DenseTableHead,
  DenseTableHeader,
  DenseTableRow,
} from "../components/ui/dense-table.js";
import { FilterPill } from "../components/ui/filter-pill.js";
import { PageHeader } from "../components/ui/page-header.js";
import { Panel } from "../components/ui/panel.js";
import { SectionHeader } from "../components/ui/section-header.js";
import { StateDot } from "../components/ui/state-dot.js";
import { useAgentNameMap } from "../lib/use-agent-name-map.js";
import { useMemberNameMap } from "../lib/use-member-name-map.js";
import { formatDate } from "../lib/utils.js";

const agentTypeValues = Object.values(AGENT_TYPES);

type RuntimeInfo = {
  runtimeState: string | null;
};

function sortByName(agents: Agent[]): Agent[] {
  return [...agents].sort((a, b) => {
    const nameA = (a.name ?? a.displayName ?? "").toLowerCase();
    const nameB = (b.name ?? b.displayName ?? "").toLowerCase();
    return nameA.localeCompare(nameB);
  });
}

function pickRuntime(agent: Agent, map: Map<string, RuntimeAgent>): RuntimeInfo {
  const r = map.get(agent.uuid);
  return {
    runtimeState: r?.runtimeState ?? null,
  };
}

function countByRuntime(agents: Agent[], map: Map<string, RuntimeAgent>, state: string): number {
  let n = 0;
  for (const a of agents) {
    if (map.get(a.uuid)?.runtimeState === state) n++;
  }
  return n;
}

type PillKey = "all" | "mine" | "running" | "attn";

export function AgentsPage() {
  const navigate = useNavigate();
  const { memberId } = useAuth();
  const [cursor, setCursor] = useState<string | undefined>();
  const [typeFilter, setTypeFilter] = useState<string>("");
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [lastStepAgent, setLastStepAgent] = useState<Agent | null>(null);
  const [pill, setPill] = useState<PillKey>("all");
  const [search, setSearch] = useState("");
  const resolveAgentName = useAgentNameMap();
  const resolveMemberName = useMemberNameMap();

  const { data, isLoading, error } = useQuery({
    queryKey: ["agents", cursor, typeFilter],
    queryFn: () => listAgents({ limit: 100, cursor, type: typeFilter || undefined }),
  });

  const { data: activity } = useQuery({
    queryKey: ["activity"],
    queryFn: getActivityOverview,
    refetchInterval: 10_000,
  });

  const runtimeMap = useMemo(() => {
    const map = new Map<string, RuntimeAgent>();
    for (const r of activity?.agents ?? []) map.set(r.agentId, r);
    return map;
  }, [activity?.agents]);

  const { myAgents, teamAgents } = useMemo(() => {
    if (!data?.items) return { myAgents: [], teamAgents: [] };
    const my: Agent[] = [];
    const team: Agent[] = [];
    for (const agent of data.items) {
      if (memberId && agent.managerId === memberId) my.push(agent);
      else team.push(agent);
    }
    return { myAgents: sortByName(my), teamAgents: sortByName(team) };
  }, [data, memberId]);

  const totalCount = data?.items.length ?? 0;
  const mineCount = myAgents.length;
  const teamCount = teamAgents.length;
  const runningCount = useMemo(
    () => (data?.items ?? []).filter((a) => runtimeMap.get(a.uuid)?.runtimeState === "working").length,
    [data?.items, runtimeMap],
  );
  const attnCount = useMemo(
    () =>
      (data?.items ?? []).filter((a) => {
        const s = runtimeMap.get(a.uuid)?.runtimeState;
        return s === "blocked" || s === "error";
      }).length,
    [data?.items, runtimeMap],
  );

  function matchesPill(agent: Agent): boolean {
    const s = runtimeMap.get(agent.uuid)?.runtimeState;
    if (pill === "mine") return memberId != null && agent.managerId === memberId;
    if (pill === "running") return s === "working";
    if (pill === "attn") return s === "blocked" || s === "error";
    return true;
  }

  function matchesSearch(agent: Agent): boolean {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    const delegate = agent.delegateMention ? resolveAgentName(agent.delegateMention) : "";
    const owner = resolveMemberName(agent.managerId);
    return (
      (agent.name ?? "").toLowerCase().includes(q) ||
      (agent.displayName ?? "").toLowerCase().includes(q) ||
      delegate.toLowerCase().includes(q) ||
      owner.toLowerCase().includes(q)
    );
  }

  const filteredMy = myAgents.filter((a) => matchesPill(a) && matchesSearch(a));
  const filteredTeam = teamAgents.filter((a) => matchesPill(a) && matchesSearch(a));

  function handleCreated(agent: Agent, runtime: "claude-code" | "kael") {
    setCreateDialogOpen(false);
    if (agent.clientId) {
      navigate(`/?a=${agent.uuid}`);
      return;
    }
    if (runtime === "claude-code") {
      setLastStepAgent(agent);
      return;
    }
    navigate(`/?a=${agent.uuid}`);
  }

  return (
    <div className="-m-6">
      <PageHeader
        title="Agents"
        subtitle={
          totalCount > 0 ? (
            <>
              {totalCount} total · {mineCount} mine · {teamCount} team
            </>
          ) : null
        }
        right={
          <div className="flex items-center gap-1.5">
            <Button size="xs" onClick={() => setCreateDialogOpen(true)}>
              <Plus className="h-3 w-3" />
              New agent
            </Button>
          </div>
        }
      />

      <div style={{ padding: "var(--sp-3_5) var(--sp-5) var(--sp-7)" }}>
        <div
          className="flex items-center gap-2.5 mb-3.5"
          style={{
            padding: "var(--sp-2) var(--sp-2_5)",
            background: "var(--bg-raised)",
            border: "var(--hairline) solid var(--border)",
            borderRadius: "var(--radius-panel)",
          }}
        >
          <div className="relative" style={{ width: 240 }}>
            <Search
              className="absolute pointer-events-none"
              style={{ left: 8, top: "50%", transform: "translateY(-50%)", color: "var(--fg-4)" }}
              size={13}
            />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter by name, delegate, owner…"
              className="w-full outline-none text-body"
              style={{
                padding: "var(--sp-1_25) var(--sp-2_5) var(--sp-1_25) var(--sp-7)",
                background: "var(--bg-sunken)",
                border: "var(--hairline) solid var(--border)",
                borderRadius: "var(--radius-input)",
                color: "var(--fg)",
              }}
            />
          </div>
          <div className="flex gap-1">
            <FilterPill active={pill === "all"} count={totalCount} onClick={() => setPill("all")}>
              all
            </FilterPill>
            <FilterPill active={pill === "mine"} count={mineCount} onClick={() => setPill("mine")}>
              mine
            </FilterPill>
            <FilterPill active={pill === "running"} count={runningCount} onClick={() => setPill("running")}>
              running
            </FilterPill>
            <FilterPill active={pill === "attn"} count={attnCount} warn onClick={() => setPill("attn")}>
              attn
            </FilterPill>
          </div>
          <div style={{ flex: 1 }} />
          <select
            value={typeFilter}
            onChange={(e) => {
              setTypeFilter(e.target.value);
              setCursor(undefined);
            }}
            className="outline-none text-label"
            style={{
              padding: "var(--sp-1_25) var(--sp-2_5)",
              background: "var(--bg-sunken)",
              border: "var(--hairline) solid var(--border)",
              borderRadius: "var(--radius-input)",
              color: "var(--fg)",
            }}
          >
            <option value="">all types</option>
            {agentTypeValues.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>

        {isLoading ? (
          <div className="text-center py-8" style={{ color: "var(--fg-3)" }}>
            Loading…
          </div>
        ) : error ? (
          <div className="text-center py-8" style={{ color: "var(--state-error)" }}>
            Failed to load agents: {error instanceof Error ? error.message : "Unknown error"}
          </div>
        ) : (
          <>
            <AgentsPanel
              title={`My agents · ${filteredMy.length}`}
              agents={filteredMy}
              runtimeMap={runtimeMap}
              resolveAgentName={resolveAgentName}
              resolveMemberName={resolveMemberName}
              navigate={navigate}
              showOwner={false}
              emptyLabel={
                myAgents.length === 0
                  ? "No agents yet — create one to get started"
                  : "No agents match the current filter"
              }
              breakdown={
                <StateBreakdown
                  items={[
                    { state: "working", count: countByRuntime(myAgents, runtimeMap, "working") },
                    { state: "blocked", count: countByRuntime(myAgents, runtimeMap, "blocked") },
                    { state: "error", count: countByRuntime(myAgents, runtimeMap, "error") },
                  ]}
                />
              }
              className="mb-4"
            />

            {teamAgents.length > 0 && (
              <AgentsPanel
                title={`Team agents · ${filteredTeam.length}`}
                agents={filteredTeam}
                runtimeMap={runtimeMap}
                resolveAgentName={resolveAgentName}
                resolveMemberName={resolveMemberName}
                navigate={navigate}
                showOwner
                emptyLabel="No agents match the current filter"
                breakdown={
                  <StateBreakdown
                    items={[
                      { state: "working", count: countByRuntime(teamAgents, runtimeMap, "working") },
                      { state: "blocked", count: countByRuntime(teamAgents, runtimeMap, "blocked") },
                      { state: "error", count: countByRuntime(teamAgents, runtimeMap, "error") },
                    ]}
                  />
                }
              />
            )}
          </>
        )}

        {data?.nextCursor && (
          <div className="flex justify-end mt-4">
            <Button variant="outline" size="xs" onClick={() => setCursor(data.nextCursor ?? undefined)}>
              Next page
            </Button>
          </div>
        )}
      </div>

      <NewAgentDialog open={createDialogOpen} onOpenChange={setCreateDialogOpen} onCreated={handleCreated} />

      {lastStepAgent && (
        <LastStepModal
          agent={lastStepAgent}
          open={lastStepAgent !== null}
          onClose={() => {
            const uuid = lastStepAgent.uuid;
            setLastStepAgent(null);
            navigate(`/?a=${uuid}`);
          }}
          onBound={(bound) => {
            setLastStepAgent(null);
            navigate(`/?a=${bound.uuid}`);
          }}
        />
      )}
    </div>
  );
}

type NavigateFn = ReturnType<typeof useNavigate>;

function AgentsPanel({
  title,
  agents,
  runtimeMap,
  resolveAgentName,
  resolveMemberName,
  navigate,
  emptyLabel,
  breakdown,
  className,
  showOwner,
}: {
  title: string;
  agents: Agent[];
  runtimeMap: Map<string, RuntimeAgent>;
  resolveAgentName: (mention: string | null | undefined) => string;
  resolveMemberName: (id: string | null | undefined) => string;
  navigate: NavigateFn;
  emptyLabel: string;
  breakdown?: ReactNode;
  className?: string;
  showOwner: boolean;
}) {
  return (
    <Panel className={className}>
      <SectionHeader right={breakdown}>{title}</SectionHeader>
      {agents.length === 0 ? (
        <div className="text-center py-8 text-body" style={{ color: "var(--fg-3)" }}>
          {emptyLabel}
        </div>
      ) : (
        <DenseTable>
          <DenseTableHeader>
            <DenseTableRow>
              <DenseTableHead>Name</DenseTableHead>
              <DenseTableHead>Display</DenseTableHead>
              <DenseTableHead>Type</DenseTableHead>
              <DenseTableHead>Delegate</DenseTableHead>
              {showOwner && <DenseTableHead>Owner</DenseTableHead>}
              <DenseTableHead>Runtime</DenseTableHead>
              <DenseTableHead>Status</DenseTableHead>
              <DenseTableHead>Created</DenseTableHead>
            </DenseTableRow>
          </DenseTableHeader>
          <DenseTableBody>
            {agents.map((agent) => (
              <AgentRow
                key={agent.uuid}
                agent={agent}
                runtime={pickRuntime(agent, runtimeMap)}
                resolveAgentName={resolveAgentName}
                resolveMemberName={resolveMemberName}
                navigate={navigate}
                showOwner={showOwner}
              />
            ))}
          </DenseTableBody>
        </DenseTable>
      )}
    </Panel>
  );
}

function StateBreakdown({ items }: { items: Array<{ state: string; count: number; label?: string }> }) {
  const nonZero = items.filter((i) => i.count > 0);
  if (nonZero.length === 0) return null;
  return (
    <span className="inline-flex items-center">
      {nonZero.map((item, idx) => (
        <span key={item.state} className="inline-flex items-center">
          {idx > 0 && (
            <span style={{ color: "var(--fg-4)", margin: "0 var(--sp-1_5)" }} aria-hidden>
              ·
            </span>
          )}
          <span
            className="mono inline-flex items-center gap-1 text-caption"
            style={{ color: `var(--state-${item.state})` }}
          >
            <span aria-hidden>●</span>
            {item.count} {item.label ?? item.state}
          </span>
        </span>
      ))}
    </span>
  );
}

function AgentRow({
  agent,
  runtime,
  resolveAgentName,
  resolveMemberName,
  navigate,
  showOwner,
}: {
  agent: Agent;
  runtime: RuntimeInfo;
  resolveAgentName: (mention: string | null | undefined) => string;
  resolveMemberName: (id: string | null | undefined) => string;
  navigate: NavigateFn;
  showOwner: boolean;
}) {
  const { runtimeState } = runtime;
  const isKnownState =
    runtimeState === "idle" ||
    runtimeState === "working" ||
    runtimeState === "blocked" ||
    runtimeState === "error" ||
    runtimeState === "offline";
  return (
    <DenseTableRow interactive onClick={() => navigate(`/agents/${agent.uuid}`)}>
      <DenseTableCell>
        <span className="mono font-medium">{agent.name}</span>
      </DenseTableCell>
      <DenseTableCell style={{ color: "var(--fg-2)" }}>{agent.displayName ?? "—"}</DenseTableCell>
      <DenseTableCell>
        <DenseBadge tone={agent.type === "autonomous_agent" ? "accent" : "neutral"}>{agent.type}</DenseBadge>
      </DenseTableCell>
      <DenseTableCell
        className="mono text-label"
        style={{ color: agent.delegateMention ? "var(--accent-dim)" : "var(--fg-4)" }}
      >
        {agent.delegateMention ? resolveAgentName(agent.delegateMention) : "—"}
      </DenseTableCell>
      {showOwner && (
        <DenseTableCell className="text-label" style={{ color: "var(--fg-2)" }}>
          {resolveMemberName(agent.managerId)}
        </DenseTableCell>
      )}
      <DenseTableCell>
        {runtimeState && isKnownState ? (
          <span className="inline-flex items-center gap-1.5">
            <StateDot state={runtimeState} size={7} />
            <span className="mono text-caption" style={{ color: "var(--fg-3)" }}>
              {runtimeState}
            </span>
          </span>
        ) : (
          <span className="mono text-caption" style={{ color: "var(--fg-4)" }}>
            —
          </span>
        )}
      </DenseTableCell>
      <DenseTableCell>
        <DenseBadge tone={agent.status === "active" ? "accent" : "outline"}>{agent.status}</DenseBadge>
      </DenseTableCell>
      <DenseTableCell className="mono text-caption" style={{ color: "var(--fg-4)" }}>
        {formatDate(agent.createdAt)}
      </DenseTableCell>
    </DenseTableRow>
  );
}
