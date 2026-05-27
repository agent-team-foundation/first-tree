import { type Agent, extractMentions, type MentionParticipant } from "@first-tree/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, Check, Menu, Paperclip, Plus, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readFileAsBase64, sendChatMessage, sendFileMessage } from "../../../api/chats.js";
import { putImage } from "../../../api/image-store.js";
import { createMeChat } from "../../../api/me-chats.js";
import { useAuth } from "../../../auth/auth-context.js";
import {
  ambiguousDisplayNames,
  buildPickerSections,
  detectMentionTrigger,
  MentionAutocompletePopover,
  type MentionCandidate,
  MentionLabel,
  useMentionAutocomplete,
} from "../../../components/mention-autocomplete.js";
import { useAgentIdentityMap } from "../../../lib/use-agent-name-map.js";
import { useAutoResizeTextarea } from "../../../lib/use-autoresize-textarea.js";
import { useDebouncedValue } from "../../../lib/use-debounced-value.js";
import { useOrgAgents, useOrgAgentsSearch } from "../../../lib/use-org-agents.js";
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

export function NewChatDraft({
  onCreated,
  onShowConversations = null,
}: {
  onCreated: (chatId: string) => void;
  /** Non-null only in narrow-viewport mode — renders a hamburger in the
   *  top-left corner that summons the conversation-list overlay. Without
   *  it, narrow users who land on a draft URL have no path back to their
   *  chats (the inline rail is collapsed). */
  onShowConversations?: (() => void) | null;
}) {
  const queryClient = useQueryClient();
  const { agentId: myAgentId, memberId: myMemberId } = useAuth();
  const agentIdentity = useAgentIdentityMap();

  const [chips, setChips] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [cursor, setCursor] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerSearch, setPickerSearch] = useState("");
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

  /** First-page baseline of org-wide addressable agents (humans + AI),
   *  backed by `GET /orgs/:orgId/agents` via `useOrgAgents`. Used to
   *  seed the default chip and feed `extractMentions` for raw-typed
   *  `@name` resolution on the small-org fast path. Picker dropdown and
   *  `@`-autocomplete results come from the server-search hook below so
   *  orgs above the 100-row cap can still reach every addable agent
   *  (issue 494). */
  const { data: orgAgentsPage } = useOrgAgents();

  /** Map of every uuid we have ever shown to the user this session —
   *  seeded from the first page and grown with each search round-trip
   *  (chip picker + textarea `@`). Keeps chip labels and
   *  `extractMentions` stable after the user opens then clears a
   *  search input. */
  const [knownAgents, setKnownAgents] = useState<Map<string, MentionCandidate>>(() => new Map());
  const mergeKnown = useCallback(
    (rows: ReadonlyArray<Agent>) => {
      setKnownAgents((prev) => {
        let changed = false;
        const next = new Map(prev);
        for (const a of rows) {
          if (myAgentId && a.uuid === myAgentId) continue;
          // Suspended / nameless rows must be evicted, not just skipped.
          // The pre-fix code skipped insertion but kept stale active
          // entries around, so an agent that was active when first cached
          // and later suspended would keep surfacing in autocomplete and
          // could be promoted into the draft via mention parsing — a
          // wrong-recipient hazard (Codex P2 review of PR 556).
          if (a.status === "suspended" || !a.name) {
            if (next.delete(a.uuid)) changed = true;
            continue;
          }
          const entry: MentionCandidate = {
            agentId: a.uuid,
            name: a.name,
            displayName: a.displayName,
            managedByMe: Boolean(myMemberId && a.managerId === myMemberId),
          };
          const existing = next.get(a.uuid);
          // Skip writes when nothing the cache exposes has changed — bouncing
          // the Map reference would re-render every chip + popover row for no
          // semantic gain.
          if (
            existing &&
            existing.name === entry.name &&
            existing.displayName === entry.displayName &&
            existing.managedByMe === entry.managedByMe
          ) {
            continue;
          }
          next.set(a.uuid, entry);
          changed = true;
        }
        return changed ? next : prev;
      });
    },
    [myAgentId, myMemberId],
  );
  useEffect(() => {
    if (!orgAgentsPage?.items) return;
    mergeKnown(orgAgentsPage.items);
  }, [orgAgentsPage?.items, mergeKnown]);

  /** Active `@<query>` trigger derived from the textarea's text +
   *  cursor. Drives a server-side search so the autocomplete popover
   *  can show matches past the first-page cap. We compute it inline
   *  (rather than rely on `useMentionAutocomplete`'s internal trigger)
   *  because we need the query string for the search hook before the
   *  hook itself runs. The hook re-detects below; both calls are cheap
   *  pure functions.
   *
   *  The trigger string is debounced (100ms — lighter than the chip
   *  picker's 200ms so popover feels responsive while typing) before
   *  hitting the server. Without it, typing `@bob` would fan out into
   *  three GETs (`b` / `bo` / `bob`), each a fresh React Query key with
   *  no dedup. `useOrgAgentsSearch`'s docstring puts debouncing on the
   *  caller; matches what the chip picker already does. */
  const trigger = useMemo(() => detectMentionTrigger(draft, cursor), [draft, cursor]);
  const triggerQuery = trigger?.query ?? "";
  const debouncedTriggerQuery = useDebouncedValue(triggerQuery, 100);
  const { data: triggerSearchPage } = useOrgAgentsSearch(debouncedTriggerQuery);
  useEffect(() => {
    if (!triggerSearchPage?.items) return;
    mergeKnown(triggerSearchPage.items);
  }, [triggerSearchPage?.items, mergeKnown]);

  /** Chip-picker search, debounced. Independent of the textarea-`@`
   *  trigger above — different surface, different debounce timing
   *  (chips picker hits server only on input lull; `@` trigger fires
   *  per detected trigger string). The shared `useOrgAgentsSearch`
   *  hook dedupes by query key, so if both surfaces happen to search
   *  the same term React Query coalesces them into one fetch. */
  const debouncedPickerSearch = useDebouncedValue(pickerSearch, 200);
  const { data: pickerSearchPage, isFetching: pickerFetching } = useOrgAgentsSearch(debouncedPickerSearch);
  useEffect(() => {
    if (!pickerSearchPage?.items) return;
    mergeKnown(pickerSearchPage.items);
  }, [pickerSearchPage?.items, mergeKnown]);
  // True while the visible result set still trails the typed term —
  // either the 200ms debounce hasn't fired yet or the post-debounce
  // fetch is still in flight. Used by the picker to suppress Enter /
  // click commits against a stale highlight, avoiding the
  // wrong-recipient hazard Codex flagged on PR 556.
  const pickerStale = pickerSearch.trim() !== debouncedPickerSearch.trim() || pickerFetching;

  /** Rows fed to the `[+]` chip-picker dropdown — server-search hits
   *  minus self / suspended / no-slug. Chips already on the row are NOT
   *  filtered out here; the picker renders them with a ✓ instead so a
   *  search for an already-added agent confirms rather than reads as
   *  "no match" (operator confusion during PR 556 manual test). */
  const pickerCandidates = useMemo<MentionCandidate[]>(() => {
    const out: MentionCandidate[] = [];
    for (const a of pickerSearchPage?.items ?? []) {
      if (myAgentId && a.uuid === myAgentId) continue;
      if (!a.name) continue;
      if (a.status === "suspended") continue;
      out.push({
        agentId: a.uuid,
        name: a.name,
        displayName: a.displayName,
        managedByMe: Boolean(myMemberId && a.managerId === myMemberId),
      });
    }
    return out;
  }, [pickerSearchPage?.items, myAgentId, myMemberId]);

  /** Candidates exposed to `useMentionAutocomplete` — union of the
   *  trigger-driven search hits and the running `knownAgents` map.
   *  Picking from this set is what promotes an agent to a chip; raw
   *  `@name` typed without autocomplete pick is best-effort resolved
   *  via `extractMentions` against the same set. */
  const candidates = useMemo<MentionCandidate[]>(() => {
    const byId = new Map<string, MentionCandidate>(knownAgents);
    for (const a of triggerSearchPage?.items ?? []) {
      if (myAgentId && a.uuid === myAgentId) continue;
      if (!a.name) continue;
      if (a.status === "suspended") continue;
      // Re-run the identity-map join so a renamed agent surfaces its
      // latest displayName even when knownAgents has a stale entry.
      const ident = agentIdentity(a.uuid);
      byId.set(a.uuid, {
        agentId: a.uuid,
        name: ident?.name ?? a.name,
        displayName: ident?.displayName ?? a.displayName,
        managedByMe: Boolean(myMemberId && a.managerId === myMemberId),
      });
    }
    return Array.from(byId.values());
  }, [knownAgents, triggerSearchPage?.items, agentIdentity, myAgentId, myMemberId]);

  useEffect(() => {
    if (seededDefaultRef.current) return;
    if (chips.length > 0) return;
    // Wait for the org-list query to settle before picking — without
    // this guard the pre-fetch render would always pick `null` and
    // arm `seededDefaultRef`, locking out the real default once the
    // data arrives.
    if (!orgAgentsPage?.items) return;
    const defaultId = pickDefault(orgAgentsPage.items, myAgentId);
    seededDefaultRef.current = true;
    if (defaultId) setChips([defaultId]);
  }, [orgAgentsPage?.items, myAgentId, chips.length]);

  const bodyMentions = useMemo(() => {
    const ps: MentionParticipant[] = candidates.map((c) => ({ agentId: c.agentId, name: c.name }));
    return extractMentions(draft, ps);
  }, [draft, candidates]);

  // See chat-view.tsx for the why — `interactiveTriggerIndex` decides
  // when the popover may hijack Enter / Tab. Without this, pasting a
  // block containing `@foo` would steal the "Enter to send" keystroke
  // because `detectMentionTrigger` opens the popover on the cursor-
  // adjacent `@`.
  //
  // Note — unlike chat-view.tsx, this composer does NOT render a
  // MentionHighlightOverlay. The chip row above the textarea is already
  // the canonical "who is in the room" surface, and an `@<name>` typed
  // in the body promotes the agent to that chip row (see the
  // bodyMentions → setChips effect below). Painting a second chip
  // inside the textarea would duplicate that signal — the chip row
  // visualisation is enough on this surface.
  const [interactiveTriggerIndex, setInteractiveTriggerIndex] = useState<number | null>(null);
  const mention = useMentionAutocomplete({
    value: draft,
    cursor,
    candidates,
    disabled: sending,
    interactiveTriggerIndex,
    onSelect: (update) => {
      setDraft(update.text);
      setCursor(update.cursor);
      setInteractiveTriggerIndex(null);
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(update.cursor, update.cursor);
      });
    },
  });

  // Drop the interactive flag when the active trigger moves or closes
  // so re-entering an OLD `@` via arrow-key doesn't re-arm the hijack.
  useEffect(() => {
    if (interactiveTriggerIndex === null) return;
    if (mention.trigger === null || mention.trigger.triggerIndex !== interactiveTriggerIndex) {
      setInteractiveTriggerIndex(null);
    }
  }, [mention.trigger, interactiveTriggerIndex]);

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
    setPickerSearch("");
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden relative" style={{ background: "var(--bg-base)" }}>
      {/* Narrow-viewport summon: parallels the hamburger in chat-view's
          header. Anchored absolutely so we don't disturb the existing
          centred composer layout. */}
      {onShowConversations ? (
        <button
          type="button"
          onClick={onShowConversations}
          aria-label="Show conversations"
          title="Show conversations"
          className="absolute z-10 inline-flex items-center justify-center transition-colors hover:bg-[var(--bg-hover)]"
          style={{
            top: "var(--sp-2)",
            left: "var(--sp-2)",
            width: 28,
            height: 28,
            border: 0,
            background: "transparent",
            borderRadius: "var(--radius-input)",
            color: "var(--fg-3)",
            cursor: "pointer",
          }}
        >
          <Menu size={16} strokeWidth={2.25} />
        </button>
      ) : null}
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
              pickerCandidates={pickerCandidates}
              pickerSearch={pickerSearch}
              setPickerSearch={setPickerSearch}
              pickerStale={pickerStale}
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
                  if (e.key === "@" && !e.metaKey && !e.ctrlKey && !e.altKey) {
                    const start = e.currentTarget.selectionStart;
                    if (start !== null) setInteractiveTriggerIndex(start);
                  }
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
 *  anchors a search-driven dropdown. The search input is always shown so
 *  orgs above the 100-row first-page cap can reach every addable agent
 *  (issue 494); the parent owns the search state + the
 *  `useOrgAgentsSearch` call so its results can also feed the running
 *  `knownAgents` map used elsewhere in the composer. */
