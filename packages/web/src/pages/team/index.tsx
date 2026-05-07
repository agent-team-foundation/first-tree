import type { Agent, RuntimeProvider } from "@agent-team-foundation/first-tree-hub-shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, UserPlus } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { getActivityOverview, type RuntimeAgent } from "../../api/activity.js";
import { listAgents } from "../../api/agents.js";
import { listMembers } from "../../api/members.js";
import { useAuth } from "../../auth/auth-context.js";
import { NewAgentDialog } from "../../components/new-agent-dialog.js";
import { Button } from "../../components/ui/button.js";
import {
  DenseTable,
  DenseTableBody,
  DenseTableCell,
  DenseTableHead,
  DenseTableHeader,
  DenseTableRow,
} from "../../components/ui/dense-table.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { FlatSectionHeader } from "../../components/ui/flat-section-header.js";
import { PageHeader } from "../../components/ui/page-header.js";
import { StateChip } from "../../components/ui/state-chip.js";
import { useMemberNameMap } from "../../lib/use-member-name-map.js";
import { formatDate } from "../../lib/utils.js";
import { InviteLinkPanel } from "../invite-link-panel.js";
import { MembersPage } from "../members.js";

type AgentsData = {
  items: Agent[];
};

/**
 * Team page — single surface combining People (login users / org members)
 * and Agents (bots) into one cohesive "this is the team" view. Two tables
 * are stacked rather than merged so each preserves its native columns and
 * actions. The AI-native team narrative is carried by the page-level
 * summary "N people · M agents".
 *
 * People = members table (login users; humans only by definition).
 * Agents = filter type=human (those are the user's own chat-identity
 * mirror, not a manageable agent — see members.ts service).
 */
export function TeamPage() {
  const { role } = useAuth();
  const isAdmin = role === "admin";
  const [inviteOpen, setInviteOpen] = useState(false);

  const { data: members } = useQuery({
    queryKey: ["members"],
    queryFn: listMembers,
  });

  const agentsQuery = useQuery({
    queryKey: ["agents", "team-page"],
    queryFn: () => listAgents({ limit: 100 }),
  });

  const peopleCount = members?.length ?? 0;
  const botCount = (agentsQuery.data?.items ?? []).filter((a) => a.type !== "human").length;

  return (
    <>
      <PageHeader
        title="Team"
        subtitle={`${peopleCount} ${peopleCount === 1 ? "human" : "humans"} and ${botCount} ${botCount === 1 ? "agent" : "agents"} working together`}
        right={
          isAdmin && (
            <Button size="xs" variant="ghost" onClick={() => setInviteOpen(true)}>
              <UserPlus className="h-3 w-3" />
              Invite link
            </Button>
          )
        }
      />
      <div
        style={{
          padding: "var(--sp-2) var(--sp-5) var(--sp-7)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--sp-5)",
        }}
      >
        <PeopleSection />
        <AgentsSection data={agentsQuery.data} isLoading={agentsQuery.isLoading} error={agentsQuery.error} />
      </div>

      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Invite link</DialogTitle>
          </DialogHeader>
          <InviteLinkPanel />
        </DialogContent>
      </Dialog>
    </>
  );
}

function PeopleSection() {
  return (
    <section>
      <FlatSectionHeader>Humans</FlatSectionHeader>
      <MembersPage />
    </section>
  );
}

