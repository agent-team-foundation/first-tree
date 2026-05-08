import { extractMentions, type MentionParticipant } from "@agent-team-foundation/first-tree-hub-shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, Plus, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { getActivityOverview, type RuntimeAgent } from "../../../api/activity.js";
import { sendChatMessage } from "../../../api/chats.js";
import { createMeChat } from "../../../api/me-chats.js";
import { useAuth } from "../../../auth/auth-context.js";
import {
  MentionAutocompletePopover,
  type MentionCandidate,
  useMentionAutocomplete,
} from "../../../components/mention-autocomplete.js";
import { useAgentIdentityMap } from "../../../lib/use-agent-name-map.js";
import { cn } from "../../../lib/utils.js";

/**
 * Inline new-chat draft, A-model split between "audience" (room
 * membership) and "inline mention" (per-message ping):
 *
 *   - Chip row at the top of the composer is the participants list for
 *     the chat being created. Independent of the textarea — adding a
 *     chip never injects text, removing one never strips an `@<name>`.
 *     Default state seeds a single MRU chip so 1:1 sends are zero-step.
 *
 *   - Textarea carries the message content. For 1:1 (single chip), no
 *     `@` is required — server treats the chat as direct and skips
 *     `enforceGroupMention`. For groups (2+ chips) the body must
 *     explicitly `@` at least one chip to wake `mention_only` agents.
 *     Send is gated client-side to mirror this.
 *
 *   - Typing `@` in the textarea opens the autocomplete (candidates =
 *     all org agents). Picking an agent that isn't in the chip row
 *     promotes them to a chip — "I want to address X" subsumes "X is
 *     in the room". This unifies entry points without making them
 *     mutually exclusive.
 *
 * On send: createMeChat({participantIds: chips}) → sendChatMessage with
 * the verbatim body. Empty body with at least one chip is allowed.
 */

