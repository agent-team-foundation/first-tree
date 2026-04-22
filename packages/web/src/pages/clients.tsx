import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronRight, Copy, Terminal, Trash2, Unplug } from "lucide-react";
import { useMemo, useState } from "react";
import {
  type ConnectTokenResponse,
  disconnectClient,
  generateConnectToken,
  getActivityOverview,
  type HubClient,
  listClients,
  type RuntimeAgent,
  retireClient,
} from "../api/activity.js";
import { ApiError } from "../api/client.js";
import { useAuth } from "../auth/auth-context.js";
import { Button } from "../components/ui/button.js";
import {
  DenseTable,
  DenseTableBody,
  DenseTableCell,
  DenseTableHead,
  DenseTableHeader,
  DenseTableRow,
} from "../components/ui/dense-table.js";
import { PageHeader } from "../components/ui/page-header.js";
import { Panel } from "../components/ui/panel.js";
import { SectionHeader, UppercaseLabel } from "../components/ui/section-header.js";
import { StateChip } from "../components/ui/state-chip.js";
import { useAgentNameMap } from "../lib/use-agent-name-map.js";
import { useUserNameMap } from "../lib/use-user-name-map.js";
import { formatDate } from "../lib/utils.js";

function ConnectStrip() {
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

  return (
    <div
      className="grid items-center gap-2.5 mb-3.5"
      style={{
        gridTemplateColumns: "auto 1fr auto auto",
        padding: "8px 12px",
        background: "var(--bg-raised)",
        border: "1px solid var(--border)",
        borderRadius: 6,
      }}
    >
      <span className="inline-flex items-center gap-2" style={{ color: "var(--fg-2)", fontSize: 12 }}>
        <Terminal className="h-3.5 w-3.5" />
        Connect a computer
      </span>
      {connectData ? (
        <code
          className="mono whitespace-nowrap overflow-hidden text-ellipsis"
          style={{
            fontSize: 11,
            padding: "5px 10px",
            background: "var(--bg-sunken)",
            border: "1px solid var(--border-faint)",
            borderRadius: 4,
            color: "var(--fg-2)",
          }}
          title={connectData.command}
        >
          {connectData.command}{" "}
          <span style={{ color: "var(--fg-4)" }}># expires in {Math.round(connectData.expiresIn / 60)}m</span>
        </code>
      ) : (
        <span className="mono" style={{ fontSize: 11, color: "var(--fg-4)" }}>
          Generate a single-use command to pair a new machine with this Hub.
        </span>
      )}
      <Button variant="outline" size="xs" onClick={handleCopy} disabled={!connectData}>
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        {copied ? "Copied" : "Copy"}
      </Button>
      <Button variant="outline" size="xs" onClick={() => generateMut.mutate()} disabled={generateMut.isPending}>
        {generateMut.isPending ? "Generating…" : connectData ? "Regenerate" : "Generate"}
      </Button>
    </div>
  );
}

