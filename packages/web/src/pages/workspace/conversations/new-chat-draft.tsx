import {
  type Agent,
  type AttachmentRef,
  COMPOSER_ACCEPT_ATTRIBUTE,
  extractMentions,
  type MentionParticipant,
} from "@first-tree/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, Check, Menu, Paperclip, Plus, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getNewChatDefaultCandidates } from "../../../api/agents.js";
import { uploadAttachment, uploadMimeFor } from "../../../api/attachments.js";
import { type ImageRefContent, readFileAsBase64 } from "../../../api/chats.js";
import { putImage } from "../../../api/image-store.js";
import { createMeTaskChat } from "../../../api/me-chats.js";
import { useAuth } from "../../../auth/auth-context.js";
import {
  AgentOption,
  AgentToken,
  ambiguousDisplayNames,
  buildPickerSections,
  detectMentionTrigger,
  MentionAutocompletePopover,
  type MentionCandidate,
  mentionOptionTitle,
  useMentionAutocomplete,
} from "../../../components/mention-autocomplete.js";
import { FileChip } from "../../../components/ui/file-chip.js";
import { clearDraft, type DraftSnapshot, loadDraft, newChatDraftScope, saveDraft } from "../../../lib/draft-store.js";
import { useAgentIdentityMap } from "../../../lib/use-agent-name-map.js";
import { useAutoResizeTextarea } from "../../../lib/use-autoresize-textarea.js";
import { useDebouncedValue } from "../../../lib/use-debounced-value.js";
import { useOrgAgents, useOrgAgentsSearch } from "../../../lib/use-org-agents.js";
import { type PendingAttachment, usePendingAttachments } from "../../../lib/use-pending-attachments.js";
import { cn } from "../../../lib/utils.js";

/**
 * Inline new-chat draft, A-model split between "audience" (room
 * membership) and "inline mention" (per-message ping):
 *
 *   - Chip row at the top of the composer is the participants list for
 *     the chat being created. Independent of the textarea — adding a
 *     chip never injects text, removing one never strips an `@<name>`.
 *     Default state seeds a single chip from explicit participants, the
 *     caller's browser-local last successful manual starter agent after
 *     server validation, or a server-resolved active/addressable fallback.
 *     Runtime presence is deliberately not a signal.
 *
 *   - Textarea carries the message content. Server's explicit-recipient enforcement
 *     contract requires an explicit recipient on every send — for 1:1
 *     (single chip) the composer auto-injects the chip's uuid into
 *     `metadata.mentions` so a bare body still passes; for groups
 *     (2+ chips) the body must explicitly `@` at least one chip and
 *     send is gated client-side to mirror that. See
 *     `services/message.ts` "Routing contract".
 *
 *   - Typing `@` in the textarea opens the autocomplete (candidates =
 *     all org agents). Picking an agent that isn't in the chip row
 *     promotes them to a chip — "I want to address X" subsumes "X is
 *     in the room". This unifies entry points without making them
 *     mutually exclusive.
 *
 *   - Attachments enter via the Paperclip button, drag-drop, or paste —
 *     staged through `usePendingAttachments` (shared with the in-chat
 *     composer). Images keep the historical image content path; documents and
 *     files ride generic `metadata.attachments` refs. Bytes are read and
 *     uploaded only on send, after the chat exists. An attachment-only send
 *     (empty body) is allowed; a group (2+ chips) still needs an `@` in the
 *     body so the initial message carries non-empty `metadata.mentions` and
 *     clears the server's per-message explicit-recipient enforcement check.
 *
 * On send: upload attachments first, then create the task chat with one
 * initial text/file message. Empty body is allowed when there's ≥1 chip and
 * (a non-empty body or ≥1 attachment).
 */

