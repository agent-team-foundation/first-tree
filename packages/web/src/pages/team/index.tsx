import type { Agent, RuntimeProvider } from "@first-tree/shared";
import { MEMBER_ROLES } from "@first-tree/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Search, UserPlus } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { listClients } from "../../api/activity.js";
import {
  deleteAgent,
  listAgents,
  listAllAgents,
  reactivateAgent,
  suspendAgent,
  updateAgent,
} from "../../api/agents.js";
import { deleteMember, listMembers, updateMember } from "../../api/members.js";
import { useAuth } from "../../auth/auth-context.js";
import { NewAgentDialog } from "../../components/new-agent-dialog.js";
import { Button } from "../../components/ui/button.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { FilterPill } from "../../components/ui/filter-pill.js";
import { Input } from "../../components/ui/input.js";
import { Label } from "../../components/ui/label.js";
import { PageHeader } from "../../components/ui/page-header.js";
import { useMemberNameMap } from "../../lib/use-member-name-map.js";
import { InviteLinkPanel } from "../invite-link-panel.js";
import { type AgentRow, type HumanRow, type RowAction, type TeamGroup, TeamTable } from "./team-table.js";

/**
 * Team page — single roster combining humans and agents into one merged
 * table. Section order is built around the two main reasons a user lands
 * on this tab: creating a new agent (top-right CTA) and configuring agents
 * they own. "Your agents" is therefore pinned to the top regardless of
 * visibility, so the most likely target of "I want to tweak this" is the
 * first thing in the user's eye-line.
 *
 *   - Your agents                 (managerId = self, any visibility — chip on row marks shared vs private)
 *   - Humans                      (login users; org members — set-delegate flow lives here)
 *   - Team agents                 (visibility = organization && managerId != self)
 *   - Other members' private agents (admin-only governance, collapsed)
 *
 * The three agent sections form a clean partition: every agent belongs to
 * exactly one section, so the table never double-lists a row.
 *
 * Admin role decides the data source: admins fetch `/agents/all` which
 * surfaces other members' private agents; members fetch the regular
 * visibility-filtered list. Either way the page uses one query — the
 * grouping below is purely client-side.
 */

type MemberListItem = {
  id: string;
  /** UUID of the human-mirror agent (members.agent_id). Needed by the Set-delegate dialog so it can PATCH the right agent row. */
  agentId: string;
  username: string;
  displayName: string;
  role: string;
  createdAt: string;
};

type MemberEditTarget = {
  id: string;
  username: string;
  displayName: string;
  role: string;
};

type DelegateTarget = {
  /** UUID of the human agent whose delegateMention we are editing. */
  humanAgentId: string;
  /** Display name of the human — shown in the dialog body so the user knows whose delegate they're configuring. */
  humanDisplayName: string;
  /** Current value of delegateMention on the human agent, or null. */
  currentDelegate: string | null;
};

type FilterKey = "all" | "yours" | "humans" | "team";

const AGENT_PAGE_SIZE = 100;
const MAX_AGENT_PAGES = 100;

export async function fetchAllAgents(
  fetchPage: (params: { limit: number; cursor?: string }) => Promise<{ items: Agent[]; nextCursor: string | null }>,
): Promise<Agent[]> {
  const items: Agent[] = [];
  let cursor: string | undefined;
  for (let pageCount = 0; pageCount < MAX_AGENT_PAGES; pageCount++) {
    const page = await fetchPage(cursor ? { limit: AGENT_PAGE_SIZE, cursor } : { limit: AGENT_PAGE_SIZE });
    items.push(...page.items);
    if (!page.nextCursor) return items;
    cursor = page.nextCursor;
  }
  throw new Error(`fetchAllAgents exceeded ${MAX_AGENT_PAGES} pages; server cursor pagination may be broken`);
}

