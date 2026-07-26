import type { Agent } from "@first-tree/shared";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useMemo, useState } from "react";
import { Link } from "react-router";
import { listAgents, listAllAgents } from "../../api/agents.js";
import { listMembers } from "../../api/members.js";
import { useAuth } from "../../auth/auth-context.js";
import { Avatar } from "../../components/avatar.js";
import { Input } from "../../components/ui/input.js";
import { presenceChipView, runtimeStateToPresence } from "../../components/ui/presence-chip.js";
import { StatusGlyph } from "../../components/ui/status-glyph.js";
import { formatRelative } from "../../lib/utils.js";
import { MobilePage, MobileSection, MobileSystemState, mobileCardStyle } from "./components.js";

type MemberListItem = {
  id: string;
  userId: string;
  organizationId: string;
  agentId: string;
  role: string;
  createdAt: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  lastActiveAt: string | null;
};

type PaginatedAgents = {
  items: Agent[];
  nextCursor: string | null;
};

const PAGE_SIZE = 100;
const MAX_PAGES = 100;

export function MobileTeamPage() {
  const { role, memberId } = useAuth();
  const [query, setQuery] = useState("");
  const isAdmin = role === "admin";

  const membersQuery = useQuery({ queryKey: ["mobile", "team", "members"], queryFn: listMembers });
  const agentsQuery = useQuery({
    queryKey: ["mobile", "team", "agents", isAdmin ? "admin" : "member"],
    queryFn: () => fetchAllAgents((params) => (isAdmin ? listAllAgents(params) : listAgents(params))),
    refetchInterval: 10_000,
  });

  const search = query.trim().toLowerCase();
  const agents = useMemo(
    () =>
      (agentsQuery.data ?? [])
        .filter((agent) => agent.type !== "human")
        .filter((agent) => matchesSearch(search, agent.displayName, agent.name ?? ""))
        .sort((a, b) => sortAgentRows(a, b, memberId)),
    [agentsQuery.data, memberId, search],
  );
  const humans = useMemo(
    () =>
      ((membersQuery.data ?? []) as MemberListItem[])
        .filter((member) => matchesSearch(search, member.displayName, member.username))
        .sort((a, b) => Number(b.id === memberId) - Number(a.id === memberId)),
    [memberId, membersQuery.data, search],
  );

  const loading = agentsQuery.isLoading || membersQuery.isLoading;
  const error = agentsQuery.error ?? membersQuery.error;

  return (
    <MobilePage className="flex flex-col" padded>
      <div style={{ marginBottom: "var(--sp-4)" }}>
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search team"
          aria-label="Search team"
          className="h-11"
        />
      </div>

      {loading && agents.length === 0 && humans.length === 0 ? (
        <MobileSystemState title="Loading team" />
      ) : error ? (
        <MobileSystemState title="Failed to load team" detail={formatError(error)} tone="error" />
      ) : (
        <div className="flex flex-col" style={{ gap: "var(--sp-5)" }}>
          <MobileSection title="Agents" count={agents.length}>
            {agents.length > 0 ? (
              <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
                {agents.map((agent) => (
                  <MobileAgentRow key={agent.uuid} agent={agent} />
                ))}
              </div>
            ) : (
              <MobileSystemState title="No agents" detail={search ? "No matches." : "Agents stay on desktop setup."} />
            )}
          </MobileSection>

          <MobileSection title="Humans" count={humans.length}>
            {humans.length > 0 ? (
              <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
                {humans.map((member) => (
                  <MobileHumanRow key={member.id} member={member} isSelf={member.id === memberId} />
                ))}
              </div>
            ) : (
              <MobileSystemState title="No humans" detail={search ? "No matches." : "Invite teammates on desktop."} />
            )}
          </MobileSection>
        </div>
      )}
    </MobilePage>
  );
}