export function NewChatDraft({
  onCreated,
  onShowConversations = null,
  initialParticipantIds,
  mobile = false,
}: {
  onCreated: (chatId: string) => void;
  /** Touch surface (the mobile route): enlarge tap targets to the touch
   *  minimum and make Enter insert a newline (send is the button only),
   *  matching the mobile chat composer. */
  mobile?: boolean;
  /** Non-null only in narrow-viewport mode — renders a hamburger in the
   *  top-left corner that summons the conversation-list overlay. Without
   *  it, narrow users who land on a draft URL have no path back to their
   *  chats (the inline rail is collapsed). */
  onShowConversations?: (() => void) | null;
  /** Initial participant uuids to seed as chips (from the `?with=` param —
   *  e.g. the Team page "Chat" action). Takes precedence over the default
   *  agent seed; only applied once, on first mount of an empty draft. */
  initialParticipantIds?: string[];
}) {
  const queryClient = useQueryClient();
  const { agentId: myAgentId, memberId: myMemberId, organizationId, user } = useAuth();
  const agentIdentity = useAgentIdentityMap();

  // Browser-local unsent-draft cache for this compose context (user + org +
  // seed participants, mirroring the center-panel remount key). User-scoped so
  // a shared browser never restores another account's draft. Read once at first
  // render so later writes never feed back into the initial value.
  const draftScope = useMemo(
    () => newChatDraftScope(user?.id ?? null, organizationId, initialParticipantIds),
    [user?.id, organizationId, initialParticipantIds],
  );
  const initialDraftRef = useRef<DraftSnapshot | null | undefined>(undefined);
  if (initialDraftRef.current === undefined) {
    initialDraftRef.current = loadDraft(draftScope);
  }
  const restoredDraft = initialDraftRef.current;
  const cachedDefaultAgentId = useMemo(
    () => loadNewChatDefaultAgentId(user?.id ?? null, organizationId),
    [user?.id, organizationId],
  );

  const [chips, setChips] = useState<string[]>(() => restoredDraft?.participantIds ?? []);
  const [draft, setDraft] = useState(() => restoredDraft?.text ?? "");
  const [cursor, setCursor] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerSearch, setPickerSearch] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Skip the default agent seed when a stored draft was restored — its
  // chips (if any) are the user's own choice and must not be overwritten.
  const seededDefaultRef = useRef(restoredDraft != null);
  const pickerContainerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Attachment staging shared with the in-chat composer (same allowlist +
  // attachment-cap rules and object-URL lifecycle). Bytes are read and
  // uploaded only on send, after the chat is created — see `createMut` below.
  const { pendingAttachments, addFiles, removeAttachment, clearAttachments } = usePendingAttachments({
    onError: setError,
    onChange: () => setError(null),
  });
  const pendingImages = useMemo(() => pendingAttachments.filter((att) => att.kind === "image"), [pendingAttachments]);
  const pendingDocs = useMemo(() => pendingAttachments.filter((att) => att.kind !== "image"), [pendingAttachments]);

  // Auto-grow the textarea up to the CSS `max-height` cap (10.5rem ≈ 8
  // visible lines). Re-measure on every keystroke so paste and delete
  // both adjust instantly; past the cap content scrolls inside.
  useAutoResizeTextarea(textareaRef, draft);

  /** First-page baseline of org-wide addressable agents (humans + AI),
   *  backed by `GET /orgs/:orgId/agents` via `useOrgAgents`. Used to feed
   *  `extractMentions` for raw-typed `@name` resolution on the small-org fast
   *  path. Picker dropdown, `@`-autocomplete results, and the default-chip
   *  candidate check all use server lookups so orgs above the 100-row cap can
   *  still reach every addable agent (issue 494). */
  const { data: orgAgentsPage } = useOrgAgents({ addressableOnly: true });
  const {
    data: defaultCandidates,
    isFetched: defaultCandidatesFetched,
    isError: defaultCandidatesError,
  } = useQuery({
    queryKey: ["agents", "new-chat-default-candidates", user?.id ?? null, organizationId, cachedDefaultAgentId],
    queryFn: () => getNewChatDefaultCandidates({ cachedAgentId: cachedDefaultAgentId }),
    enabled: Boolean(myAgentId && organizationId && user?.id),
  });

  /** Map of every uuid we have ever shown to the user this session —
   *  seeded from the first page and grown with each search round-trip
   *  (chip picker + textarea `@`). Keeps chip labels and
   *  `extractMentions` stable after the user opens then clears a
   *  search input. */
  const [knownAgents, setKnownAgents] = useState<Map<string, MentionCandidate>>(() => new Map());
  const [knownAgentRows, setKnownAgentRows] = useState<Map<string, StarterAgentCacheCandidate>>(() => new Map());
  const mergeKnown = useCallback(
    (rows: ReadonlyArray<KnownAgentRow>) => {
      setKnownAgentRows((prev) => {
        let changed = false;
        const next = new Map(prev);
        for (const a of rows) {
          const entry: StarterAgentCacheCandidate = { uuid: a.uuid, type: a.type, status: a.status };
          const existing = next.get(a.uuid);
          if (existing && existing.type === entry.type && existing.status === entry.status) continue;
          next.set(a.uuid, entry);
          changed = true;
        }
        return changed ? next : prev;
      });
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
            avatarImageUrl: a.avatarImageUrl ?? null,
            avatarColorToken: a.avatarColorToken ?? null,
          };
          const existing = next.get(a.uuid);
          // Skip writes when nothing the cache exposes has changed — bouncing
          // the Map reference would re-render every chip + popover row for no
          // semantic gain.
          if (
            existing &&
            existing.name === entry.name &&
            existing.displayName === entry.displayName &&
            existing.managedByMe === entry.managedByMe &&
            existing.avatarImageUrl === entry.avatarImageUrl &&
            existing.avatarColorToken === entry.avatarColorToken
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
  useEffect(() => {
    if (!defaultCandidates?.agent) return;
    mergeKnown([defaultCandidates.agent]);
  }, [defaultCandidates?.agent, mergeKnown]);

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
  const { data: triggerSearchPage } = useOrgAgentsSearch(debouncedTriggerQuery, { addressableOnly: true });
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
  const { data: pickerSearchPage, isFetching: pickerFetching } = useOrgAgentsSearch(debouncedPickerSearch, {
    addressableOnly: true,
  });
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
        avatarImageUrl: a.avatarImageUrl ?? null,
        avatarColorToken: a.avatarColorToken ?? null,
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
        avatarImageUrl: ident?.avatarImageUrl ?? a.avatarImageUrl ?? null,
        avatarColorToken: ident?.avatarColorToken ?? a.avatarColorToken ?? null,
      });
    }
    return Array.from(byId.values());
  }, [knownAgents, triggerSearchPage?.items, agentIdentity, myAgentId, myMemberId]);

  useEffect(() => {
    if (seededDefaultRef.current) return;
    if (chips.length > 0) return;
    // Explicit `?with=` participants (e.g. the Team page "Chat" action)
    // take precedence over the default agent seed and don't need to
    // wait for the org list — the uuids come from a trusted caller and
    // chip labels resolve once knownAgents catches up.
    if (initialParticipantIds && initialParticipantIds.length > 0) {
      seededDefaultRef.current = true;
      setChips([...initialParticipantIds]);
      return;
    }
    if (!myAgentId) return;
    // Wait for the dedicated default-candidate lookup. It validates the
    // browser-local starter-agent cache by uuid and resolves a deterministic
    // active/addressable fallback server-side, so large orgs do not lose
    // defaults past the 100-row roster cap.
    if (!defaultCandidatesFetched && !defaultCandidatesError) return;
    const defaultId = defaultCandidates?.agent?.uuid ?? null;
    seededDefaultRef.current = true;
    if (defaultId) setChips([defaultId]);
  }, [
    defaultCandidates,
    defaultCandidatesFetched,
    defaultCandidatesError,
    myAgentId,
    chips.length,
    initialParticipantIds,
  ]);

  // Persist unsent body + chosen participants for this compose context so
  // navigating away and back (or a reload) restores the draft. saveDraft gates
  // on a non-empty trimmed body, so chip-only state is never stored and
  // emptying the body clears the entry; we also clear explicitly on send below
  // because onCreated unmounts this component before the effect could flush.
  useEffect(() => {
    saveDraft(draftScope, { text: draft, participantIds: chips });
  }, [draftScope, draft, chips]);

  const bodyMentions = useMemo(() => {
    const ps: MentionParticipant[] = candidates.map((c) => ({ agentId: c.agentId, name: c.name }));
    return extractMentions(draft, ps);
  }, [draft, candidates]);

  // Unlike chat-view.tsx, this composer does NOT render a
  // MentionHighlightOverlay. The chip row above the textarea is already
  // the canonical "who is in the room" surface, and an `@<name>` typed
  // in the body promotes the agent to that chip row (see the
  // bodyMentions → setChips effect below). Painting a second chip
  // inside the textarea would duplicate that signal — the chip row
  // visualisation is enough on this surface.
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

  const createMut = useMutation({
    mutationFn: async ({
      participantIds,
      text,
      images,
      docs,
      mentions,
    }: {
      participantIds: string[];
      text: string;
      images: PendingAttachment[];
      docs: PendingAttachment[];
      mentions: string[];
    }) => {
      const trimmed = text.trim();
      const contextParticipantAgentIds = participantIds.filter((id) => !mentions.includes(id));

      const docRefs: AttachmentRef[] = [];
      for (const doc of docs) {
        const uploaded = await uploadAttachment(doc.file);
        docRefs.push({
          attachmentId: uploaded.id,
          kind: doc.kind,
          mimeType: uploadMimeFor(doc.file),
          filename: doc.file.name,
          size: doc.file.size,
        });
      }

      if (images.length > 0) {
        const attachments: ImageRefContent[] = [];
        for (const img of images) {
          // Upload bytes to the org attachment store first; the returned id
          // is what every recipient fetches from GET /attachments/:id. The
          // message carries refs only — no inline base64.
          const uploaded = await uploadAttachment(img.file);
          // Warm this tab's IndexedDB cache so the sending user renders the
          // image immediately on refetch instead of round-tripping the server.
          // Best-effort: the bytes are authoritative server-side, so a cache
          // miss is recoverable on the render path.
          try {
            const data = await readFileAsBase64(img.file);
            await putImage({ imageId: uploaded.id, base64: data, mimeType: img.file.type });
          } catch {
            // ignore — render path re-fetches from the server on miss
          }
          attachments.push({
            imageId: uploaded.id,
            mimeType: img.file.type,
            filename: img.file.name,
            size: img.file.size,
          });
        }
        const created = await createMeTaskChat({
          mode: "task",
          initialRecipientAgentIds: mentions,
          initialRecipientNames: [],
          contextParticipantAgentIds,
          contextParticipantNames: [],
          initialMessage: {
            format: "file",
            content: {
              ...(trimmed.length > 0 ? { caption: trimmed } : {}),
              attachments,
            },
            ...(docRefs.length > 0 ? { metadata: { attachments: docRefs } } : {}),
            source: "web",
          },
        });
        return {
          chatId: created.chatId,
          cacheableStarterAgentId: await resolveCacheableStarterAgentId(participantIds, knownAgentRows),
        };
      }

      const created = await createMeTaskChat({
        mode: "task",
        initialRecipientAgentIds: mentions,
        initialRecipientNames: [],
        contextParticipantAgentIds,
        contextParticipantNames: [],
        initialMessage: {
          format: "text",
          content: trimmed,
          ...(docRefs.length > 0 ? { metadata: { attachments: docRefs } } : {}),
          source: "web",
        },
      });
      return {
        chatId: created.chatId,
        cacheableStarterAgentId: await resolveCacheableStarterAgentId(participantIds, knownAgentRows),
      };
    },
    onSuccess: ({ chatId, cacheableStarterAgentId }) => {
      saveNewChatDefaultAgentId(user?.id ?? null, organizationId, cacheableStarterAgentId);
      clearDraft(draftScope);
      setDraft("");
      setChips([]);
      clearAttachments();
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
    // Body OR at least one attachment — attachment-only sends are allowed
    // (mirrors the in-chat composer's "text non-empty or has attachment" rule).
    if (draft.trim().length === 0 && pendingAttachments.length === 0) return false;
    // Groups still need an explicit `@` even for attachment-only sends: the
    // server's explicit-recipient enforcement runs per message regardless of format,
    // and group chats can't rely on the 1:1 auto-inject path.
    if (chips.length >= 2 && bodyMentions.length === 0) return false;
    return true;
  }, [sending, createMut.isPending, chips.length, draft, bodyMentions.length, pendingAttachments.length]);

  const sendBlockedReason = useMemo(() => {
    if (chips.length === 0) return "Add at least one participant";
    if (draft.trim().length === 0 && pendingAttachments.length === 0) return null;
    if (chips.length >= 2 && bodyMentions.length === 0) {
      return "Group chats need an @ to wake at least one participant";
    }
    return null;
  }, [chips.length, draft, bodyMentions.length, pendingAttachments.length]);

  const handleSend = async (): Promise<void> => {
    if (!canSend) return;
    // Merge `bodyMentions` into the participant list synchronously.
    // The `bodyMentions → chips` promote effect runs asynchronously
    // (via `useEffect`), so a fast user who types `@bob` and presses
    // Enter immediately can land in `handleSend` before `chips` has
    // absorbed bob — without this merge, task creation would create the
    // chat without bob and bob's `@`-token would silently drop on the
    // server (no such participant). Compute the union here so the
    // committed audience always reflects what the user just typed.
    const participantIds = Array.from(new Set([...chips, ...bodyMentions]));
    // Explicit-only routing contract (services/message.ts): the server
    // no longer infers wake targets from content. For 1:1 chats (one
    // peer), auto-inject the peer's uuid so a bare "hi" still wakes
    // them — this mirrors the in-chat composer's `effectiveSendMentions`
    // derivation. For group chats, `canSend` already requires at least
    // one `bodyMentions` entry.
    const peerForOneOnOne = participantIds.length === 1 ? participantIds[0] : undefined;
    const effectiveMentions = peerForOneOnOne ? Array.from(new Set([...bodyMentions, peerForOneOnOne])) : bodyMentions;
    setError(null);
    setSending(true);
    try {
      await createMut.mutateAsync({
        participantIds,
        text: draft,
        images: pendingImages,
        docs: pendingDocs,
        mentions: effectiveMentions,
      });
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
    <div className="flex-1 flex flex-col overflow-hidden relative" style={{ background: "var(--bg)" }}>
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

          {/* biome-ignore lint/a11y/noStaticElementInteractions: drop target for attachment upload */}
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
              addFiles(Array.from(e.dataTransfer.files));
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
            {/* Attachment preview row — between the chip row and the textarea. */}
            {pendingAttachments.length > 0 && (
              <div
                className="flex items-center"
                style={{ gap: 6, padding: "0 var(--sp-2_5) var(--sp-1)", overflowX: "auto" }}
              >
                {pendingAttachments.map((att) =>
                  att.kind === "image" && att.previewUrl ? (
                    <div
                      key={att.id}
                      style={{
                        position: "relative",
                        flexShrink: 0,
                        borderRadius: 4,
                        border: "var(--hairline) solid var(--border)",
                        overflow: "hidden",
                      }}
                    >
                      <img
                        src={att.previewUrl}
                        alt={att.file.name}
                        style={{ height: 32, width: "auto", display: "block", objectFit: "cover" }}
                      />
                      <button
                        type="button"
                        onClick={() => removeAttachment(att.id)}
                        title="Remove image"
                        aria-label={`Remove ${att.file.name}`}
                        style={{
                          position: "absolute",
                          top: 1,
                          right: 1,
                          // Mobile: roomier corner × (kept modest vs the thumbnail).
                          width: mobile ? 20 : 14,
                          height: mobile ? 20 : 14,
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
                        <X className={mobile ? "h-3 w-3" : "h-2 w-2"} />
                      </button>
                    </div>
                  ) : (
                    <FileChip
                      key={att.id}
                      filename={att.file.name}
                      trailing={
                        <button
                          type="button"
                          onClick={() => removeAttachment(att.id)}
                          title="Remove file"
                          aria-label={`Remove ${att.file.name}`}
                          style={{
                            // Mobile: roomier tap target on the file chip's × .
                            width: mobile ? 26 : 14,
                            height: mobile ? 26 : 14,
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
                          <X className={mobile ? "h-3.5 w-3.5" : "h-2 w-2"} />
                        </button>
                      }
                    />
                  ),
                )}
              </div>
            )}
            {/* `composer-input` opts the mention popover into the phone full-width
                dock. No `data-picker-open`: the popover docks above the message
                textarea, which sits below the chip row (not at the card's top
                edge), so the panel is full-width but not corner-welded. */}
            <div className="composer-input" style={{ position: "relative" }}>
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
                    addFiles(files);
                  }
                }}
                placeholder={
                  chips.length >= 2 ? "Describe the task. Use @ to address one or more." : "Describe the task…"
                }
                rows={1}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return;
                  if (mention.handleKey(e)) return;
                  // Mobile soft keyboards have no Shift+Enter, so Enter inserts a
                  // newline; sending is the button only. Desktop keeps Enter-to-send.
                  if (!mobile && e.key === "Enter" && !e.shiftKey) {
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
                    // Tracks the textarea, which the mobile zoom guard
                    // (index.css) raises to the iOS no-zoom floor on phone
                    // widths; reading the same var keeps this ghost hint
                    // aligned with typed text.
                    fontSize: "var(--composer-font-size)",
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
                  title="Attach file"
                  aria-label="Attach file"
                  className={cn("inline-flex items-center", mobile && "justify-center")}
                  style={{
                    background: "none",
                    border: "none",
                    cursor: sending || createMut.isPending ? "not-allowed" : "pointer",
                    color: "var(--fg-3)",
                    padding: 0,
                    // Mobile: grow the tap target to the touch minimum.
                    ...(mobile ? { width: 44, height: 44 } : {}),
                  }}
                >
                  <Paperclip className={mobile ? "h-5 w-5" : "h-3.5 w-3.5"} />
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={COMPOSER_ACCEPT_ATTRIBUTE}
                  multiple
                  style={{ display: "none" }}
                  onChange={(e) => {
                    if (e.target.files) {
                      addFiles(Array.from(e.target.files));
                      e.target.value = "";
                    }
                  }}
                />
              </span>
              <span className="flex items-center" style={{ gap: 8 }}>
                {sending && pendingAttachments.length > 0 && (
                  <span className="mono text-caption" style={{ color: "var(--primary)" }}>
                    uploading…
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => void handleSend()}
                  disabled={!canSend}
                  title={sendBlockedReason ?? (mobile ? "Send" : "Send (Enter)")}
                  aria-label="Send"
                  className={cn(
                    "inline-flex items-center justify-center transition-opacity",
                    !canSend && "opacity-40 cursor-not-allowed",
                  )}
                  style={{
                    // Mobile: 44 hit area (the only send path there — Enter inserts
                    // a newline); desktop stays compact.
                    width: mobile ? 44 : 28,
                    height: mobile ? 44 : 28,
                    borderRadius: mobile ? 12 : "var(--radius-input)",
                    background: "var(--fg)",
                    color: "var(--bg-raised)",
                    border: "none",
                  }}
                >
                  <ArrowUp className={mobile ? "h-5 w-5" : "h-3.5 w-3.5"} strokeWidth={2.5} />
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

const PARTICIPANT_PICKER_VIEWPORT_MARGIN = 8;
const PARTICIPANT_PICKER_TRIGGER_GAP = 4;

/**
 * Clamp the new-chat participant picker into the visual viewport. The `[+]`
 * trigger is inline after the selected chips, so its x-coordinate can be
 * anywhere in the row; a trigger-relative `left: 0` panel therefore overflows
 * as soon as earlier chips push the trigger near the right edge.
 *
 * Pure geometry keeps the collision behavior stable under unit test while the
 * component supplies live DOMRect / VisualViewport measurements.
 */
export function participantPickerPlacement({
  anchor,
  panel,
  viewport,
  margin = PARTICIPANT_PICKER_VIEWPORT_MARGIN,
  gap = PARTICIPANT_PICKER_TRIGGER_GAP,
}: {
  anchor: { left: number; top: number; bottom: number };
  panel: { width: number; height: number };
  viewport: { left: number; top: number; width: number; height: number };
  margin?: number;
  gap?: number;
}): { left: number; top: number; width: number } {
  const width = Math.min(panel.width, Math.max(0, viewport.width - margin * 2));
  const minLeft = viewport.left + margin;
  const maxLeft = Math.max(minLeft, viewport.left + viewport.width - margin - width);
  const left = Math.max(minLeft, Math.min(anchor.left, maxLeft));

  const minTop = viewport.top + margin;
  const maxTop = Math.max(minTop, viewport.top + viewport.height - margin - panel.height);
  const belowTop = anchor.bottom + gap;
  const aboveTop = anchor.top - panel.height - gap;
  const fitsBelow = belowTop <= maxTop;
  const fitsAbove = aboveTop >= minTop;
  const preferredTop = fitsBelow || !fitsAbove ? belowTop : aboveTop;
  const top = Math.max(minTop, Math.min(preferredTop, maxTop));

  return { left, top, width };
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
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [panelPosition, setPanelPosition] = useState<{ left: number; top: number; width: number } | null>(null);
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

  // The panel is portalled to <body>, so outside-click must treat the trigger
  // and portal as one interactive region. Otherwise a row mousedown closes and
  // unmounts the panel before its click can commit the selected participant.
  useEffect(() => {
    if (!pickerOpen) return;
    const handler = (event: MouseEvent): void => {
      const target = event.target as Node;
      if (pickerContainerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setPickerOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [pickerOpen, pickerContainerRef, setPickerOpen]);

  // Portal + fixed positioning escapes the draft's clipping ancestors. Clamp
  // against VisualViewport (not only the layout viewport) so browser zoom and
  // mobile keyboard/viewport shifts keep both horizontal edges reachable.
  useLayoutEffect(() => {
    if (!pickerOpen) {
      setPanelPosition(null);
      return;
    }
    const anchor = pickerContainerRef.current;
    const panel = panelRef.current;
    if (!anchor || !panel) return;

    let frame = 0;
    const place = (): void => {
      frame = 0;
      const anchorRect = anchor.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      const visualViewport = window.visualViewport;
      const next = participantPickerPlacement({
        anchor: anchorRect,
        panel: panelRect,
        viewport: {
          left: visualViewport?.offsetLeft ?? 0,
          top: visualViewport?.offsetTop ?? 0,
          width: visualViewport?.width ?? window.innerWidth,
          height: visualViewport?.height ?? window.innerHeight,
        },
      });
      setPanelPosition((current) =>
        current?.left === next.left && current.top === next.top && current.width === next.width ? current : next,
      );
    };
    const schedule = (): void => {
      if (frame) return;
      frame = window.requestAnimationFrame(place);
    };

    place();
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    window.visualViewport?.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("scroll", schedule);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    observer?.observe(anchor);
    observer?.observe(panel);

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      window.visualViewport?.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("scroll", schedule);
    };
  }, [pickerOpen, pickerContainerRef]);
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
        // Fall back to a bare candidate when the id isn't in the known
        // set yet (search cache not warmed). Carry the id through as
        // `name` so the token still shows the full identifier — matching
        // the prior chip's `?? id` fallback — with a seed-hashed identicon.
        const cand = candidates.find((c) => c.agentId === id) ?? {
          agentId: id,
          name: id,
          displayName: null,
          managedByMe: false,
        };
        return <AgentToken key={id} candidate={cand} onRemove={() => onRemove(id)} />;
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
        {pickerOpen &&
          createPortal(
            <div
              ref={panelRef}
              role="listbox"
              aria-label="Add participant"
              data-participant-picker=""
              className="z-50 flex flex-col rounded-[var(--radius-panel)] border shadow-[var(--shadow-md)]"
              style={{
                position: "fixed",
                top: panelPosition?.top ?? -9999,
                left: panelPosition?.left ?? -9999,
                visibility: panelPosition ? "visible" : "hidden",
                width: panelPosition?.width ?? "min(var(--sp-90), calc(100vw - var(--sp-4)))",
                maxWidth: "var(--sp-90)",
                boxSizing: "border-box",
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
                      const fullTitle = mentionOptionTitle(item);
                      if (isInChips) {
                        return (
                          <div
                            key={item.agentId}
                            role="presentation"
                            title={fullTitle ? `${fullTitle} — already in this draft` : "Already in this draft"}
                            className="flex w-full items-center px-3 py-1.5 text-left text-body"
                            style={{
                              background: "transparent",
                              color: "var(--fg-3)",
                              cursor: "default",
                            }}
                          >
                            <AgentOption
                              candidate={item}
                              ambiguous={ambiguous}
                              trailing={<Check className="h-3.5 w-3.5" aria-label="Already in draft" />}
                            />
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
                          title={fullTitle}
                          onClick={() => onAdd(item.agentId)}
                          onMouseEnter={() => setHighlight(myIdx)}
                          className="flex w-full items-center px-3 py-1.5 text-left text-body"
                          style={{
                            background: active ? "var(--bg-hover)" : "transparent",
                            color: "var(--fg)",
                            border: "none",
                            cursor: "pointer",
                          }}
                        >
                          <AgentOption candidate={item} ambiguous={ambiguous} />
                        </button>
                      );
                    });
                  })()
                )}
              </div>
            </div>,
            document.body,
          )}
      </div>
    </div>
  );
}

type KnownAgentRow = Pick<Agent, "uuid" | "type" | "status" | "name" | "displayName" | "managerId"> & {
  // Optional so callers without avatar data (e.g. the default-candidate
  // fetch) still fit; the chip then falls back to a seed-hashed identicon
  // until a search round-trip warms the full row.
  avatarColorToken?: string | null;
  avatarImageUrl?: string | null;
};
export type StarterAgentCacheCandidate = Pick<KnownAgentRow, "uuid" | "type" | "status">;

export function newChatDefaultAgentCacheKey(userId: string | null, organizationId: string | null): string | null {
  if (!userId || !organizationId) return null;
  return `first-tree:new-chat-default-agent:${userId}:${organizationId}`;
}

function loadNewChatDefaultAgentId(userId: string | null, organizationId: string | null): string | null {
  const key = newChatDefaultAgentCacheKey(userId, organizationId);
  if (!key || typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function saveNewChatDefaultAgentId(userId: string | null, organizationId: string | null, agentId: string | null): void {
  const key = newChatDefaultAgentCacheKey(userId, organizationId);
  if (!key || typeof window === "undefined") return;
  try {
    if (agentId) {
      window.localStorage.setItem(key, agentId);
    } else {
      window.localStorage.removeItem(key);
    }
  } catch {
    // Best-effort local preference; sending the chat already succeeded.
  }
}

export function firstCacheableStarterAgentId(
  participantIds: ReadonlyArray<string>,
  agentsById: ReadonlyMap<string, StarterAgentCacheCandidate>,
): string | null {
  for (const id of participantIds) {
    const agent = agentsById.get(id);
    if (agent?.type === "agent" && agent.status === "active") return id;
  }
  return null;
}

async function resolveCacheableStarterAgentId(
  participantIds: ReadonlyArray<string>,
  agentsById: ReadonlyMap<string, StarterAgentCacheCandidate>,
): Promise<string | null> {
  for (const id of participantIds) {
    const agent = agentsById.get(id);
    if (agent) {
      if (agent.type === "agent" && agent.status === "active") return id;
      continue;
    }
    try {
      const resolved = await getNewChatDefaultCandidates({ cachedAgentId: id });
      if (resolved.agent?.uuid === id && resolved.agent.type === "agent" && resolved.agent.status === "active") {
        return id;
      }
    } catch {
      return null;
    }
  }
  return null;
}
