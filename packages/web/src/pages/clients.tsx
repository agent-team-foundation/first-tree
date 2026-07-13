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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog.js";
import { PresenceChip, runtimeStateToPresence } from "../components/ui/presence-chip.js";
import { RowActionsMenu } from "../components/ui/row-actions-menu.js";
import { Section } from "../components/ui/section.js";
import { UppercaseLabel } from "../components/ui/section-header.js";
import { useAgentNameMap } from "../lib/use-agent-name-map.js";
import { formatDate, formatRelative } from "../lib/utils.js";
import { ComputerCard } from "./clients/cards/computer-card.js";
import { PROVIDER_LABEL, PROVIDER_ORDER, providerInstallHint } from "./clients/cards/shared/providers.js";
import { ComputerStatusPill } from "./clients/computer-status-pill.js";
import { DemoNavigator, useDemoScenarioParam } from "./clients/demo-navigator.js";
import { compareByPillPriority, deriveComputerStatus } from "./clients/derive-status.js";
import { DEMO_AGENT_NAMES, DEMO_SELF_USER_ID, findDemoScenario } from "./clients/dev-fixtures.js";
import { NewConnectionDialog } from "./clients/new-connection-dialog.js";

/**
 * `embedded` drops the full-bleed `-m-6` wrapper so this page can be rendered
 * inside another master-detail container (e.g. /settings) whose own outer
 * chrome has already escaped the parent padding.
 *
 * Data-source split (admin vs member):
 *   - **member** mode reads `/me/clients` only — single block, no Owner column,
 *     identical layout to pre-admin-view.
 *   - **admin** mode reads `/orgs/:orgId/clients` for the "Team computers"
 *     block and splits client-side into "Your computers" + "Team computers".
 *     `/me/clients` is *also* fetched and unioned (deduped by id) into the
 *     viewer's own block only — so a client the viewer owns that the
 *     org-scoped view omits (e.g. after leaving the team that minted its
 *     agents, issue 1353) still surfaces and stays retirable. The union is
 *     one-directional (own block only) and dedups by id, so no row is shown
 *     twice and the per-tick block-disagreement the single-source design
 *     guarded against cannot occur. Owner lookup uses `/orgs/:orgId/members`
 *     with `staleTime: 60s` and no polling to keep the Owner cell from
 *     flickering.
 */
