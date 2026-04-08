import { AGENT_TYPES } from "@first-tree-hub/shared";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router";
import { listAgents } from "../api/agents.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.js";
import { cn, formatDate } from "../lib/utils.js";

const agentTypeValues = Object.values(AGENT_TYPES);

export function AgentsPage() {
  const navigate = useNavigate();
  const [cursor, setCursor] = useState<string | undefined>();
  const [typeFilter, setTypeFilter] = useState<string>("");

  const { data, isLoading, error } = useQuery({
    queryKey: ["agents", cursor],
    queryFn: () => listAgents({ limit: 20, cursor }),
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
      </div>

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
                        {typeFilter ? `No ${typeFilter} agents` : "No agents yet"}
                      </TableCell>
                    </TableRow>
                  );
                }
                return filtered.map((agent) => (
                  <TableRow key={agent.id} className="cursor-pointer" onClick={() => navigate(`/agents/${agent.id}`)}>
                    <TableCell className="font-mono text-sm">{agent.id}</TableCell>
                    <TableCell>{agent.displayName ?? "\u2014"}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{agent.type}</Badge>
                    </TableCell>
                    <TableCell className="font-mono text-sm text-muted-foreground">
                      {agent.delegateMention ?? "\u2014"}
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
