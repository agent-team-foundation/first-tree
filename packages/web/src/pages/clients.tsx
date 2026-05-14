import {
  type CapabilityEntry,
  type ClientCapabilities,
  RUNTIME_PROVIDERS,
  type RuntimeProvider,
} from "@agent-team-foundation/first-tree-hub-shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, type LucideIcon, Plus, User, Users } from "lucide-react";
import { useMemo, useState } from "react";
import {
  type ClientWithCapabilities,
  disconnectClient,
  getActivityOverview,
  getClientCapabilities,
  type HubClient,
  listClients,
  listOrgClients,
  type RuntimeAgent,
  retireClient,
} from "../api/activity.js";
import { ApiError } from "../api/client.js";
import { listMembers } from "../api/members.js";
import { useAuth } from "../auth/auth-context.js";
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
import { PageHeader } from "../components/ui/page-header.js";
import { Panel } from "../components/ui/panel.js";
import { SectionHeader, UppercaseLabel } from "../components/ui/section-header.js";
import { StateChip } from "../components/ui/state-chip.js";
import { useAgentNameMap } from "../lib/use-agent-name-map.js";
import { formatDate } from "../lib/utils.js";
import { NewConnectionDialog } from "./clients/new-connection-dialog.js";

/**
 * `embedded` drops the full-bleed `-m-6` wrapper so this page can be rendered
 * inside another master-detail container (e.g. /settings) whose own outer
 * chrome has already escaped the parent padding.
 *
 * Data-source split (admin vs member):
 *   - **member** mode reads `/me/clients` only — single block, no Owner column,
 *     identical layout to pre-admin-view.
 *   - **admin** mode reads `/orgs/:orgId/clients` as the *single source of truth*
 *     and splits client-side into "Your computers" + "Team computers". The
 *     admin happy path deliberately does NOT call `/me/clients` (the two
 *     endpoints poll on a 10s cadence and a dual-source approach would let
 *     the user's own rows briefly disagree between the blocks on each tick).
 *     `/me/clients` is only resurrected as a *fallback* when the org-scoped
 *     listing errors out, so admins still see something instead of an empty
 *     page. Owner lookup uses `/orgs/:orgId/members` with `staleTime: 60s`
 *     and no polling to keep the Owner cell from flickering.
 */