export function ClientsPage({ embedded = false }: { embedded?: boolean } = {}) {
  const queryClient = useQueryClient();
  const realAgentName = useAgentNameMap();
  const { role, user } = useAuth();
  // DEV-only "?demo=<key>" param swaps the page's data sources for
  // fixtures without touching the queries themselves. Lets a reviewer
  // flip through every pill × sub-variant inside the real page chrome.
  // Disabled (no-op) in production builds — Vite folds
  // `import.meta.env.DEV` to false so the fixtures + DemoNavigator
  // tree-shake out.
  const [demoKey, setDemoKey] = useDemoScenarioParam();
  const demoScenario = import.meta.env.DEV ? findDemoScenario(demoKey) : null;
  const isAdmin = demoScenario ? demoScenario.key === "admin-grouped" : role === "admin";
  const viewerUserId = demoScenario ? DEMO_SELF_USER_ID : user?.id;
  // Demo agent names overlay the live map so fixture agent IDs render
  // human-friendly labels in the bound-agents block.
  const agentName = demoScenario
    ? (uuid: string | null | undefined) => {
        if (!uuid) return "unknown";
        return DEMO_AGENT_NAMES[uuid] ?? realAgentName(uuid);
      }
    : realAgentName;
  // Personal scope: a user typically has 1-3 computers, so expand by default
  // and only let them collapse rows they actively want to hide. New clients
  // arriving via the 10s poll auto-expand too — we only treat the closed set
  // as "rows the user explicitly closed".
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set());
  // Admin's Team computers section starts collapsed so it doesn't push the
  // viewer's own machines below the fold. Visible count badge on the
  // header still tells admins "you have N teammates" — they click to
  // expand when they're in support mode. Reset rule: nothing forces it
  // open automatically (in particular, polled changes to teamList shouldn't
  // surprise-expand it).
  const [teamExpanded, setTeamExpanded] = useState(false);
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

  // member mode → primary data source. admin mode → always fetched too and
  // unioned into the viewer's *own* block (see `mineList`). `/me/clients` is
  // the authoritative cross-org "my computers" list, so a client the viewer
  // owns that the org-scoped admin view omits (e.g. after leaving the team
  // that minted its agents — issue 1353) still surfaces and stays retirable.
  // The Team block stays org-scoped, so no row is shown twice.
  const meClientsQuery = useQuery({
    queryKey: ["clients", "me"],
    queryFn: listClients,
    enabled: true,
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
  // computers instead of a broken page. Demo mode forces the split based
  // on the scenario.
  const grouped = demoScenario ? demoScenario.key === "admin-grouped" : isAdmin && !orgClientsQuery.isError;
  const teamLoadError = !demoScenario && isAdmin && orgClientsQuery.isError;

  // Demo-mode data overrides feed the same downstream useMemo / render
  // tree. Production builds skip these (demoScenario stays null).
  const orgClientsData = demoScenario ? demoScenario.clients : orgClientsQuery.data;
  const meClientsData = demoScenario
    ? demoScenario.clients.filter((c) => c.userId === DEMO_SELF_USER_ID)
    : meClientsQuery.data;

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
    const source = demoScenario ? demoScenario.agents : (activity?.agents ?? []);
    const map = new Map<string, RuntimeAgent[]>();
    for (const a of source) {
      if (!a.clientId) continue;
      const list = map.get(a.clientId) ?? [];
      list.push(a);
      map.set(a.clientId, list);
    }
    return map;
  }, [activity?.agents, demoScenario]);

  const getClientAgents = (clientId: string): RuntimeAgent[] => agentsByClient.get(clientId) ?? [];

  // admin grouped view: split the single org-scoped list into the viewer's
  // own machines vs everyone else's. Each group sorts by status pill priority
  // (auth_expired → setup_incomplete → offline → ready), then stable
  // hostname/id order — surfaces problem rows without letting heartbeat-time
  // churn reshuffle same-state computers. `userId === null` (legacy clients
  // that pre-date user binding) lands in the team block.
  const mineList = useMemo<HubClient[]>(() => {
    if (!grouped || !viewerUserId) return [];
    // Seed from `/me/clients` so a viewer-owned client the org-scoped admin
    // view omits still appears in "Your computers" (issue 1353). Org-scoped
    // rows win on overlap — they carry the same owner-resolution context as
    // the Team block, keeping fields consistent across the page.
    const byId = new Map<string, HubClient>();
    for (const c of meClientsData ?? []) byId.set(c.id, c);
    for (const c of orgClientsData ?? []) {
      if (c.userId === viewerUserId) byId.set(c.id, c);
    }
    return [...byId.values()].sort(compareByPillPriority);
  }, [grouped, orgClientsData, meClientsData, viewerUserId]);

  const teamList = useMemo<HubClient[]>(() => {
    if (!grouped || !orgClientsData || !viewerUserId) return [];
    return [...orgClientsData].filter((c) => c.userId !== viewerUserId).sort(compareByPillPriority);
  }, [grouped, orgClientsData, viewerUserId]);

  /**
   * Member-mode list (non-admin): the `/me/clients` payload arrives in
   * server-default order (no explicit ORDER BY). Sort by pill priority so
   * an Auth expired row cannot hide below a Ready one. This is a
   * deliberate UX change vs. the prior table — see PR description.
   */
  const memberList = useMemo<HubClient[] | undefined>(() => {
    if (grouped || !meClientsData) return meClientsData;
    return [...meClientsData].sort(compareByPillPriority);
  }, [grouped, meClientsData]);

  const membersById = useMemo<Map<string, string>>(() => {
    const map = new Map<string, string>();
    for (const m of membersQuery.data ?? []) map.set(m.userId, m.displayName);
    return map;
  }, [membersQuery.data]);

  const resolveOwner = (client: HubClient): { text: string; title?: string } => {
    if (client.userId === null) return { text: "—" };
    if (client.userId === viewerUserId) {
      const display = membersById.get(client.userId);
      // "gandy · you" rather than "gandy (you)" — nested parens read stiff
      // in card headers; the middot is the same separator the rest of the
      // page uses for meta segments.
      const name = display ?? (demoScenario ? "gandy" : null);
      return { text: name ? `${name} · you` : "you" };
    }
    const display = membersById.get(client.userId);
    if (display) return { text: display };
    if (demoScenario) {
      // Fixtures don't have a real members map — fall back to a friendly
      // display name so the team-table doesn't show "other-us" short-ids.
      return { text: "Alice" };
    }
    // Owner is bound to a userId we can't resolve right now — either the
    // members fetch is still in flight or the user was removed from the org
    // mid-session. Show the short-id with a tooltip carrying the full uuid
    // so the admin has something actionable to copy.
    return { text: client.userId.slice(0, 8), title: client.userId };
  };

  // Single source of truth for "what the user is looking at right now": admin
  // grouped mode → the viewer's own block (which now unions `/me/clients`)
  // plus the team block; member mode → the pill-sorted memberList. Driving the
  // empty-state branch off this keeps a viewer with only `/me`-sourced
  // computers from falling through to the "no computers" CTA (issue 1353).
  const clients = grouped ? [...mineList, ...teamList] : memberList;

  // "Are we still waiting on the primary listing?" — distinct from `!clients`
  // because once a query resolves with an empty array we want to drop out of
  // loading and show the empty state. Without this gate, admins see the empty
  // CTA flash before the org-scoped query lands on first paint. The admin
  // happy path now also waits on `/me/clients`, since `mineList` unions it —
  // otherwise an admin whose org view resolves empty *before* `/me` lands
  // would flash the "no computers" CTA for one tick before their own
  // `/me`-sourced rows pop in (issue 1353). Demo mode short-circuits since
  // fixtures are synchronous.
  const clientsLoading = demoScenario
    ? false
    : isAdmin
      ? orgClientsQuery.isError
        ? meClientsQuery.isLoading
        : orgClientsQuery.isLoading || meClientsQuery.isLoading
      : meClientsQuery.isLoading;

  // A discreet always-available "+ Connect" entry shows whenever the viewer
  // already has at least one of their own computers. Hidden when they have 0
  // (the empty-state CTA "Connect your first computer" covers that case, no
  // need to double up).
  const viewerOwnCount = grouped ? mineList.length : (memberList?.length ?? 0);
  const showHeaderConnectButton = viewerOwnCount >= 1;

  // "+ Connect" lives in the "Your computers" section header, not a page header:
  // the Settings layout now owns the single page heading (see settings.tsx).
  const connectButton = showHeaderConnectButton ? (
    <Button variant="outline" size="sm" onClick={openNewConnection}>
      <Plus className="h-3.5 w-3.5" />
      Connect
    </Button>
  ) : undefined;

  return (
    <div className={embedded ? "" : "-m-6"}>
      {demoScenario && (
        <DemoNavigator activeKey={demoScenario.key} onSelect={(k) => setDemoKey(k)} onExit={() => setDemoKey(null)} />
      )}

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
          <Dialog
            open
            onOpenChange={(open) => {
              if (!open) {
                setConfirmRetire(null);
                setRetireError(null);
              }
            }}
          >
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Retire Computer</DialogTitle>
              </DialogHeader>
              <DialogDescription>
                Permanently remove{" "}
                <span className="font-medium" style={{ color: "var(--fg)" }}>
                  {confirmRetire.hostname ?? confirmRetire.id.slice(0, 8)}
                </span>
                . Retiring is blocked while an agent is still assigned to this computer — delete those agents first
                (reassigning isn't available yet).
              </DialogDescription>
              {getClientAgents(confirmRetire.id).length > 0 && (
                <div
                  className="p-2 rounded-[var(--radius-input)]"
                  style={{
                    background: "var(--state-blocked-soft)",
                    border: "var(--hairline) solid var(--state-blocked-border)",
                  }}
                >
                  <div className="text-label mb-1">Agents on this computer (delete them first):</div>
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
                  className="p-2 rounded-[var(--radius-input)] text-body"
                  style={{
                    background: "var(--state-error-soft)",
                    border: "var(--hairline) solid var(--state-error-border)",
                    color: "var(--state-error)",
                  }}
                >
                  {retireError}
                </div>
              )}
              <DialogFooter>
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
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}

        {confirmDisconnect && (
          <Dialog
            open
            onOpenChange={(open) => {
              if (!open) setConfirmDisconnect(null);
            }}
          >
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Disconnect Computer</DialogTitle>
              </DialogHeader>
              <DialogDescription>
                This will disconnect{" "}
                <span className="font-medium" style={{ color: "var(--fg)" }}>
                  {confirmDisconnect.hostname ?? confirmDisconnect.id.slice(0, 8)}
                </span>{" "}
                and affect all agents on this computer:
              </DialogDescription>
              <ul className="space-y-1">
                {getClientAgents(confirmDisconnect.id).length === 0 ? (
                  <li className="text-body" style={{ color: "var(--fg-3)" }}>
                    No agents on this computer
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
              <DialogFooter>
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
              </DialogFooter>
            </DialogContent>
          </Dialog>
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
              <Button size="sm" variant="cta" onClick={openNewConnection}>
                <Plus className="h-3.5 w-3.5" />
                Connect your first computer
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col" style={{ gap: "var(--sp-6)" }}>
            {teamLoadError && <TeamLoadErrorBanner />}
            {grouped ? (
              <>
                <Section
                  title="Your computers"
                  count={mineList.length > 1 ? mineList.length : undefined}
                  action={connectButton}
                >
                  {mineList.length === 0 ? (
                    // Admin with no own computers + N team rows — the "Add
                    // another computer" bottom button would read wrong here
                    // ("another" implies a first), so keep the connect CTA
                    // inside the empty section instead.
                    <div
                      className="flex flex-col items-start"
                      style={{ color: "var(--fg-3)", gap: "var(--sp-3)", padding: "var(--sp-4) 0" }}
                    >
                      <span className="text-body">No computers of your own.</span>
                      <Button size="sm" variant="cta" onClick={openNewConnection}>
                        <Plus className="h-3.5 w-3.5" />
                        Connect your first computer
                      </Button>
                    </div>
                  ) : (
                    <CardStack>
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
                          // No ownerLabel: the parent "Your computers" Section
                          // header already establishes that every card in
                          // this stack belongs to the viewer, so repeating
                          // "Dev User · you" next to each hostname is just
                          // noise. Owner labeling lives only on the
                          // Team-computers table where it disambiguates
                          // between teammates.
                        />
                      ))}
                    </CardStack>
                  )}
                </Section>
                <Section
                  title="Team computers"
                  count={teamList.length > 1 ? teamList.length : undefined}
                  action={
                    teamList.length > 0 ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setTeamExpanded((e) => !e)}
                        aria-expanded={teamExpanded}
                      >
                        {teamExpanded ? (
                          <>
                            <ChevronDown className="h-3 w-3" />
                            Hide
                          </>
                        ) : (
                          <>
                            <ChevronRight className="h-3 w-3" />
                            Show
                          </>
                        )}
                      </Button>
                    ) : undefined
                  }
                >
                  {teamList.length === 0 ? (
                    <EmptyCardsNote message="No other team computers." />
                  ) : teamExpanded ? (
                    // Team rows stay as table for now — read-only audit
                    // view. Per-row inline affordances (Generate new
                    // token / install guide) don't apply to teammates;
                    // the full team-card redesign with "Copy suggestion
                    // → Alice" buttons is deferred to a follow-up PR
                    // (proposal §"Variant D").
                    <TeamComputersTable
                      teamList={teamList}
                      collapsedIds={collapsedIds}
                      setCollapsedIds={setCollapsedIds}
                      agentName={agentName}
                      getClientAgents={getClientAgents}
                      resolveOwner={resolveOwner}
                    />
                  ) : null}
                </Section>
              </>
            ) : (
              <>
                {connectButton && <div className="flex justify-end">{connectButton}</div>}
                <CardStack>
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
                </CardStack>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Vertical stack of computer cards with hairline separators. Each card
 * renders as a flat `<article>` (no own chrome) inside the parent
 * `<Section>`; this wrapper paints a hairline between adjacent computers
 * so the eye still sees "here ends one machine, here begins the next"
 * without nesting boxes.
 *
 * The hairline is injected via a sibling-selector class — defining it
 * once at the page level keeps every ComputerCard pure of "I might be
 * first or not" awareness.
 *
 * Previous PR-B used a `repeat(auto-fit, minmax(35rem, 1fr))` 2-up grid
 * — that fights the Settings tab's single-column hairline-separated
 * vocabulary (see /settings/github, /settings/messaging), so it was
 * collapsed to a stack here.
 */
function CardStack({ children }: { children: React.ReactNode }) {
  return <div className="computer-card-stack">{children}</div>;
}

function EmptyCardsNote({ message }: { message: string }) {
  return (
    <div className="text-body" style={{ color: "var(--fg-4)", padding: "var(--sp-3) 0" }}>
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
  // Wrapping div pulls the table left by the first cell's left padding
  // so the chevron column lines up with the parent Section's title left
  // edge. Without this the hostname column sits inside the section,
  // breaking the page's vertical alignment rhythm. Audit-only table,
  // no horizontal scroll concerns — safe to bleed past padding.
  return (
    <div style={{ marginLeft: "calc(-1 * var(--sp-3_5))", marginRight: "calc(-1 * var(--sp-3_5))" }}>
      <DenseTable>
        <DenseTableHeader>
          <DenseTableRow>
            <DenseTableHead style={{ width: "var(--sp-4)" }} />
            <DenseTableHead>Hostname</DenseTableHead>
            <DenseTableHead>Owner</DenseTableHead>
            <DenseTableHead>OS</DenseTableHead>
            <DenseTableHead>First Tree</DenseTableHead>
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
    </div>
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
function CapabilityMatrix({ capabilities, os }: { capabilities: ClientCapabilities; os: string | null }) {
  const empty = Object.keys(capabilities).length === 0;
  return (
    <>
      <UppercaseLabel style={{ display: "block", marginBottom: "var(--sp-1_5)" }}>Runtimes</UppercaseLabel>
      {empty ? (
        <div className="text-body" style={{ color: "var(--fg-3)" }}>
          Capabilities not yet reported. Reconnect this computer to refresh.
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          {PROVIDER_ORDER.map((provider) => (
            <ProviderRow key={provider} provider={provider} entry={capabilities[provider] ?? null} os={os} />
          ))}
        </div>
      )}
    </>
  );
}

function ProviderRow({
  provider,
  entry,
  os,
}: {
  provider: RuntimeProvider;
  entry: CapabilityEntry | null;
  os: string | null;
}) {
  const label = PROVIDER_LABEL[provider];
  if (!entry) {
    return (
      <div className="flex items-center gap-2.5 text-body" style={{ opacity: 0.7 }}>
        <span className="font-medium" style={{ minWidth: "var(--sp-35)" }}>
          {label}
        </span>
        <span className="text-caption" style={{ color: "var(--fg-4)" }}>
          not reported · {providerInstallHint(provider, os)}
        </span>
      </div>
    );
  }
  switch (entry.state) {
    case "ok":
      return (
        <div className="flex items-center gap-2.5 text-body">
          <span className="font-medium" style={{ minWidth: "var(--sp-35)" }}>
            {label}
          </span>
          <span className="text-caption" style={{ color: "var(--success)" }}>
            ✓ installed{entry.sdkVersion ? ` v${entry.sdkVersion}` : ""}
          </span>
        </div>
      );
    case "missing":
      return (
        <div className="flex items-center gap-2.5 text-body" style={{ opacity: 0.7 }}>
          <span className="font-medium" style={{ minWidth: "var(--sp-35)" }}>
            {label}
          </span>
          <span className="text-caption" style={{ color: "var(--fg-4)" }}>
            ✗ {providerInstallHint(provider, os, entry.error)}
          </span>
        </div>
      );
    case "error":
      return (
        <div className="flex items-center gap-2.5 text-body">
          <span className="font-medium" style={{ minWidth: "var(--sp-35)" }}>
            {label}
          </span>
          <span className="text-caption" style={{ color: "var(--state-error)" }}>
            error · {entry.error ?? "probe failed"}
          </span>
        </div>
      );
  }
}

// Column count in member mode — `chevron | Hostname | OS | First Tree |
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
        background: "var(--state-error-soft)",
        border: "var(--hairline) solid var(--state-error-border)",
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
        <DenseTableCell style={{ width: "var(--sp-4)" }}>
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
        <DenseTableCell style={{ width: "var(--hairline)", whiteSpace: "nowrap" }}>
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
            <CapabilityMatrix capabilities={client.capabilities} os={client.os} />
            {boundAgents.length > 0 && (
              <>
                <UppercaseLabel style={{ display: "block", marginTop: "var(--sp-3)", marginBottom: "var(--sp-1_5)" }}>
                  Agents · {boundAgents.length}
                </UppercaseLabel>
                <div className="flex flex-col gap-1">
                  {boundAgents.map((a) => (
                    <div key={a.agentId} className="flex items-center gap-2.5 text-body">
                      <span className="font-medium" style={{ minWidth: "var(--sp-35)" }}>
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
