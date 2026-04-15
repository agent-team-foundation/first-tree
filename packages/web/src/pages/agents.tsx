import type { Agent } from "@agent-team-foundation/first-tree-hub-shared";
import { AGENT_TYPES } from "@agent-team-foundation/first-tree-hub-shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { createAgent, listAgents } from "../api/agents.js";
import { useAuth } from "../auth/auth-context.js";
import { type AgentFormData, AgentFormDialog } from "../components/agent-form-dialog.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.js";
import { useAgentNameMap } from "../lib/use-agent-name-map.js";
import { useMemberNameMap } from "../lib/use-member-name-map.js";
import { cn, formatDate } from "../lib/utils.js";

const agentTypeValues = Object.values(AGENT_TYPES);

function sortByName(agents: Agent[]): Agent[] {
  return [...agents].sort((a, b) => {
    const nameA = (a.name ?? a.displayName ?? "").toLowerCase();
    const nameB = (b.name ?? b.displayName ?? "").toLowerCase();
    return nameA.localeCompare(nameB);
  });
}

export function AgentsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { memberId } = useAuth();
  const [cursor, setCursor] = useState<string | undefined>();
  const [typeFilter, setTypeFilter] = useState<string>("");
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const resolveAgentName = useAgentNameMap();
  const resolveMemberName = useMemberNameMap();

  const { data, isLoading, error } = useQuery({
    queryKey: ["agents", cursor, typeFilter],
    queryFn: () => listAgents({ limit: 100, cursor, type: typeFilter || undefined }),
  });

  const { myAgents, teamAgents } = useMemo(() => {
    if (!data?.items) return { myAgents: [], teamAgents: [] };
    const my: Agent[] = [];
    const team: Agent[] = [];
    for (const agent of data.items) {
      if (memberId && agent.managerId === memberId) {
        my.push(agent);
      } else {
        team.push(agent);
      }
    }
    return { myAgents: sortByName(my), teamAgents: sortByName(team) };
  }, [data, memberId]);

  const createMutation = useMutation({
    mutationFn: (formData: AgentFormData) =>
      createAgent({
        name: formData.name,
        type: formData.type,
        displayName: formData.displayName ?? undefined,
        delegateMention: formData.delegateMention ?? undefined,
      }),
    onSuccess: (agent) => {
      setCreateDialogOpen(false);
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      navigate(`/agents/${agent.uuid}`);
    },
  });

  function renderAgentRow(agent: Agent) {
    const ext = agent as Record<string, unknown>;
    const runtimeState = ext.runtimeState as string | null;
    const runtimeColors: Record<string, string> = {
      idle: "bg-green-500",
      working: "bg-blue-500",
      error: "bg-red-500",
    };

    return (
      <TableRow key={agent.uuid} className="cursor-pointer" onClick={() => navigate(`/agents/${agent.uuid}`)}>
        <TableCell className="font-mono text-sm">{agent.name}</TableCell>
        <TableCell>{agent.displayName ?? "\u2014"}</TableCell>
        <TableCell>
          <Badge variant="secondary">{agent.type}</Badge>
        </TableCell>
        <TableCell className="font-mono text-sm text-muted-foreground">
          {agent.delegateMention ? resolveAgentName(agent.delegateMention) : "\u2014"}
        </TableCell>
        <TableCell className="text-sm text-muted-foreground">{resolveMemberName(agent.managerId)}</TableCell>
        <TableCell>
          {runtimeState ? (
            <span className="flex items-center gap-1.5">
              <span className={cn("inline-block h-2 w-2 rounded-full", runtimeColors[runtimeState] ?? "bg-gray-300")} />
              <span className="text-xs text-muted-foreground">{runtimeState}</span>
            </span>
          ) : (
            <span className="inline-block h-2 w-2 rounded-full bg-gray-300" title="not running" />
          )}
        </TableCell>
        <TableCell>
          <Badge variant={agent.status === "active" ? "default" : "destructive"}>{agent.status}</Badge>
        </TableCell>
        <TableCell className="text-muted-foreground">{formatDate(agent.createdAt)}</TableCell>
      </TableRow>
    );
  }

  return (
    <div className="space-y-8">
      {/* Page header with type filter */}
      <div className="flex items-center gap-4">
        <h1 className="text-2xl font-semibold">Agents</h1>
        <select
          value={typeFilter}
          onChange={(e) => {
            setTypeFilter(e.target.value);
            setCursor(undefined);
          }}
          className="h-8 rounded-md border border-input bg-transparent px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <option value="">All types</option>
          {agentTypeValues.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>

      {isLoading ? (
        <div className="text-center py-8 text-muted-foreground">Loading...</div>
      ) : error ? (
        <div className="text-center py-8 text-destructive">
          Failed to load agents: {error instanceof Error ? error.message : "Unknown error"}
        </div>
      ) : (
        <>
          {/* My Agents */}
          <section>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-medium">My Agents</h2>
              <Button size="sm" onClick={() => setCreateDialogOpen(true)}>
                <Plus className="h-4 w-4 mr-2" />
                New Agent
              </Button>
            </div>
            <div className="border rounded-lg">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Display Name</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Delegate</TableHead>
                    <TableHead>Owner</TableHead>
                    <TableHead>Runtime</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {myAgents.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                        No agents yet — create one to get started
                      </TableCell>
                    </TableRow>
                  ) : (
                    myAgents.map((agent) => renderAgentRow(agent))
                  )}
                </TableBody>
              </Table>
            </div>
          </section>

          {/* Team Agents */}
          {teamAgents.length > 0 && (
            <section>
              <h2 className="text-lg font-medium mb-3">Team Agents</h2>
              <div className="border rounded-lg">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Display Name</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Delegate</TableHead>
                      <TableHead>Owner</TableHead>
                      <TableHead>Runtime</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Created</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>{teamAgents.map((agent) => renderAgentRow(agent))}</TableBody>
                </Table>
              </div>
            </section>
          )}
        </>
      )}

      {data?.nextCursor && (
        <div className="flex justify-end">
          <Button variant="outline" onClick={() => setCursor(data.nextCursor ?? undefined)}>
            Next Page
          </Button>
        </div>
      )}

      <AgentFormDialog
        mode="create"
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        onSubmit={(formData) => createMutation.mutate(formData)}
        isPending={createMutation.isPending}
        error={createMutation.error instanceof Error ? createMutation.error : null}
      />
    </div>
  );
}
