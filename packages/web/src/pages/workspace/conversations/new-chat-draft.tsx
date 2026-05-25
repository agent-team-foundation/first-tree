import { type Agent, extractMentions, type MentionParticipant } from "@first-tree/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, Paperclip, Plus, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { readFileAsBase64, sendChatMessage, sendFileMessage } from "../../../api/chats.js";
import { putImage } from "../../../api/image-store.js";
import { createMeChat } from "../../../api/me-chats.js";
import { useAuth } from "../../../auth/auth-context.js";
import {
  ambiguousDisplayNames,
  groupAndSortCandidates,
  MentionAutocompletePopover,
  type MentionCandidate,
  MentionLabel,
  useMentionAutocomplete,
} from "../../../components/mention-autocomplete.js";
import { useAgentIdentityMap } from "../../../lib/use-agent-name-map.js";
import { useAutoResizeTextarea } from "../../../lib/use-autoresize-textarea.js";
import { useOrgAgents } from "../../../lib/use-org-agents.js";
import { type PendingImage, usePendingImages } from "../../../lib/use-pending-images.js";
import { cn } from "../../../lib/utils.js";

/**
 * Inline new-chat draft, A-model split between "audience" (room
 * membership) and "inline mention" (per-message ping):
 *
 *   - Chip row at the top of the composer is the participants list for
 *     the chat being created. Independent of the textarea — adding a
 *     chip never injects text, removing one never strips an `@<name>`.
 *     Default state seeds a single chip (the caller's personal assistant
 *     or any of their managed agents — see `pickDefault`) so the common
 *     "ask my PA something" case is zero-step. Stable across clicks —
 *     no runtime-presence MRU here, see issue 342.
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
 *   - Images attach via the Paperclip button, drag-drop, or paste —
 *     staged through `usePendingImages` (shared with the in-chat
 *     composer). Bytes are read and uploaded only on send, after the
 *     chat exists. An image-only send (empty body) is allowed; a group
 *     (2+ chips) still needs an `@` in the body so the server's per-
 *     message mention guard accepts the file send.
 *
 * On send: createMeChat({participantIds: chips ∪ body @s}) → for each
 * staged image putImage(IndexedDB) + sendFileMessage → sendChatMessage
 * with the verbatim body. Empty body is allowed when there's ≥1 chip and
 * (a non-empty body or ≥1 image).
 */

