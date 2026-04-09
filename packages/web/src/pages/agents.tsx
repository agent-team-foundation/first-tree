import { AGENT_TYPES } from "@first-tree-hub/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { createAgent, listAgents } from "../api/agents.js";
import { type AgentFormData, AgentFormDialog } from "../components/agent-form-dialog.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.js";
import { useAgentNameMap } from "../lib/use-agent-name-map.js";
import { cn, formatDate } from "../lib/utils.js";

const agentTypeValues = Object.values(AGENT_TYPES);

export function AgentsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [cursor, setCursor] = useState<string | undefined>();
  const [typeFilter, setTypeFilter] = useState<string>("");
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const resolveAgentName = useAgentNameMap();

  const { data, isLoading, error } = useQuery({
    queryKey: ["agents", cursor, typeFilter],
    queryFn: () => listAgents({ limit: 20, cursor, type: typeFilter || undefined }),
  });

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

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
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
              <TableHead>Runtime</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                  Loading...
                </TableCell>
              </TableRow>
            ) : error ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center py-8 text-destructive">
                  Failed to load agents: {error instanceof Error ? error.message : "Unknown error"}
                </TableCell>
              </TableRow>
            ) : !data?.items.length ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                  {typeFilter ? `No ${typeFilter} agents` : "No agents yet"}
                </TableCell>
              </TableRow>
            ) : (
              data.items.map((agent) => (
                <TableRow key={agent.uuid} className="cursor-pointer" onClick={() => navigate(`/agents/${agent.uuid}`)}>
                  <TableCell className="font-mono text-sm">{agent.name}</TableCell>
                  <TableCell>{agent.displayName ?? "\u2014"}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">{agent.type}</Badge>
                  </TableCell>
                  <TableCell className="font-mono text-sm text-muted-foreground">
                    {agent.delegateMention ? resolveAgentName(agent.delegateMention) : "\u2014"}
                  </TableCell>
                  <TableCell>
                    {(() => {
                      const a = agent as Record<string, unknown>;
                      const state = a.runtimeState as string | null;
                      if (!state) {
                        return <span className="inline-block h-2 w-2 rounded-full bg-gray-300" title="not running" />;
                      }
                      const colors: Record<string, string> = {
                        idle: "bg-green-500",
                        working: "bg-blue-500",
                        error: "bg-red-500",
                      };
                      return (
                        <span className="flex items-center gap-1.5">
                          <span className={cn("inline-block h-2 w-2 rounded-full", colors[state] ?? "bg-gray-300")} />
                          <span className="text-xs text-muted-foreground">{state}</span>
                        </span>
                      );
                    })()}
                  </TableCell>
                  <TableCell>
                    <Badge variant={agent.status === "active" ? "default" : "destructive"}>{agent.status}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{formatDate(agent.createdAt)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {data?.nextCursor && (
        <div className="flex justify-end mt-4">
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