export function ClientsPage() {
  const queryClient = useQueryClient();
  const agentName = useAgentNameMap();
  const ownerName = useUserNameMap();
  const { role } = useAuth();
  const isAdmin = role === "admin";
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState<HubClient | null>(null);
  const [confirmRetire, setConfirmRetire] = useState<HubClient | null>(null);
  const [retireError, setRetireError] = useState<string | null>(null);

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

  const retireMut = useMutation({
    mutationFn: retireClient,
    onSuccess: () => {
      setConfirmRetire(null);
      setRetireError(null);
      queryClient.invalidateQueries({ queryKey: ["clients"] });
      queryClient.invalidateQueries({ queryKey: ["activity"] });
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError) setRetireError(err.message);
      else setRetireError(err instanceof Error ? err.message : String(err));
    },
  });

  const agentsByClient = useMemo(() => {
    const map = new Map<string, RuntimeAgent[]>();
    for (const a of activity?.agents ?? []) {
      if (!a.clientId) continue;
      const list = map.get(a.clientId) ?? [];
      list.push(a);
      map.set(a.clientId, list);
    }
    return map;
  }, [activity?.agents]);

  const getClientAgents = (clientId: string): RuntimeAgent[] => agentsByClient.get(clientId) ?? [];

  const connectedCount = (clients ?? []).filter((c) => c.status === "connected").length;
  const totalAgentsBound = (clients ?? []).reduce((n, c) => n + c.agentCount, 0);

  return (
    <div className="-m-6">
      <PageHeader
        title="Computers"
        subtitle={
          clients && clients.length > 0 ? (
            <>
              {clients.length} total · {connectedCount} connected · {totalAgentsBound} agents bound
            </>
          ) : null
        }
      />

      <div style={{ padding: "14px 20px 28px" }}>
        <ConnectStrip />

        {confirmRetire && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
            <div
              className="max-w-md w-full"
              style={{
                background: "var(--bg-raised)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                padding: 24,
                boxShadow: "var(--shadow-md)",
              }}
            >
              <h3 className="text-base font-semibold mb-2">Retire Computer</h3>
              <p className="text-sm mb-3" style={{ color: "var(--fg-3)" }}>
                Permanently remove{" "}
                <span style={{ color: "var(--fg)", fontWeight: 500 }}>
                  {confirmRetire.hostname ?? confirmRetire.id.slice(0, 8)}
                </span>
                . Retire refuses if any agent is still pinned to this computer — you must delete those agents first
                (reassign is not available in this milestone).
              </p>
              {getClientAgents(confirmRetire.id).length > 0 && (
                <div
                  className="mb-3 p-2 rounded"
                  style={{
                    background: "color-mix(in oklch, var(--state-blocked) 12%, transparent)",
                    border: "1px solid color-mix(in oklch, var(--state-blocked) 28%, transparent)",
                  }}
                >
                  <div className="text-xs font-medium mb-1">
                    Agents currently bound to this computer (delete them first):
                  </div>
                  <ul className="text-sm space-y-0.5">
                    {getClientAgents(confirmRetire.id).map((a) => (
                      <li key={a.agentId} className="font-medium">
                        {agentName(a.agentId)}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {retireError && (
                <div
                  className="mb-3 p-2 rounded text-sm"
                  style={{
                    background: "color-mix(in oklch, var(--state-error) 12%, transparent)",
                    border: "1px solid color-mix(in oklch, var(--state-error) 28%, transparent)",
                    color: "var(--state-error)",
                  }}
                >
                  {retireError}
                </div>
              )}
              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setConfirmRetire(null);
                    setRetireError(null);
                  }}
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => retireMut.mutate(confirmRetire.id)}
                  disabled={retireMut.isPending}
                >
                  {retireMut.isPending ? "Retiring…" : "Retire"}
                </Button>
              </div>
            </div>
          </div>
        )}

        {confirmDisconnect && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
            <div
              className="max-w-md w-full"
              style={{
                background: "var(--bg-raised)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                padding: 24,
                boxShadow: "var(--shadow-md)",
              }}
            >
              <h3 className="text-base font-semibold mb-2">Disconnect Computer</h3>
              <p className="text-sm mb-3" style={{ color: "var(--fg-3)" }}>
                This will disconnect{" "}
                <span style={{ color: "var(--fg)", fontWeight: 500 }}>
                  {confirmDisconnect.hostname ?? confirmDisconnect.id.slice(0, 8)}
                </span>{" "}
                and affect all bound agents:
              </p>
              <ul className="mb-4 space-y-1">
                {getClientAgents(confirmDisconnect.id).length === 0 ? (
                  <li className="text-sm" style={{ color: "var(--fg-3)" }}>
                    No bound agents
                  </li>
                ) : (
                  getClientAgents(confirmDisconnect.id).map((a) => (
                    <li key={a.agentId} className="text-sm flex items-center gap-2">
                      <span className="font-medium">{agentName(a.agentId)}</span>
                      <StateChip state={a.runtimeState} />
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
                  {disconnectMut.isPending ? "Disconnecting…" : "Disconnect"}
                </Button>
              </div>
            </div>
          </div>
        )}

        {!clients || clients.length === 0 ? (
          <Panel>
            <div className="text-center py-10" style={{ color: "var(--fg-3)", fontSize: 12 }}>
              No computers. Use the button above to generate a connect command.
            </div>
          </Panel>
        ) : (
          <Panel>
            <SectionHeader
              right={
                <span className="mono" style={{ color: "var(--fg-3)", textTransform: "none", letterSpacing: 0 }}>
                  click a row to expand
                </span>
              }
            >
              Registered · {clients.length}
            </SectionHeader>
            <DenseTable>
              <DenseTableHeader>
                <DenseTableRow>
                  <DenseTableHead style={{ width: 16 }} />
                  <DenseTableHead>Hostname</DenseTableHead>
                  {isAdmin && <DenseTableHead>Owner</DenseTableHead>}
                  <DenseTableHead>OS</DenseTableHead>
                  <DenseTableHead>SDK</DenseTableHead>
                  <DenseTableHead>Agents</DenseTableHead>
                  <DenseTableHead>Connected</DenseTableHead>
                  <DenseTableHead>Status</DenseTableHead>
                  <DenseTableHead />
                </DenseTableRow>
              </DenseTableHeader>
              <DenseTableBody>
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
                      showOwner={isAdmin}
                      ownerName={ownerName}
                      onToggle={() => setExpandedId(isExpanded ? null : client.id)}
                      onDisconnect={() => setConfirmDisconnect(client)}
                      onRetire={() => {
                        setRetireError(null);
                        setConfirmRetire(client);
                      }}
                    />
                  );
                })}
              </DenseTableBody>
            </DenseTable>
          </Panel>
        )}
      </div>
    </div>
  );
}

