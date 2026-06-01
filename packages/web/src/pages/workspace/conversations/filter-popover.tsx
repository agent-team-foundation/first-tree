import type { ChatEngagementView, ChatSource } from "@first-tree/shared";
import { Check, Settings } from "lucide-react";
import { Popover } from "../../../components/ui/popover.js";
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
  { value: "manual", label: "Manual" },
  { value: "github", label: "GitHub" },
];

/** Map a `ChatSource` to its short user-facing label. */
export function originLabel(source: ChatSource): string {
  return ORIGIN_OPTIONS.find((o) => o.value === source)?.label ?? source;
}

/**
 * Scope (lifecycle) options. Demoted from a persistent segmented control
 * into the filter popover in the conversation-list redesign — `Active` is
 * the overwhelming default, so the header stays a single row and the rarer
 * `Archived` / `All` views live one click away.
 */
export const SCOPE_OPTIONS: ReadonlyArray<{ value: ChatEngagementView; label: string }> = [
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
  { value: "all", label: "All" },
];

/** Short label for a non-default scope — used by the chip row. */
export function scopeLabel(view: ChatEngagementView): string {
  return SCOPE_OPTIONS.find((o) => o.value === view)?.label ?? view;
}

/**
 * Group-by options. Also demoted from a persistent header dropdown into the
 * popover — grouping is a view-mode preference, not a daily-touch control.
 */
export const GROUP_OPTIONS: ReadonlyArray<{ value: GroupMode; label: string }> = [
  { value: "recency", label: "By time" },
  { value: "source", label: "By source" },
];

type FilterPopoverProps = {
  origin: ReadonlyArray<ChatSource>;
  onOriginChange: (next: ReadonlyArray<ChatSource>) => void;
  /** Scope (lifecycle) view — Active / Archived / All. */
  engagement: ChatEngagementView;
  onEngagementChange: (next: ChatEngagementView) => void;
  /** Grouping mode — Source / Recency. */
  group: GroupMode;
  onGroupChange: (next: GroupMode) => void;
  /**
   * Whether the Group-by section renders inside the popover. False when the
   * rail surfaces Group-by as its own header control instead (the
   * "separated" layout), so the same control never appears in two places.
   */
  showGroup?: boolean;
  /**
   * Clears every rail filter dimension in one URL mutation. The popover
   * delegates "Reset all" to this so the reset doesn't have to call
   * `onOriginChange([])` back-to-back with the others — those calls would
   * each derive from the same render-stale `searchParams` snapshot and the
   * later `setSearchParams` would clobber the earlier (same bug as Phase
   * A's two-setter Clear). Also covers `with` (participants), which the
   * popover doesn't surface on its own but which the URL can carry today
   * via hand-typed parameters.
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
 * secondary, lower-frequency controls so the header collapses to a single
 * row (New chat + the All / Unread / Watching triad + this button):
 * multi-select origin, scope (Active/Archived/All), and group-by. Each
 * control writes through to the URL immediately, so "Done" is just a
 * dismiss — there's no apply/save step.
 *
 * The primary engagement triad (All / Unread / Watching) lives in the
 * header, not here — it's the daily-touch filter. Participants picker is
 * intentionally absent: the `?with=` wire is plumbed end-to-end (URL parser
 * + listMeChats) but the picker UI is a follow-up; users who need it today
 * can hand-type `?with=…` and the rail narrows accordingly.
 */
export function FilterPopover({
  origin,
  onOriginChange,
  engagement,
  onEngagementChange,
  group,
  onGroupChange,
  showGroup = true,
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
          <Settings size={14} strokeWidth={1.75} />
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
            {SCOPE_OPTIONS.map((opt) => (
              <FilterRadio
                key={opt.value}
                label={opt.label}
                selected={engagement === opt.value}
                onSelect={() => {
                  if (engagement !== opt.value) onEngagementChange(opt.value);
                }}
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
                checked={origin.includes(opt.value)}
                onChange={() => toggleOrigin(opt.value)}
              />
            ))}
          </section>

          {/* Hairline groups the two filters (Status / Source) above from the
              arrangement (Group by) below — one semantic separator, same
              `--hairline` + `--border-faint` recipe as the footer divider
              (DESIGN.md §5 hairlines / §3 border-faint). No literals, no colour.
              Omitted entirely in the "separated" layout, where Group-by is a
              header control instead. */}
          {showGroup && (
            <section
              className="flex flex-col"
              style={{
                gap: "var(--sp-0_5)",
                borderTop: "var(--hairline) solid var(--border-faint)",
                paddingTop: "var(--sp-2)",
              }}
            >
              <header
                className="text-eyebrow"
                style={{ color: "var(--fg-4)", textTransform: "uppercase", paddingBottom: "var(--sp-0_5)" }}
              >
                Group by
              </header>
              {GROUP_OPTIONS.map((opt) => (
                <FilterRadio
                  key={opt.value}
                  label={opt.label}
                  selected={group === opt.value}
                  onSelect={() => {
                    if (group !== opt.value) onGroupChange(opt.value);
                  }}
                />
              ))}
            </section>
          )}

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
 * Single-select row for the Scope / Group-by sections. Same de-chipped
 * language as `FilterCheckbox`, but the selected row is marked by the
 * active background + a trailing check (radio semantics via the native
 * `<input type=radio>` kept `sr-only` for keyboard / screen-reader use).
 */
function FilterRadio({ label, selected, onSelect }: { label: string; selected: boolean; onSelect: () => void }) {
  return (
    <label
      className="inline-flex items-center text-label cursor-pointer transition-colors hover:bg-[var(--bg-hover)]"
      style={{
        gap: "var(--sp-1_5)",
        padding: "var(--sp-0_75) var(--sp-1)",
        borderRadius: 4,
        background: selected ? "var(--bg-active)" : "transparent",
        color: selected ? "var(--fg)" : "var(--fg-2)",
      }}
    >
      <span>{label}</span>
      {selected && (
        <span aria-hidden className="inline-flex items-center" style={{ marginLeft: "auto", color: "var(--primary)" }}>
          <Check size={12} strokeWidth={2.5} />
        </span>
      )}
      <input type="radio" checked={selected} onChange={onSelect} className="sr-only" />
    </label>
  );
}
