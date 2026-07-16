import { useMutation } from "@tanstack/react-query";
import { Check, Loader2, Plus, UserPlus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { addMeChatParticipants } from "../api/me-chats.js";
import { useAuth } from "../auth/auth-context.js";
import { useDebouncedValue } from "../lib/use-debounced-value.js";
import { useOrgAgentsSearch } from "../lib/use-org-agents.js";
import {
  AgentOption,
  ambiguousDisplayNames,
  buildPickerSections,
  type MentionCandidate,
  mentionOptionTitle,
} from "./mention-autocomplete.js";

/**
 * Shared "add an agent to this chat" dropdown. Backs both the header
 * quick-add icon (`variant="icon"`) and the right-sidebar inline row
 * (`variant="inline"`). Only the trigger shell differs by variant; the
 * dropdown body is identical across both surfaces: search input on top,
 * then the avatar + "mine / others" grouping with a divider.
 *
 * The component owns disclosure (open / click-outside / Esc), search
 * input state + debounce, the server-side query
 * ({@link useOrgAgentsSearch}), keyboard navigation, and the immediate
 * `addMeChatParticipants` mutation. Server search keys the picker on the
 * typed term so orgs above the org-list 100-row first-page cap can still
 * reach every addable agent (issue 494). The caller supplies the chat
 * id, the current participant ids (already-in members are filtered out
 * here), the variant, and the post-add callback.
 */
export function AddParticipantDropdown({
  chatId,
  participantIds,
  onAdded,
  variant,
}: {
  chatId: string;
  participantIds: string[];
  onAdded: () => void;
  variant: "icon" | "inline";
}) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [searchInput, setSearchInput] = useState("");
  const debouncedSearch = useDebouncedValue(searchInput, 200);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const { agentId: myAgentId, memberId: myMemberId } = useAuth();
  const { data: agentsPage, isFetching: searchFetching } = useOrgAgentsSearch(debouncedSearch, {
    addressableOnly: true,
  });

  const candidates = useMemo<MentionCandidate[]>(() => {
    const out: MentionCandidate[] = [];
    for (const a of agentsPage?.items ?? []) {
      if (a.status === "suspended") continue;
      if (myAgentId && a.uuid === myAgentId) continue;
      if (!a.name) continue;
      out.push({
        agentId: a.uuid,
        name: a.name,
        displayName: a.displayName,
        managedByMe: Boolean(myMemberId && a.managerId === myMemberId),
        // Candidate carries its own avatar (image + hue token) so the
        // shared AgentOption renders straight from the row — no side-map,
        // and no re-routing through the identity cache (itself capped at
        // the first 100 agents, so it would miss search hits past that).
        avatarImageUrl: a.avatarImageUrl ?? null,
        avatarColorToken: a.avatarColorToken ?? null,
      });
    }
    return out;
  }, [agentsPage?.items, myAgentId, myMemberId]);

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
      setSearchInput("");
      onAdded();
    },
  });

  // Bucket search hits into addable (not yet in chat) and already-in
  // (matched the query but is a current participant). Showing the
  // already-in rows with a ✓ instead of dropping them prevents the
  // "Picker Agent 110 was just added — why does my search now say 'no
  // match'?" confusion the operator hit during PR 556 testing.
  const participantSet = useMemo(() => new Set(participantIds), [participantIds]);
  const addable = useMemo(() => candidates.filter((c) => !participantSet.has(c.agentId)), [candidates, participantSet]);
  const alreadyIn = useMemo(
    () =>
      candidates
        .filter((c) => participantSet.has(c.agentId))
        .sort((a, b) => (a.displayName ?? a.name ?? "").localeCompare(b.displayName ?? b.name ?? "")),
    [candidates, participantSet],
  );

  // `items` is the render walk-order (mine-first / others / divider /
  // already-in); `selectable` is the addable subset in the SAME order
  // (divider stripped) so the keyboard highlight index lines up with
  // the Enter commit target. Routing both through `buildPickerSections`
  // is the single source of truth — the third Codex / human review of
  // PR 556 caught a regression where the two derived from different
  // sources and the highlight could drift from the row Enter committed.
  const { items, selectable } = useMemo(() => buildPickerSections(addable, alreadyIn), [addable, alreadyIn]);
  const ambiguous = useMemo(() => ambiguousDisplayNames([...addable, ...alreadyIn]), [addable, alreadyIn]);

  // Search input is always visible — orgs above the org-list 100-row cap
  // need it to reach agents past page 1, and small orgs get a fast
  // client-feel filter for free. Disable the trigger only while a mutation
  // is in-flight; "empty result set" no longer disables the trigger because
  // the user may simply not have typed yet.
  const disabled = addMut.isPending;

  // Reset the highlight whenever the menu opens or the option set changes,
  // and focus the search input so the user can type immediately. The menu
  // itself is no longer the keystroke target — arrow / Enter keys are
  // captured on the input so the user never loses focus while typing.
  useEffect(() => {
    if (open) {
      setHighlight(0);
      inputRef.current?.focus();
    }
  }, [open]);
  // Re-clamp the highlight whenever the candidate set shifts so the
  // active row never points past the end of the new list (debounced
  // search lands, a candidate gets added to the chat, etc.).
  useEffect(() => {
    if (selectable.length === 0) {
      setHighlight(0);
      return;
    }
    setHighlight((i) => Math.min(i, selectable.length - 1));
  }, [selectable]);

  const commit = (agentId: string): void => {
    if (addMut.isPending) return;
    addMut.mutate(agentId);
  };

  // The displayed candidate list trails the input by `useDebouncedValue` +
  // the in-flight server fetch. If the user types a new term and slams
  // Enter inside that gap, `selectable` still reflects the previous query
  // and the highlighted row may not be what they think they're picking —
  // a wrong-recipient hazard in production chats (Codex P2 review of
  // PR 556). We block the commit until the displayed list matches the
  // typed term AND no fetch is in flight.
  const searchStale = searchInput.trim() !== debouncedSearch.trim() || searchFetching;

  const onInputKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((i) => (selectable.length === 0 ? 0 : (i + 1) % selectable.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((i) => (selectable.length === 0 ? 0 : (i - 1 + selectable.length) % selectable.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (searchStale) return;
      const picked = selectable[highlight] ?? selectable[0];
      if (picked) commit(picked.agentId);
    }
    // Escape is handled by the capture-phase document listener above.
  };

  const label = addMut.isPending ? "Adding…" : "Add";

  /**
   * Empty-state hint surfaced under the search input when the rendered
   * list (addable + already-in) is empty. We distinguish:
   *   - mid-fetch: don't promise "no matches" — let the user wait
   *   - search has a non-empty term: explicit "no match" for it
   *   - search is empty: rare ("no agents to add"), means every other
   *     visible agent in the org is already a participant
   * When the only hits are already-in rows we keep the hint null and
   * just render the ✓ section, so the user sees confirmation rather
   * than a confusing "no match".
   */
  const emptyHint = (() => {
    if (addable.length > 0 || alreadyIn.length > 0) return null;
    // `searchStale` covers both the in-flight fetch and the
    // debounce-pending window where no fetch has fired yet but the
    // displayed list is already known to be out of date.
    if (searchStale) return "Searching…";
    if (debouncedSearch.length > 0) return `No agents match “${debouncedSearch}”`;
    return "No agents to add";
  })();

  return (
    <div ref={containerRef} className="relative">
      {variant === "icon" ? (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          disabled={disabled}
          title="Add participant"
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

      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Add participant"
          tabIndex={-1}
          className="absolute z-20 flex flex-col border shadow-[var(--shadow-md)] outline-none"
          style={{
            top: "calc(100% + var(--sp-1))",
            // Icon trigger sits at the panel's right edge → grow leftward,
            // capped (same cap as `.mention-popover`'s max-width) so one long
            // candidate name can't stretch the panel — rows truncate instead;
            // the inline row spans the rail → match its full width.
            ...(variant === "icon" ? { right: 0, minWidth: 280, maxWidth: "var(--sp-90)" } : { left: 0, right: 0 }),
            background: "var(--bg-raised)",
            borderColor: "var(--border)",
            borderRadius: "var(--radius-input)",
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
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
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
          <div className="overflow-auto" style={{ maxHeight: "18rem" }}>
            {emptyHint !== null ? (
              <div className="text-body" style={{ padding: "var(--sp-2_5) var(--sp-2)", color: "var(--fg-3)" }}>
                {emptyHint}
              </div>
            ) : (
              (() => {
                // `addableIdx` counts only addable rows so the keyboard
                // highlight index lines up with `selectable` (which the
                // Enter handler indexes). Already-in rows are display-only
                // and skip this counter.
                let addableIdx = -1;
                let dividerIdx = 0;
                return items.map((it) => {
                  if ("divider" in it) {
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
                  const isInChat = participantSet.has(it.agentId);
                  const fullTitle = mentionOptionTitle(it);
                  if (isInChat) {
                    return (
                      <div
                        key={it.agentId}
                        role="presentation"
                        title={fullTitle ? `${fullTitle} — already in this chat` : "Already in this chat"}
                        className="flex w-full items-center text-left"
                        style={{
                          padding: "var(--sp-1_75) var(--sp-2)",
                          background: "transparent",
                          color: "var(--fg-3)",
                          cursor: "default",
                        }}
                      >
                        <AgentOption
                          candidate={it}
                          ambiguous={ambiguous}
                          trailing={<Check className="h-3.5 w-3.5" aria-label="Already in chat" />}
                        />
                      </div>
                    );
                  }
                  addableIdx += 1;
                  const myIdx = addableIdx;
                  const active = myIdx === highlight;
                  return (
                    <button
                      key={it.agentId}
                      type="button"
                      role="menuitem"
                      title={fullTitle}
                      onClick={() => commit(it.agentId)}
                      onMouseEnter={() => setHighlight(myIdx)}
                      disabled={addMut.isPending}
                      className="flex w-full items-center text-left transition-colors"
                      style={{
                        padding: "var(--sp-1_75) var(--sp-2)",
                        border: 0,
                        background: active ? "var(--bg-hover)" : "transparent",
                        cursor: addMut.isPending ? "default" : "pointer",
                      }}
                    >
                      <AgentOption candidate={it} ambiguous={ambiguous} />
                    </button>
                  );
                });
              })()
            )}
          </div>
        </div>
      )}
    </div>
  );
}
