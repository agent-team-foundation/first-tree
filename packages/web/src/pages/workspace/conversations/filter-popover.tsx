import type { ChatEngagementView, ChatSource } from "@first-tree/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Filter, X } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Popover } from "../../../components/ui/popover.js";
import { rememberParticipantNames, useParticipantNames } from "../../../lib/participant-name-cache.js";
import { useAgentNameMap } from "../../../lib/use-agent-name-map.js";
import { useDebouncedValue } from "../../../lib/use-debounced-value.js";
import { useOrgAgentsSearch } from "../../../lib/use-org-agents.js";
import type { GroupMode } from "./group-rows.js";

/**
 * Canonical order of origin filters shown in the popover. Phase C
 * collapsed the GitHub entity types (PR / Issue / Discussion / Commit)
 * into a single `github` entry — the per-entity granularity lives on
 * `MeChatRow.entityType` and drives the row's leading icon, not a
 * separate filter dimension.
 *
 * Exported so the filter-chip row in `conversations/index.tsx` can
 * render each active origin's short label without duplicating the
 * mapping.
 */
export const ORIGIN_OPTIONS: ReadonlyArray<{ value: ChatSource; label: string }> = [
  // "Human" (not "Manual") — users don't think of themselves as creating
  // chats "manually"; the dimension is who started the work stream, matching
  // the Source group-by buckets ("Started by me/teammates").
  { value: "manual", label: "Human" },
  { value: "github", label: "GitHub" },
  { value: "gitlab", label: "GitLab" },
  { value: "agent", label: "Agent" },
];

/** Map a `ChatSource` to its short user-facing label. */
export function originLabel(source: ChatSource): string {
  return ORIGIN_OPTIONS.find((o) => o.value === source)?.label ?? source;
}

/**
 * Group-by options. Also demoted from a persistent header dropdown into the
 * popover — grouping is a view-mode preference, not a daily-touch control.
 */
export const GROUP_OPTIONS: ReadonlyArray<{ value: GroupMode; label: string }> = [
  { value: "recency", label: "Recent" },
  { value: "source", label: "Source" },
];

type FilterPopoverProps = {
  origin: ReadonlyArray<ChatSource>;
  onOriginChange: (next: ReadonlyArray<ChatSource>) => void;
  /** Scope (lifecycle) view — Active / Archived / All. */
  engagement: ChatEngagementView;
  onEngagementChange: (next: ChatEngagementView) => void;
  /**
   * Participants filter — an optional additive OR-picker over people/agents the
   * viewer can see. Empty = no constraint (the default); a stream matches when
   * ANY selected identity is a speaker. Carried on the URL as `?with=`.
   */
  participants: ReadonlyArray<string>;
  onParticipantsChange: (next: ReadonlyArray<string>) => void;
  /**
   * Resets the popover's OWN filter dimensions — Source (`origin`),
   * Participants (`with`), and Status (`engagement`) — in one URL mutation.
   * The "Reset" button delegates to this so the reset doesn't call
   * `onOriginChange([])` back-to-back with the others — those calls would each
   * derive from the same render-stale `searchParams` snapshot and the later
   * `setSearchParams` would clobber the earlier. The header triad (All /
   * Unread / Watching) is a separate control and is deliberately NOT reset here.
   */
  onResetAll: () => void;
  /**
   * Number of active *filter* dimensions the popover hides from the
   * persistent header (origin + non-default scope + participants). Drives
   * the trigger's badge so the user knows the popover has narrowed the
   * list without opening it. Grouping is a view-mode, not a filter, so it
   * is intentionally excluded from this count.
   */
  activeCount: number;
};

/**
 * Filter popover — the workspace rail's `⚙` button + panel. Holds the
 * secondary, lower-frequency controls so the header collapses to a single row
 * (New chat + the All / Unread / Watching triad + this button), following the
 * tree 721 rail-filter contract:
 *   - Status — exclusive Active / Archived / All (Active is the default + reset
 *     target);
 *   - Source — a NON-EMPTY additive selection over creation origin (default all,
 *     no zero-source state);
 *   - Participants — an optional additive OR-picker over the org's addressable
 *     agents (empty = no constraint).
 * Each control writes through to the URL immediately, so "Done" is just a
 * dismiss; "Reset" restores Active + all sources + no participants (the header
 * triad is a separate control and is left as-is).
 *
 * The primary engagement triad (All / Unread / Watching) and Group-by both live
 * in the header, not here.
 */
