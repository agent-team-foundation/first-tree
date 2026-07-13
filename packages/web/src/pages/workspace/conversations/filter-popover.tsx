import type { ChatEngagementView, ChatSource } from "@first-tree/shared";
import { Check, Filter } from "lucide-react";
import { useId } from "react";
import { Popover } from "../../../components/ui/popover.js";
import { useOrgAgents } from "../../../lib/use-org-agents.js";
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
  { value: "recency", label: "Recent activity" },
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
      panelStyle={{ minWidth: 240, padding: "var(--sp-2)" }}
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
function FilterCheckbox({ label, checked, onChange }: { label: string; checked: boolean; onChange: () => void }) {
  return (
    // `focus-within` puts a visible ring on the row when the `sr-only` input is
    // keyboard-focused (WCAG 2.4.7) — the clipped native input has no visible
    // focus of its own.
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
          borderRadius: 3,
          border: `var(--hairline) solid ${checked ? "var(--primary)" : "var(--border)"}`,
          background: checked ? "var(--primary)" : "transparent",
          color: "var(--primary-on)",
        }}
      >
        {checked && <Check size={10} strokeWidth={3} />}
      </span>
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={onChange} className="sr-only" />
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
 * Participants OR-picker — the org's addressable (speaker-eligible) agents and
 * humans. Empty selection = no constraint (the default); each checked identity
 * is an additive OR match, carried on the URL as `?with=`.
 *
 * Extracted into its own component (rather than inlined in `FilterPopover`) so
 * its `useOrgAgents` roster fetch + 30s poll only run while the popover panel is
 * OPEN: `Popover` conditionally renders its panel, so this component unmounts on
 * close and a never-opened filter costs no background roster poll for the whole
 * session.
 */
function ParticipantsSection({
  participants,
  onParticipantsChange,
}: {
  participants: ReadonlyArray<string>;
  onParticipantsChange: (next: ReadonlyArray<string>) => void;
}) {
  const agentsQuery = useOrgAgents({ addressableOnly: true });
  const participantOptions = agentsQuery.data?.items ?? [];
  const participantSet = new Set(participants);
  const toggleParticipant = (uuid: string): void => {
    const next = new Set(participantSet);
    if (next.has(uuid)) next.delete(uuid);
    else next.add(uuid);
    // Emit in a canonical (sorted) order so picking A-then-B and B-then-A yield
    // the same `?with=` — one react-query cache key, not two, for a logically
    // identical OR-filter (mirrors Source's canonical re-emit).
    onParticipantsChange([...next].sort());
  };
  const resetParticipants = (): void => onParticipantsChange([]);

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
            onClick={resetParticipants}
            className="text-label cursor-pointer"
            style={{ background: "transparent", border: 0, padding: 0, color: "var(--primary)" }}
          >
            Reset
          </button>
        )}
      </header>
      {agentsQuery.isError ? (
        // A failed roster load says so (with a retry) rather than masquerading as
        // "No people to filter by." — an empty roster and a fetch error are
        // distinct states that must not read identically.
        <div className="flex items-center justify-between" style={{ padding: "var(--sp-0_75) var(--sp-1)" }}>
          <span className="text-label" style={{ color: "var(--fg-4)" }}>
            {"Couldn't load people."}
          </span>
          <button
            type="button"
            onClick={() => agentsQuery.refetch()}
            className="text-label cursor-pointer"
            style={{ background: "transparent", border: 0, padding: 0, color: "var(--primary)" }}
          >
            Retry
          </button>
        </div>
      ) : participantOptions.length === 0 ? (
        <p className="text-label" style={{ color: "var(--fg-4)", padding: "var(--sp-0_75) var(--sp-1)" }}>
          {agentsQuery.isLoading ? "Loading…" : "No people to filter by."}
        </p>
      ) : (
        // Empty selection = no constraint, so every box starts UNCHECKED (unlike
        // Source). Any checked identity is an OR match. Scrollable so a large
        // roster doesn't blow out the popover height.
        <div className="flex flex-col overflow-y-auto" style={{ maxHeight: 168 }}>
          {participantOptions.map((agent) => (
            <FilterCheckbox
              key={agent.uuid}
              label={agent.displayName}
              checked={participantSet.has(agent.uuid)}
              onChange={() => toggleParticipant(agent.uuid)}
            />
          ))}
        </div>
      )}
    </section>
  );
}
