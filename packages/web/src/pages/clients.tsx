import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronRight, Copy, Terminal, Unplug } from "lucide-react";
import { useState } from "react";
import {
  type ConnectTokenResponse,
  disconnectClient,
  generateConnectToken,
  getActivityOverview,
  type HubClient,
  listClients,
  type RuntimeAgent,
} from "../api/activity.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.js";
import { useAgentNameMap } from "../lib/use-agent-name-map.js";
import { cn, formatDate } from "../lib/utils.js";

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

function ConnectCommandBanner() {
  const [connectData, setConnectData] = useState<ConnectTokenResponse | null>(null);
  const [copied, setCopied] = useState(false);

  const generateMut = useMutation({
    mutationFn: generateConnectToken,
    onSuccess: (data) => {
      setConnectData(data);
      setCopied(false);
    },
  });

  const handleCopy = async () => {
    if (!connectData) return;
    await navigator.clipboard.writeText(connectData.command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!connectData) {
    return (
      <div className="flex items-center gap-3 mb-4 p-3 border border-border rounded-lg bg-muted/30">
        <Terminal className="h-4 w-4 text-muted-foreground shrink-0" />
        <span className="text-sm text-muted-foreground">Connect a new client to this Hub</span>
        <Button variant="outline" size="sm" onClick={() => generateMut.mutate()} disabled={generateMut.isPending}>
          {generateMut.isPending ? "Generating..." : "Generate Connect Command"}
        </Button>
      </div>
    );
  }

  return (
    <div className="mb-4 p-3 border border-border rounded-lg bg-muted/30 space-y-2">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Terminal className="h-4 w-4 shrink-0" />
        <span>Run this command in your terminal (expires in {connectData.expiresIn / 60} min):</span>
      </div>
      <div className="flex items-center gap-2">
        <code className="flex-1 text-xs bg-background border border-border rounded px-3 py-2 font-mono break-all select-all">
          {connectData.command}
        </code>
        <Button variant="outline" size="sm" onClick={handleCopy} className="shrink-0">
          {copied ? <Check className="h-3 w-3 mr-1" /> : <Copy className="h-3 w-3 mr-1" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">This token is single-use. Generate a new one if it expires.</p>
    </div>
  );
}

export function ClientsPage() {
  const queryClient = useQueryClient();
  const agentName = useAgentNameMap();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState<HubClient | null>(null);

  const { data: clients } = useQuery({
    queryKey: ["clients"],
    queryFn: listClients,
    refetchInterval: 10_000,
  });

  const { data: activity } = useQuery({
    queryKey: ["activity"],
    queryFn: getActivityOverview,
    refetchInterval: 10_000,
  });

  const disconnectMut = useMutation({
    mutationFn: disconnectClient,
    onSuccess: () => {
      setConfirmDisconnect(null);
      queryClient.invalidateQueries({ queryKey: ["clients"] });
      queryClient.invalidateQueries({ queryKey: ["activity"] });
    },
  });

  // Build clientId → agents[] mapping
  const agentsByClient = new Map<string, RuntimeAgent[]>();
  if (activity?.agents) {
    for (const a of activity.agents) {
      if (a.clientId) {
        const list = agentsByClient.get(a.clientId) ?? [];
        list.push(a);
        agentsByClient.set(a.clientId, list);
      }
    }
  }

  const getClientAgents = (clientId: string): RuntimeAgent[] => agentsByClient.get(clientId) ?? [];

  return (
    <div>
      <ConnectCommandBanner />

      {/* Confirm disconnect dialog */}
      {confirmDisconnect && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-card border border-border rounded-lg p-6 max-w-md w-full shadow-lg">
            <h3 className="text-lg font-semibold mb-2">Disconnect Client</h3>
            <p className="text-sm text-muted-foreground mb-3">
              This will disconnect{" "}
              <span className="font-medium text-foreground">
                {confirmDisconnect.hostname ?? confirmDisconnect.id.slice(0, 8)}
              </span>{" "}
              and affect all bound agents:
            </p>
            <ul className="mb-4 space-y-1">
              {getClientAgents(confirmDisconnect.id).length === 0 ? (
                <li className="text-sm text-muted-foreground">No bound agents</li>
              ) : (
                getClientAgents(confirmDisconnect.id).map((a) => (
                  <li key={a.agentId} className="text-sm flex items-center gap-2">
                    <span className="font-medium">{agentName(a.agentId)}</span>
                    <RuntimeBadge state={a.runtimeState} />
                  </li>
                ))
              )}
            </ul>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setConfirmDisconnect(null)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => disconnectMut.mutate(confirmDisconnect.id)}
                disabled={disconnectMut.isPending}
              >
                {disconnectMut.isPending ? "Disconnecting..." : "Disconnect"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {!clients || clients.length === 0 ? (
        <div className="text-center text-muted-foreground py-12">
          No connected clients. Use the button above to generate a connect command.
        </div>
      ) : (
        <div className="border rounded-lg overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>Hostname</TableHead>
                <TableHead>OS</TableHead>
                <TableHead>SDK</TableHead>
                <TableHead>Agents</TableHead>
                <TableHead>Connected</TableHead>
                <TableHead>Status</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {clients.map((client) => {
                const isExpanded = expandedId === client.id;
                const boundAgents = getClientAgents(client.id);
                return (
                  <ClientRow
                    key={client.id}
                    client={client}
                    boundAgents={boundAgents}
                    isExpanded={isExpanded}
                    agentName={agentName}
                    onToggle={() => setExpandedId(isExpanded ? null : client.id)}
                    onDisconnect={() => setConfirmDisconnect(client)}
                  />
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function ClientRow({
  client,
  boundAgents,
  isExpanded,
  agentName,
  onToggle,
  onDisconnect,
}: {
  client: HubClient;
  boundAgents: RuntimeAgent[];
  isExpanded: boolean;
  agentName: (uuid: string | null | undefined) => string;
  onToggle: () => void;
  onDisconnect: () => void;
}) {
  return (
    <>
      <TableRow className="cursor-pointer hover:bg-accent/50" onClick={onToggle}>
        <TableCell className="px-2">
          {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </TableCell>
        <TableCell className="font-medium">{client.hostname ?? "\u2014"}</TableCell>
        <TableCell className="text-muted-foreground">{client.os ?? "\u2014"}</TableCell>
        <TableCell className="font-mono text-xs text-muted-foreground">{client.sdkVersion ?? "\u2014"}</TableCell>
        <TableCell>{client.agentCount}</TableCell>
        <TableCell className="text-muted-foreground text-sm">
          {client.connectedAt ? formatDate(client.connectedAt) : "\u2014"}
        </TableCell>
        <TableCell>
          <Badge variant={client.status === "connected" ? "default" : "secondary"}>{client.status}</Badge>
        </TableCell>
        <TableCell>
          <Button
            variant="outline"
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              onDisconnect();
            }}
          >
            <Unplug className="h-3 w-3 mr-1" />
            Disconnect
          </Button>
        </TableCell>
      </TableRow>
      {isExpanded && (
        <TableRow>
          <TableCell colSpan={8} className="bg-muted/30 px-8 py-3">
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
              Bound Agents ({boundAgents.length})
            </div>
            {boundAgents.length === 0 ? (
              <div className="text-sm text-muted-foreground">No agents bound to this client</div>
            ) : (
              <div className="space-y-1">
                {boundAgents.map((a) => (
                  <div key={a.agentId} className="flex items-center gap-3 text-sm">
                    <span className="font-medium">{agentName(a.agentId)}</span>
                    <RuntimeBadge state={a.runtimeState} />
                    <span className="text-xs text-muted-foreground">
                      {a.activeSessions !== null ? `${a.activeSessions}/${a.totalSessions ?? 0} sessions` : ""}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