export function FilterPopover({
  origin,
  onOriginChange,
  engagement,
  onEngagementChange,
  participants,
  onParticipantsChange,
  onResetAll,
  activeCount,
}: FilterPopoverProps) {
  // Source is a NON-EMPTY additive selection over creation origin (tree 721).
  // `origin: []` is the wire's "unrestricted" (all sources) state — display it as
  // every box checked rather than an empty list whose hidden meaning is "all".
  const allSources = ORIGIN_OPTIONS.map((o) => o.value);
  const sourceSelected = origin.length === 0 ? new Set<ChatSource>(allSources) : new Set(origin);
  const toggleOrigin = (src: ChatSource): void => {
    const next = new Set(sourceSelected);
    if (next.has(src)) {
      if (next.size === 1) return; // forbid the zero-source state — the last stays
      next.delete(src);
    } else {
      next.add(src);
    }
    // Re-emit in canonical order for a stable URL; the FULL set normalizes back to
    // the empty/unrestricted wire so "all sources" never counts as active narrowing.
    const selected = allSources.filter((v) => next.has(v));
    onOriginChange(selected.length === allSources.length ? [] : selected);
  };
  const resetOrigin = (): void => onOriginChange([]);

  // Status is the viewer's engagement projection — one MUTUALLY EXCLUSIVE
  // selection (tree 721): `Active` (default + reset target) / `Archived` / `All`
  // (their union, still excluding deleted). A radio group, not the old
  // composable checkbox pair, so the visible state can never read as an empty
  // "means everything" selection.
  const STATUS_OPTIONS: ReadonlyArray<{ value: ChatEngagementView; label: string }> = [
    { value: "active", label: "Active" },
    { value: "archived", label: "Archived" },
    { value: "all", label: "All" },
  ];
  // Per-instance radio-group name so two `FilterPopover`s mounted at once (a
  // future split view) can't have their native radios merged into one browser
  // group, where arrow-key focus and checked-grouping would bleed across panels.
  const statusRadioName = useId();

  return (
    <Popover
      align="end"
      panelStyle={{ minWidth: 240, maxWidth: "var(--sp-90)", padding: "var(--sp-2)" }}
      trigger={({ open, toggle }) => (
        <button
          type="button"
          onClick={toggle}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label="Filter"
          className="inline-flex items-center text-label cursor-pointer transition-colors hover:bg-[var(--bg-hover)]"
          style={{
            gap: "var(--sp-1)",
            padding: "var(--sp-0_5) var(--sp-1_5)",
            border: 0,
            borderRadius: 4,
            // Open state and "filters are narrowing the list" both earn
            // the active-bg highlight, so the user always sees when the
            // popover is live or has unsaved narrowing.
            background: open || activeCount > 0 ? "var(--bg-active)" : "transparent",
            color: open || activeCount > 0 ? "var(--fg)" : "var(--fg-3)",
          }}
          title="Filter"
        >
          <Filter size={14} strokeWidth={1.75} />
          {activeCount > 0 && (
            <span className="mono" style={{ color: "var(--primary)" }}>
              {activeCount}
            </span>
          )}
        </button>
      )}
    >
      {({ close }) => (
        <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
          <section className="flex flex-col" style={{ gap: "var(--sp-0_5)" }}>
            <header
              className="text-eyebrow"
              style={{ color: "var(--fg-4)", textTransform: "uppercase", paddingBottom: "var(--sp-0_5)" }}
            >
              Status
            </header>
            {STATUS_OPTIONS.map((opt) => (
              <FilterRadio
                key={opt.value}
                name={statusRadioName}
                label={opt.label}
                checked={engagement === opt.value}
                onChange={() => onEngagementChange(opt.value)}
              />
            ))}
          </section>

          <section className="flex flex-col" style={{ gap: "var(--sp-0_5)" }}>
            <header
              className="flex items-center justify-between text-eyebrow"
              style={{ color: "var(--fg-4)", textTransform: "uppercase", paddingBottom: "var(--sp-0_5)" }}
            >
              <span>Source</span>
              {origin.length > 0 && (
                <button
                  type="button"
                  onClick={resetOrigin}
                  className="text-label cursor-pointer"
                  style={{ background: "transparent", border: 0, padding: 0, color: "var(--primary)" }}
                >
                  Reset
                </button>
              )}
            </header>
            {ORIGIN_OPTIONS.map((opt) => (
              <FilterCheckbox
                key={opt.value}
                label={opt.label}
                checked={sourceSelected.has(opt.value)}
                onChange={() => toggleOrigin(opt.value)}
              />
            ))}
          </section>

          <ParticipantsSection participants={participants} onParticipantsChange={onParticipantsChange} />

          <div
            className="flex items-center"
            style={{
              gap: "var(--sp-1)",
              paddingTop: "var(--sp-1)",
              borderTop: "var(--hairline) solid var(--border-faint)",
            }}
          >
            <button
              type="button"
              onClick={onResetAll}
              className="text-label cursor-pointer"
              style={{
                background: "transparent",
                border: 0,
                padding: "var(--sp-0_5) 0",
                color: "var(--primary)",
              }}
            >
              Reset
            </button>
            <button
              type="button"
              onClick={close}
              className="text-label cursor-pointer"
              style={{
                marginLeft: "auto",
                padding: "var(--sp-0_5) var(--sp-2)",
                border: "var(--hairline) solid var(--border)",
                borderRadius: 4,
                background: "var(--bg-raised)",
                color: "var(--fg-2)",
              }}
            >
              Done
            </button>
          </div>
        </div>
      )}
    </Popover>
  );
}

