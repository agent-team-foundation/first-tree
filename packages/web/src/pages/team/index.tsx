import type { Agent, RuntimeProvider } from "@first-tree/shared";
import { MEMBER_ROLES } from "@first-tree/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link2, Plus, Search } from "lucide-react";
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
import { deleteMember, listMembers, updateMember, updateMyProfile } from "../../api/members.js";
import { getOrgUsageByAgent } from "../../api/usage.js";
import { useAuth } from "../../auth/auth-context.js";
import {
  AgentDeleteConfirmDialog,
  AgentSuspendConfirmDialog,
} from "../../components/agent-lifecycle-confirm-dialog.js";
import { InviteDialog } from "../../components/invite-dialog.js";
import { NewAgentDialog } from "../../components/new-agent-dialog.js";
import { Button } from "../../components/ui/button.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { Input } from "../../components/ui/input.js";
import { Label } from "../../components/ui/label.js";
import { PageHeader } from "../../components/ui/page-header.js";
import { invalidateDisplayNameQueries } from "../../lib/identity-cache.js";
import { useMemberNameMap } from "../../lib/use-member-name-map.js";
import { formatRelative } from "../../lib/utils.js";
import {
  type AgentFilter,
  matchesAgentScope,
  readAgentFilterPreference,
  writeAgentFilterPreference,
} from "./agent-filter.js";
import { type AgentRow, type HumanRow, type RowAction, TeamTable } from "./team-table.js";

/**
 * Team page — two stacked sections (Agent teammates first, Human teammates
 * second). Replaces the old merged single table. See the design doc
 * (drafts/team-teammates-redesign.md) and the `/preview/team` prototype.
 *
 *   - Agent teammates: Public / Private subgroups; visibility encoded by the
 *     group (no per-row chip). `All | Mine` filter; own agents pinned first.
 *   - Human teammates: Delegate (inline, self-editable) · Last active · actions.
 *
 * Admin role decides the agent data source: admins fetch `/agents/all`
 * (includes other members' private agents); members fetch the visibility-
 * filtered list. Grouping/sorting/search is client-side in `buildTeamData`.
 */

type MemberListItem = {
  id: string;
  /** UUID of the human-mirror agent (members.agent_id) — delegate edits PATCH this. */
  agentId: string;
  username: string;
  displayName: string;
  role: string;
  createdAt: string;
  avatarUrl: string | null;
  /** Derived from the member's most recent message; null = never active. */
  lastActiveAt: string | null;
};

type MemberEditTarget = {
  id: string;
  username: string;
  displayName: string;
  role: string;
};

