import { ChevronDown, ChevronUp } from "lucide-react";
import type { ReactNode } from "react";
import { DenseBadge, type DenseBadgeTone } from "../../components/ui/dense-badge.js";
import { RowActionsMenu, type RowAction as RowMenuAction } from "../../components/ui/row-actions-menu.js";
import { Switch } from "../../components/ui/switch.js";
import { cn } from "../../lib/utils.js";

/**
 * The single flat row primitive for every "effective resource" on the agent
 * detail page — instructions (Instructions tab), skills + MCP (Tools & skills),
 * and repositories (Repositories tab). All rows read identically wherever they
 * appear:
 *   - line 1: name → source → status, then the converged action cluster
 *     (`[Switch] [⋯]`), then an optional expand chevron;
 *   - line 2 (collapsed): a two-line clamped `peek`;
 *   - expanded / editing: a sunken contained block below.
 *
 * Actions are structured, not freeform: a `toggle` (the on/off Switch for a
 * team-recommended resource) and a `menu` (the ⋯ overflow for the secondary
 * Customize / Edit / Remove actions). A row's controls are derived entirely
 * from its source + state by the call site, so the language stays consistent:
 * Switch = "enabled / disabled (stays, greyed)", ⋯ = "everything else".
 */
export type RowStatusMarker = { label: string; tone: DenseBadgeTone } | null;

/** The converged on/off control for a team-recommended row. */
export type RowToggle = {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Accessible name — the row title alone isn't enough to announce the control. */
  ariaLabel: string;
};

/** The ⋯ overflow menu's secondary actions. Empty → no ⋯ is rendered. */
export type RowMenu = { actions: RowMenuAction[]; ariaLabel: string };

export function ResourceRowView(props: {
  /** Row title. `null` when the row has no resource name (inline custom prompt);
   *  the peek then carries identity. */
  name: ReactNode | null;
  /** Already-resolved source label text (e.g. "Team default"). */
  source: ReactNode;
  /** Overridden / Can't load marker — omitted for a normal row. A disabled row
   *  is conveyed by `toggle` (off) + `dimmed`, not a status badge. */
  status?: RowStatusMarker;
  /** Collapsed preview, clamped to two lines. */
  peek?: ReactNode;
  /** Render the peek in mono — for technical content (repo URL, MCP command),
   *  NOT for prose (a skill description). */
  monoPeek?: boolean;
  /** On/off Switch — the primary control for a team-recommended resource. */
  toggle?: RowToggle;
  /** ⋯ overflow menu for secondary actions (Customize / Edit / Remove). */
  menu?: RowMenu;
  /** Grey the row down — the disabled (Switch-off, still-listed) state. */
  dimmed?: boolean;
  /** Expand affordance + body rendered in the sunken block when expanded. */
  expand?: { canExpand: boolean; expanded: boolean; onToggle: () => void; body: ReactNode };
  /** When set, the sunken block always shows this (an inline editor) regardless
   *  of expand state, and the chevron is suppressed. */
  editor?: ReactNode;
  /** Shown when there is neither a peek nor an expanded body (e.g. "No instructions yet."). */
  emptyPeek?: ReactNode;
  /** Noun for the expand/collapse control's aria-label (e.g. "instructions"), so the
   *  shared row still announces WHAT expands. Falls back to a bare "Expand"/"Collapse". */
  expandLabel?: string;
  /** Leading type glyph (repo / skill / MCP / instruction) so the four resource
   *  kinds are distinguishable at a glance. A small line icon, tinted --fg-4. */
  leadingIcon?: ReactNode;
  /** Prompt-only presentation used by Instructions. The default keeps every
   *  other Agent Detail resource row byte-for-byte on its existing layout. */
  presentation?: "default" | "instruction";
}): ReactNode {
  const instructionPresentation = props.presentation === "instruction";
  const expanded = !!props.expand?.expanded;
  const canExpand = !props.editor && !!props.expand?.canExpand;
  const showSunken = props.editor ? true : expanded && !!props.expand?.body;
  const hasMenu = !!props.menu && props.menu.actions.length > 0;
  // Expand is triggered by clicking the row heading (de-crowd), not a separate
  // chevron button — so the right cluster carries only the Switch + ⋯.
  const showCluster = !!props.toggle || hasMenu;
  // Name the expand control after the row so multiple expanders stay
  // distinguishable to assistive tech (not a generic "Expand instructions").
  const expandNoun = typeof props.name === "string" && props.name ? props.name : (props.expandLabel ?? "");
  return (
    <div
      data-resource-row
      data-dimmed={props.dimmed ? "true" : undefined}
      className="ad-resource-row"
      style={{
        padding: "var(--sp-3) 0",
      }}
    >
      {/* Title + action cluster. On mobile they stack (title, then the controls
          wrap below) so a long control group never overflows a phone width; on
          sm+ they sit on one row with the controls right-aligned. */}
      <div
        className={cn(
          instructionPresentation
            ? "grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2"
            : "flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-3",
        )}
      >
        <div className="min-w-0 flex-1">
          {canExpand ? (
            <button
              type="button"
              aria-expanded={expanded}
              aria-label={
                expanded
                  ? `Collapse${expandNoun ? ` ${expandNoun}` : ""}`
                  : `Expand${expandNoun ? ` ${expandNoun}` : ""}`
              }
              onClick={props.expand?.onToggle}
              className="block min-h-11 w-full text-left"
              style={{ background: "transparent", border: 0, padding: 0, cursor: "pointer" }}
            >
              <RowHeading
                name={props.name}
                source={props.source}
                status={props.status}
                leadingIcon={props.leadingIcon}
                dimmed={props.dimmed}
                expandable
                expanded={expanded}
                instructionPresentation={instructionPresentation}
              />
            </button>
          ) : (
            <RowHeading
              name={props.name}
              source={props.source}
              status={props.status}
              leadingIcon={props.leadingIcon}
              dimmed={props.dimmed}
              instructionPresentation={instructionPresentation}
            />
          )}
        </div>
        {showCluster ? (
          <div className={cn("flex shrink-0 items-center", instructionPresentation ? "gap-2" : "flex-wrap gap-1")}>
            {props.toggle ? (
              <Switch
                checked={props.toggle.checked}
                onCheckedChange={props.toggle.onChange}
                disabled={props.toggle.disabled}
                aria-label={props.toggle.ariaLabel}
                touchTarget={instructionPresentation}
              />
            ) : null}
            {props.menu ? (
              <RowActionsMenu
                actions={props.menu.actions}
                ariaLabel={props.menu.ariaLabel}
                touchTarget={instructionPresentation}
              />
            ) : null}
          </div>
        ) : null}
      </div>
      {showSunken ? (
        <div
          className="text-body"
          style={{
            marginTop: "var(--sp-2)",
            background: instructionPresentation && !props.editor ? "transparent" : "var(--bg-sunken)",
            border: instructionPresentation && !props.editor ? "none" : "var(--hairline) solid var(--border-faint)",
            borderRadius: instructionPresentation && !props.editor ? undefined : "var(--radius-panel)",
            padding: instructionPresentation && !props.editor ? "0 0 0 var(--sp-6)" : "var(--sp-3)",
          }}
        >
          {props.editor ? props.editor : props.expand?.body}
        </div>
      ) : props.peek ? (
        <p
          className={cn("m-0 text-caption", props.monoPeek && "mono")}
          data-line-clamp={instructionPresentation ? "3" : undefined}
          style={{
            color: "var(--fg-3)",
            marginTop: "var(--sp-0_5)",
            display: "-webkit-box",
            WebkitBoxOrient: "vertical",
            WebkitLineClamp: instructionPresentation ? 3 : 2,
            overflow: "hidden",
            paddingLeft: instructionPresentation ? "var(--sp-6)" : undefined,
          }}
        >
          {props.peek}
        </p>
      ) : props.emptyPeek ? (
        <p
          className="m-0 text-caption text-muted-foreground"
          style={{
            marginTop: "var(--sp-0_5)",
            paddingLeft: instructionPresentation ? "var(--sp-6)" : undefined,
          }}
        >
          {props.emptyPeek}
        </p>
      ) : null}
    </div>
  );
}