export function NewChatDraft({ onCreated }: { onCreated: (chatId: string) => void }) {
  const queryClient = useQueryClient();
  const { agentId: myAgentId } = useAuth();
  const agentIdentity = useAgentIdentityMap();

  const [chips, setChips] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [cursor, setCursor] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const seededDefaultRef = useRef(false);
  const pickerContainerRef = useRef<HTMLDivElement>(null);

  const { data: activity } = useQuery({
    queryKey: ["activity"],
    queryFn: getActivityOverview,
    refetchInterval: 15_000,
  });

  const candidates = useMemo<MentionCandidate[]>(() => {
    const rows = activity?.agents ?? [];
    const out: MentionCandidate[] = [];
    for (const row of rows) {
      if (myAgentId && row.agentId === myAgentId) continue;
      const ident = agentIdentity(row.agentId);
      if (!ident || !ident.name) continue;
      out.push({ agentId: row.agentId, name: ident.name, displayName: ident.displayName });
    }
    return out;
  }, [activity, agentIdentity, myAgentId]);

  useEffect(() => {
    if (seededDefaultRef.current) return;
    if (chips.length > 0) return;
    if (candidates.length === 0) return;
    const defaultId = pickDefault(candidates, activity?.agents ?? []);
    if (!defaultId) return;
    setChips([defaultId]);
    seededDefaultRef.current = true;
  }, [candidates, activity, chips.length]);

  const bodyMentions = useMemo(() => {
    const ps: MentionParticipant[] = candidates.map((c) => ({ agentId: c.agentId, name: c.name }));
    return extractMentions(draft, ps);
  }, [draft, candidates]);

  const mention = useMentionAutocomplete({
    value: draft,
    cursor,
    candidates,
    disabled: sending,
    onSelect: (update) => {
      setDraft(update.text);
      setCursor(update.cursor);
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(update.cursor, update.cursor);
      });
    },
  });

  /** Promote textarea-`@`-mentioned agents to chips (single source of
   *  truth: "addressing X" ⇒ "X is in the room"). Doesn't remove chips
   *  when `@`s are deleted — chip life cycle is governed by `×`. */
  useEffect(() => {
    if (bodyMentions.length === 0) return;
    setChips((prev) => {
      const set = new Set(prev);
      let changed = false;
      for (const id of bodyMentions) {
        if (!set.has(id)) {
          set.add(id);
          changed = true;
        }
      }
      return changed ? [...set] : prev;
    });
  }, [bodyMentions]);

  useEffect(() => {
    if (!pickerOpen) return;
    const handler = (ev: MouseEvent) => {
      if (!pickerContainerRef.current) return;
      if (pickerContainerRef.current.contains(ev.target as Node)) return;
      setPickerOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [pickerOpen]);

  const createMut = useMutation({
    mutationFn: async ({ participantIds, text }: { participantIds: string[]; text: string }) => {
      const created = await createMeChat({ participantIds });
      const trimmed = text.trim();
      if (trimmed.length > 0) {
        await sendChatMessage(created.chatId, trimmed);
      }
      return created.chatId;
    },
    onSuccess: (chatId) => {
      setDraft("");
      setChips([]);
      seededDefaultRef.current = false;
      queryClient.invalidateQueries({ queryKey: ["me", "chats"] });
      onCreated(chatId);
    },
    onError: (err: unknown) => {
      setError(err instanceof Error ? err.message : "Failed to create chat");
    },
  });

  const canSend = useMemo(() => {
    if (sending || createMut.isPending) return false;
    if (chips.length === 0) return false;
    if (draft.trim().length === 0) return false;
    if (chips.length >= 2 && bodyMentions.length === 0) return false;
    return true;
  }, [sending, createMut.isPending, chips.length, draft, bodyMentions.length]);

  const sendBlockedReason = useMemo(() => {
    if (chips.length === 0) return "Add at least one participant";
    if (draft.trim().length === 0) return null;
    if (chips.length >= 2 && bodyMentions.length === 0) {
      return "Group chats need an @ to wake at least one participant";
    }
    return null;
  }, [chips.length, draft, bodyMentions.length]);

  const handleSend = async (): Promise<void> => {
    if (!canSend) return;
    // Merge `bodyMentions` into the participant list synchronously.
    // The `bodyMentions → chips` promote effect runs asynchronously
    // (via `useEffect`), so a fast user who types `@bob` and presses
    // Enter immediately can land in `handleSend` before `chips` has
    // absorbed bob — without this merge, `createMeChat` would create
    // the chat without bob and bob's `@`-token would silently drop on
    // the server (no such participant). Compute the union here so the
    // committed audience always reflects what the user just typed.
    const participantIds = Array.from(new Set([...chips, ...bodyMentions]));
    setError(null);
    setSending(true);
    try {
      await createMut.mutateAsync({ participantIds, text: draft });
    } finally {
      setSending(false);
    }
  };

  const removeChip = (agentId: string): void => {
    setChips((prev) => prev.filter((id) => id !== agentId));
  };
  const addChip = (agentId: string): void => {
    setChips((prev) => (prev.includes(agentId) ? prev : [...prev, agentId]));
    setPickerOpen(false);
  };
  const chipCandidates = useMemo(() => candidates.filter((c) => !chips.includes(c.agentId)), [candidates, chips]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden" style={{ background: "var(--bg-base)" }}>
      <div className="flex-1 flex flex-col items-center justify-center" style={{ padding: "var(--sp-6)" }}>
        <div style={{ width: "100%", maxWidth: "clamp(55rem, 75%, 70rem)" }}>
          <p className="text-title" style={{ color: "var(--fg)", textAlign: "center", marginBottom: "var(--sp-5)" }}>
            What's the task?
          </p>

          <div
            style={{
              borderRadius: 10,
              background: "var(--bg-raised)",
              boxShadow: "var(--shadow-md)",
              overflow: "visible",
            }}
          >
            <ParticipantChips
              chips={chips}
              candidates={candidates}
              chipCandidates={chipCandidates}
              pickerOpen={pickerOpen}
              setPickerOpen={setPickerOpen}
              pickerContainerRef={pickerContainerRef}
              onAdd={addChip}
              onRemove={removeChip}
            />
            <div style={{ position: "relative" }}>
              <MentionAutocompletePopover
                trigger={mention.trigger}
                results={mention.results}
                highlightIndex={mention.highlightIndex}
                anchorRef={textareaRef}
                onPick={mention.pick}
              />
              <textarea
                ref={textareaRef}
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setCursor(e.target.selectionStart ?? e.target.value.length);
                }}
                onSelect={(e) => {
                  setCursor(e.currentTarget.selectionStart ?? draft.length);
                }}
                placeholder={
                  chips.length >= 2 ? "Describe the task. Use @ to address one or more." : "Describe the task…"
                }
                rows={1}
                onKeyDown={(e) => {
                  if (mention.handleKey(e)) return;
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void handleSend();
                  }
                }}
                disabled={sending || createMut.isPending}
                className="w-full outline-none text-subtitle font-normal"
                style={{
                  padding: "var(--sp-2) var(--sp-3)",
                  background: "transparent",
                  border: "none",
                  resize: "none",
                  color: "var(--fg)",
                }}
              />
              {/* Ghost-text hint that trails the user's cursor when they're
                  typing in a group chat without an `@`. Mirrors the textarea's
                  font/padding/wrap so the hint slots seamlessly after the
                  last typed character on the visible line. Set
                  `pointer-events: none` and `aria-hidden` so it's a pure
                  visual cue — clicks fall through to the textarea. */}
              {chips.length >= 2 && bodyMentions.length === 0 && draft.trim().length > 0 && (
                <div
                  aria-hidden="true"
                  className="text-subtitle font-normal"
                  style={{
                    position: "absolute",
                    inset: 0,
                    padding: "var(--sp-2) var(--sp-3)",
                    margin: 0,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    pointerEvents: "none",
                    color: "transparent",
                    overflow: "hidden",
                  }}
                >
                  {draft}
                  <span style={{ color: "var(--fg-4)" }}>{"  ← @ a group member to send"}</span>
                </div>
              )}
            </div>
            <div className="flex items-center justify-end" style={{ padding: "var(--sp-1_5) var(--sp-2_5)" }}>
              <button
                type="button"
                onClick={() => void handleSend()}
                disabled={!canSend}
                title={sendBlockedReason ?? "Send (Enter)"}
                aria-label="Send"
                className={cn(
                  "inline-flex items-center justify-center transition-opacity",
                  !canSend && "opacity-40 cursor-not-allowed",
                )}
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: "var(--radius-input)",
                  background: "var(--fg)",
                  color: "var(--bg-raised)",
                  border: "none",
                }}
              >
                <ArrowUp className="h-3.5 w-3.5" strokeWidth={2.5} />
              </button>
            </div>
          </div>

          {error && (
            <p className="mono text-label" style={{ color: "var(--state-error)", marginTop: 8 }}>
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/** Participant chip row at the top of the composer card. Renders one
 *  pill per chip with `×` revealed on hover, plus a `[+]` button that
 *  anchors a small dropdown of remaining candidates. */
function ParticipantChips({
  chips,
  candidates,
  chipCandidates,
  pickerOpen,
  setPickerOpen,
  pickerContainerRef,
  onAdd,
  onRemove,
}: {
  chips: string[];
  candidates: MentionCandidate[];
  chipCandidates: MentionCandidate[];
  pickerOpen: boolean;
  setPickerOpen: (open: boolean) => void;
  pickerContainerRef: React.RefObject<HTMLDivElement | null>;
  onAdd: (agentId: string) => void;
  onRemove: (agentId: string) => void;
}) {
  return (
    <div
      className="flex items-center flex-wrap"
      style={{
        gap: 6,
        padding: "var(--sp-1_5) var(--sp-2_5) var(--sp-1)",
      }}
    >
      {chips.map((id) => {
        const cand = candidates.find((c) => c.agentId === id);
        const label = cand?.displayName ?? cand?.name ?? id;
        return (
          <span
            key={id}
            className="group inline-flex items-center text-label"
            style={{
              gap: 2,
              padding: "var(--sp-0_5) var(--sp-1_5)",
              borderRadius: "var(--radius-chip)",
              background: "var(--bg-sunken)",
              color: "var(--fg)",
            }}
          >
            <span>{label}</span>
            <button
              type="button"
              onClick={() => onRemove(id)}
              title="Remove participant"
              className="opacity-0 group-hover:opacity-100 transition-opacity"
              style={{
                background: "none",
                border: "none",
                padding: 0,
                marginLeft: 2,
                cursor: "pointer",
                color: "var(--fg-3)",
                display: "inline-flex",
                alignItems: "center",
              }}
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        );
      })}

      <div ref={pickerContainerRef} style={{ position: "relative" }}>
        <button
          type="button"
          onClick={() => setPickerOpen(!pickerOpen)}
          title="Add participant"
          aria-label="Add participant"
          disabled={chipCandidates.length === 0}
          className="inline-flex items-center transition-colors hover:bg-[var(--bg-sunken)]"
          style={{
            padding: "var(--sp-0_5) var(--sp-1)",
            borderRadius: "var(--radius-chip)",
            border: "var(--hairline) solid var(--border)",
            background: "transparent",
            color: chipCandidates.length === 0 ? "var(--fg-4)" : "var(--fg-3)",
            cursor: chipCandidates.length === 0 ? "not-allowed" : "pointer",
          }}
        >
          <Plus className="h-3 w-3" />
        </button>
        {pickerOpen && chipCandidates.length > 0 && (
          <div
            role="listbox"
            aria-label="Add participant"
            className="absolute z-20 max-h-56 overflow-auto rounded-md border shadow-lg"
            style={{
              top: "calc(100% + var(--sp-1))",
              left: 0,
              minWidth: 280,
              background: "var(--bg-raised)",
              borderColor: "var(--border)",
            }}
          >
            {chipCandidates.map((c) => (
              <button
                key={c.agentId}
                type="button"
                role="option"
                aria-selected="false"
                onClick={() => onAdd(c.agentId)}
                className="flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-body"
                style={{
                  background: "transparent",
                  color: "var(--fg)",
                  border: "none",
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                <span className="font-medium">{c.displayName ?? (c.name ? `@${c.name}` : "—")}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Pick a default seed chip when the user opens an empty draft.
 *  Most-recently-active agent first, then any `personal_assistant`,
 *  then whatever sorts first in the candidate list. */
function pickDefault(candidates: MentionCandidate[], activity: RuntimeAgent[]): string | null {
  const ids = new Set(candidates.map((c) => c.agentId));
  const mru = [...activity]
    .filter((a) => ids.has(a.agentId) && a.runtimeUpdatedAt)
    .sort((a, b) => (b.runtimeUpdatedAt ?? "").localeCompare(a.runtimeUpdatedAt ?? ""))[0];
  if (mru) return mru.agentId;
  const pa = activity.find((a) => ids.has(a.agentId) && a.type === "personal_assistant");
  if (pa) return pa.agentId;
  return candidates[0]?.agentId ?? null;
}
