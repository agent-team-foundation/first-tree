import type { CapabilityEntry, ClientCapabilities, RuntimeProvider } from "@first-tree/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import {
  disconnectClient,
  getActivityOverview,
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
import {
  DenseTable,
  DenseTableBody,
  DenseTableCell,
  DenseTableHead,
  DenseTableHeader,
  DenseTableRow,
} from "../components/ui/dense-table.js";
import { PageHeader } from "../components/ui/page-header.js";
import { PresenceChip, runtimeStateToPresence } from "../components/ui/presence-chip.js";
import { RowActionsMenu } from "../components/ui/row-actions-menu.js";
import { UppercaseLabel } from "../components/ui/section-header.js";
import { useAgentNameMap } from "../lib/use-agent-name-map.js";
import { formatDate, formatRelative } from "../lib/utils.js";
import { ComputerCard } from "./clients/cards/computer-card.js";
import {
  PROVIDER_INSTALL_HINT,
  PROVIDER_LABEL,
  PROVIDER_ORDER,
  PROVIDER_UNAUTH_HINT,
} from "./clients/cards/shared/providers.js";
import { ComputerStatusPill } from "./clients/computer-status-pill.js";
import { compareByPillPriority, deriveComputerStatus, summarizeComputers } from "./clients/derive-status.js";
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
  /**
   * Re-auth target — when set, the next NewConnectionDialog opening is
   * scoped to *this specific client.id* so the arrival detector only
   * succeeds when that machine reconnects. Without this, a parallel
   * AuthExpired re-auth on another card could consume the wrong event.
   * Cleared when the dialog closes.
   */
  const [reAuthClientId, setReAuthClientId] = useState<string | null>(null);
  /** Hostname captured when the re-auth was kicked off — drives dialog copy. */
  const [reAuthHostname, setReAuthHostname] = useState<string | null>(null);

  const openNewConnection = (): void => {
    setReAuthClientId(null);
    setReAuthHostname(null);
    setNewConnectionOpen(true);
  };
  const openReAuth = (client: HubClient): void => {
    setReAuthClientId(client.id);
    setReAuthHostname(client.hostname);
    setNewConnectionOpen(true);
  };
  const handleDialogClose = (next: boolean): void => {
    setNewConnectionOpen(next);
    if (!next) {
      setReAuthClientId(null);
      setReAuthHostname(null);
    }
  };

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
  // own machines vs everyone else's. Each group sorts by status pill priority
  // (auth_expired → setup_incomplete → offline → ready) with lastSeenAt as
  // tie-break — surfaces problem rows at the top without forcing the viewer
  // to scan the full list. `userId === null` (legacy clients that pre-date
  // user binding) lands in the team block.
  const mineList = useMemo<HubClient[]>(() => {
    if (!grouped || !orgClientsQuery.data || !user) return [];
    return [...orgClientsQuery.data].filter((c) => c.userId === user.id).sort(compareByPillPriority);
  }, [grouped, orgClientsQuery.data, user]);

  const teamList = useMemo<HubClient[]>(() => {
    if (!grouped || !orgClientsQuery.data || !user) return [];
    return [...orgClientsQuery.data].filter((c) => c.userId !== user.id).sort(compareByPillPriority);
  }, [grouped, orgClientsQuery.data, user]);

  /**
   * Member-mode list (non-admin): the `/me/clients` payload arrives in
   * server-default order (no explicit ORDER BY). Sort by pill priority so
   * an Auth expired row cannot hide below a Ready one. This is a
   * deliberate UX change vs. the prior table — see PR description.
   */
  const memberList = useMemo<HubClient[] | undefined>(() => {
    if (grouped || !meClientsQuery.data) return meClientsQuery.data;
    return [...meClientsQuery.data].sort(compareByPillPriority);
  }, [grouped, meClientsQuery.data]);

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

  // Single source of truth for "what the user is looking at right now": admin
  // grouped mode → the org-scoped list (covers both mineList + teamList);
  // member mode → the pill-sorted memberList. Driving the subtitle and the
  // empty-state branch off this list keeps the two display modes in sync.
  const clients = grouped ? orgClientsQuery.data : memberList;

  // "Are we still waiting on the primary listing?" — distinct from `!clients`
  // because once a query resolves with an empty array we want to drop out of
  // loading and show the empty state. Without this gate, admins see the empty
  // CTA flash before the org-scoped query lands on first paint.
  const clientsLoading = isAdmin
    ? orgClientsQuery.isError
      ? meClientsQuery.isLoading
      : orgClientsQuery.isLoading
    : meClientsQuery.isLoading;

  // Subtitle is the pure-function output of `summarizeComputers` — single
  // headline for one row owned by the viewer ("Your computer is ready"),
  // neutral phrasing when admin is looking at a teammate's lone row, and a
  // zero-suppressed pill-count breakdown for multi-row views. The `· N
  // agents bound` suffix restores the power-user signal the old subtitle
  // surfaced. See `clients/derive-status.ts` for the pure logic + tests.
  const subtitle = useMemo(() => summarizeComputers(clients, user?.id), [clients, user?.id]);

  // Cards now host the per-row affordances (Generate new token, install
  // guide, ⋯ menu) inline, so the PageHeader's right slot no longer needs
  // a "+ Connect" button. The connect entry point lives at the bottom of
  // the page as a low-emphasis "Add another computer" outline button when
  // appropriate (see `addAnotherSpot` below). Single-device + viewer-owned
  // hides the button entirely per mockup §"已敲定" 第 5 条 — a user with
  // exactly one working computer doesn't usually want a second one, and
  // they can still reach the entry via the empty-state CTA after retire.
  const singleOwnCard = !grouped && (memberList?.length ?? 0) === 1 && memberList?.[0]?.userId === user?.id;
  const showBottomAddButton = !singleOwnCard && (clients?.length ?? 0) >= 1;

  return (
    <div className={embedded ? "" : "-m-6"}>
      <PageHeader title="Computers" subtitle={subtitle} />

      <div style={{ padding: "var(--sp-3_5) var(--sp-5) var(--sp-7)" }}>
        <NewConnectionDialog
          open={newConnectionOpen}
          onOpenChange={handleDialogClose}
          targetClientId={reAuthClientId ?? undefined}
          titleOverride={reAuthClientId ? "Re-authenticate computer" : undefined}
          descriptionOverride={
            reAuthClientId
              ? `Run this command on ${reAuthHostname ?? "the computer"} to refresh its access token.`
              : undefined
          }
        />

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
                      <PresenceChip status={runtimeStateToPresence(a.runtimeState)} />
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

        {clientsLoading ? (
          // Hold the page chrome quiet while the primary listing is still
          // in flight. Without this, admins briefly see the "No computers
          // connected yet" empty state on first paint because
          // `orgClientsQuery.data` is `undefined` for one render before the
          // 10s-poll query resolves — a confusing flash on a settings page
          // they're typically returning to, not visiting fresh.
          <div className="py-10 text-body" style={{ color: "var(--fg-4)", textAlign: "center" }}>
            Loading computers…
          </div>
        ) : !clients || clients.length === 0 ? (
          <div>
            {teamLoadError && <TeamLoadErrorBanner />}
            <div
              className="flex flex-col items-center text-center py-10 text-body"
              style={{ color: "var(--fg-3)", gap: "var(--sp-3)" }}
            >
              <span>No computers connected yet.</span>
              <Button size="sm" onClick={openNewConnection}>
                <Plus className="h-3 w-3" />
                Connect your first computer
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col" style={{ gap: "var(--sp-6)" }}>
            {teamLoadError && <TeamLoadErrorBanner />}
            {grouped ? (
              <>
                <CardSection title="Your computers" count={mineList.length}>
                  {mineList.length === 0 ? (
                    <EmptyCardsNote message="No computers of your own." />
                  ) : (
                    <CardGrid>
                      {mineList.map((client) => (
                        <ComputerCard
                          key={client.id}
                          client={client}
                          boundAgents={getClientAgents(client.id)}
                          agentName={agentName}
                          onGenerateNewToken={() => openReAuth(client)}
                          onReconnect={openNewConnection}
                          onDisconnect={() => setConfirmDisconnect(client)}
                          onRetire={() => {
                            setRetireError(null);
                            setConfirmRetire(client);
                          }}
                          ownerLabel={resolveOwner(client)}
                        />
                      ))}
                    </CardGrid>
                  )}
                </CardSection>
                <CardSection title="Team computers" count={teamList.length}>
                  {teamList.length === 0 ? (
                    <EmptyCardsNote message="No other team computers." />
                  ) : (
                    // Team rows stay as table for PR-B — they're read-only,
                    // their primary value is "at a glance, who needs help",
                    // and the per-row inline action affordances cards offer
                    // (Generate new token / install guide) aren't applicable
                    // to teammates. The full team-card redesign with
                    // "Copy suggestion → Alice" buttons is deferred to a
                    // follow-up PR; see proposal §"Variant D".
                    <TeamComputersTable
                      teamList={teamList}
                      collapsedIds={collapsedIds}
                      setCollapsedIds={setCollapsedIds}
                      agentName={agentName}
                      getClientAgents={getClientAgents}
                      resolveOwner={resolveOwner}
                    />
                  )}
                </CardSection>
              </>
            ) : (
              <CardGrid>
                {(memberList ?? []).map((client) => (
                  <ComputerCard
                    key={client.id}
                    client={client}
                    boundAgents={getClientAgents(client.id)}
                    agentName={agentName}
                    onGenerateNewToken={() => openReAuth(client)}
                    onReconnect={openNewConnection}
                    onDisconnect={() => setConfirmDisconnect(client)}
                    onRetire={() => {
                      setRetireError(null);
                      setConfirmRetire(client);
                    }}
                  />
                ))}
              </CardGrid>
            )}

            {showBottomAddButton && (
              <div className="flex justify-center" style={{ paddingTop: "var(--sp-2)" }}>
                <Button variant="outline" size="sm" onClick={openNewConnection}>
                  <Plus className="h-3 w-3" />
                  Add another computer
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Responsive card grid. `auto-fit` with `minmax(min(100%, 35rem), 1fr)`
 * yields 2-up on viewports wider than ~1120 logical units and 1-up
 * below. The 35rem minimum keeps the AuthExpired card's
 * `first-tree login <jwt>` command from wrapping into ugly multi-line
 * fragments inside narrow cards.
 */
function CardGrid({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "grid",
        gap: "var(--sp-4)",
        gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 35rem), 1fr))",
      }}
    >
      {children}
    </div>
  );
}