function RowHeading({
  name,
  source,
  status,
  leadingIcon,
  dimmed,
  expandable,
  expanded,
  instructionPresentation,
}: {
  name: ReactNode | null;
  source: ReactNode;
  status?: RowStatusMarker;
  leadingIcon?: ReactNode;
  dimmed?: boolean;
  /** When the heading itself is the expand trigger, show a subtle affordance. */
  expandable?: boolean;
  expanded?: boolean;
  instructionPresentation?: boolean;
}) {
  if (instructionPresentation) {
    return (
      <span className="flex min-w-0 items-start gap-2">
        {leadingIcon ? (
          <span className="inline-flex shrink-0 items-center" style={{ color: "var(--fg-3)" }} aria-hidden>
            {leadingIcon}
          </span>
        ) : null}
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            {name ? (
              <span
                className="min-w-0 truncate text-body font-medium"
                style={{ color: dimmed ? "var(--fg-4)" : "var(--fg)" }}
              >
                {name}
              </span>
            ) : null}
            {status ? (
              <DenseBadge tone={status.tone} className="shrink-0">
                {status.label}
              </DenseBadge>
            ) : null}
            {expandable ? (
              <span className="inline-flex shrink-0 items-center" style={{ color: "var(--fg-4)" }} aria-hidden>
                {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              </span>
            ) : null}
          </span>
          <span className="block text-caption font-normal" style={{ color: "var(--fg-4)", marginTop: "var(--sp-0_5)" }}>
            {source}
          </span>
        </span>
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-2">
      {leadingIcon ? (
        // Type glyph one step stronger than --fg-4 so the four resource kinds read
        // apart at a glance (ux-expert trial; revert to --fg-4 if too heavy).
        <span className="inline-flex shrink-0 items-center" style={{ color: "var(--fg-3)" }} aria-hidden>
          {leadingIcon}
        </span>
      ) : null}
      {name ? (
        <span className="text-body font-medium truncate" style={{ color: dimmed ? "var(--fg-4)" : "var(--fg)" }}>
          {name}
        </span>
      ) : null}
      <span className="text-caption font-normal" style={{ color: "var(--fg-4)" }}>
        {source}
      </span>
      {status ? (
        <DenseBadge tone={status.tone} className="shrink-0">
          {status.label}
        </DenseBadge>
      ) : null}
      {expandable ? (
        <span className="inline-flex shrink-0 items-center" style={{ color: "var(--fg-4)" }} aria-hidden>
          {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </span>
      ) : null}
    </span>
  );
}