export function ClientsPage({ embedded = false }: { embedded?: boolean } = {}) {
  const queryClient = useQueryClient();
  const agentName = useAgentNameMap();
  const { role, user } = useAuth();
  const isAdmin = role === "admin";
  // Personal scope: a user typically has 1-3 computers, so expand by default
  // and only let them collapse rows they actively want to hide. New clients
  // arriving via the 10s poll auto-expand too — we only treat the closed set
  // as "rows the user explicitly closed".
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set());
  const [confirmDisconnect, setConfirmDisconnect] = useState<HubClient | null>(null);
  const [confirmRetire, setConfirmRetire] = useState<HubClient | null>(null);
  const [retireError, setRetireError] = useState<string | null>(null);
  const [newConnectionOpen, setNewConnectionOpen] = useState(false);

  const orgClientsQuery = useQuery({
    queryKey: ["clients", "org"],
    queryFn: listOrgClients,
    enabled: isAdmin,
    refetchInterval: 10_000,
  });

  // member mode → primary data source. admin mode → only enabled as a
  // fallback when `/orgs/:orgId/clients` errors out (see §6 of the design
  // doc), so the admin happy path stays single-source.
  const meClientsQuery = useQuery({
    queryKey: ["clients", "me"],
    queryFn: listClients,
    enabled: !isAdmin || orgClientsQuery.isError,
    refetchInterval: 10_000,
  });

  // Members are needed only to resolve the Owner column. They rarely change
  // — `staleTime: 60s` + no polling keeps the Owner cell from flickering
  // back to a short-id during the gap between a refetch firing and its
  // response landing (Owner column relies on the cached map, not just the
  // freshest fetch).
  const membersQuery = useQuery({
    queryKey: ["members"],
    queryFn: listMembers,
    enabled: isAdmin,
    staleTime: 60_000,
  });

  // `grouped` decides whether to render the two-block admin layout (with the
  // Owner column). When the org-scoped listing fails we collapse back to
  // the single-block member-style view so the admin still sees their own
  // computers instead of a broken page.
  const grouped = isAdmin && !orgClientsQuery.isError;
  const teamLoadError = isAdmin && orgClientsQuery.isError;
  const clients = grouped ? orgClientsQuery.data : meClientsQuery.data;

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

  // admin grouped view: split the single org-scoped list into the viewer's
  // own machines vs everyone else's, each sorted by recency. `userId === null`
  // (legacy clients that pre-date user binding) lands in the team block — the
  // viewer isn't its owner, so it doesn't belong in "yours".
  const mineList = useMemo<HubClient[]>(() => {
    if (!grouped || !orgClientsQuery.data || !user) return [];
    return [...orgClientsQuery.data]
      .filter((c) => c.userId === user.id)
      .sort((a, b) => (a.lastSeenAt > b.lastSeenAt ? -1 : a.lastSeenAt < b.lastSeenAt ? 1 : 0));
  }, [grouped, orgClientsQuery.data, user]);

  const teamList = useMemo<HubClient[]>(() => {
    if (!grouped || !orgClientsQuery.data || !user) return [];
    return [...orgClientsQuery.data]
      .filter((c) => c.userId !== user.id)
      .sort((a, b) => (a.lastSeenAt > b.lastSeenAt ? -1 : a.lastSeenAt < b.lastSeenAt ? 1 : 0));
  }, [grouped, orgClientsQuery.data, user]);

  const membersById = useMemo<Map<string, string>>(() => {
    const map = new Map<string, string>();
    for (const m of membersQuery.data ?? []) map.set(m.userId, m.displayName);
    return map;
  }, [membersQuery.data]);

  const resolveOwner = (client: HubClient): { text: string; title?: string } => {
    if (client.userId === null) return { text: "—" };
    if (client.userId === user?.id) {
      const display = membersById.get(client.userId);
      return { text: display ? `${display} (you)` : "you" };
    }
    const display = membersById.get(client.userId);
    if (display) return { text: display };
    // Owner is bound to a userId we can't resolve right now — either the
    // members fetch is still in flight or the user was removed from the org
    // mid-session. Show the short-id with a tooltip carrying the full uuid
    // so the admin has something actionable to copy.
    return { text: client.userId.slice(0, 8), title: client.userId };
  };

  const connectedCount = (clients ?? []).filter((c) => c.status === "connected").length;
  const totalAgentsBound = (clients ?? []).reduce((n, c) => n + c.agentCount, 0);
  const authBrokenCount = (clients ?? []).filter((c) => c.authState !== "ok").length;

  return (
    <div className={embedded ? "" : "-m-6"}>
      <PageHeader
        title="Computers"
        subtitle={
          clients && clients.length > 0 ? (
            <>
              {clients.length} total · {connectedCount} connected · {totalAgentsBound} agents bound
              {authBrokenCount > 0 && (
                <>
                  {" · "}
                  <span style={{ color: "var(--state-error)" }}>{authBrokenCount} need re-auth</span>
                </>
              )}
            </>
          ) : null
        }
        right={
          <div className="flex items-center gap-1.5">
            <Button size="xs" onClick={() => setNewConnectionOpen(true)}>
              <Plus className="h-3 w-3" />
              Connect computer
            </Button>
          </div>
        }
      />

      <div style={{ padding: "var(--sp-3_5) var(--sp-5) var(--sp-7)" }}>
        <NewConnectionDialog open={newConnectionOpen} onOpenChange={setNewConnectionOpen} />

        {confirmRetire && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay-scrim">
            <div
              className="max-w-md w-full"
              style={{
                background: "var(--bg-raised)",
                border: "var(--hairline) solid var(--border)",
                borderRadius: "var(--radius-panel)",
                padding: 24,
                boxShadow: "var(--shadow-md)",
              }}
            >
              <h3 className="text-subtitle mb-2">Retire Computer</h3>
              <p className="text-body mb-3" style={{ color: "var(--fg-3)" }}>
                Permanently remove{" "}
                <span className="font-medium" style={{ color: "var(--fg)" }}>
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
                    border: "var(--hairline) solid color-mix(in oklch, var(--state-blocked) 28%, transparent)",
                  }}
                >
                  <div className="text-label mb-1">Agents currently bound to this computer (delete them first):</div>
                  <ul className="text-body space-y-0.5">
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
                  className="mb-3 p-2 rounded text-body"
                  style={{
                    background: "color-mix(in oklch, var(--state-error) 12%, transparent)",
                    border: "var(--hairline) solid color-mix(in oklch, var(--state-error) 28%, transparent)",
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
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay-scrim">
            <div
              className="max-w-md w-full"
              style={{
                background: "var(--bg-raised)",
                border: "var(--hairline) solid var(--border)",
                borderRadius: "var(--radius-panel)",
                padding: 24,
                boxShadow: "var(--shadow-md)",
              }}
            >
              <h3 className="text-subtitle mb-2">Disconnect Computer</h3>
              <p className="text-body mb-3" style={{ color: "var(--fg-3)" }}>
                This will disconnect{" "}
                <span className="font-medium" style={{ color: "var(--fg)" }}>
                  {confirmDisconnect.hostname ?? confirmDisconnect.id.slice(0, 8)}
                </span>{" "}
                and affect all bound agents:
              </p>
              <ul className="mb-4 space-y-1">
                {getClientAgents(confirmDisconnect.id).length === 0 ? (
                  <li className="text-body" style={{ color: "var(--fg-3)" }}>
                    No bound agents
                  </li>
                ) : (
                  getClientAgents(confirmDisconnect.id).map((a) => (
                    <li key={a.agentId} className="text-body flex items-center gap-2">
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
            {teamLoadError && <TeamLoadErrorBanner />}
            <div className="text-center py-10 text-body" style={{ color: "var(--fg-3)" }}>
              No computers connected. Use the button above to generate a connect command.
            </div>
          </Panel>
        ) : (
          <Panel>
            {teamLoadError && <TeamLoadErrorBanner />}
            <SectionHeader>Registered · {clients.length}</SectionHeader>
            <DenseTable>
              <DenseTableHeader>
                <DenseTableRow>
                  <DenseTableHead style={{ width: 16 }} />
                  <DenseTableHead>Hostname</DenseTableHead>
                  {grouped && <DenseTableHead>Owner</DenseTableHead>}
                  <DenseTableHead>OS</DenseTableHead>
                  <DenseTableHead>SDK</DenseTableHead>
                  <DenseTableHead>Agents</DenseTableHead>
                  <DenseTableHead>Connected</DenseTableHead>
                  <DenseTableHead>Status</DenseTableHead>
                  <DenseTableHead aria-hidden />
                </DenseTableRow>
              </DenseTableHeader>
              <DenseTableBody>
                {grouped ? (
                  <>
                    <GroupHeaderRow
                      icon={User}
                      title="Your computers"
                      count={mineList.length}
                      colSpan={ADMIN_COLSPAN}
                    />
                    {mineList.length === 0 ? (
                      <EmptyGroupRow colSpan={ADMIN_COLSPAN} message="No computers of your own." />
                    ) : (
                      mineList.map((client) => {
                        const isExpanded = !collapsedIds.has(client.id);
                        const boundAgents = getClientAgents(client.id);
                        return (
                          <ClientRow
                            key={client.id}
                            client={client}
                            boundAgents={boundAgents}
                            isExpanded={isExpanded}
                            agentName={agentName}
                            onToggle={() =>
                              setCollapsedIds((prev) => {
                                const next = new Set(prev);
                                if (next.has(client.id)) next.delete(client.id);
                                else next.add(client.id);
                                return next;
                              })
                            }
                            onDisconnect={() => setConfirmDisconnect(client)}
                            onRetire={() => {
                              setRetireError(null);
                              setConfirmRetire(client);
                            }}
                            onReconnect={() => setNewConnectionOpen(true)}
                            showOwner
                            ownerLabel={resolveOwner(client)}
                          />
                        );
                      })
                    )}
                    <GroupHeaderRow
                      icon={Users}
                      title="Team computers"
                      count={teamList.length}
                      colSpan={ADMIN_COLSPAN}
                    />
                    {teamList.length === 0 ? (
                      <EmptyGroupRow colSpan={ADMIN_COLSPAN} message="No other team computers." />
                    ) : (
                      teamList.map((client) => {
                        const isExpanded = !collapsedIds.has(client.id);
                        const boundAgents = getClientAgents(client.id);
                        return (
                          <ClientRow
                            key={client.id}
                            client={client}
                            boundAgents={boundAgents}
                            isExpanded={isExpanded}
                            agentName={agentName}
                            onToggle={() =>
                              setCollapsedIds((prev) => {
                                const next = new Set(prev);
                                if (next.has(client.id)) next.delete(client.id);
                                else next.add(client.id);
                                return next;
                              })
                            }
                            // Team rows are read-only for admins — see ClientRow:restricted
                            // for the full story. Server enforces this too:
                            // `DELETE /clients/:id` 403s on non-owners, and
                            // `GET /clients/:id` (used by the expanded row's
                            // capability matrix) does the same. We don't even
                            // wire the open/close callbacks, since the row is
                            // not interactive.
                            onDisconnect={() => {}}
                            onRetire={() => {}}
                            onReconnect={() => {}}
                            showOwner
                            ownerLabel={resolveOwner(client)}
                            restricted
                          />
                        );
                      })
                    )}
                  </>
                ) : (
                  clients.map((client) => {
                    const isExpanded = !collapsedIds.has(client.id);
                    const boundAgents = getClientAgents(client.id);
                    return (
                      <ClientRow
                        key={client.id}
                        client={client}
                        boundAgents={boundAgents}
                        isExpanded={isExpanded}
                        agentName={agentName}
                        onToggle={() =>
                          setCollapsedIds((prev) => {
                            const next = new Set(prev);
                            if (next.has(client.id)) next.delete(client.id);
                            else next.add(client.id);
                            return next;
                          })
                        }
                        onDisconnect={() => setConfirmDisconnect(client)}
                        onRetire={() => {
                          setRetireError(null);
                          setConfirmRetire(client);
                        }}
                        onReconnect={() => setNewConnectionOpen(true)}
                      />
                    );
                  })
                )}
              </DenseTableBody>
            </DenseTable>
          </Panel>
        )}
      </div>
    </div>
  );
}

const PROVIDER_LABEL: Record<RuntimeProvider, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

const PROVIDER_ORDER: RuntimeProvider[] = [RUNTIME_PROVIDERS.CLAUDE_CODE, RUNTIME_PROVIDERS.CODEX];

const PROVIDER_INSTALL_HINT: Record<RuntimeProvider, string> = {
  "claude-code": "Run `npm install -g @anthropic-ai/claude-code` on this computer.",
  codex: "Install the OpenAI Codex CLI on this computer.",
};

const PROVIDER_UNAUTH_HINT: Record<RuntimeProvider, string> = {
  "claude-code": "Run `claude login` (or set ANTHROPIC_API_KEY) on the computer.",
  codex: "Run `codex login` (or set CODEX_API_KEY) on the computer.",
};

/**
 * Lazy-loaded runtime-provider capability matrix shown inside the expanded
 * row of the Computers table. We only fetch when the row is open so the
 * /clients listing stays cheap on large fleets — capabilities are reported by
 * the client at startup and stored under `clients.metadata.capabilities`.
 */
function CapabilityMatrix({ clientId, enabled }: { clientId: string; enabled: boolean }) {
  const { data, isLoading } = useQuery({
    queryKey: ["client-capabilities", clientId],
    queryFn: () => getClientCapabilities(clientId),
    enabled,
  });
  const capabilities: ClientCapabilities | null = (data as ClientWithCapabilities | undefined)?.capabilities ?? null;
  return (
    <>
      <UppercaseLabel style={{ display: "block", marginBottom: 6 }}>Runtimes</UppercaseLabel>
      {isLoading && !capabilities ? (
        <div className="text-body" style={{ color: "var(--fg-3)" }}>
          Loading…
        </div>
      ) : capabilities && Object.keys(capabilities).length === 0 ? (
        <div className="text-body" style={{ color: "var(--fg-3)" }}>
          Capabilities not yet reported. Reconnect this computer to refresh.
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          {PROVIDER_ORDER.map((provider) => (
            <ProviderRow
              key={provider}
              provider={provider}
              entry={capabilities ? (capabilities[provider] ?? null) : null}
            />
          ))}
        </div>
      )}
    </>
  );
}

function ProviderRow({ provider, entry }: { provider: RuntimeProvider; entry: CapabilityEntry | null }) {
  const label = PROVIDER_LABEL[provider];
  if (!entry) {
    return (
      <div className="flex items-center gap-2.5 text-body" style={{ opacity: 0.7 }}>
        <span className="font-medium" style={{ minWidth: 140 }}>
          {label}
        </span>
        <span className="text-caption" style={{ color: "var(--fg-4)" }}>
          not reported · {PROVIDER_INSTALL_HINT[provider]}
        </span>
      </div>
    );
  }
  switch (entry.state) {
    case "ok":
      return (
        <div className="flex items-center gap-2.5 text-body">
          <span className="font-medium" style={{ minWidth: 140 }}>
            {label}
          </span>
          <span className="text-caption" style={{ color: "var(--state-idle)" }}>
            ✓ {entry.sdkVersion ? `v${entry.sdkVersion} · ` : ""}authenticated ({entry.authMethod})
          </span>
        </div>
      );
    case "unauthenticated":
      return (
        <div className="flex items-center gap-2.5 text-body">
          <span className="font-medium" style={{ minWidth: 140 }}>
            {label}
          </span>
          <span className="text-caption" style={{ color: "var(--state-blocked)" }}>
            ⚠ installed{entry.sdkVersion ? ` v${entry.sdkVersion}` : ""}, not authenticated ·{" "}
            {PROVIDER_UNAUTH_HINT[provider]}
          </span>
        </div>
      );
    case "missing":
      return (
        <div className="flex items-center gap-2.5 text-body" style={{ opacity: 0.7 }}>
          <span className="font-medium" style={{ minWidth: 140 }}>
            {label}
          </span>
          <span className="text-caption" style={{ color: "var(--fg-4)" }}>
            ✗ not installed · {PROVIDER_INSTALL_HINT[provider]}
          </span>
        </div>
      );
    case "error":
      return (
        <div className="flex items-center gap-2.5 text-body">
          <span className="font-medium" style={{ minWidth: 140 }}>
            {label}
          </span>
          <span className="text-caption" style={{ color: "var(--state-error)" }}>
            error · {entry.error ?? "probe failed"}
          </span>
        </div>
      );
  }
}

/**
 * Distinguishes "credentials died" from "machine offline". Server derives
 * the state from offline duration vs configured refresh-token TTL, so the
 * pill flips on its own once the row has been disconnected long enough.
 */
function AuthExpiredChip() {
  return (
    <span
      className="mono inline-flex items-center gap-1.5 uppercase text-caption"
      style={{ color: "var(--state-error)" }}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: "var(--state-error)",
          display: "inline-block",
        }}
      />
      AUTH EXPIRED
    </span>
  );
}