/** Target for the suspend / delete confirm dialogs (adopted from main PR 673). */
type AgentLifecycleTarget = {
  uuid: string;
  label: string;
};

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
  const { role, memberId, refreshMe } = useAuth();
  const isAdmin = role === "admin";
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const resolveMember = useMemberNameMap();

  const [inviteOpen, setInviteOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<MemberEditTarget | null>(null);
  const [agentFilter, setAgentFilter] = useState<AgentFilter>(() => readAgentFilterPreference());
  const [suspendTarget, setSuspendTarget] = useState<AgentLifecycleTarget | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AgentLifecycleTarget | null>(null);
  const [query, setQuery] = useState("");

  const membersQuery = useQuery({ queryKey: ["members"], queryFn: listMembers });

  // Window is fixed at 7 days; the column header no longer exposes a picker.
  const usageQuery = useQuery({
    queryKey: ["usage", "by-agent", "7d"],
    queryFn: () => getOrgUsageByAgent("7d"),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const usageByAgentId = useMemo(() => {
    if (!usageQuery.data) return null;
    const m = new Map<string, (typeof usageQuery.data.rows)[number]>();
    for (const r of usageQuery.data.rows) m.set(r.agentId, r);
    return m;
  }, [usageQuery.data]);

  const agentsQuery = useQuery({
    queryKey: ["agents", "team-page", isAdmin ? "admin" : "member"],
    queryFn: () => fetchAllAgents((params) => (isAdmin ? listAllAgents(params) : listAgents(params))),
    // Reachability (Status PresenceChip) is derived from agent.runtimeState off
    // this list; nothing invalidates ["agents"] on a presence flip, so poll.
    refetchInterval: 10_000,
  });

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

  const members = useMemo<MemberListItem[]>(() => membersQuery.data ?? [], [membersQuery.data]);
  const allAgents = useMemo<Agent[]>(() => agentsQuery.data ?? [], [agentsQuery.data]);
  const agentByUuid = useMemo(() => {
    const m = new Map<string, Agent>();
    for (const a of allAgents) m.set(a.uuid, a);
    return m;
  }, [allAgents]);
  // type="human" mirrors are shown in the Human section; hide them from agent groups.
  const agents = useMemo<Agent[]>(() => allAgents.filter((a) => a.type !== "human"), [allAgents]);

  const updateMemberMut = useMutation({
    mutationFn: async (vars: { id: string; patch: { displayName?: string; role?: "admin" | "member" } }) =>
      updateMember(vars.id, vars.patch),
    onSuccess: async (_member, vars) => {
      const refreshProjection =
        vars.patch.displayName !== undefined
          ? invalidateDisplayNameQueries(queryClient)
          : queryClient.invalidateQueries({ queryKey: ["members"] });
      // A combined self rename + role edit uses this admin route rather than
      // /me/profile. AuthProvider owns a separate /me snapshot, so refresh it
      // alongside React Query or the user menu keeps the old identity/role.
      await Promise.all([refreshProjection, ...(vars.id === memberId ? [refreshMe()] : [])]);
    },
  });
  // Self-service display-name edit (PATCH /me/profile). Routed here instead of
  // the admin member route so a non-admin can rename themselves; the server
  // strips role, so this can never change the caller's own role. The human
  // agent's displayName changes too, so refresh agents alongside members.
  const updateMyProfileMut = useMutation({
    mutationFn: async (displayName: string) => updateMyProfile({ displayName }),
    onSuccess: async () => {
      // displayName has TWO visible sources of truth: the members/agents React
      // Query caches AND the AuthProvider's own `/me` state (user-menu, etc.
      // read useAuth().user.displayName, which is NOT in the query cache).
      // Refresh both, else the top-right menu shows the old name until the next
      // natural fetchMe.
      await refreshMe();
      await invalidateDisplayNameQueries(queryClient);
    },
  });
  const deleteMemberMut = useMutation({
    mutationFn: deleteMember,
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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      queryClient.invalidateQueries({ queryKey: ["activity"] });
    },
  });
  const reactivateAgentMut = useMutation({
    mutationFn: reactivateAgent,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      queryClient.invalidateQueries({ queryKey: ["activity"] });
    },
  });
  const setDelegateMut = useMutation({
    mutationFn: async (vars: { humanAgentId: string; delegateMention: string | null }) =>
      updateAgent(vars.humanAgentId, { delegateMention: vars.delegateMention }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["agents"] }),
  });

  const search = query.trim().toLowerCase();
  const handleAgentFilterChange = (next: AgentFilter) => {
    setAgentFilter(next);
    writeAgentFilterPreference(next);
  };
  const { publicAgents, privateAgents, humans, agentCount } = useMemo(
    () =>
      buildTeamData({
        filter: agentFilter,
        search,
        isAdmin,
        selfMemberId: memberId,
        members,
        agents,
        agentByUuid,
        resolveMember,
      }),
    [agentFilter, search, isAdmin, memberId, members, agents, agentByUuid, resolveMember],
  );

  // Personal-assistant candidates for the viewer's own delegate selector.
  const delegateCandidates = useMemo(() => selectDelegateCandidates(allAgents, memberId), [allAgents, memberId]);

  function getAgentMenuActions(row: AgentRow): RowAction[] {
    const { agent, isOwnedBySelf } = row;
    const canManage = isAdmin || isOwnedBySelf;
    if (!canManage) return [];
    const actions: RowAction[] = [];
    // Suspend/Delete go through confirm dialogs; delete is gated behind
    // suspension (suspended-agent lifecycle, main PR 673).
    if (agent.status === "active") {
      actions.push({
        key: "suspend",
        label: "Suspend",
        onSelect: () => setSuspendTarget({ uuid: agent.uuid, label: agent.displayName || agent.name || agent.uuid }),
      });
    } else if (agent.clientId !== null) {
      actions.push({ key: "reactivate", label: "Reactivate", onSelect: () => reactivateAgentMut.mutate(agent.uuid) });
    }
    actions.push({
      key: "delete",
      label: agent.status === "suspended" ? "Delete" : "Delete (suspend first)",
      destructive: true,
      disabled: agent.status !== "suspended",
      onSelect: () =>
        agent.status === "suspended"
          ? setDeleteTarget({ uuid: agent.uuid, label: agent.displayName || agent.name || agent.uuid })
          : undefined,
    });
    return actions;
  }

  function getHumanMenuActions(row: HumanRow): RowAction[] {
    if (!isAdmin || row.isSelf) return [];
    return [
      {
        key: "remove",
        label: "Remove from org",
        destructive: true,
        onSelect: () => {
          if (window.confirm(`Remove ${row.displayName} from the org? The human agent will be deactivated.`)) {
            deleteMemberMut.mutate(row.id);
          }
        },
      },
    ];
  }

  return (
    <>
      <PageHeader
        title="Team"
        subtitle="Agents and humans on your team."
        right={
          // Page-level controls live on the title row: full-page search (it
          // filters BOTH sections) sits left of the create actions. The
          // agent-only All/Mine scope is NOT here — it lives in the Agent
          // teammates header (it doesn't affect Human teammates).
          <div className="flex items-center" style={{ gap: "var(--sp-2)" }}>
            <SearchBar query={query} onQuery={setQuery} />
            {/* Brand-green cta is reserved for the one creation/hero action. */}
            <Button size="sm" variant="cta" onClick={() => setCreateOpen(true)}>
              <Plus className="h-3.5 w-3.5" />
              New agent
            </Button>
            {/* Secondary, member-level — neutral outline, never green. Sharing
                the invite link is a member-level capability (issue 836); the
                dialog's panel role-forks so only admins see Rotate. */}
            <Button size="sm" variant="outline" onClick={() => setInviteOpen(true)}>
              <Link2 className="h-3.5 w-3.5" />
              Invite link
            </Button>
          </div>
        }
      />
      <div
        style={{
          padding: "var(--sp-2) var(--sp-5) var(--sp-7)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--sp-1)",
        }}
      >
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
            publicAgents={publicAgents}
            privateAgents={privateAgents}
            humans={humans}
            isAdmin={isAdmin}
            dimPrivateOwner={!isAdmin}
            agentCount={agentCount}
            clientHostMap={clientHostMap}
            usageByAgentId={usageByAgentId}
            usageLoading={usageQuery.isLoading}
            onChat={(uuid) => navigate(`/?c=draft&with=${encodeURIComponent(uuid)}`)}
            onAgentDetails={(uuid) => navigate(`/agents/${encodeURIComponent(uuid)}`)}
            getAgentMenuActions={getAgentMenuActions}
            onHumanDetails={(row) =>
              setEditTarget({ id: row.id, username: row.username, displayName: row.displayName, role: row.role })
            }
            getHumanMenuActions={getHumanMenuActions}
            delegateCandidates={delegateCandidates}
            onSetDelegate={(humanAgentId, delegateUuid) =>
              setDelegateMut.mutate({ humanAgentId, delegateMention: delegateUuid })
            }
            searchActive={search.length > 0}
            agentFilter={agentFilter}
            onAgentFilter={handleAgentFilterChange}
            onInvite={() => setInviteOpen(true)}
          />
        )}
      </div>

      <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} />

      <NewAgentDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(_agent: Agent, _runtime: RuntimeProvider) => {
          setCreateOpen(false);
          queryClient.invalidateQueries({ queryKey: ["agents"] });
          queryClient.invalidateQueries({ queryKey: ["activity"] });
        }}
      />

      <MemberDetailsDialog
        target={editTarget}
        isAdmin={isAdmin}
        isSelf={editTarget !== null && editTarget.id === memberId}
        isSaving={updateMemberMut.isPending || updateMyProfileMut.isPending}
        onClose={() => setEditTarget(null)}
        onSave={async (patch) => {
          if (!editTarget) return;
          // Self renaming (no role change) goes through /me/profile so it works
          // for non-admins; everything else (admin editing others, any role
          // change) uses the admin member route.
          if (editTarget.id === memberId && patch.role === undefined && patch.displayName !== undefined) {
            await updateMyProfileMut.mutateAsync(patch.displayName);
          } else {
            await updateMemberMut.mutateAsync({ id: editTarget.id, patch });
          }
          setEditTarget(null);
        }}
      />

      <AgentSuspendConfirmDialog
        open={suspendTarget !== null}
        onOpenChange={(open) => {
          if (!open) setSuspendTarget(null);
        }}
        label={suspendTarget?.label ?? ""}
        pending={suspendAgentMut.isPending}
        onConfirm={() => {
          if (!suspendTarget) return;
          suspendAgentMut.mutate(suspendTarget.uuid, { onSuccess: () => setSuspendTarget(null) });
        }}
      />

      <AgentDeleteConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        expected={deleteTarget?.label ?? ""}
        deleting={deleteAgentMut.isPending}
        onDelete={() => {
          if (!deleteTarget) return;
          deleteAgentMut.mutate(deleteTarget.uuid, { onSuccess: () => setDeleteTarget(null) });
        }}
      />
    </>
  );
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function SearchBar({ query, onQuery }: { query: string; onQuery: (q: string) => void }) {
  // Lives on the page title row next to the create buttons; fixed 180-wide
  // (--sp-45) and h-8 so it sits at the same height as the adjacent `sm`
  // buttons without crowding them.
  return (
    <div className="relative" style={{ width: "var(--sp-45)", maxWidth: "100%" }}>
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
        className="h-8 text-caption"
        style={{ paddingLeft: "var(--sp-5)" }}
      />
    </div>
  );
}