export function NewChatDraft({ onCreated }: { onCreated: (chatId: string) => void }) {
  const queryClient = useQueryClient();
  const { agentId: myAgentId, memberId: myMemberId } = useAuth();
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
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Image staging shared with the in-chat composer (same image/* + 5 MB
  // rules and object-URL lifecycle). Bytes are read and uploaded only on
  // send, after the chat is created — see `createMut` below.
  const { pendingImages, addImages, removeImage, clearImages } = usePendingImages({
    onError: setError,
    onChange: () => setError(null),
  });

  // Auto-grow the textarea up to the CSS `max-height` cap (10.5rem ≈ 8
  // visible lines). Re-measure on every keystroke so paste and delete
  // both adjust instantly; past the cap content scrolls inside.
  useAutoResizeTextarea(textareaRef, draft);

  /** Candidate source: org-wide addressable agents (humans + AI), backed
   *  by `GET /orgs/:orgId/agents` via the shared `useOrgAgents` hook.
   *  Pre-issue 343 we sourced this from `/activity`, which filters on
   *  `runtimeState IS NOT NULL` and silently dropped human members —
   *  making it impossible to start a chat with a coworker. `listAgents`
   *  already LEFT-JOINs `agent_presence` and surfaces humans natively. */
  const { data: orgAgentsPage } = useOrgAgents();

  const candidates = useMemo<MentionCandidate[]>(() => {
    const out: MentionCandidate[] = [];
    for (const a of orgAgentsPage?.items ?? []) {
      if (myAgentId && a.uuid === myAgentId) continue;
      if (!a.name) continue;
      if (a.status === "suspended") continue;
      const ident = agentIdentity(a.uuid);
      // Prefer the shared identity map (kept fresh by other queries) but
      // fall back to the agent row itself — `listAgents` is the only
      // source guaranteed to surface humans, so an identity-map miss for
      // a never-seen human shouldn't drop them from the picker.
      const name = ident?.name ?? a.name;
      const displayName = ident?.displayName ?? a.displayName;
      out.push({
        agentId: a.uuid,
        name,
        displayName,
        managedByMe: Boolean(myMemberId && a.managerId === myMemberId),
      });
    }
    return out;
  }, [orgAgentsPage?.items, agentIdentity, myAgentId, myMemberId]);

  useEffect(() => {
    if (seededDefaultRef.current) return;
    if (chips.length > 0) return;
    if (candidates.length === 0) return;
    const defaultId = pickDefault(orgAgentsPage?.items ?? [], myMemberId);
    if (!defaultId) return;
    setChips([defaultId]);
    seededDefaultRef.current = true;
  }, [candidates, orgAgentsPage?.items, myMemberId, chips.length]);

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
    mutationFn: async ({
      participantIds,
      text,
      images,
      mentions,
    }: {
      participantIds: string[];
      text: string;
      images: PendingImage[];
      mentions: string[];
    }) => {
      const created = await createMeChat({ participantIds });
      const chatId = created.chatId;
      // Send images first (mirrors the in-chat composer ordering), then the
      // text body, so the new chat opens with attachments above the message.
      if (images.length > 0) {
        // Carry the @-mentions onto each image message so the server's
        // group-chat mention guard accepts file-format sends (issue 387).
        // Single-chip (direct) chats have no mentions and skip the check.
        const imageMetadata = mentions.length > 0 ? { mentions } : undefined;
        for (const img of images) {
          const data = await readFileAsBase64(img.file);
          const imageId = crypto.randomUUID();
          // Write to IndexedDB before the POST so the sending tab can render
          // the image from its imageRef immediately on refetch.
          await putImage({ imageId, base64: data, mimeType: img.file.type });
          await sendFileMessage(
            chatId,
            {
              data,
              mimeType: img.file.type,
              filename: img.file.name,
              size: img.file.size,
              imageId,
            },
            imageMetadata,
          );
        }
      }
      const trimmed = text.trim();
      if (trimmed.length > 0) {
        await sendChatMessage(chatId, trimmed);
      }
      return chatId;
    },
    onSuccess: (chatId) => {
      setDraft("");
      setChips([]);
      clearImages();
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
    // Body OR at least one image — image-only sends are allowed (mirrors the
    // in-chat composer's "text non-empty or has image" rule).
    if (draft.trim().length === 0 && pendingImages.length === 0) return false;
    // Groups still need an @ even for image-only sends: the server's
    // group-chat mention guard runs per message regardless of format.
    if (chips.length >= 2 && bodyMentions.length === 0) return false;
    return true;
  }, [sending, createMut.isPending, chips.length, draft, bodyMentions.length, pendingImages.length]);

  const sendBlockedReason = useMemo(() => {
    if (chips.length === 0) return "Add at least one participant";
    if (draft.trim().length === 0 && pendingImages.length === 0) return null;
    if (chips.length >= 2 && bodyMentions.length === 0) {
      return "Group chats need an @ to wake at least one participant";
    }
    return null;
  }, [chips.length, draft, bodyMentions.length, pendingImages.length]);

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
      await createMut.mutateAsync({ participantIds, text: draft, images: pendingImages, mentions: bodyMentions });
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

          {/* biome-ignore lint/a11y/noStaticElementInteractions: drop target for image upload */}
          <div
            style={{
              borderRadius: 10,
              background: "var(--bg-raised)",
              boxShadow: "var(--shadow-md)",
              overflow: "visible",
            }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              addImages(Array.from(e.dataTransfer.files));
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
            {/* Image preview row — between the chip row and the textarea. */}
            {pendingImages.length > 0 && (
              <div
                className="flex items-center"
                style={{ gap: 6, padding: "0 var(--sp-2_5) var(--sp-1)", overflowX: "auto" }}
              >
                {pendingImages.map((img) => (
                  <div
                    key={img.id}
                    style={{
                      position: "relative",
                      flexShrink: 0,
                      borderRadius: 4,
                      border: "var(--hairline) solid var(--border)",
                      overflow: "hidden",
                    }}
                  >
                    <img
                      src={img.previewUrl}
                      alt={img.file.name}
                      style={{ height: 32, width: "auto", display: "block", objectFit: "cover" }}
                    />
                    <button
                      type="button"
                      onClick={() => removeImage(img.id)}
                      title="Remove image"
                      style={{
                        position: "absolute",
                        top: 1,
                        right: 1,
                        width: 14,
                        height: 14,
                        borderRadius: "50%",
                        background: "var(--color-overlay-scrim)",
                        border: "none",
                        color: "var(--bg-raised)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        cursor: "pointer",
                        padding: 0,
                      }}
                    >
                      <X className="h-2 w-2" />
                    </button>
                  </div>
                ))}
              </div>
            )}
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
                onPaste={(e) => {
                  const files = Array.from(e.clipboardData.files);
                  if (files.length > 0) {
                    e.preventDefault();
                    addImages(files);
                  }
                }}
                placeholder={
                  chips.length >= 2 ? "Describe the task. Use @ to address one or more." : "Describe the task…"
                }
                rows={1}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return;
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
                  // `rows={1}` sets the initial height; useAutoResizeTextarea
                  // expands it on each keystroke. Cap at 10.5rem (~8 visible
                  // lines) so long pastes scroll inside the textarea instead
                  // of pushing the send button off-screen.
                  maxHeight: "10.5rem",
                  overflowY: "auto",
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
            <div className="flex items-center justify-between" style={{ padding: "var(--sp-1_5) var(--sp-2_5)" }}>
              <span className="flex items-center" style={{ gap: 10 }}>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={sending || createMut.isPending}
                  title="Attach image"
                  aria-label="Attach image"
                  className="inline-flex items-center"
                  style={{
                    background: "none",
                    border: "none",
                    cursor: sending || createMut.isPending ? "not-allowed" : "pointer",
                    color: "var(--fg-3)",
                    padding: 0,
                  }}
                >
                  <Paperclip className="h-3.5 w-3.5" />
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  style={{ display: "none" }}
                  onChange={(e) => {
                    if (e.target.files) {
                      addImages(Array.from(e.target.files));
                      e.target.value = "";
                    }
                  }}
                />
              </span>
              <span className="flex items-center" style={{ gap: 8 }}>
                {sending && pendingImages.length > 0 && (
                  <span className="mono text-caption" style={{ color: "var(--accent)" }}>
                    uploading…
                  </span>
                )}
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
              </span>
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
            {(() => {
              const ambiguous = ambiguousDisplayNames(chipCandidates);
              // My-managed agents first, then teammates', alphabetical
              // within each group, divider between the two groups (only
              // when both are non-empty). The thin --border-faint
              // hairline is intentional: visible enough to read as
              // grouping, quiet enough to not compete for attention.
              return groupAndSortCandidates(chipCandidates).map((item) => {
                if ("divider" in item) {
                  return (
                    <div
                      key="__divider"
                      // `role="presentation"` strips this from the a11y
                      // tree: listbox semantics expect children to be
                      // `option`s, and an announced separator inflates
                      // the "N of M" count in some screen readers. The
                      // grouping is purely a visual cue.
                      role="presentation"
                      style={{
                        height: "var(--hairline)",
                        background: "var(--border-faint)",
                        margin: "var(--sp-0_5) var(--sp-3)",
                      }}
                    />
                  );
                }
                return (
                  <button
                    key={item.agentId}
                    type="button"
                    role="option"
                    aria-selected="false"
                    title={item.name ? `@${item.name}` : undefined}
                    onClick={() => onAdd(item.agentId)}
                    className="flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-body"
                    style={{
                      background: "transparent",
                      color: "var(--fg)",
                      border: "none",
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    <MentionLabel candidate={item} ambiguous={ambiguous} />
                  </button>
                );
              });
            })()}
          </div>
        )}
      </div>
    </div>
  );
}

