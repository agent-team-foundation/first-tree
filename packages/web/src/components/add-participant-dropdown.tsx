import { useMutation } from "@tanstack/react-query";
import { Loader2, Plus, UserPlus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { addMeChatParticipants } from "../api/me-chats.js";
import { Avatar as RealAvatar } from "./avatar.js";
import {
  ambiguousDisplayNames,
  groupAndSortCandidates,
  type MentionCandidate,
  MentionLabel,
} from "./mention-autocomplete.js";

type AgentIdentityResolver = (
  uuid: string | null | undefined,
) => { name: string | null; displayName: string; avatarImageUrl: string | null } | null;

/**
 * Shared "add an agent to this chat" dropdown. Backs both the header
 * quick-add icon (`variant="icon"`) and the right-sidebar inline row
 * (`variant="inline"`). Only the trigger shell differs by variant; the
 * dropdown list is identical across both surfaces: avatar + "mine / others"
 * grouping with a divider.
 *
 * The component owns disclosure (open / click-outside / Esc), keyboard
 * navigation, and the immediate `addMeChatParticipants` mutation. Callers
 * pass the candidate union (members + org-discoverable, already shaped to
 * `MentionCandidate`, self excluded) and the current `participantIds`; the
 * already-in members are filtered out here.
 */
export function AddParticipantDropdown({
  chatId,
  candidates,
  participantIds,
  agentIdentity,
  onAdded,
  variant,
}: {
  chatId: string;
  candidates: MentionCandidate[];
  participantIds: string[];
  agentIdentity: AgentIdentityResolver;
  onAdded: () => void;
  variant: "icon" | "inline";
}) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Click-outside closes the dropdown.
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

  // Esc closes only this dropdown. Capture phase + stopPropagation so it
  // fires before chat-view's bubble-phase sidebar Esc handler — without
  // this, Esc in the header/sidebar picker would also collapse the rail.
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

  // Unified appearance: mine-first / others grouping with a divider.
  // `items` carries the divider marker; `selectable` is the divider-free
  // list that keyboard navigation walks.
  const items = useMemo(() => groupAndSortCandidates(outsideCandidates), [outsideCandidates]);
  const selectable = useMemo(() => items.filter((it): it is MentionCandidate => !("divider" in it)), [items]);
  const ambiguous = useMemo(() => ambiguousDisplayNames(outsideCandidates), [outsideCandidates]);

  // Reset the highlight whenever the menu opens or the option set changes,
  // and focus the menu so it receives arrow / Enter keystrokes.
  useEffect(() => {
    if (open) {
      setHighlight(0);
      menuRef.current?.focus();
    }
  }, [open]);

  const commit = (agentId: string): void => {
    if (addMut.isPending) return;
    addMut.mutate(agentId);
  };

  const onMenuKeyDown = (e: React.KeyboardEvent): void => {
    if (selectable.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((i) => (i + 1) % selectable.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((i) => (i - 1 + selectable.length) % selectable.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const picked = selectable[highlight] ?? selectable[0];
      if (picked) commit(picked.agentId);
    }
    // Escape is handled by the capture-phase document listener above.
  };

  const label = addMut.isPending ? "Adding…" : allAdded ? "All added" : "Add";

  return (
    <div ref={containerRef} className="relative">
      {variant === "icon" ? (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          disabled={disabled}
          title={allAdded ? "All available agents are already in this chat" : "Add participant"}
          aria-label="Add participant"
          aria-haspopup="menu"
          aria-expanded={open}
          className="inline-flex shrink-0 items-center justify-center transition-colors hover:bg-[var(--bg-hover)]"
          style={{
            width: 28,
            height: 28,
            border: 0,
            background: "transparent",
            borderRadius: "var(--radius-input)",
            color: disabled ? "var(--fg-4)" : "var(--fg-3)",
            cursor: disabled ? "not-allowed" : "pointer",
          }}
        >
          <UserPlus size={16} />
        </button>
      ) : (
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
          {/* Dashed-circle avatar stand-in — keeps the row left edge aligned
              with the avatars on the participant rows above. */}
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
      )}

      {open && !allAdded && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Add participant"
          tabIndex={-1}
          onKeyDown={onMenuKeyDown}
          className="absolute z-20 max-h-72 overflow-auto border shadow-lg outline-none"
          style={{
            top: "calc(100% + var(--sp-1))",
            // Icon trigger sits at the panel's right edge → grow leftward;
            // the inline row spans the rail → match its full width.
            ...(variant === "icon" ? { right: 0, minWidth: 280 } : { left: 0, right: 0 }),
            background: "var(--bg-raised)",
            borderColor: "var(--border)",
            borderRadius: "var(--radius-input)",
          }}
        >
          {(() => {
            let idx = -1;
            return items.map((it) => {
              if ("divider" in it) {
                return (
                  <div
                    key="__divider"
                    role="presentation"
                    style={{
                      height: "var(--hairline)",
                      background: "var(--border-faint)",
                      margin: "var(--sp-0_5) var(--sp-3)",
                    }}
                  />
                );
              }
              idx += 1;
              const myIdx = idx;
              const active = myIdx === highlight;
              const ident = agentIdentity(it.agentId);
              const fallback = it.displayName ?? it.name ?? it.agentId.slice(0, 8);
              return (
                <button
                  key={it.agentId}
                  type="button"
                  role="menuitem"
                  title={it.name ? `@${it.name}` : undefined}
                  onClick={() => commit(it.agentId)}
                  onMouseEnter={() => setHighlight(myIdx)}
                  disabled={addMut.isPending}
                  className="flex w-full items-center text-left transition-colors"
                  style={{
                    gap: "var(--sp-2_5)",
                    padding: "var(--sp-1_75) var(--sp-2)",
                    border: 0,
                    background: active ? "var(--bg-hover)" : "transparent",
                    cursor: addMut.isPending ? "default" : "pointer",
                  }}
                >
                  <RealAvatar src={ident?.avatarImageUrl ?? null} name={fallback} seed={it.agentId} size={28} />
                  <MentionLabel candidate={it} ambiguous={ambiguous} />
                </button>
              );
            });
          })()}
        </div>
      )}
    </div>
  );
}