export function TeamPage() {
  const { role, memberId } = useAuth();
  const isAdmin = role === "admin";
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const resolveMember = useMemberNameMap();

  const [inviteOpen, setInviteOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<MemberEditTarget | null>(null);
  const [delegateTarget, setDelegateTarget] = useState<DelegateTarget | null>(null);
  const [filter, setFilter] = useState<FilterKey>("all");
  const [query, setQuery] = useState("");

  const membersQuery = useQuery({
    queryKey: ["members"],
    queryFn: listMembers,
  });

  // Admins read the superset; members read the visibility-filtered view.
  // Both produce the same `Agent[]` shape so downstream code branches only
  // on what's *in* the list, not on the query key.
  const agentsQuery = useQuery({
    queryKey: ["agents", "team-page", isAdmin ? "admin" : "member"],
    queryFn: () => fetchAllAgents((params) => (isAdmin ? listAllAgents(params) : listAgents(params))),
    // Reachability (the Status column's `<PresenceChip>`) reads
    // `agent.presenceStatus` off this list. No admin-WS frame invalidates
    // `["agents"]` today, so without polling an agent that flips between
    // online and offline while the Team tab stays open would keep showing
    // the stale value until the user refocuses or remounts. Match the 10s
    // cadence the legacy `/activity` poll used before this surface migrated
    // off it.
    refetchInterval: 10_000,
  });

  // `/me/clients` is the cross-org list of clients the caller owns. We use
  // it to enrich each agent's Runtime cell with the host it's bound to
  // (e.g. `claude-code @ alice-macbook`). Agents bound to clients we don't
  // own (other members' machines hosting shared agents) won't resolve — the
  // cell falls back to just the runtime provider, which is acceptable: a
  // dedicated org-admin clients endpoint exists server-side but isn't wired
  // here yet.
  const { data: clientsData } = useQuery({
    queryKey: ["clients", "team-page"],
    queryFn: listClients,
    staleTime: 30_000,
  });
  const clientHostMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of clientsData ?? []) {
      if (c.hostname) m.set(c.id, c.hostname);
    }
    return m;
  }, [clientsData]);

  // Each derivation is memoized so the downstream `groups` useMemo (which
  // depends on these arrays) can actually cache — without these, every
  // render produced fresh array refs and `groups` recomputed every time.
  const members = useMemo<MemberListItem[]>(() => membersQuery.data ?? [], [membersQuery.data]);
  // Full agents list — includes humans, used to resolve a member's
  // delegateMention into a display identity. The visible agent groups
  // filter humans out below (they're already shown in the Humans section).
  const allAgents = useMemo<Agent[]>(() => agentsQuery.data ?? [], [agentsQuery.data]);
  const agentByUuid = useMemo(() => {
    const m = new Map<string, Agent>();
    for (const a of allAgents) m.set(a.uuid, a);
    return m;
  }, [allAgents]);
  // type === "human" agents are the user-mirrors auto-created for every
  // member (chat-identity proxies). The Humans section above already shows
  // them as people, so the agents groups must hide them to avoid double-listing.
  const agents = useMemo<Agent[]>(() => allAgents.filter((a) => a.type !== "human"), [allAgents]);

  // Three-way partition of the loaded agent list — every agent appears in
  // exactly one bucket so the table never double-lists a row.
  //   - yourAgents:         managed by me (any visibility) → top section, the headline answer to "what did I build?"
  //   - teamAgents:         org-shared agents managed by *others* → "what did the team build?"
  //   - otherPrivateAgents: private agents managed by others (admin-only) → governance bucket, collapsed
  const yourAgents = useMemo(() => agents.filter((a) => a.managerId === memberId), [agents, memberId]);
  const teamAgents = useMemo(
    () => agents.filter((a) => a.visibility === "organization" && a.managerId !== memberId),
    [agents, memberId],
  );
  const otherPrivateAgents = useMemo(
    () => agents.filter((a) => a.visibility === "private" && a.managerId !== memberId),
    [agents, memberId],
  );

  const updateMemberMut = useMutation({
    mutationFn: async (vars: { id: string; patch: { displayName?: string; role?: "admin" | "member" } }) =>
      updateMember(vars.id, vars.patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["members"] }),
  });
  const deleteMemberMut = useMutation({
    mutationFn: deleteMember,
    // The server reassigns the removed member's managed agents to a fallback
    // admin (services/member.ts:deleteMember), so the agents query is stale
    // too. Invalidate both to keep the manager column accurate.
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["members"] });
      queryClient.invalidateQueries({ queryKey: ["agents"] });
    },
  });
  const deleteAgentMut = useMutation({
    mutationFn: deleteAgent,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      queryClient.invalidateQueries({ queryKey: ["activity"] });
    },
  });
  const suspendAgentMut = useMutation({
    mutationFn: suspendAgent,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["agents"] }),
  });
  const reactivateAgentMut = useMutation({
    mutationFn: reactivateAgent,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["agents"] }),
  });
  const setDelegateMut = useMutation({
    mutationFn: async (vars: { humanAgentId: string; delegateMention: string | null }) =>
      updateAgent(vars.humanAgentId, { delegateMention: vars.delegateMention }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["agents"] }),
  });

  const search = query.trim().toLowerCase();
  const groups = useMemo(
    () =>
      buildGroups({
        filter,
        search,
        isAdmin,
        selfMemberId: memberId,
        members,
        yourAgents,
        teamAgents,
        otherPrivateAgents,
        resolveMember,
        agentByUuid,
        openDelegate: (humanAgentId, humanDisplayName) =>
          setDelegateTarget({
            humanAgentId,
            humanDisplayName,
            currentDelegate: agentByUuid.get(humanAgentId)?.delegateMention ?? null,
          }),
      }),
    [
      filter,
      search,
      isAdmin,
      memberId,
      members,
      yourAgents,
      teamAgents,
      otherPrivateAgents,
      resolveMember,
      agentByUuid,
    ],
  );

  function getHumanActions(row: HumanRow): RowAction[] {
    const actions: RowAction[] = [];
    // Delegate edits live inline in the Manager · Delegate column (see
    // HumanDelegateCell) — no kebab entry needed. PATCH /orgs/:orgId/members/:id
    // is admin-only (server gates with requireOrgAdmin), so "Edit profile"
    // only appears for admins; surfacing it to non-admin self would 403.
    if (isAdmin) {
      actions.push({
        key: "edit",
        label: "Edit profile",
        onSelect: () =>
          setEditTarget({ id: row.id, username: row.username, displayName: row.displayName, role: row.role }),
      });
    }
    if (isAdmin && !row.isSelf) {
      actions.push({
        key: "remove",
        label: "Remove from org",
        destructive: true,
        onSelect: () => {
          if (window.confirm(`Remove ${row.displayName} from the org? The human agent will be deactivated.`)) {
            deleteMemberMut.mutate(row.id);
          }
        },
      });
    }
    return actions;
  }

  function getAgentActions(row: AgentRow): RowAction[] {
    const { agent, isOwnedBySelf } = row;
    const canManage = isAdmin || isOwnedBySelf;
    const actions: RowAction[] = [
      {
        key: "open",
        label: "Open",
        onSelect: () => navigate(`/agents/${encodeURIComponent(agent.uuid)}`),
      },
    ];
    if (canManage) {
      if (agent.status === "suspended") {
        actions.push({
          key: "reactivate",
          label: "Reactivate",
          onSelect: () => reactivateAgentMut.mutate(agent.uuid),
        });
      } else {
        actions.push({
          key: "suspend",
          label: "Suspend",
          onSelect: () => suspendAgentMut.mutate(agent.uuid),
        });
      }
      actions.push({
        key: "delete",
        label: "Delete",
        destructive: true,
        onSelect: () => {
          if (window.confirm(`Delete agent ${agent.displayName}? This cannot be undone.`)) {
            deleteAgentMut.mutate(agent.uuid);
          }
        },
      });
    }
    return actions;
  }

  return (
    <>
      <PageHeader
        title="Team"
        right={
          <div className="flex items-center" style={{ gap: "var(--sp-2)" }}>
            <Button size="xs" onClick={() => setCreateOpen(true)}>
              <Plus className="h-3 w-3" />
              New agent
            </Button>
            {isAdmin && (
              <Button size="xs" variant="ghost" onClick={() => setInviteOpen(true)}>
                <UserPlus className="h-3 w-3" />
                Invite link
              </Button>
            )}
          </div>
        }
      />
      <div
        style={{
          padding: "var(--sp-2) var(--sp-5) var(--sp-7)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--sp-3)",
        }}
      >
        <FilterBar
          filter={filter}
          onFilter={setFilter}
          query={query}
          onQuery={setQuery}
          counts={{
            yours: yourAgents.length,
            humans: members.length,
            team: teamAgents.length,
          }}
        />

        {agentsQuery.isLoading || membersQuery.isLoading ? (
          <div className="text-center py-8 text-body" style={{ color: "var(--fg-3)" }}>
            Loading…
          </div>
        ) : agentsQuery.error || membersQuery.error ? (
          <div className="text-center py-8 text-body" style={{ color: "var(--state-error)" }}>
            Failed to load: {formatError(agentsQuery.error ?? membersQuery.error)}
          </div>
        ) : (
          <TeamTable
            groups={groups}
            clientHostMap={clientHostMap}
            onAgentClick={(uuid) => navigate(`/agents/${encodeURIComponent(uuid)}`)}
            getHumanActions={getHumanActions}
            getAgentActions={getAgentActions}
          />
        )}
      </div>

      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Invite link</DialogTitle>
          </DialogHeader>
          <InviteLinkPanel />
        </DialogContent>
      </Dialog>

      <NewAgentDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(_agent: Agent, _runtime: RuntimeProvider) => {
          setCreateOpen(false);
          queryClient.invalidateQueries({ queryKey: ["agents"] });
          queryClient.invalidateQueries({ queryKey: ["activity"] });
        }}
      />

      <EditMemberDialog
        target={editTarget}
        isAdmin={isAdmin}
        isSaving={updateMemberMut.isPending}
        onClose={() => setEditTarget(null)}
        onSave={async (patch) => {
          if (!editTarget) return;
          await updateMemberMut.mutateAsync({ id: editTarget.id, patch });
          setEditTarget(null);
        }}
      />

      <SetDelegateDialog
        target={delegateTarget}
        candidates={selectDelegateCandidates(allAgents)}
        isSaving={setDelegateMut.isPending}
        onClose={() => setDelegateTarget(null)}
        onSave={async (delegateMention) => {
          if (!delegateTarget) return;
          await setDelegateMut.mutateAsync({ humanAgentId: delegateTarget.humanAgentId, delegateMention });
          setDelegateTarget(null);
        }}
      />
    </>
  );
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function FilterBar({
  filter,
  onFilter,
  query,
  onQuery,
  counts,
}: {
  filter: FilterKey;
  onFilter: (k: FilterKey) => void;
  query: string;
  onQuery: (q: string) => void;
  counts: { yours: number; humans: number; team: number };
}) {
  // Pills sit in the same order the sections render below: "Your agents"
  // first because it's the primary scan target (creating + tweaking your
  // own agents is the main reason people open this tab), then Humans
  // (where the set-delegate flow lives), then Team agents. Each pill maps
  // 1:1 to a section title so the filter mental model is trivial.
  const chips: Array<{ key: FilterKey; label: string; count?: number }> = [
    { key: "all", label: "All" },
    { key: "yours", label: "Your agents", count: counts.yours },
    { key: "humans", label: "Humans", count: counts.humans },
    { key: "team", label: "Team agents", count: counts.team },
  ];
  return (
    <div className="flex flex-wrap items-center" style={{ gap: "var(--sp-2)" }}>
      <div className="flex flex-wrap items-center" style={{ gap: "var(--sp-1)" }}>
        {chips.map((chip) => (
          <FilterPill key={chip.key} active={filter === chip.key} count={chip.count} onClick={() => onFilter(chip.key)}>
            {chip.label}
          </FilterPill>
        ))}
      </div>
      {/* Search input is sized to match the FilterPill rhythm (short
          height, text-caption, tiny corner radius) rather than the default
          Input atom (h-9, text-body, larger radius) — that way the filter
          row reads as one homogenous chip strip instead of a tall input
          sitting beside short pills. The radius matches FilterPill's
          inline `borderRadius: 3` so the two atoms read as siblings. */}
      <div className="relative" style={{ width: 220 }}>
        <Search
          aria-hidden
          className="h-3.5 w-3.5"
          style={{
            position: "absolute",
            left: "var(--sp-1_5)",
            top: "50%",
            transform: "translateY(-50%)",
            color: "var(--fg-4)",
          }}
        />
        <Input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Search name or @handle"
          aria-label="Search team"
          className="h-7 text-caption"
          style={{ paddingLeft: "var(--sp-5)", borderRadius: 3 }}
        />
      </div>
    </div>
  );
}