function ParticipantChips({
  chips,
  candidates,
  pickerCandidates,
  pickerSearch,
  setPickerSearch,
  pickerStale,
  pickerOpen,
  setPickerOpen,
  pickerContainerRef,
  onAdd,
  onRemove,
}: {
  chips: string[];
  candidates: MentionCandidate[];
  pickerCandidates: MentionCandidate[];
  pickerSearch: string;
  setPickerSearch: (value: string) => void;
  /** True while the displayed result set still trails the typed term
   *  (debounce hasn't fired or a fetch is in flight). Suppresses Enter
   *  commits so the user can't accidentally invite an agent from the
   *  previous query — see Codex P2 review of PR 556. */
  pickerStale: boolean;
  pickerOpen: boolean;
  setPickerOpen: (open: boolean) => void;
  pickerContainerRef: React.RefObject<HTMLDivElement | null>;
  onAdd: (agentId: string) => void;
  onRemove: (agentId: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [highlight, setHighlight] = useState(0);

  // Bucket the picker hits into addable (not yet a chip) and already-in
  // (matched the query but is already on the chip row). Showing already-
  // in rows with a ✓ instead of dropping them prevents the operator-
  // confusing "I just added them — why does my search now say no match?"
  // failure mode found in PR 556 testing.
  const chipSet = useMemo(() => new Set(chips), [chips]);
  const addable = useMemo(() => pickerCandidates.filter((c) => !chipSet.has(c.agentId)), [pickerCandidates, chipSet]);
  const alreadyIn = useMemo(
    () =>
      pickerCandidates
        .filter((c) => chipSet.has(c.agentId))
        .sort((a, b) => (a.displayName ?? a.name ?? "").localeCompare(b.displayName ?? b.name ?? "")),
    [pickerCandidates, chipSet],
  );
  // `items` and `selectable` share `buildPickerSections` so the render
  // walk-order (mine / others / divider / already-in) and the
  // keyboard-navigation order (the divider-stripped addable view of the
  // same list) are derived from a single source — eliminating the
  // wrong-recipient drift where Enter committed a different row than
  // the visible highlight pointed at. Same helper as
  // `AddParticipantDropdown`; the invariant is unit-tested in
  // `mention-autocomplete.test.ts`.
  const { items, selectable } = useMemo(() => buildPickerSections(addable, alreadyIn), [addable, alreadyIn]);
  const ambiguous = useMemo(() => ambiguousDisplayNames([...addable, ...alreadyIn]), [addable, alreadyIn]);

  useEffect(() => {
    if (!pickerOpen) return;
    setHighlight(0);
    inputRef.current?.focus();
  }, [pickerOpen]);
  // Re-clamp the highlight whenever the candidate set shifts (debounced
  // search lands, chip removed, etc.) so it never points past the end.
  useEffect(() => {
    if (selectable.length === 0) {
      setHighlight(0);
      return;
    }
    setHighlight((i) => Math.min(i, selectable.length - 1));
  }, [selectable]);

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((i) => (selectable.length === 0 ? 0 : (i + 1) % selectable.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((i) => (selectable.length === 0 ? 0 : (i - 1 + selectable.length) % selectable.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (pickerStale) return;
      const picked = selectable[highlight] ?? selectable[0];
      if (picked) onAdd(picked.agentId);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setPickerOpen(false);
    }
  };

  const emptyHint = (() => {
    if (addable.length > 0 || alreadyIn.length > 0) return null;
    // `pickerStale` covers both the in-flight fetch and the
    // debounce-pending window where no fetch has fired yet but the
    // displayed list is already known to be out of date.
    if (pickerStale) return "Searching…";
    if (pickerSearch.trim().length > 0) return `No agents match “${pickerSearch.trim()}”`;
    return "No agents to add";
  })();

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
          aria-haspopup="listbox"
          aria-expanded={pickerOpen}
          className="inline-flex items-center transition-colors hover:bg-[var(--bg-sunken)]"
          style={{
            padding: "var(--sp-0_5) var(--sp-1)",
            borderRadius: "var(--radius-chip)",
            border: "var(--hairline) solid var(--border)",
            background: "transparent",
            color: "var(--fg-3)",
            cursor: "pointer",
          }}
        >
          <Plus className="h-3 w-3" />
        </button>
        {pickerOpen && (
          <div
            role="listbox"
            aria-label="Add participant"
            className="absolute z-20 flex flex-col rounded-md border shadow-lg"
            style={{
              top: "calc(100% + var(--sp-1))",
              left: 0,
              minWidth: 280,
              background: "var(--bg-raised)",
              borderColor: "var(--border)",
            }}
          >
            <div
              style={{
                padding: "var(--sp-1_5) var(--sp-2)",
                borderBottom: "var(--hairline) solid var(--border-faint)",
              }}
            >
              <input
                ref={inputRef}
                type="text"
                value={pickerSearch}
                onChange={(e) => setPickerSearch(e.target.value)}
                onKeyDown={onInputKeyDown}
                placeholder="Search by name…"
                aria-label="Search agents"
                className="w-full text-body outline-none"
                style={{
                  padding: "var(--sp-1) var(--sp-1_5)",
                  background: "var(--bg-sunken)",
                  border: "var(--hairline) solid var(--border)",
                  borderRadius: "var(--radius-input)",
                  color: "var(--fg)",
                }}
              />
            </div>
            <div className="overflow-auto" style={{ maxHeight: "16rem" }}>
              {emptyHint !== null ? (
                <div className="text-body" style={{ padding: "var(--sp-2_5) var(--sp-2)", color: "var(--fg-3)" }}>
                  {emptyHint}
                </div>
              ) : (
                (() => {
                  // `addableIdx` walks only addable rows so the keyboard
                  // highlight lines up with `selectable`. Already-in rows
                  // skip the counter (display-only ✓).
                  let addableIdx = -1;
                  let dividerIdx = 0;
                  return items.map((item) => {
                    if ("divider" in item) {
                      dividerIdx += 1;
                      return (
                        <div
                          key={`__divider-${dividerIdx}`}
                          role="presentation"
                          style={{
                            height: "var(--hairline)",
                            background: "var(--border-faint)",
                            margin: "var(--sp-0_5) var(--sp-3)",
                          }}
                        />
                      );
                    }
                    const isInChips = chipSet.has(item.agentId);
                    if (isInChips) {
                      return (
                        <div
                          key={item.agentId}
                          role="presentation"
                          title={item.name ? `@${item.name} — already in this draft` : "Already in this draft"}
                          className="flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-body"
                          style={{
                            background: "transparent",
                            color: "var(--fg-3)",
                            cursor: "default",
                            whiteSpace: "nowrap",
                          }}
                        >
                          <span className="flex min-w-0 flex-1 items-baseline gap-2">
                            <MentionLabel candidate={item} ambiguous={ambiguous} />
                          </span>
                          <Check className="h-3.5 w-3.5 shrink-0" aria-label="Already in draft" />
                        </div>
                      );
                    }
                    addableIdx += 1;
                    const myIdx = addableIdx;
                    const active = myIdx === highlight;
                    return (
                      <button
                        key={item.agentId}
                        type="button"
                        role="option"
                        aria-selected={active}
                        title={item.name ? `@${item.name}` : undefined}
                        onClick={() => onAdd(item.agentId)}
                        onMouseEnter={() => setHighlight(myIdx)}
                        className="flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-body"
                        style={{
                          background: active ? "var(--bg-hover)" : "transparent",
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
                })()
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Pick a default seed chip when the user opens an empty draft.
 *
 *  Single rule: the caller's own human agent's `delegateMention` — i.e.
 *  the agent the user has explicitly designated as their stand-in. When
 *  it's unset (or the target was suspended / deleted) we return `null`
 *  and let the user pick.
 *
 *  Pre-issue 494 the default walked the caller's managed agents
 *  (personal_assistant first, then any) — which seeded a chip even when
 *  the user had no opinion about who that should be. Defaulting to the
 *  caller-declared delegate is a more deliberate signal: if the user
 *  hasn't set one, no chip is the right starting state.
 *
 *  Validation: we still need to confirm the delegate is in the org list
 *  and not suspended, so a delegate set months ago but since deleted
 *  doesn't seed a dangling uuid. When the user's own row is past the
 *  100-row first-page cap of `useOrgAgents()` we can't validate — in
 *  that rare case we return null rather than seed a chip we can't
 *  confirm. */

/** Exported for `__tests__/pick-default.test.ts`. The signature accepts
 *  a `Pick<Agent, ...>` slice rather than `Agent` so callers (and tests)
 *  can pass minimal fixtures without inventing inboxIds, metadata, etc. */
export type PickDefaultAgent = Pick<Agent, "uuid" | "type" | "managerId" | "status" | "delegateMention">;

export function pickDefault(orgAgents: ReadonlyArray<PickDefaultAgent>, myAgentId: string | null): string | null {
  if (!myAgentId) return null;
  const myHuman = orgAgents.find((a) => a.uuid === myAgentId);
  const delegateUuid = myHuman?.delegateMention ?? null;
  if (!delegateUuid) return null;
  const delegate = orgAgents.find((a) => a.uuid === delegateUuid);
  if (!delegate) return null;
  if (delegate.status === "suspended") return null;
  return delegate.uuid;
}
