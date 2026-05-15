import type { ChatSource } from "@agent-team-foundation/first-tree-hub-shared";
import { Check, Settings } from "lucide-react";
import { Popover } from "../../../components/ui/popover.js";

/**
 * Canonical order of origin filters shown in the popover. Matches the
 * `CHAT_SOURCES` declaration order in shared, with display labels for
 * the UI. Phase A's `SOURCE_TABS` constant carried the same order; we
 * keep it here so the popover and the per-row source icon read the
 * same vocabulary.
 *
 * Exported so the filter-chip row in `conversations/index.tsx` can
 * render each active origin's short label without duplicating the
 * mapping.
 */
export const ORIGIN_OPTIONS: ReadonlyArray<{ value: ChatSource; label: string }> = [
  { value: "manual", label: "Manual" },
  { value: "github_pull_request", label: "Pull request" },
  { value: "github_issue", label: "Issue" },
  { value: "github_discussion", label: "Discussion" },
  { value: "github_commit", label: "Commit" },
  { value: "feishu", label: "Feishu" },
];

/** Map a `ChatSource` to its short user-facing label (Phase B). */
export function originLabel(source: ChatSource): string {
  return ORIGIN_OPTIONS.find((o) => o.value === source)?.label ?? source;
}

type FilterPopoverProps = {
  origin: ReadonlyArray<ChatSource>;
  onOriginChange: (next: ReadonlyArray<ChatSource>) => void;
  watching: boolean;
  onWatchingChange: (next: boolean) => void;
  /**
   * Clears every rail filter dimension in one URL mutation. The popover
   * delegates "Reset all" to this so the reset doesn't have to call
   * `onOriginChange([])` + `onWatchingChange(false)` back-to-back —
   * those calls would each derive from the same render-stale
   * `searchParams` snapshot and the second `setSearchParams` would
   * clobber the first (same bug as Phase A's two-setter Clear).
   * Also covers `with` (participants), which the popover doesn't
   * surface on its own but which the URL can carry today via
   * hand-typed parameters.
   */
  onResetAll: () => void;
  /**
   * Number of active filter dimensions across origin/watching (and,
   * in Phase B v2, participants). Drives the trigger's badge so the
   * user knows the popover has narrowed the list without opening it.
   */
  activeCount: number;
};

/**
 * Filter popover — the workspace rail's `⚙ Filter` button + panel.
 * Multi-select origin, watching toggle, and (later) participants
 * picker. Each toggle writes through to the URL immediately, so
 * "Done" is just a dismiss — there's no apply/save step.
 *
 * Participants picker is intentionally absent in Phase B v1: the
 * `?with=` wire is plumbed end-to-end (URL parser + listMeChats),
 * but the picker UI (agent autocomplete + selected-chip list) is a
 * follow-up. Users who need it today can hand-type `?with=…` in the
 * URL; the rail will narrow accordingly.
 */
export function FilterPopover({
  origin,
  onOriginChange,
  watching,
  onWatchingChange,
  onResetAll,
  activeCount,
}: FilterPopoverProps) {
  const toggleOrigin = (src: ChatSource): void => {
    const set = new Set(origin);
    if (set.has(src)) set.delete(src);
    else set.add(src);
    // Re-emit in canonical order so the resulting URL is stable
    // regardless of which checkbox the user clicked first.
    onOriginChange(ORIGIN_OPTIONS.map((o) => o.value).filter((v) => set.has(v)));
  };
  const resetOrigin = (): void => onOriginChange([]);

  return (
    <Popover
      align="end"
      panelStyle={{ minWidth: 240, padding: "var(--sp-2)" }}
      trigger={({ open, toggle }) => (
        <button
          type="button"
          onClick={toggle}
          aria-pressed={open}
          aria-haspopup="dialog"
          aria-expanded={open}
          className="inline-flex items-center text-label cursor-pointer transition-colors hover:bg-[var(--bg-hover)]"
          style={{
            gap: "var(--sp-1)",
            padding: "var(--sp-0_5) var(--sp-1_5)",
            border: 0,
            borderRadius: 4,
            // Open state and "filters are narrowing the list" both
            // earn the active-bg highlight, so the user always sees
            // when the popover is live or has unsaved narrowing.
            background: open || activeCount > 0 ? "var(--bg-active)" : "transparent",
            color: open || activeCount > 0 ? "var(--fg)" : "var(--fg-3)",
          }}
          title="Filter"
        >
          <Settings size={14} strokeWidth={1.75} />
          <span>Filter</span>
          {activeCount > 0 && (
            <span className="mono" style={{ color: "var(--accent)" }}>
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
              className="flex items-center justify-between text-eyebrow"
              style={{ color: "var(--fg-4)", textTransform: "uppercase", paddingBottom: "var(--sp-0_5)" }}
            >
              <span>Origin</span>
              {origin.length > 0 && (
                <button
                  type="button"
                  onClick={resetOrigin}
                  className="text-label cursor-pointer"
                  style={{ background: "transparent", border: 0, padding: 0, color: "var(--accent)" }}
                >
                  Reset
                </button>
              )}
            </header>
            {ORIGIN_OPTIONS.map((opt) => {
              const checked = origin.includes(opt.value);
              return (
                <FilterCheckbox
                  key={opt.value}
                  label={opt.label}
                  checked={checked}
                  onChange={() => toggleOrigin(opt.value)}
                />
              );
            })}
          </section>

          <section className="flex flex-col" style={{ gap: "var(--sp-0_5)" }}>
            <header
              className="text-eyebrow"
              style={{ color: "var(--fg-4)", textTransform: "uppercase", paddingBottom: "var(--sp-0_5)" }}
            >
              Status
            </header>
            <FilterCheckbox label="Watching only" checked={watching} onChange={() => onWatchingChange(!watching)} />
          </section>

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
                color: "var(--accent)",
              }}
            >
              Reset all
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
    <label
      className="inline-flex items-center text-label cursor-pointer transition-colors hover:bg-[var(--bg-hover)]"
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
          border: `var(--hairline) solid ${checked ? "var(--accent)" : "var(--border)"}`,
          background: checked ? "var(--accent)" : "transparent",
          color: "var(--fg-on-vivid)",
        }}
      >
        {checked && <Check size={10} strokeWidth={3} />}
      </span>
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={onChange} className="sr-only" />
    </label>
  );
}