export function buildGroups(args: {
  filter: FilterKey;
  search: string;
  isAdmin: boolean;
  selfMemberId: string | null;
  members: MemberListItem[];
  /** Agents managed by the viewer, any visibility. Rendered first. */
  yourAgents: Agent[];
  /** Shared agents managed by other members. */
  teamAgents: Agent[];
  /** Private agents managed by other members — admin governance bucket. */
  otherPrivateAgents: Agent[];
  resolveMember: (id: string) => string;
  agentByUuid: Map<string, Agent>;
  openDelegate: (humanAgentId: string, humanDisplayName: string) => void;
}): TeamGroup[] {
  const {
    filter,
    search,
    isAdmin,
    selfMemberId,
    members,
    yourAgents,
    teamAgents,
    otherPrivateAgents,
    agentByUuid,
    openDelegate,
  } = args;

  // Returns the resolved identity of the human's delegate agent, or null
  // if no delegate is configured / the target agent isn't in the loaded
  // page (e.g. soft-deleted, beyond the 100-row cap).
  const resolveDelegate = (humanAgentId: string): { name: string | null; displayName: string } | null => {
    const human = agentByUuid.get(humanAgentId);
    if (!human?.delegateMention) return null;
    const d = agentByUuid.get(human.delegateMention);
    if (!d) return null;
    return { name: d.name, displayName: d.displayName };
  };

  const matchHuman = (m: MemberListItem) =>
    !search || m.displayName.toLowerCase().includes(search) || m.username.toLowerCase().includes(search);
  const matchAgent = (a: Agent) =>
    !search || a.displayName.toLowerCase().includes(search) || (a.name ?? "").toLowerCase().includes(search);

  const showYours = filter === "all" || filter === "yours";
  const showHumans = filter === "all" || filter === "humans";
  const showTeam = filter === "all" || filter === "team";
  // Admin governance bucket only renders inside the All view; the
  // dedicated pills don't surface it to keep their meaning literal.
  const showOtherPrivate = isAdmin && filter === "all";

  const humanRows: HumanRow[] = members
    .filter(matchHuman)
    .map((m): HumanRow => {
      const isSelf = selfMemberId === m.id;
      return {
        kind: "human",
        id: m.id,
        agentId: m.agentId,
        username: m.username,
        displayName: m.displayName,
        role: m.role,
        createdAt: m.createdAt,
        isSelf,
        delegate: resolveDelegate(m.agentId),
        canEditDelegate: isSelf || isAdmin,
        onEditDelegate: () => openDelegate(m.agentId, m.displayName),
      };
    })
    // Pin (you) to the top of the Humans section — when scanning a roster the
    // viewer almost always wants their own row first, and it's where the
    // "Set delegate →" inline CTA lives. Stable sort keeps backend order for
    // the rest.
    .sort((a, b) => Number(b.isSelf) - Number(a.isSelf));

  const toAgentRow = (agent: Agent, opts?: { showVisibilityChip?: boolean }): AgentRow => ({
    kind: "agent",
    agent,
    managerLabel: agent.managerId ? args.resolveMember(agent.managerId) : null,
    isOwnedBySelf: agent.managerId === selfMemberId,
    showVisibilityChip: opts?.showVisibilityChip ?? false,
  });

  // "Your agents" mixes shared + private rows, so each row carries an
  // inline visibility chip so the viewer can tell them apart at a glance.
  // Sort:
  //   1. Private agents first (governance attention belongs on the more
  //      sensitive rows).
  //   2. Tiebreaker on displayName so order stays deterministic across
  //      paginated fetches and refetches — the source `yourAgents` array
  //      arrives in whatever order /agents pages return, and without a
  //      stable secondary key the section would visibly reshuffle when
  //      the list refreshes.
  const yourRows: AgentRow[] = yourAgents
    .filter(matchAgent)
    .map((a) => toAgentRow(a, { showVisibilityChip: true }))
    .sort((a, b) => {
      const aPriv = a.agent.visibility === "private" ? 0 : 1;
      const bPriv = b.agent.visibility === "private" ? 0 : 1;
      if (aPriv !== bPriv) return aPriv - bPriv;
      // Case-insensitive locale-aware compare so "Coder" and "coder" sort
      // adjacent rather than splitting by ASCII code point.
      return a.agent.displayName.localeCompare(b.agent.displayName, undefined, { sensitivity: "base" });
    });
  // Team / Other-private rows are homogeneous in visibility (shared / private
  // respectively); the section title already encodes that, so no chip.
  const teamRows: AgentRow[] = teamAgents.filter(matchAgent).map((a) => toAgentRow(a));
  const otherPrivateRows: AgentRow[] = otherPrivateAgents.filter(matchAgent).map((a) => toAgentRow(a));

  const groups: TeamGroup[] = [];
  if (showYours) {
    groups.push({
      key: "yours",
      title: "Your agents",
      count: yourRows.length,
      rows: yourRows,
      emptyMessage: search
        ? "No agents match this search."
        : "You haven't created any agents yet. Click New agent above to add one.",
    });
  }
  if (showHumans) {
    groups.push({
      key: "humans",
      title: "Humans",
      count: humanRows.length,
      rows: humanRows,
      emptyMessage: search ? "No humans match this search." : undefined,
    });
  }
  if (showTeam) {
    groups.push({
      key: "team",
      title: "Team agents",
      count: teamRows.length,
      rows: teamRows,
      emptyMessage: search ? "No team agents match this search." : "No shared agents from other team members yet.",
    });
  }
  if (showOtherPrivate && otherPrivateRows.length > 0) {
    groups.push({
      key: "other-private",
      title: "Other members' private agents",
      count: otherPrivateRows.length,
      rows: otherPrivateRows,
      collapsible: true,
    });
  }
  return groups;
}