/** Pick a default seed chip when the user opens an empty draft.
 *
 *  Scope: agents the caller **personally manages** — never another
 *  member's agent (even if it's org-visible). Defaulting a new chat to
 *  a coworker's agent is a footgun: the user might fire off a message
 *  thinking it's their own assistant. When the caller manages no
 *  agents, return `null` and let the user pick — better an empty chip
 *  row than a wrong default.
 *
 *  Within the my-managed subset (in priority order):
 *    1. Any `personal_assistant` — the user's primary AI representative.
 *    2. First my-managed agent — final fallback so we always seed
 *       something if I do manage at least one.
 *
 *  Humans never seed: a human "self-mirror" chip in a new chat is
 *  nonsense (you don't start a chat with yourself).
 *
 *  Pre-issue 343 there was also a "most-recently-active by
 *  `runtimeUpdatedAt`" step 1, which made the default flip between
 *  clicks whenever runtime presence shifted (issue 342). Dropped here —
 *  stability across clicks is more important than "show me my busiest
 *  agent". A more deliberate default (e.g. the caller's
 *  `delegateMention`) is tracked separately in issue 342. */

/** Exported for `__tests__/pick-default.test.ts`. The signature accepts
 *  a `Pick<Agent, ...>` slice rather than `Agent` so callers (and tests)
 *  can pass minimal fixtures without inventing inboxIds, metadata, etc. */
export type PickDefaultAgent = Pick<Agent, "uuid" | "type" | "managerId" | "status">;

export function pickDefault(orgAgents: ReadonlyArray<PickDefaultAgent>, myMemberId: string | null): string | null {
  if (!myMemberId) return null;
  const mine = orgAgents.filter((a) => a.managerId === myMemberId && a.status !== "suspended" && a.type !== "human");
  if (mine.length === 0) return null;

  const pa = mine.find((a) => a.type === "personal_assistant");
  if (pa) return pa.uuid;

  return mine[0]?.uuid ?? null;
}
