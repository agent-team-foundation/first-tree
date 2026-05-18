import type { ChatParticipantDetail } from "@agent-team-foundation/first-tree-hub-shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2, Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { getActivityOverview } from "../../../api/activity.js";
import { getChat } from "../../../api/chats.js";
import { addMeChatParticipants } from "../../../api/me-chats.js";
import { useAuth } from "../../../auth/auth-context.js";
import { Avatar as RealAvatar } from "../../../components/avatar.js";
import {
  ambiguousDisplayNames,
  type MentionCandidate,
  MentionLabel,
} from "../../../components/mention-autocomplete.js";
import { DenseBadge } from "../../../components/ui/dense-badge.js";
import { AgentRow } from "./agent-row.js";

/**
 * Participants section — full chat membership (humans + agents). Per-row
 * Suspend lives on AgentRow when the caller can manage that agent.
 * Humans render a simplified row (no session state, no actions in v1 —
 * Remove / Change role are deferred to a future iteration alongside the
 * missing backend routes for member-side participant removal).
 *
 * The "+ Add participant" affordance at the bottom mirrors the header
 * quick-add icon — both go through the same `addMeChatParticipants`
 * mutation and the same one-way-door notice (membership is currently
 * non-revocable; see chat-view.tsx ParticipantsHeader for the canonical
 * inline copy and the design-doc reference).
 */
export function ParticipantsSection({
  chatId,
  addParticipantsCandidates,
  agentIdentity,
  onAdded,
  readOnly,
}: {
  chatId: string;
  addParticipantsCandidates: MentionCandidate[];
  agentIdentity: (
    uuid: string | null | undefined,
  ) => { name: string | null; displayName: string; avatarImageUrl: string | null } | null;
  onAdded: () => void;
  readOnly: boolean;
}) {
  const { role } = useAuth();
  const chatQuery = useQuery({
    queryKey: ["chat-detail", chatId],
    queryFn: () => getChat(chatId),
    enabled: !!chatId,
  });
  const activityQuery = useQuery({
    queryKey: ["activity"],
    queryFn: getActivityOverview,
    refetchInterval: 15_000,
  });

  const managedByMe = useMemo(() => {
    const m = new Map<string, boolean>();
    for (const a of activityQuery.data?.agents ?? []) m.set(a.agentId, a.managedByMe);
    return m;
  }, [activityQuery.data?.agents]);

  const participants = chatQuery.data?.participants ?? [];
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
        {chatQuery.isLoading ? (
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
          <AddParticipantInlineButton
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
        {/* Same DenseBadge slot as AgentRow's state badge — keeps the
            two row variants visually symmetric so the eye doesn't have
            to context-switch between "agent row" and "human row" styling
            mid-list. Humans don't have runtime state, so the badge just
            labels the kind. */}
        <div className="mono flex items-center text-caption" style={{ color: "var(--fg-3)" }}>
          <DenseBadge tone="outline">HUMAN</DenseBadge>
        </div>
      </div>
    </div>
  );
}

/**
 * Inline "+ Add participant" button that opens a dropdown of org-wide
 * addable agents — same data source as the header quick-add icon
 * (`addableCandidates` derived in chat-view). The pick triggers the
 * shared `addMeChatParticipants` mutation; the v1 one-way-door notice
 * lives at the top of the dropdown so users see it before they pick.
 */
function AddParticipantInlineButton({
  chatId,
  candidates,
  participantIds,
  agentIdentity,
  onAdded,
}: {
  chatId: string;
  candidates: MentionCandidate[];
  participantIds: string[];
  agentIdentity: (
    uuid: string | null | undefined,
  ) => { name: string | null; displayName: string; avatarImageUrl: string | null } | null;
  onAdded: () => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const handler = (ev: MouseEvent) => {
      if (!containerRef.current) return;
      if (containerRef.current.contains(ev.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const addMut = useMutation({
    mutationFn: (agentId: string) => addMeChatParticipants(chatId, { participantIds: [agentId] }),
    onSuccess: () => {
      setOpen(false);
      onAdded();
    },
  });

  const outsideCandidates = useMemo(
    () => candidates.filter((c) => !participantIds.includes(c.agentId)),
    [candidates, participantIds],
  );
  const disabled = outsideCandidates.length === 0 || addMut.isPending;

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex w-full items-center transition-colors hover:bg-[var(--bg-hover)]"
        style={{
          gap: "var(--sp-2)",
          padding: "var(--sp-1_75) var(--sp-2)",
          borderRadius: "var(--radius-input)",
          border: "var(--hairline) solid var(--border)",
          background: "transparent",
          color: disabled ? "var(--fg-4)" : "var(--fg-2)",
          cursor: disabled ? "not-allowed" : "pointer",
        }}
        title={outsideCandidates.length === 0 ? "All available agents are already in this chat" : "Add participant"}
      >
        {addMut.isPending ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
        ) : (
          <Plus className="h-3.5 w-3.5 shrink-0" />
        )}
        <span className="text-body">{addMut.isPending ? "Adding…" : "Add participant"}</span>
      </button>
      {open && outsideCandidates.length > 0 && (
        <div
          role="menu"
          aria-label="Add participant"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
            }
          }}
          className="absolute z-20 max-h-72 overflow-auto rounded-md border shadow-lg"
          style={{
            bottom: "calc(100% + var(--sp-1))",
            left: 0,
            right: 0,
            background: "var(--bg-raised)",
            borderColor: "var(--border)",
          }}
        >
          <div
            role="note"
            className="text-caption"
            style={{
              padding: "var(--sp-1) var(--sp-3)",
              color: "var(--fg-3)",
              borderBottom: "var(--hairline) solid var(--border-faint)",
              background: "var(--bg-sunken)",
              whiteSpace: "normal",
              lineHeight: 1.4,
            }}
          >
            Adding is a one-way door — V1 has no remove flow yet.
          </div>
          {(() => {
            const ambiguous = ambiguousDisplayNames(outsideCandidates);
            return outsideCandidates.map((cand) => {
              const ident = agentIdentity(cand.agentId);
              const avatarUrl = ident?.avatarImageUrl ?? null;
              const label = cand.displayName ?? cand.name ?? cand.agentId.slice(0, 8);
              return (
                <button
                  key={cand.agentId}
                  type="button"
                  role="menuitem"
                  onClick={() => addMut.mutate(cand.agentId)}
                  disabled={addMut.isPending}
                  className="flex w-full items-center text-left transition-colors hover:bg-[var(--bg-hover)]"
                  style={{
                    gap: "var(--sp-2)",
                    padding: "var(--sp-1_5) var(--sp-3)",
                    border: 0,
                    background: "transparent",
                    cursor: addMut.isPending ? "default" : "pointer",
                  }}
                >
                  <RealAvatar src={avatarUrl} name={label} seed={cand.agentId} size={20} />
                  <MentionLabel candidate={cand} ambiguous={ambiguous} />
                </button>
              );
            });
          })()}
        </div>
      )}
    </div>
  );
}