export function buildTeamData(args: {
  filter: AgentFilter;
  search: string;
  isAdmin: boolean;
  selfMemberId: string | null;
  members: MemberListItem[];
  /** Non-human agents only. */
  agents: Agent[];
  agentByUuid: Map<string, Agent>;
  resolveMember: (id: string) => string;
}): { publicAgents: AgentRow[]; privateAgents: AgentRow[]; humans: HumanRow[]; agentCount: number } {
  const { filter, search, isAdmin, selfMemberId, members, agents, agentByUuid, resolveMember } = args;

  const matchAgent = (a: Agent) =>
    !search || a.displayName.toLowerCase().includes(search) || (a.name ?? "").toLowerCase().includes(search);
  const matchHuman = (m: MemberListItem) =>
    !search || m.displayName.toLowerCase().includes(search) || m.username.toLowerCase().includes(search);
  const memberById = new Map(members.map((m) => [m.id, m]));

  const visible = (a: Agent) => {
    // Members only see their own private agents; admins see all.
    if (a.visibility === "private" && !isAdmin && a.managerId !== selfMemberId) return false;
    // `Mine` filter: across both groups, only agents the viewer manages.
    if (!matchesAgentScope(a, filter, selfMemberId)) return false;
    return matchAgent(a);
  };

  const toRow = (a: Agent): AgentRow => ({
    kind: "agent",
    agent: a,
    managerLabel: a.managerId ? resolveMember(a.managerId) : null,
    managerAvatarUrl: a.managerId ? (memberById.get(a.managerId)?.avatarUrl ?? null) : null,
    isOwnedBySelf: a.managerId === selfMemberId,
  });

  // Own agents pinned first (fast self-location), then alphabetical — stable
  // across paginated refetches.
  const sortRows = (rows: AgentRow[]) =>
    rows.sort((x, y) => {
      const mineX = x.isOwnedBySelf ? 0 : 1;
      const mineY = y.isOwnedBySelf ? 0 : 1;
      if (mineX !== mineY) return mineX - mineY;
      return x.agent.displayName.localeCompare(y.agent.displayName, undefined, { sensitivity: "base" });
    });

  const publicAgents = sortRows(agents.filter((a) => a.visibility === "organization" && visible(a)).map(toRow));
  const privateAgents = sortRows(agents.filter((a) => a.visibility === "private" && visible(a)).map(toRow));

  const resolveDelegate = (humanAgentId: string): HumanRow["delegate"] => {
    const human = agentByUuid.get(humanAgentId);
    if (!human?.delegateMention) return null;
    const d = agentByUuid.get(human.delegateMention);
    if (!d) return null;
    return {
      uuid: d.uuid,
      name: d.name,
      displayName: d.displayName,
      colorToken: d.avatarColorToken,
      avatarImageUrl: d.avatarImageUrl,
    };
  };

  const humans: HumanRow[] = members
    .filter(matchHuman)
    .map((m): HumanRow => {
      const isSelf = selfMemberId === m.id;
      return {
        kind: "human",
        id: m.id,
        agentId: m.agentId,
        username: m.username,
        displayName: m.displayName,
        avatarUrl: m.avatarUrl,
        role: m.role,
        isSelf,
        delegate: resolveDelegate(m.agentId),
        // Per spec only the user themselves sets their own delegate (admins don't).
        canEditDelegate: isSelf,
        // Derived from the member's most recent message (口径 B). Null → "—".
        lastActiveLabel: m.lastActiveAt ? formatRelative(m.lastActiveAt) : null,
      };
    })
    // Pin (you) to the top of the Humans section.
    .sort((a, b) => Number(b.isSelf) - Number(a.isSelf));

  return { publicAgents, privateAgents, humans, agentCount: publicAgents.length + privateAgents.length };
}