function CardSection({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <section className="flex flex-col" style={{ gap: "var(--sp-3)" }}>
      <header className="flex items-baseline" style={{ gap: "var(--sp-2)" }}>
        {/*
          `text-subtitle` + `font-semibold` is the same visual weight used by
          PageHeader's section headings — bumping above `text-body` makes the
          "Your computers" / "Team computers" hierarchy survive when both
          sections are present (admin view) and the page is otherwise wall-
          to-wall cards.
        */}
        <h2 className="text-subtitle font-semibold" style={{ margin: 0, color: "var(--fg)" }}>
          {title}
        </h2>
        <span className="text-caption" style={{ color: "var(--fg-4)" }}>
          · {count}
        </span>
      </header>
      {children}
    </section>
  );
}

function EmptyCardsNote({ message }: { message: string }) {
  return (
    <div className="text-body" style={{ color: "var(--fg-4)", padding: "var(--sp-3) var(--sp-1)" }}>
      {message}
    </div>
  );
}

/**
 * Team computers table — preserved from pre-PR-B as the admin's
 * read-only audit view. Wraps the existing `ClientRow` component with
 * the table chrome that used to live inline in `ClientsPage`.
 */
function TeamComputersTable({
  teamList,
  collapsedIds,
  setCollapsedIds,
  agentName,
  getClientAgents,
  resolveOwner,
}: {
  teamList: HubClient[];
  collapsedIds: Set<string>;
  setCollapsedIds: (updater: (prev: Set<string>) => Set<string>) => void;
  agentName: (uuid: string | null | undefined) => string;
  getClientAgents: (clientId: string) => RuntimeAgent[];
  resolveOwner: (client: HubClient) => { text: string; title?: string };
}) {
  return (
    <DenseTable>
      <DenseTableHeader>
        <DenseTableRow>
          <DenseTableHead style={{ width: "var(--sp-4)" }} />
          <DenseTableHead>Hostname</DenseTableHead>
          <DenseTableHead>Owner</DenseTableHead>
          <DenseTableHead>OS</DenseTableHead>
          <DenseTableHead>first-tree</DenseTableHead>
          <DenseTableHead>Agents</DenseTableHead>
          <DenseTableHead>Last seen</DenseTableHead>
          <DenseTableHead>Status</DenseTableHead>
        </DenseTableRow>
      </DenseTableHeader>
      <DenseTableBody>
        {teamList.map((client) => {
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
              onDisconnect={() => {}}
              onRetire={() => {}}
              onReconnect={() => {}}
              showOwner
              ownerLabel={resolveOwner(client)}
              restricted
            />
          );
        })}
      </DenseTableBody>
    </DenseTable>
  );
}