function AgentsSection({
  data,
  isLoading,
  error,
}: {
  data: AgentsData | undefined;
  isLoading: boolean;
  error: unknown;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const resolveMember = useMemberNameMap();
  const { memberId } = useAuth();
  const [createOpen, setCreateOpen] = useState(false);

  const { data: activity } = useQuery({
    queryKey: ["activity"],
    queryFn: getActivityOverview,
    refetchInterval: 10_000,
  });

  const runtimeMap = useMemo(() => {
    const map = new Map<string, RuntimeAgent>();
    for (const r of activity?.agents ?? []) map.set(r.agentId, r);
    return map;
  }, [activity?.agents]);

  // Filter out human-type (user's chat-identity mirror — already shown
  // in the People section as a member) and float the current user's
  // agents to the top.
  const items = useMemo(() => {
    const all = (data?.items ?? []).filter((a) => a.type !== "human");
    if (!memberId) return all;
    const mine: typeof all = [];
    const others: typeof all = [];
    for (const a of all) (a.managerId === memberId ? mine : others).push(a);
    return [...mine, ...others];
  }, [data?.items, memberId]);

  function handleCreated(_agent: Agent, _runtimeProvider: RuntimeProvider) {
    setCreateOpen(false);
    queryClient.invalidateQueries({ queryKey: ["agents"] });
    queryClient.invalidateQueries({ queryKey: ["activity"] });
  }

  return (
    <>
      <section>
        <FlatSectionHeader
          right={
            <Button
              size="xs"
              variant="ghost"
              className="normal-case tracking-normal"
              onClick={() => setCreateOpen(true)}
            >
              <Plus className="h-3 w-3" />
              New agent
            </Button>
          }
        >
          Agents
        </FlatSectionHeader>

        {isLoading ? (
          <div className="text-center py-8 text-body" style={{ color: "var(--fg-3)" }}>
            Loading…
          </div>
        ) : error ? (
          <div className="text-center py-8 text-body" style={{ color: "var(--state-error)" }}>
            Failed to load agents: {error instanceof Error ? error.message : "Unknown error"}
          </div>
        ) : items.length === 0 ? (
          <div className="text-center py-8 text-body" style={{ color: "var(--fg-3)" }}>
            No agents yet — create one with “New agent”.
          </div>
        ) : (
          <DenseTable>
            <DenseTableHeader>
              <DenseTableRow>
                <DenseTableHead style={{ width: 160 }}>Display name</DenseTableHead>
                <DenseTableHead style={{ width: 140 }}>Agent name</DenseTableHead>
                <DenseTableHead style={{ minWidth: 150 }}>Type</DenseTableHead>
                <DenseTableHead style={{ minWidth: 160 }}>Managed by</DenseTableHead>
                <DenseTableHead style={{ minWidth: 100 }}>Visibility</DenseTableHead>
                <DenseTableHead style={{ minWidth: 110 }}>Status</DenseTableHead>
                <DenseTableHead style={{ minWidth: 150 }}>Created</DenseTableHead>
              </DenseTableRow>
            </DenseTableHeader>
            <DenseTableBody>
              {items.map((a) => {
                const runtime = runtimeMap.get(a.uuid);
                return (
                  <DenseTableRow
                    key={a.uuid}
                    interactive
                    onClick={() => navigate(`/agents/${encodeURIComponent(a.uuid)}`)}
                  >
                    <DenseTableCell>
                      <span className="font-medium">{a.displayName}</span>
                    </DenseTableCell>
                    <DenseTableCell>
                      {a.name ? (
                        <span className="mono text-label" style={{ color: "var(--fg-3)" }}>
                          @{a.name}
                        </span>
                      ) : (
                        <span className="mono text-label" style={{ color: "var(--fg-4)" }}>
                          —
                        </span>
                      )}
                    </DenseTableCell>
                    <DenseTableCell className="text-label" style={{ color: "var(--fg-3)" }}>
                      {agentTypeLabel(a.type)}
                    </DenseTableCell>
                    <DenseTableCell className="text-label" style={{ color: "var(--fg-2)" }}>
                      {a.managerId ? resolveMember(a.managerId) : "—"}
                      {a.managerId && a.managerId === memberId && (
                        <span className="text-label italic" style={{ marginLeft: 6, color: "var(--fg-3)" }}>
                          (you)
                        </span>
                      )}
                    </DenseTableCell>
                    <DenseTableCell className="text-label" style={{ color: "var(--fg-3)" }}>
                      {visibilityLabel(a.visibility)}
                    </DenseTableCell>
                    <DenseTableCell>
                      <StateChip state={runtime?.runtimeState ?? null} />
                    </DenseTableCell>
                    <DenseTableCell className="mono text-caption" style={{ color: "var(--fg-4)" }}>
                      {formatDate(a.createdAt)}
                    </DenseTableCell>
                  </DenseTableRow>
                );
              })}
            </DenseTableBody>
          </DenseTable>
        )}
      </section>

      <NewAgentDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={handleCreated} />
    </>
  );
}

function agentTypeLabel(type: string): string {
  if (type === "autonomous_agent") return "Autonomous agent";
  if (type === "personal_assistant") return "Personal assistant";
  return type;
}

function visibilityLabel(visibility: string): string {
  if (visibility === "organization") return "Shared";
  if (visibility === "private") return "Private";
  return visibility;
}
