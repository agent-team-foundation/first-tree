import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, AlertTriangle, Monitor, Pause, Play, RefreshCw, Server, Unplug } from "lucide-react";
import { useState } from "react";
import {
  disconnectClient,
  getActivityOverview,
  type HubClient,
  listClients,
  type RuntimeAgent,
  resetAgentActivity,
} from "../api/activity.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.js";

function stateColor(state: string | null): string {
  switch (state) {
    case "idle":
      return "text-green-600 bg-green-50";
    case "working":
      return "text-blue-600 bg-blue-50";
    case "error":
      return "text-red-600 bg-red-50";
    default:
      return "text-muted-foreground bg-muted";
  }
}

function StateBadge({ state }: { state: string | null }) {
  if (!state) return <span className="text-muted-foreground text-sm">—</span>;
  return <Badge className={stateColor(state)}>{state}</Badge>;
}

export function ActivityPage() {
  const queryClient = useQueryClient();
  const [view, setView] = useState<"agents" | "clients">("agents");

  const { data: activity, isLoading: activityLoading } = useQuery({
    queryKey: ["activity"],
    queryFn: getActivityOverview,
    refetchInterval: 5_000,
  });

  const { data: clients } = useQuery({
    queryKey: ["clients"],
    queryFn: listClients,
    refetchInterval: 10_000,
  });

  const resetMutation = useMutation({
    mutationFn: resetAgentActivity,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["activity"] }),
  });

  const disconnectMutation = useMutation({
    mutationFn: disconnectClient,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["activity"] });
      queryClient.invalidateQueries({ queryKey: ["clients"] });
    },
  });

  const stats = [
    { label: "Clients", value: activity?.clients, icon: Server },
    { label: "Running", value: activity?.running, icon: Play },
    { label: "Working", value: activity?.byState.working, icon: Activity },
    { label: "Idle", value: activity?.byState.idle, icon: Pause },
    { label: "Error", value: activity?.byState.error, icon: AlertTriangle },
  ];

  return (
    <div>
      <h1 className="text-2xl font-semibold mb-6">Agent Activity</h1>

      {/* Stat cards */}
      <div className="grid gap-4 md:grid-cols-5 mb-6">
        {stats.map((stat) => (
          <Card key={stat.label}>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">{stat.label}</CardTitle>
              <stat.icon className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{activityLoading ? "..." : (stat.value ?? 0)}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* View toggle */}
      <div className="flex gap-2 mb-4">
        <Button variant={view === "agents" ? "default" : "outline"} size="sm" onClick={() => setView("agents")}>
          <Monitor className="h-4 w-4 mr-2" />
          Agent View
        </Button>
        <Button variant={view === "clients" ? "default" : "outline"} size="sm" onClick={() => setView("clients")}>
          <Server className="h-4 w-4 mr-2" />
          Client View
        </Button>
      </div>

      {/* Agent view */}
      {view === "agents" && (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Agent</TableHead>
                  <TableHead>Runtime</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Sessions</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {(!activity?.agents || activity.agents.length === 0) && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                      No running agents
                    </TableCell>
                  </TableRow>
                )}
                {activity?.agents.map((agent: RuntimeAgent) => (
                  <TableRow key={agent.agentId}>
                    <TableCell className="font-medium">{agent.agentId}</TableCell>
                    <TableCell>{agent.runtimeType ?? "—"}</TableCell>
                    <TableCell>
                      <StateBadge state={agent.runtimeState} />
                    </TableCell>
                    <TableCell>
                      {agent.activeSessions !== null ? `${agent.activeSessions}/${agent.totalSessions ?? 0}` : "—"}
                    </TableCell>
                    <TableCell>
                      {agent.runtimeState === "error" && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => resetMutation.mutate(agent.agentId)}
                          disabled={resetMutation.isPending}
                        >
                          <RefreshCw className="h-3 w-3 mr-1" />
                          Reset
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Client view */}
      {view === "clients" && (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Client ID</TableHead>
                  <TableHead>Host</TableHead>
                  <TableHead>OS</TableHead>
                  <TableHead>Agents</TableHead>
                  <TableHead>Connected</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {(!clients || clients.length === 0) && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                      No connected clients
                    </TableCell>
                  </TableRow>
                )}
                {clients?.map((client: HubClient) => (
                  <TableRow key={client.id}>
                    <TableCell className="font-mono text-sm">{client.id}</TableCell>
                    <TableCell>{client.hostname ?? "—"}</TableCell>
                    <TableCell>{client.os ?? "—"}</TableCell>
                    <TableCell>{client.agentCount}</TableCell>
                    <TableCell>
                      {client.connectedAt ? new Date(client.connectedAt).toLocaleString("zh-CN") : "—"}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => disconnectMutation.mutate(client.id)}
                        disabled={disconnectMutation.isPending}
                      >
                        <Unplug className="h-3 w-3 mr-1" />
                        Disconnect
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