export function selectDelegateCandidates(agents: Agent[]): Agent[] {
  return agents.filter((a) => a.type === "personal_assistant" && a.status === "active");
}

const roleValues = Object.values(MEMBER_ROLES);

function EditMemberDialog({
  target,
  isAdmin,
  isSaving,
  onClose,
  onSave,
}: {
  target: MemberEditTarget | null;
  isAdmin: boolean;
  isSaving: boolean;
  onClose: () => void;
  onSave: (patch: { displayName?: string; role?: "admin" | "member" }) => Promise<void>;
}) {
  const [displayName, setDisplayName] = useState("");
  const [memberRole, setMemberRole] = useState<string>("member");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (target) {
      setDisplayName(target.displayName);
      setMemberRole(target.role);
      setError(null);
    }
  }, [target]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!target) return;
    const patch: { displayName?: string; role?: "admin" | "member" } = {};
    if (displayName.trim() && displayName !== target.displayName) {
      patch.displayName = displayName.trim();
    }
    if (isAdmin && memberRole !== target.role) {
      patch.role = memberRole as "admin" | "member";
    }
    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }
    try {
      await onSave(patch);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const open = target !== null;

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit profile</DialogTitle>
        </DialogHeader>
        {target && (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label>Username</Label>
              <Input value={target.username} disabled className="font-mono" />
              <p className="text-caption" style={{ color: "var(--fg-3)" }}>
                Username is permanent after creation.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-member-display">Display name</Label>
              <Input
                id="edit-member-display"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                required
                maxLength={200}
              />
            </div>
            {isAdmin && (
              <div className="space-y-2">
                <Label htmlFor="edit-member-role">Role</Label>
                <select
                  id="edit-member-role"
                  value={memberRole}
                  onChange={(e) => setMemberRole(e.target.value)}
                  className="flex h-9 w-full rounded-[var(--radius-input)] border border-input bg-transparent px-3 py-1 text-body shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  {roleValues.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
                <p className="text-caption" style={{ color: "var(--fg-3)" }}>
                  Demoting the last admin is blocked — every org needs at least one admin to manage members.
                </p>
              </div>
            )}
            {error && (
              <p className="text-body" style={{ color: "var(--state-error)" }}>
                {error}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={onClose} disabled={isSaving}>
                Cancel
              </Button>
              <Button type="submit" disabled={isSaving}>
                {isSaving ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Focused dialog for the "configure my delegate" flow. The full identity
 * editor (display name + visibility + delegate) lives on the agent-detail
 * page, but the Team page surfaces this single decision directly so a
 * non-admin self has a one-click path that doesn't require visiting their
 * mirror agent's detail page.
 *
 * The candidate list mirrors what the identity-section editor uses:
 * active `personal_assistant` agents from the Team page's fully-paginated
 * agent query. Admins receive the all-agent source so private assistants
 * owned by other members remain selectable when editing another human.
 */
function SetDelegateDialog({
  target,
  candidates,
  isSaving,
  onClose,
  onSave,
}: {
  target: DelegateTarget | null;
  candidates: Agent[];
  isSaving: boolean;
  onClose: () => void;
  onSave: (delegateMention: string | null) => Promise<void>;
}) {
  const [delegate, setDelegate] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (target) {
      setDelegate(target.currentDelegate ?? "");
      setError(null);
    }
  }, [target]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!target) return;
    setError(null);
    try {
      await onSave(delegate || null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const open = target !== null;

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Set delegate</DialogTitle>
        </DialogHeader>
        {target && (
          <form onSubmit={handleSubmit} className="space-y-4">
            <p className="text-body" style={{ color: "var(--fg-2)" }}>
              Pick a personal assistant to act on behalf of <strong>{target.humanDisplayName}</strong>. When teammates
              @mention this human, the assistant receives the message and can reply in their place.
            </p>
            <div className="space-y-2">
              <Label htmlFor="set-delegate-pick">Delegate</Label>
              <select
                id="set-delegate-pick"
                value={delegate}
                onChange={(e) => setDelegate(e.target.value)}
                className="flex h-9 w-full rounded-[var(--radius-input)] border border-input bg-transparent px-3 py-1 text-body shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="">None — no delegate</option>
                {candidates.map((a) => (
                  <option key={a.uuid} value={a.uuid}>
                    {a.displayName ? `${a.displayName} (@${a.name ?? a.uuid})` : a.name ? `@${a.name}` : a.uuid}
                  </option>
                ))}
              </select>
              {candidates.length === 0 && (
                <p className="text-caption" style={{ color: "var(--fg-3)" }}>
                  No personal assistants available. Create one from the <em>New agent</em> button above first.
                </p>
              )}
            </div>
            {error && (
              <p className="text-body" style={{ color: "var(--state-error)" }}>
                {error}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={onClose} disabled={isSaving}>
                Cancel
              </Button>
              <Button type="submit" disabled={isSaving}>
                {isSaving ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
