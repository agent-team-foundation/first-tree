import { AGENT_TYPES } from "@first-tree-core/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { getSyncStatus, listAgents, triggerSync } from "../api/agents.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.js";
import { cn, formatDate } from "../lib/utils.js";

const agentTypeValues = Object.values(AGENT_TYPES);

export function AgentsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [cursor, setCursor] = useState<string | undefined>();
  const [typeFilter, setTypeFilter] = useState<string>("");

  const { data, isLoading, error } = useQuery({
    queryKey: ["agents", cursor],
    queryFn: () => listAgents({ limit: 20, cursor }),
  });

  const { data: syncStatus } = useQuery({
    queryKey: ["sync-status"],
    queryFn: getSyncStatus,
    refetchInterval: 30_000,
  });

  const syncMutation = useMutation({
    mutationFn: triggerSync,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      queryClient.invalidateQueries({ queryKey: ["sync-status"] });
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
        <div className="flex items-center gap-3">
          {syncStatus?.lastSync && (
            <span className="text-xs text-muted-foreground">Last sync: {formatDate(syncStatus.lastSync.syncedAt)}</span>
          )}
          <Button variant="outline" size="sm" onClick={() => syncMutation.mutate()} disabled={syncMutation.isPending}>
            <RefreshCw className={cn("h-4 w-4 mr-2", syncMutation.isPending && "animate-spin")} />
            {syncMutation.isPending ? "Syncing..." : "Sync Now"}
          </Button>
        </div>
      </div>

      {/* Sync result banner */}
      {syncMutation.data && (
        <div className="mb-4 rounded-md border bg-muted/50 p-3 text-sm">
          <span className="font-medium">Sync complete: </span>
          {syncMutation.data.summary.created > 0 && (
            <Badge variant="default" className="mr-1">
              +{syncMutation.data.summary.created} created
            </Badge>
          )}
          {syncMutation.data.summary.updated > 0 && (
            <Badge variant="secondary" className="mr-1">
              {syncMutation.data.summary.updated} updated
            </Badge>
          )}
          {syncMutation.data.summary.suspended > 0 && (
            <Badge variant="destructive" className="mr-1">
              {syncMutation.data.summary.suspended} suspended
            </Badge>
          )}
          {syncMutation.data.summary.unchanged > 0 && (
            <span className="text-muted-foreground mr-1">{syncMutation.data.summary.unchanged} unchanged</span>
          )}
          {syncMutation.data.summary.errors > 0 && (
            <Badge variant="destructive">{syncMutation.data.summary.errors} errors</Badge>
          )}
        </div>
      )}
      {syncMutation.error instanceof Error && (
        <div className="mb-4 text-sm text-destructive">{syncMutation.error.message}</div>
      )}

      <div className="border rounded-lg">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ID</TableHead>
              <TableHead>Display Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Delegate</TableHead>
              <TableHead>Online</TableHead>
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
            ) : (
              (() => {
                const filtered = typeFilter ? data?.items.filter((a) => a.type === typeFilter) : data?.items;
                if (!filtered || filtered.length === 0) {
                  return (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                        {typeFilter
                          ? `No ${typeFilter} agents`
                          : "No agents yet — click Sync Now to import from Context Tree"}
                      </TableCell>
                    </TableRow>
                  );
                }
                return filtered.map((agent) => (
                  <TableRow key={agent.id} className="cursor-pointer" onClick={() => navigate(`/agents/${agent.id}`)}>
                    <TableCell className="font-mono text-sm">{agent.id}</TableCell>
                    <TableCell>{agent.displayName ?? "—"}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{agent.type}</Badge>
                    </TableCell>
                    <TableCell className="font-mono text-sm text-muted-foreground">
                      {agent.delegateMention ?? "—"}
                    </TableCell>
                    <TableCell>
                      <span
                        className={cn(
                          "inline-block h-2 w-2 rounded-full",
                          agent.presenceStatus === "online" ? "bg-green-500" : "bg-gray-300",
                        )}
                        title={agent.presenceStatus ?? "offline"}
                      />
                    </TableCell>
                    <TableCell>
                      <Badge variant={agent.status === "active" ? "default" : "destructive"}>{agent.status}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{formatDate(agent.createdAt)}</TableCell>
                  </TableRow>
                ));
              })()
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
    </div>
  );
}