function MobileAgentRow({ agent }: { agent: Agent }) {
  // Fold reachability and visibility into a single secondary line: a colored
  // presence dot (blue online / muted offline) plus a muted, non-mono
  // "Online · Private" caption. Dropping the "agent" suffix — the row already
  // sits under the "Agents" section header — and the standalone presence line
  // takes each card from three lines to two.
  const presence = presenceChipView(runtimeStateToPresence(agent.runtimeState));
  const visibility = agent.visibility === "private" ? "Private" : "Public";
  return (
    <MobileTeamRow
      avatar={
        <Avatar
          name={agent.displayName}
          src={agent.avatarImageUrl}
          colorToken={agent.avatarColorToken}
          seed={agent.uuid}
          size={36}
        />
      }
      title={agent.displayName}
      secondary={
        <>
          <StatusGlyph shape="dot" colorVar={presence.color} size={7} />
          <span className="truncate">{`${presence.label} · ${visibility}`}</span>
        </>
      }
      chatTarget={agent.uuid}
    />
  );
}

function MobileHumanRow({ member, isSelf }: { member: MemberListItem; isSelf: boolean }) {
  const activeLabel = member.lastActiveAt ? formatRelative(member.lastActiveAt) : "No activity";
  // The "Humans" section header already conveys the kind, so the former
  // "Human" meta badge is redundant; the role + last-active line is enough and
  // keeps the row to two lines, consistent with the agent rows.
  return (
    <MobileTeamRow
      avatar={<Avatar name={member.displayName} src={member.avatarUrl} seed={member.id} size={36} />}
      title={isSelf ? `${member.displayName} (you)` : member.displayName}
      secondary={<span className="truncate">{`${member.role} · ${activeLabel}`}</span>}
      chatTarget={isSelf ? null : member.agentId}
    />
  );
}

function MobileTeamRow({
  avatar,
  title,
  secondary,
  chatTarget,
}: {
  avatar: ReactNode;
  title: string;
  secondary: ReactNode;
  chatTarget: string | null;
}) {
  const cardStyle = {
    ...mobileCardStyle("panel"),
    gap: "var(--sp-3)",
  };
  const body = (
    <>
      <div className="shrink-0">{avatar}</div>
      <div className="min-w-0" style={{ flex: 1 }}>
        <p className="text-mobile-subtitle truncate" style={{ color: "var(--fg)", margin: 0 }}>
          {title}
        </p>
        <div
          className="flex items-center text-mobile-body"
          style={{ color: "var(--fg-3)", gap: "var(--sp-1_5)", margin: "var(--sp-0_5) 0 0" }}
        >
          {secondary}
        </div>
      </div>
    </>
  );
  // The whole card is the tap target — start/open a chat with this teammate.
  // Self (chatTarget null) has nothing to chat with, so it stays a plain,
  // non-interactive row.
  if (!chatTarget) {
    return (
      <div className="flex items-center" style={cardStyle} data-mobile-card="panel">
        {body}
      </div>
    );
  }
  return (
    <Link
      to={`/m/work?c=draft&with=${encodeURIComponent(chatTarget)}`}
      aria-label={`Chat with ${title}`}
      className="flex items-center transition-colors hover:bg-[var(--bg-hover)]"
      style={{ ...cardStyle, color: "var(--fg)", textDecoration: "none" }}
      data-mobile-card="panel"
    >
      {body}
    </Link>
  );
}

async function fetchAllAgents(
  fetchPage: (params: { limit: number; cursor?: string }) => Promise<PaginatedAgents>,
): Promise<Agent[]> {
  const items: Agent[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await fetchPage(cursor ? { limit: PAGE_SIZE, cursor } : { limit: PAGE_SIZE });
    items.push(...result.items);
    if (!result.nextCursor) return items;
    cursor = result.nextCursor;
  }
  throw new Error(`fetchAllAgents exceeded ${MAX_PAGES} pages`);
}

function matchesSearch(search: string, ...values: string[]): boolean {
  if (!search) return true;
  return values.some((value) => value.toLowerCase().includes(search));
}

function sortAgentRows(a: Agent, b: Agent, memberId: string | null): number {
  const mineA = a.managerId === memberId ? 0 : 1;
  const mineB = b.managerId === memberId ? 0 : 1;
  if (mineA !== mineB) return mineA - mineB;
  return a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" });
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