/**
 * Runtime-provider capability matrix shown inside the expanded row of the
 * Computers table. The snapshot is pre-loaded with the list response now
 * (single-source via `/me/clients` / `/orgs/:orgId/clients`), so the
 * matrix renders synchronously — no extra round-trip when a row opens.
 *
 * Constants for label / order / hints live in `cards/shared/providers.ts`
 * — the card-based IA uses the same vocabulary, so duplicating strings
 * here would invite drift.
 */
function CapabilityMatrix({ capabilities }: { capabilities: ClientCapabilities }) {
  const empty = Object.keys(capabilities).length === 0;
  return (
    <>
      <UppercaseLabel style={{ display: "block", marginBottom: 6 }}>Runtimes</UppercaseLabel>
      {empty ? (
        <div className="text-body" style={{ color: "var(--fg-3)" }}>
          Capabilities not yet reported. Reconnect this computer to refresh.
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          {PROVIDER_ORDER.map((provider) => (
            <ProviderRow key={provider} provider={provider} entry={capabilities[provider] ?? null} />
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

// Column count in member mode — `chevron | Hostname | OS | first-tree |
// Agents | Last seen | Status | Actions`. admin mode inserts an Owner column
// between Hostname and OS, bumping the count by 1.
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
  // Row status pill is computed by `deriveComputerStatus` — pure function
  // over (status, authState, capabilities). Encodes the priority rules
  // ("auth expired wins over offline") that previously lived in this
  // component, and unlocks `setup_incomplete` which the prior visuals
  // could not express. See `clients/derive-status.ts`.
  const status = deriveComputerStatus(client);
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
        <DenseTableCell
          className="mono text-caption"
          style={{ color: "var(--fg-4)" }}
          title={formatDate(client.lastSeenAt)}
        >
          {formatRelative(client.lastSeenAt)}
        </DenseTableCell>
        <DenseTableCell>
          <ComputerStatusPill pill={status.pill} />
        </DenseTableCell>
        {/* Overflow menu for row actions. Reconnect / Disconnect / Retire
            are all low-frequency operations (Retire is destructive and
            once-off, Disconnect is rare, Reconnect only matters when offline)
            so a kebab menu keeps the table clean. Team rows in admin view
            get no menu — the underlying ops are owner-checked server-side
            (DELETE /clients/:id 403s on non-owners), so surfacing them here
            would just produce errors. */}
        <DenseTableCell style={{ width: 1, whiteSpace: "nowrap" }}>
          {restricted ? null : (
            <div className="flex items-center justify-end">
              <RowActionsMenu
                ariaLabel="Computer actions"
                actions={[
                  ...(isOffline ? [{ key: "reconnect", label: "Reconnect", onSelect: onReconnect }] : []),
                  { key: "disconnect", label: "Disconnect", onSelect: onDisconnect },
                  { key: "retire", label: "Retire", destructive: true, onSelect: onRetire },
                ]}
              />
            </div>
          )}
        </DenseTableCell>
      </DenseTableRow>
      {effectiveExpanded && (
        <tr style={{ background: "var(--bg-sunken)" }}>
          <DenseTableCell />
          <DenseTableCell colSpan={colSpan - 1} style={{ padding: "var(--sp-2_5) var(--sp-3) var(--sp-3_5)" }}>
            <CapabilityMatrix capabilities={client.capabilities} />
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
                      <PresenceChip status={runtimeStateToPresence(a.runtimeState)} />
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
