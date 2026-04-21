import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { listAdapterMappings } from "../api/adapter-mappings.js";
import { getAdapterStatuses } from "../api/adapter-status.js";
import { listAdapters } from "../api/adapters.js";
import { Badge } from "../components/ui/badge.js";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.js";
import { useAgentNameMap } from "../lib/use-agent-name-map.js";
import { cn, formatDate } from "../lib/utils.js";

export function BindingsPage() {
  const navigate = useNavigate();
  const resolveAgentName = useAgentNameMap();

  const { data: adapters, isLoading: loadingAdapters } = useQuery({
    queryKey: ["adapters"],
    queryFn: listAdapters,
  });

  const { data: mappings, isLoading: loadingMappings } = useQuery({
    queryKey: ["adapter-mappings"],
    queryFn: listAdapterMappings,
  });

  const { data: botStatuses } = useQuery({
    queryKey: ["adapter-statuses"],
    queryFn: getAdapterStatuses,
    refetchInterval: 15_000,
  });

  const isLoading = loadingAdapters || loadingMappings;

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Overview of platform bindings for agents you can manage. Configure each binding from the Agent detail page.
      </p>

      {/* Bot Bindings (non-human agents) */}
      <Card>
        <CardHeader>
          <CardTitle>Bot Bindings</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Agent</TableHead>
                <TableHead>Platform</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Connection</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-4 text-muted-foreground">
                    Loading...
                  </TableCell>
                </TableRow>
              ) : !adapters?.length ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-4 text-muted-foreground">
                    No bot bindings
                  </TableCell>
                </TableRow>
              ) : (
                adapters.map((a) => {
                  const status = botStatuses?.find((s) => s.configId === a.id);
                  return (
                    <TableRow key={a.id} className="cursor-pointer" onClick={() => navigate(`/agents/${a.agentId}`)}>
                      <TableCell className="font-mono text-sm">{resolveAgentName(a.agentId)}</TableCell>
                      <TableCell>
                        <Badge variant="secondary">{a.platform}</Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant={a.status === "active" ? "default" : "destructive"}>{a.status}</Badge>
                      </TableCell>
                      <TableCell>
                        <span className="flex items-center gap-1.5">
                          <span
                            className={cn(
                              "inline-block h-2 w-2 rounded-full",
                              status?.connected ? "bg-green-500" : "bg-gray-300",
                            )}
                          />
                          <span className="text-xs text-muted-foreground">
                            {status?.connected ? "Online" : "Offline"}
                          </span>
                        </span>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{formatDate(a.createdAt)}</TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* User Bindings (human agents) */}
      <Card>
        <CardHeader>
          <CardTitle>User Bindings</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Agent</TableHead>
                <TableHead>Platform</TableHead>
                <TableHead>External User ID</TableHead>
                <TableHead>Display Name</TableHead>
                <TableHead>Bound Via</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-4 text-muted-foreground">
                    Loading...
                  </TableCell>
                </TableRow>
              ) : !mappings?.length ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-4 text-muted-foreground">
                    No user bindings
                  </TableCell>
                </TableRow>
              ) : (
                mappings.map((m) => (
                  <TableRow key={m.id} className="cursor-pointer" onClick={() => navigate(`/agents/${m.agentId}`)}>
                    <TableCell className="font-mono text-sm">{resolveAgentName(m.agentId)}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{m.platform}</Badge>
                    </TableCell>
                    <TableCell className="font-mono text-sm">{m.externalUserId}</TableCell>
                    <TableCell>{m.displayName ?? "—"}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{m.boundVia ?? "—"}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{formatDate(m.createdAt)}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