// Column count in member mode — `chevron | Hostname | OS | SDK | Agents |
// Connected | Status | Actions`. admin mode inserts an Owner column between
// Hostname and OS, bumping the count by 1.
const MEMBER_COLSPAN = 8;
const ADMIN_COLSPAN = MEMBER_COLSPAN + 1;

function TeamLoadErrorBanner() {
  return (
    <div
      className="text-body"
      style={{
        margin: "var(--sp-3) var(--sp-3) 0",
        padding: "var(--sp-2_5) var(--sp-3)",
        borderRadius: "var(--radius-panel)",
        background: "color-mix(in oklch, var(--state-error) 12%, transparent)",
        border: "var(--hairline) solid color-mix(in oklch, var(--state-error) 28%, transparent)",
        color: "var(--state-error)",
      }}
    >
      Failed to load team computers. Showing only your computers.
    </div>
  );
}

function GroupHeaderRow({
  icon: Icon,
  title,
  count,
  colSpan,
}: {
  icon: LucideIcon;
  title: string;
  count: number;
  colSpan: number;
}) {
  return (
    <DenseTableRow>
      <td colSpan={colSpan} style={{ padding: "var(--sp-6) var(--sp-3_5) var(--sp-2) 0" }}>
        <span className="inline-flex items-center" style={{ gap: "var(--sp-2)" }}>
          <Icon className="h-4 w-4" aria-hidden style={{ color: "var(--fg-3)" }} />
          <span className="text-body font-medium" style={{ color: "var(--fg)" }}>
            {title}
          </span>
          <DenseBadge tone="outline">{count}</DenseBadge>
        </span>
      </td>
    </DenseTableRow>
  );
}

