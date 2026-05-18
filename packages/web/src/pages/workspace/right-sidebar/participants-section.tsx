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
 * The bottom "Add" affordance mirrors the header quick-add icon —
 * both go through the same `addMeChatParticipants` mutation.
 * Membership is currently non-revocable; only the header dropdown
 * still surfaces the one-way-door notice inline (see chat-view.tsx
 * ParticipantsHeader for the canonical copy and the design-doc
 * reference). The sidebar dropdown drops the notice — users opening
 * the sidebar are already in management mode and the repeated banner
 * was visual noise.
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
 * Inline "Add" row at the bottom of the Participants section. Visually
 * folds into the participant list — same row padding and an avatar-sized
 * dashed-circle stand-in (so the left edge lines up with HumanRow /
 * AgentRow) so the eye reads it as the list's next row, not a separate
 * button.
 *
 * States:
 *   - default:  "Add"        (clickable, opens the picker dropdown)
 *   - pending:  "Adding…"    (spinner in the slot, disabled)
 *   - all in:   "All added"  (disabled, dimmed, no dropdown)
 *
 * Shares `addMeChatParticipants` with the header quick-add icon.
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
  // Esc must close the dropdown without leaking to chat-view's
  // sidebar-level Esc handler. The trigger button keeps focus while the
  // menu is open, so a React-level handler scoped to the menu div never
  // sees the keystroke. Attaching to `document` in capture phase fires
  // before chat-view's bubble-phase listener, so stopPropagation here
  // peels off only the dropdown and leaves a closed dropdown's Esc free
  // to bubble and collapse the sidebar as before.
  useEffect(() => {
    if (!open) return;
    const handler = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
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
  const allAdded = outsideCandidates.length === 0;
  const disabled = allAdded || addMut.isPending;
  const label = addMut.isPending ? "Adding…" : allAdded ? "All added" : "Add";

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
          gap: "var(--sp-2_5)",
          padding: "var(--sp-1_75) var(--sp-2)",
          borderRadius: "var(--radius-input)",
          border: 0,
          background: "transparent",
          color: disabled ? "var(--fg-4)" : "var(--fg-3)",
          cursor: disabled ? "not-allowed" : "pointer",
          opacity: allAdded ? 0.55 : 1,
        }}
      >
        {/* Dashed-circle avatar stand-in — keeps the row left edge
            aligned with the avatars on participant rows above. */}
        <span
          aria-hidden="true"
          className="flex shrink-0 items-center justify-center"
          style={{
            width: 28,
            height: 28,
            borderRadius: 999,
            border: "var(--hairline) dashed var(--border)",
            color: "inherit",
          }}
        >
          {addMut.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
        </span>
        <span className="text-body">{label}</span>
      </button>
      {open && !allAdded && (
        <div
          role="menu"
          aria-label="Add participant"
          className="absolute z-20 max-h-72 overflow-auto border shadow-lg"
          style={{
            bottom: "calc(100% + var(--sp-1))",
            left: 0,
            right: 0,
            background: "var(--bg-raised)",
            borderColor: "var(--border)",
            borderRadius: "var(--radius-input)",
          }}
        >
          {(() => {
            const ambiguous = ambiguousDisplayNames(outsideCandidates);
            return outsideCandidates.map((cand) => {
              const ident = agentIdentity(cand.agentId);
              const avatarUrl = ident?.avatarImageUrl ?? null;
              const fallback = cand.displayName ?? cand.name ?? cand.agentId.slice(0, 8);
              return (
                <button
                  key={cand.agentId}
                  type="button"
                  role="menuitem"
                  onClick={() => addMut.mutate(cand.agentId)}
                  disabled={addMut.isPending}
                  className="flex w-full items-center text-left transition-colors hover:bg-[var(--bg-hover)]"
                  style={{
                    gap: "var(--sp-2_5)",
                    padding: "var(--sp-1_75) var(--sp-2)",
                    border: 0,
                    background: "transparent",
                    cursor: addMut.isPending ? "default" : "pointer",
                  }}
                >
                  <RealAvatar src={avatarUrl} name={fallback} seed={cand.agentId} size={28} />
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