export function selectDelegateCandidates(agents: Agent[], managerId: string | null | undefined): Agent[] {
  // Delegate candidates are the viewer's own active agents: type=agent + active
  // + managed by the viewer. Visibility is NOT a filter — a private agent (your
  // personal assistant) is a first-class delegate, and the server accepts it
  // (same-org check only; webhook routing checks same-org + active). This must
  // stay in sync with the Agent Detail picker (profile-edit-dialog.tsx): both
  // entry points set the same field and must offer the same candidates. The
  // managerId filter is the issue 669 candidate fix — the selector only lists
  // the user's own agents, not the whole org's.
  return agents.filter((a) => a.type === "agent" && a.status === "active" && a.managerId === managerId);
}

const roleValues = Object.values(MEMBER_ROLES);

/**
 * Member profile dialog. Opened by the row "Details" action.
 *   - Admin: edit anyone's display name + role.
 *   - Self (any role): edit own display name via `PATCH /me/profile`; the role
 *     selector stays admin-only, so a member can never self-promote.
 *   - Otherwise: read-only profile.
 */
function MemberDetailsDialog({
  target,
  isAdmin,
  isSelf,
  isSaving,
  onClose,
  onSave,
}: {
  target: MemberEditTarget | null;
  isAdmin: boolean;
  isSelf: boolean;
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
    if (memberRole !== target.role) {
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
  // Admins edit anyone; a member can edit their own name (role stays admin-only).
  const readOnly = !isAdmin && !isSelf;

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{readOnly ? "Profile" : "Edit profile"}</DialogTitle>
        </DialogHeader>
        {target && (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label>Username</Label>
              <Input value={target.username} disabled className="font-mono" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="member-display">Display name</Label>
              <Input
                id="member-display"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                required
                maxLength={200}
                disabled={readOnly}
              />
            </div>
            {isAdmin && (
              <div className="space-y-2">
                <Label htmlFor="member-role">Role</Label>
                <select
                  id="member-role"
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
                  Demoting the last admin is blocked — every org needs at least one admin.
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
                {readOnly ? "Close" : "Cancel"}
              </Button>
              {!readOnly && (
                <Button type="submit" disabled={isSaving}>
                  {isSaving ? "Saving…" : "Save"}
                </Button>
              )}
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
