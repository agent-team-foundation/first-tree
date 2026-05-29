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
import { deleteMember, listMembers, updateMember } from "../../api/members.js";
import { getOrgUsageByAgent, type UsageWindow } from "../../api/usage.js";
import { useAuth } from "../../auth/auth-context.js";
import { NewAgentDialog } from "../../components/new-agent-dialog.js";
import { Button } from "../../components/ui/button.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { Input } from "../../components/ui/input.js";
import { Label } from "../../components/ui/label.js";
import { PageHeader } from "../../components/ui/page-header.js";
import { useMemberNameMap } from "../../lib/use-member-name-map.js";
import { InviteLinkPanel } from "../invite-link-panel.js";
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
};

type MemberEditTarget = {
  id: string;
  username: string;
  displayName: string;
  role: string;
};

type AgentFilter = "all" | "mine";

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
  const [agentFilter, setAgentFilter] = useState<AgentFilter>("all");
  const [query, setQuery] = useState("");
  const [usageWindow, setUsageWindow] = useState<UsageWindow>("30d");

  const membersQuery = useQuery({ queryKey: ["members"], queryFn: listMembers });

  const usageQuery = useQuery({
    queryKey: ["usage", "by-agent", usageWindow],
    queryFn: () => getOrgUsageByAgent(usageWindow),
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
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["members"] }),
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
    if (agent.status === "suspended") {
      actions.push({ key: "reactivate", label: "Reactivate", onSelect: () => reactivateAgentMut.mutate(agent.uuid) });
    } else {
      actions.push({ key: "suspend", label: "Suspend", onSelect: () => suspendAgentMut.mutate(agent.uuid) });
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
        right={
          <div className="flex items-center" style={{ gap: "var(--sp-2)" }}>
            {/* Brand-green cta is reserved for the one creation/hero action. */}
            <Button size="sm" variant="cta" onClick={() => setCreateOpen(true)}>
              <Plus className="h-3.5 w-3.5" />
              New agent
            </Button>
            {/* Secondary, admin-only — neutral outline, never green. */}
            {isAdmin && (
              <Button size="sm" variant="outline" onClick={() => setInviteOpen(true)}>
                <Link2 className="h-3.5 w-3.5" />
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
          gap: "var(--sp-1)",
        }}
      >
        <SearchBar query={query} onQuery={setQuery} />

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
            agentFilter={agentFilter}
            onAgentFilter={setAgentFilter}
            agentCount={agentCount}
            clientHostMap={clientHostMap}
            usageByAgentId={usageByAgentId}
            usageWindow={usageWindow}
            onUsageWindowChange={setUsageWindow}
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

      <MemberDetailsDialog
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
    </>
  );
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function SearchBar({ query, onQuery }: { query: string; onQuery: (q: string) => void }) {
  return (
    <div className="relative" style={{ width: "var(--sp-60)", maxWidth: "100%", marginBottom: "var(--sp-2)" }}>
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

  const visible = (a: Agent) => {
    // Members only see their own private agents; admins see all.
    if (a.visibility === "private" && !isAdmin && a.managerId !== selfMemberId) return false;
    // `Mine` filter: across both groups, only agents the viewer manages.
    if (filter === "mine" && a.managerId !== selfMemberId) return false;
    return matchAgent(a);
  };

  const toRow = (a: Agent): AgentRow => ({
    kind: "agent",
    agent: a,
    managerLabel: a.managerId ? resolveMember(a.managerId) : null,
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
    return { uuid: d.uuid, name: d.name, displayName: d.displayName };
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
        role: m.role,
        isSelf,
        delegate: resolveDelegate(m.agentId),
        // Per spec only the user themselves sets their own delegate (admins don't).
        canEditDelegate: isSelf,
        // Phase 2 wires the real timestamp; null renders "—" for now.
        lastActiveLabel: null,
      };
    })
    // Pin (you) to the top of the Humans section.
    .sort((a, b) => Number(b.isSelf) - Number(a.isSelf));

  return { publicAgents, privateAgents, humans, agentCount: publicAgents.length + privateAgents.length };
}

export function selectDelegateCandidates(agents: Agent[], managerId: string | null | undefined): Agent[] {
  // Personal assistants the viewer manages: type=agent + private + active +
  // managed by the viewer. The managerId filter is the issue 669 candidate fix —
  // the selector only lists the user's own agents, not the whole org's.
  return agents.filter(
    (a) => a.type === "agent" && a.visibility === "private" && a.status === "active" && a.managerId === managerId,
  );
}

const roleValues = Object.values(MEMBER_ROLES);

/**
 * Member profile dialog. Opened by the row "Details" action. Admins can edit
 * (display name + role); non-admins see a read-only profile for now. Self-edit
 * of one's own profile lands in Phase 2 via `PATCH /me/profile`.
 */
function MemberDetailsDialog({
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
  const readOnly = !isAdmin;

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