function EmptyGroupRow({ colSpan, message }: { colSpan: number; message: string }) {
  return (
    <DenseTableRow>
      <td
        colSpan={colSpan}
        className="text-body"
        style={{
          padding: "var(--sp-3) var(--sp-3_5)",
          color: "var(--fg-4)",
        }}
      >
        {message}
      </td>
    </DenseTableRow>
  );
}

function ClientRow({
  client,
  boundAgents,
  isExpanded,
  agentName,
  onToggle,
  onDisconnect,
  onRetire,
  onReconnect,
  showOwner = false,
  ownerLabel,
  restricted = false,
}: {
  client: HubClient;
  boundAgents: RuntimeAgent[];
  isExpanded: boolean;
  agentName: (uuid: string | null | undefined) => string;
  onToggle: () => void;
  onDisconnect: () => void;
  onRetire: () => void;
  onReconnect: () => void;
  /** When true, render the Owner column between Hostname and OS (admin view). */
  showOwner?: boolean;
  /** Resolved owner display value. Required when `showOwner` is true. */
  ownerLabel?: { text: string; title?: string };
  /**
   * Read-only mode for rows the viewer doesn't own (admin viewing team
   * computers). Collapses three behaviors into one flag because they're
   * always toggled together:
   *   - Hides Reconnect / Disconnect / Retire (server-side owner check
   *     would 403 anyway).
   *   - Suppresses the expand chevron and ignores `onToggle` so clicking
   *     the row does nothing (and the capability-matrix `GET /clients/:id`
   *     — which also 403s on non-owners — is never fired, avoiding both
   *     wasted retries and a misleading "not reported" fallback).
   *   - Drops the `interactive` hover styling so the row reads as inert
   *     metadata, not a clickable target.
   */
  restricted?: boolean;
}) {
  const colSpan = showOwner ? ADMIN_COLSPAN : MEMBER_COLSPAN;
  const isOffline = client.status !== "connected";
  // The expanded sub-row carries owner-only capability data — we never let
  // it render in restricted mode (see prop doc). `effectiveExpanded` mirrors
  // `isExpanded` for owner rows and is forced to false for team rows so a
  // stale collapsed-set never accidentally opens one.
  const effectiveExpanded = restricted ? false : isExpanded;
  // Auth health takes priority over the connection state when rendering the
  // row's status pill: "auth expired" must outrank the plain "offline" so
  // the user knows it isn't going to come back without intervention.
  const authBroken = client.authState !== "ok";
  const statusState = client.status === "connected" ? "idle" : "offline";
  return (
    <>
      <DenseTableRow interactive={!restricted} selected={effectiveExpanded} onClick={restricted ? undefined : onToggle}>
        <DenseTableCell style={{ width: 16 }}>
          {restricted ? null : (
            <span style={{ color: "var(--fg-4)", display: "inline-flex" }}>
              {effectiveExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            </span>
          )}
        </DenseTableCell>
        <DenseTableCell className="font-medium">{client.hostname ?? "—"}</DenseTableCell>
        {showOwner && (
          <DenseTableCell style={{ color: "var(--fg-3)" }} title={ownerLabel?.title}>
            {ownerLabel?.text ?? "—"}
          </DenseTableCell>
        )}
        <DenseTableCell style={{ color: "var(--fg-3)" }}>{client.os ?? "—"}</DenseTableCell>
        <DenseTableCell className="mono text-label" style={{ color: "var(--fg-3)" }}>
          {client.sdkVersion ?? "—"}
        </DenseTableCell>
        <DenseTableCell>
          <span className="mono tnum text-label">{client.agentCount}</span>
        </DenseTableCell>
        <DenseTableCell className="mono text-caption" style={{ color: "var(--fg-4)" }}>
          {client.connectedAt ? formatDate(client.connectedAt) : "—"}
        </DenseTableCell>
        <DenseTableCell>{authBroken ? <AuthExpiredChip /> : <StateChip state={statusState} />}</DenseTableCell>
        {/* Plain text actions, always visible. The row already gives them a
            dedicated rightmost cell with whitespace-nowrap, so the three
            options sit in their own column rather than crowding the data.
            Team rows in admin view render an empty cell — the underlying
            ops are owner-checked server-side (DELETE /clients/:id 403s on
            non-owners), so surfacing them here would just produce errors. */}
        <DenseTableCell style={{ width: 1, whiteSpace: "nowrap" }}>
          {restricted ? null : (
            <div className="flex items-center justify-end text-label" style={{ gap: "var(--sp-3_5)" }}>
              {isOffline && (
                <button
                  type="button"
                  className="rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  style={{ color: authBroken ? "var(--state-error)" : "var(--fg-2)" }}
                  onClick={(e) => {
                    e.stopPropagation();
                    onReconnect();
                  }}
                >
                  Reconnect
                </button>
              )}
              <button
                type="button"
                className="rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                style={{ color: "var(--fg-2)" }}
                onClick={(e) => {
                  e.stopPropagation();
                  onDisconnect();
                }}
              >
                Disconnect
              </button>
              <button
                type="button"
                className="rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                style={{ color: "var(--fg-4)" }}
                onClick={(e) => {
                  e.stopPropagation();
                  onRetire();
                }}
              >
                Retire
              </button>
            </div>
          )}
        </DenseTableCell>
      </DenseTableRow>
      {effectiveExpanded && (
        <tr style={{ background: "var(--bg-sunken)" }}>
          <DenseTableCell />
          <DenseTableCell colSpan={colSpan - 1} style={{ padding: "var(--sp-2_5) var(--sp-3) var(--sp-3_5)" }}>
            <CapabilityMatrix clientId={client.id} enabled={effectiveExpanded} />
            {boundAgents.length > 0 && (
              <>
                <UppercaseLabel style={{ display: "block", marginTop: "var(--sp-3)", marginBottom: 6 }}>
                  Bound agents · {boundAgents.length}
                </UppercaseLabel>
                <div className="flex flex-col gap-1">
                  {boundAgents.map((a) => (
                    <div key={a.agentId} className="flex items-center gap-2.5 text-body">
                      <span className="font-medium" style={{ minWidth: 140 }}>
                        {agentName(a.agentId)}
                      </span>
                      <StateChip state={a.runtimeState} />
                      {a.activeSessions !== null && (
                        <span className="mono tnum text-caption" style={{ color: "var(--fg-3)" }}>
                          {a.activeSessions} / {a.totalSessions ?? 0} sessions
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}
          </DenseTableCell>
        </tr>
      )}
    </>
  );
}