/**
 * Custom-styled checkbox row matching the workspace rail's de-chipped
 * visual language. The native `<input type=checkbox>` is hidden via
 * `sr-only` so keyboard focus + screen-reader semantics stay native;
 * the visible square + Check icon are pure decoration that reflects
 * the input's checked state.
 */
function FilterCheckbox({
  label,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
}) {
  return (
    // `focus-within` puts a visible ring on the row when the `sr-only` input is
    // keyboard-focused (WCAG 2.4.7) — the clipped native input has no visible
    // focus of its own. When `disabled` (a stale search row still settling) the
    // row dims and cannot be toggled.
    <label
      className={`inline-flex items-center text-label transition-colors focus-within:ring-1 focus-within:ring-ring focus-within:ring-offset-1 focus-within:ring-offset-[var(--bg-raised)] ${disabled ? "cursor-default opacity-50" : "cursor-pointer hover:bg-[var(--bg-hover)]"}`}
      style={{
        gap: "var(--sp-1_5)",
        padding: "var(--sp-0_75) var(--sp-1)",
        borderRadius: 4,
        color: "var(--fg-2)",
      }}
    >
      <span
        aria-hidden
        className="inline-flex items-center justify-center shrink-0"
        style={{
          width: 14,
          height: 14,
          borderRadius: 3,
          border: `var(--hairline) solid ${checked ? "var(--primary)" : "var(--border)"}`,
          background: checked ? "var(--primary)" : "transparent",
          color: "var(--primary-on)",
        }}
      >
        {checked && <Check size={10} strokeWidth={3} />}
      </span>
      <span className="min-w-0 truncate" title={label}>
        {label}
      </span>
      <input type="checkbox" checked={checked} onChange={onChange} disabled={disabled} className="sr-only" />
    </label>
  );
}

/**
 * Single-select sibling of `FilterCheckbox` for the exclusive Status axis. The
 * native `<input type=radio>` is `sr-only` so keyboard + screen-reader semantics
 * stay native (arrow-keys move within the radiogroup); the visible ring + filled
 * dot are decoration reflecting the checked state.
 */