function ClientRow({
  client,
  boundAgents,
  isExpanded,
  agentName,
  showOwner,
  ownerName,
  onToggle,
  onDisconnect,
  onRetire,
}: {
  client: HubClient;
  boundAgents: RuntimeAgent[];
  isExpanded: boolean;
  agentName: (uuid: string | null | undefined) => string;
  showOwner: boolean;
  ownerName: (userId: string | null | undefined) => string;
  onToggle: () => void;
  onDisconnect: () => void;
  onRetire: () => void;
}) {
  const colSpan = showOwner ? 9 : 8;
  const statusState = client.status === "connected" ? "idle" : "offline";
  return (
    <>
      <DenseTableRow interactive selected={isExpanded} onClick={onToggle}>
        <DenseTableCell style={{ width: 16 }}>
          <span style={{ color: "var(--fg-4)", display: "inline-flex" }}>
            {isExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </span>
        </DenseTableCell>
        <DenseTableCell style={{ fontWeight: 500 }}>{client.hostname ?? "—"}</DenseTableCell>
        {showOwner && <DenseTableCell style={{ color: "var(--fg-2)" }}>{ownerName(client.userId)}</DenseTableCell>}
        <DenseTableCell style={{ color: "var(--fg-3)" }}>{client.os ?? "—"}</DenseTableCell>
        <DenseTableCell className="mono" style={{ fontSize: 11, color: "var(--fg-3)" }}>
          {client.sdkVersion ?? "—"}
        </DenseTableCell>
        <DenseTableCell>
          <span className="mono tnum" style={{ fontSize: 11.5 }}>
            {client.agentCount}
          </span>
        </DenseTableCell>
        <DenseTableCell className="mono" style={{ fontSize: 10.5, color: "var(--fg-4)" }}>
          {client.connectedAt ? formatDate(client.connectedAt) : "—"}
        </DenseTableCell>
        <DenseTableCell>
          <StateChip state={statusState} />
        </DenseTableCell>
        <DenseTableCell style={{ width: 1, whiteSpace: "nowrap" }}>
          <div className="flex gap-1 justify-end">
            <Button
              variant="ghost"
              size="xs"
              className="text-[11px]"
              onClick={(e) => {
                e.stopPropagation();
                onDisconnect();
              }}
            >
              <Unplug className="h-3 w-3" /> Disconnect
            </Button>
            <Button
              variant="ghost"
              size="xs"
              className="text-[11px]"
              style={{ color: "var(--fg-4)" }}
              onClick={(e) => {
                e.stopPropagation();
                onRetire();
              }}
            >
              <Trash2 className="h-3 w-3" /> Retire
            </Button>
          </div>
        </DenseTableCell>
      </DenseTableRow>
      {isExpanded && (
        <tr style={{ background: "var(--bg-sunken)" }}>
          <DenseTableCell />
          <DenseTableCell colSpan={colSpan - 1} style={{ padding: "10px 12px 14px" }}>
            <UppercaseLabel style={{ display: "block", marginBottom: 6 }}>
              Bound agents · {boundAgents.length}
            </UppercaseLabel>
            {boundAgents.length === 0 ? (
              <div className="text-sm" style={{ color: "var(--fg-3)", fontSize: 12 }}>
                No agents bound to this computer
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                {boundAgents.map((a) => (
                  <div key={a.agentId} className="flex items-center gap-2.5" style={{ fontSize: 12 }}>
                    <span className="mono" style={{ fontWeight: 500, minWidth: 180 }}>
                      {agentName(a.agentId)}
                    </span>
                    <StateChip state={a.runtimeState} />
                    {a.activeSessions !== null && (
                      <span className="mono tnum" style={{ fontSize: 10.5, color: "var(--fg-3)" }}>
                        {a.activeSessions} / {a.totalSessions ?? 0} sessions
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </DenseTableCell>
        </tr>
      )}
    </>
  );
}
