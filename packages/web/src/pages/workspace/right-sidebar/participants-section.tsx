import type { ChatParticipantDetail } from "@agent-team-foundation/first-tree-hub-shared";
import { useMemo } from "react";
import { useAuth } from "../../../auth/auth-context.js";
import { AddParticipantDropdown } from "../../../components/add-participant-dropdown.js";
import { Avatar as RealAvatar } from "../../../components/avatar.js";
import type { MentionCandidate } from "../../../components/mention-autocomplete.js";
import { AgentRow } from "./agent-row.js";

/**
 * Participants section — full chat membership (humans + agents). Per-row
 * Suspend lives on AgentRow when the caller can manage that agent.
 * Humans render a simplified row (no session state, no actions in v1 —
 * Remove / Change role are deferred to a future iteration alongside the
 * missing backend routes for member-side participant removal).
 *
 * The bottom "Add" affordance shares <AddParticipantDropdown> with the
 * header quick-add icon — both go through the same `addMeChatParticipants`
 * mutation and the same grouped, avatar'd picker.
 *
 * Membership data (`participants` / `managedByMe`) is passed down from
 * ChatView, which already holds the `chat-detail` + `activity` queries —
 * this section no longer re-declares them.
 */
export function ParticipantsSection({
  chatId,
  participants,
  participantsLoading,
  managedByMe,
  addParticipantsCandidates,
  agentIdentity,
  onAdded,
  readOnly,
}: {
  chatId: string;
  participants: ChatParticipantDetail[];
  participantsLoading: boolean;
  managedByMe: Map<string, boolean>;
  addParticipantsCandidates: MentionCandidate[];
  agentIdentity: (
    uuid: string | null | undefined,
  ) => { name: string | null; displayName: string; avatarImageUrl: string | null } | null;
  onAdded: () => void;
  readOnly: boolean;
}) {
  const { role } = useAuth();

  // Humans first (the people in the room), then agents (the tools and
  // teammates). Within each group, server order is preserved.
  const sorted = useMemo(() => {
    const humans = participants.filter((p) => p.type === "human");
    const agents = participants.filter((p) => p.type !== "human");
    return [...humans, ...agents];
  }, [participants]);

  const isAdmin = role === "admin";

  return (
    <section style={{ borderBottom: "var(--hairline) solid var(--border-faint)" }}>
      {/* Count is rendered inline ("Participants · N") rather than as a
          right-aligned separate field; the right edge of this eyebrow
          row is reserved for the floating X close button on the rail. */}
      <div className="text-eyebrow" style={{ padding: "var(--sp-2_5) var(--sp-3) var(--sp-1)", color: "var(--fg-4)" }}>
        Participants <span className="mono">· {sorted.length}</span>
      </div>

      <div className="flex flex-col" style={{ padding: "0 var(--sp-2) var(--sp-1)", gap: 2 }}>
        {participantsLoading ? (
          <div className="text-body" style={{ padding: "var(--sp-2)", color: "var(--fg-3)" }}>
            Loading…
          </div>
        ) : sorted.length === 0 ? (
          <div className="text-body" style={{ padding: "var(--sp-2)", color: "var(--fg-3)" }}>
            No participants yet.
          </div>
        ) : (
          sorted.map((p) =>
            p.type === "human" ? (
              <HumanRow key={p.agentId} participant={p} />
            ) : (
              <AgentRow
                key={p.agentId}
                chatId={chatId}
                participant={p}
                canSuspend={isAdmin || (managedByMe.get(p.agentId) ?? false)}
              />
            ),
          )
        )}
      </div>

      {readOnly ? null : (
        <div style={{ padding: "var(--sp-1) var(--sp-2) var(--sp-2)" }}>
          <AddParticipantDropdown
            variant="inline"
            chatId={chatId}
            candidates={addParticipantsCandidates}
            participantIds={participants.map((p) => p.agentId)}
            agentIdentity={agentIdentity}
            onAdded={onAdded}
          />
        </div>
      )}
    </section>
  );
}

function HumanRow({ participant }: { participant: ChatParticipantDetail }) {
  return (
    <div
      className="flex items-center"
      style={{
        gap: "var(--sp-2_5)",
        padding: "var(--sp-1_75) var(--sp-2)",
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