function FilterRadio({
  name,
  label,
  checked,
  onChange,
}: {
  name: string;
  label: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    // `focus-within` ring for the same reason as `FilterCheckbox` — the native
    // radio is `sr-only`, so the row carries the visible keyboard focus.
    <label
      className="inline-flex items-center text-label cursor-pointer transition-colors hover:bg-[var(--bg-hover)] focus-within:ring-1 focus-within:ring-ring focus-within:ring-offset-1 focus-within:ring-offset-[var(--bg-raised)]"
      style={{
        gap: "var(--sp-1_5)",
        padding: "var(--sp-0_75) var(--sp-1)",
        borderRadius: 4,
        color: "var(--fg-2)",
      }}
    >
      <span
        aria-hidden
        className="inline-flex items-center justify-center shrink-0"
        style={{
          width: 14,
          height: 14,
          borderRadius: "50%",
          border: `var(--hairline) solid ${checked ? "var(--primary)" : "var(--border)"}`,
        }}
      >
        {checked && <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--primary)" }} />}
      </span>
      <span>{label}</span>
      <input type="radio" name={name} checked={checked} onChange={onChange} className="sr-only" />
    </label>
  );
}

/**
 * Participants OR-picker — a SEARCH-driven multi-select over the org's
 * addressable (speaker-eligible) agents and humans. Empty selection = no
 * constraint (the default); each checked identity is an additive OR match,
 * carried on the URL as `?with=`.
 *
 * Search-only (no upfront roster): typing drives a `useOrgAgentsSearch`
 * typeahead keyed on the debounced term, so it scales to any org — past the
 * org-list 100-row first page — and matches the app's other people pickers
 * (new-chat, chat-header, @-mention) instead of dumping a flat list. An empty
 * query renders just a hint; current selections show as removable chips above
 * the search so they stay visible and manageable without re-searching. Mounted
 * only inside the open `Popover` panel, so it costs nothing until the filter is
 * opened.
 */
