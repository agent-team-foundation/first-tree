import type { ChatParticipantDetail } from "@first-tree/shared";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { useAuth } from "../../../auth/auth-context.js";
import { AddParticipantDropdown } from "../../../components/add-participant-dropdown.js";
import { Avatar as RealAvatar } from "../../../components/avatar.js";
import { AgentStatusPanel } from "../../../components/chat/agent-status-panel.js";

/** Roster rows shown before the "Show all" fold. The rail is a calm
 *  inspection surface, not a member-management screen — a long roster
 *  shouldn't push Description / GitHub off-screen, so we cap the visible
 *  rows and tuck the rest behind a toggle. */
export const VISIBLE_LIMIT = 5;

/**
 * Order the roster agents-first (their live status is the glanceable pulse),
 * then humans, preserving server order within each group; cap to `limit`
 * unless `showAll`. Pure so the ordering / fold math is unit-testable without
 * rendering the query-backed AgentStatusPanel.
 */
export function partitionRoster(
  participants: ChatParticipantDetail[],
  showAll: boolean,
  limit: number = VISIBLE_LIMIT,
): {
  total: number;
  visibleAgents: ChatParticipantDetail[];
  visibleHumans: ChatParticipantDetail[];
  hiddenCount: number;
} {
  const agents = participants.filter((p) => p.type !== "human");
  const humans = participants.filter((p) => p.type === "human");
  const ordered = [...agents, ...humans];
  const total = ordered.length;
  const visible = showAll ? ordered : ordered.slice(0, limit);
  return {
    total,
    visibleAgents: visible.filter((p) => p.type !== "human"),
    visibleHumans: visible.filter((p) => p.type === "human"),
    hiddenCount: total - visible.length,
  };
}

/**
 * Participants section — full chat membership (humans + agents), the top
 * section of the rail. Agents render first (their live status is the
 * glanceable pulse of the work) through <AgentStatusPanel> (one
 * /chats/:id/agent-status call drives every agent's composite status +
 * per-row Pause when the caller can manage). Humans follow as a simplified
 * roster (no session state, no actions in v1 — Remove / Change role are
 * deferred alongside the missing backend routes for member-side removal).
 *
 * The roster is capped at VISIBLE_LIMIT; the remainder collapses behind a
 * "Show all" toggle so a crowded chat can't dominate the rail.
 *
 * The bottom "Add" affordance shares <AddParticipantDropdown> with the
 * header quick-add icon — both go through the same `addMeChatParticipants`
 * mutation and the same grouped, avatar'd picker.
 *
 * Membership data (`participants` / `managedByMe`) is passed down from
 * ChatView, which already holds the `chat-detail` + `activity` queries.
 */
export function ParticipantsSection({
  chatId,
  participants,
  participantsLoading,
  managedByMe,
  onAdded,
  readOnly,
  liveTurnAgentIds,
}: {
  chatId: string;
  participants: ChatParticipantDetail[];
  participantsLoading: boolean;
  managedByMe: Map<string, boolean>;
  onAdded: () => void;
  readOnly: boolean;
  /** Agents with a live (un-ended) turn in the timeline; forwarded to
   *  AgentStatusPanel so a lapsed runtime heartbeat can't show Idle while the
   *  conversation shows the turn running. */
  liveTurnAgentIds?: ReadonlySet<string>;
}) {
  const { role } = useAuth();
  const [showAll, setShowAll] = useState(false);

  const isAdmin = role === "admin";
  const { total, visibleAgents, visibleHumans, hiddenCount } = useMemo(
    () => partitionRoster(participants, showAll),
    [participants, showAll],
  );

  return (
    <section style={{ borderBottom: "var(--hairline) solid var(--border-faint)" }}>
      <div className="text-eyebrow" style={{ padding: "var(--sp-2_5) var(--sp-3) var(--sp-1)", color: "var(--fg-4)" }}>
        Participants <span className="mono">· {total}</span>
      </div>

      <div className="flex flex-col" style={{ padding: "0 var(--sp-2) var(--sp-1)", gap: 2 }}>
        {participantsLoading ? (
          <div className="text-body" style={{ padding: "var(--sp-2)", color: "var(--fg-3)" }}>
            Loading…
          </div>
        ) : total === 0 ? (
          <div className="text-body" style={{ padding: "var(--sp-2)", color: "var(--fg-3)" }}>
            No participants yet.
          </div>
        ) : (
          <>
            {visibleAgents.length > 0 ? (
              <AgentStatusPanel
                chatId={chatId}
                agents={visibleAgents}
                canManage={(id) => isAdmin || (managedByMe.get(id) ?? false)}
                compact
                liveTurnAgentIds={liveTurnAgentIds}
              />
            ) : null}
            {visibleHumans.map((p) => (
              <HumanRow key={p.agentId} participant={p} />
            ))}
            {hiddenCount > 0 ? (
              <RosterToggle onClick={() => setShowAll(true)}>Show all · {total}</RosterToggle>
            ) : showAll && total > VISIBLE_LIMIT ? (
              <RosterToggle onClick={() => setShowAll(false)}>Show less</RosterToggle>
            ) : null}
          </>
        )}
      </div>

      {readOnly ? null : (
        <div style={{ padding: "var(--sp-1) var(--sp-2) var(--sp-2)" }}>
          <AddParticipantDropdown
            variant="inline"
            chatId={chatId}
            participantIds={participants.map((p) => p.agentId)}
            onAdded={onAdded}
          />
        </div>
      )}
    </section>
  );
}

function RosterToggle({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-caption w-full text-left transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--fg)]"
      style={{ padding: "var(--sp-1_5) var(--sp-2)", color: "var(--fg-3)", borderRadius: "var(--radius-input)" }}
    >
      {children}
    </button>
  );
}

function HumanRow({ participant }: { participant: ChatParticipantDetail }) {
  return (
    <div
      className="flex items-center"
      style={{
        gap: "var(--sp-2_5)",
        padding: "var(--sp-1_25) var(--sp-2)",
        borderRadius: "var(--radius-input)",
      }}
    >
      <RealAvatar
        src={participant.avatarImageUrl}
        name={participant.displayName}
        seed={participant.agentId}
        colorToken={participant.avatarColorToken}
        size={28}
      />
      <div className="flex min-w-0 flex-1 flex-col" style={{ gap: 2 }}>
        <div className="truncate text-subtitle">{participant.displayName}</div>
      </div>
    </div>
  );
}