function ParticipantsSection({
  participants,
  onParticipantsChange,
}: {
  participants: ReadonlyArray<string>;
  onParticipantsChange: (next: ReadonlyArray<string>) => void;
}) {
  const [search, setSearch] = useState("");
  const debounced = useDebouncedValue(search, 200);
  const trimmed = debounced.trim();
  // Empty query short-circuits inside the hook to the cached first page, but we
  // never render that — only the hint — so no roster list is dumped.
  const resultsQuery = useOrgAgentsSearch(trimmed, { addressableOnly: true });
  const resolveName = useAgentNameMap();
  const participantSet = new Set(participants);

  // Remember the display name of each identity picked FROM SEARCH so a selected
  // agent past the org-list 100-row cap — exactly who this search-only picker
  // exists to reach — still shows a name on its chip; `useAgentNameMap` alone
  // caps at 100. Falls back to the name map for a `?with=` selection restored
  // from the URL in a later session.
  const queryClient = useQueryClient();
  const cachedName = useParticipantNames();
  // Authoritative identity map wins (a rename refreshes it); the search-fed cache
  // only fills the gap for an id past the map's 100-row page.
  const chipName = (uuid: string): string => {
    const authoritative = resolveName(uuid);
    return authoritative !== uuid ? authoritative : (cachedName(uuid) ?? uuid);
  };

  const toggle = (uuid: string, displayName: string): void => {
    const next = new Set(participantSet);
    if (next.has(uuid)) next.delete(uuid);
    else {
      next.add(uuid);
      // Cache the picked name so its chip stays readable for an identity past the
      // identity-map cap, across popover close/reopen and on the persistent rail
      // chip (both read the shared, org/auth-scoped cache).
      rememberParticipantNames(queryClient, [{ uuid, displayName }]);
    }
    // Canonical (sorted) order so picking A-then-B and B-then-A yield the same
    // `?with=` — one react-query cache key for a logically identical OR-filter.
    onParticipantsChange([...next].sort());
  };
  const remove = (uuid: string): void => onParticipantsChange(participants.filter((p) => p !== uuid));

  const resultItems = resultsQuery.data?.items;
  const results = trimmed.length > 0 ? (resultItems ?? []) : [];
  // Cache every result's name (not only picks) so a selection made from an
  // earlier / different search still resolves on its chip.
  useEffect(() => {
    if (resultItems && resultItems.length > 0) {
      rememberParticipantNames(
        queryClient,
        resultItems.map((a) => ({ uuid: a.uuid, displayName: a.displayName })),
      );
    }
  }, [resultItems, queryClient]);
  // The rendered results trail the input by the debounce + the in-flight fetch;
  // treat that window as "searching" so an empty list never falsely reads "no
  // match" for a term the user just finished typing — and stale rows stay
  // non-interactive (disabled) until the rendered query matches the input.
  const searching = search.trim() !== trimmed || resultsQuery.isFetching;
  const statusStyle = { color: "var(--fg-4)", padding: "var(--sp-0_75) var(--sp-1)" };

  return (
    <section className="flex flex-col" style={{ gap: "var(--sp-0_5)" }}>
      <header
        className="flex items-center justify-between text-eyebrow"
        style={{ color: "var(--fg-4)", textTransform: "uppercase", paddingBottom: "var(--sp-0_5)" }}
      >
        <span>Participants</span>
        {participants.length > 0 && (
          <button
            type="button"
            onClick={() => onParticipantsChange([])}
            className="text-label cursor-pointer"
            style={{ background: "transparent", border: 0, padding: 0, color: "var(--primary)" }}
          >
            Reset
          </button>
        )}
      </header>

      {/* Current selections as removable chips — visible + manageable without
          re-searching; names resolve via the shared identity map, same as the
          rail's filter-chip row. */}
      {participants.length > 0 && (
        <div className="flex flex-wrap" style={{ gap: "var(--sp-1)", padding: "var(--sp-0_5) var(--sp-1)" }}>
          {participants.map((uuid) => (
            <button
              key={uuid}
              type="button"
              onClick={() => remove(uuid)}
              className="inline-flex items-center text-label cursor-pointer hover:bg-[var(--bg-hover)]"
              style={{
                gap: "var(--sp-0_5)",
                padding: "var(--sp-0_5) var(--sp-1)",
                border: "var(--hairline) solid var(--border)",
                borderRadius: 999,
                background: "var(--bg-sunken)",
                color: "var(--fg-2)",
              }}
              aria-label={`Remove ${chipName(uuid)}`}
            >
              <span className="truncate" style={{ maxWidth: 140 }}>
                @{chipName(uuid)}
              </span>
              <X size={11} strokeWidth={2} />
            </button>
          ))}
        </div>
      )}

      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search people…"
        aria-label="Search participants"
        className="w-full text-label outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--bg-raised)]"
        style={{
          padding: "var(--sp-1) var(--sp-1_5)",
          background: "var(--bg-sunken)",
          border: "var(--hairline) solid var(--border)",
          borderRadius: 4,
          color: "var(--fg)",
        }}
      />

      {trimmed.length === 0 ? (
        <p aria-live="polite" className="text-label" style={statusStyle}>
          Type to search people.
        </p>
      ) : results.length > 0 ? (
        // Any checked identity is an OR match. Results stay visible while a newer
        // term is still settling (no blank flash). Scrollable so a broad match
        // set doesn't blow out the popover height.
        <div className="flex flex-col overflow-y-auto" style={{ maxHeight: 168 }}>
          {results.map((agent) => (
            <FilterCheckbox
              key={agent.uuid}
              label={agent.displayName}
              checked={participantSet.has(agent.uuid)}
              onChange={() => toggle(agent.uuid, agent.displayName)}
              // Stale rows (a newer term is settling) stay visible but can't be
              // toggled, so a pick always matches the query the user sees.
              disabled={searching}
            />
          ))}
        </div>
      ) : searching ? (
        <p aria-live="polite" className="text-label" style={statusStyle}>
          Searching…
        </p>
      ) : resultsQuery.isError ? (
        // A failed search reports the failure (with a retry) rather than
        // masquerading as an empty "No people match" result.
        <div aria-live="polite" className="flex items-center justify-between" style={statusStyle}>
          <span className="text-label" style={{ color: "var(--fg-4)" }}>
            {"Couldn't search people."}
          </span>
          <button
            type="button"
            onClick={() => resultsQuery.refetch()}
            className="text-label cursor-pointer"
            style={{ background: "transparent", border: 0, padding: 0, color: "var(--primary)" }}
          >
            Retry
          </button>
        </div>
      ) : (
        <p aria-live="polite" className="text-label" style={statusStyle}>
          {`No people match “${trimmed}”.`}
        </p>
      )}
    </section>
  );
}
