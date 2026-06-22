import { ChevronDown, ChevronUp } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../../components/ui/button.js";
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
 *   - line 2 (collapsed): a single-line truncated `peek`;
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
  /** Already-resolved source label text (e.g. "From your team"). */
  source: ReactNode;
  /** Overridden / Can't load marker — omitted for a normal row. A disabled row
   *  is conveyed by `toggle` (off) + `dimmed`, not a status badge. */
  status?: RowStatusMarker;
  /** Collapsed single-line preview. */
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
}): ReactNode {
  const expanded = !!props.expand?.expanded;
  const canExpand = !props.editor && !!props.expand?.canExpand;
  const showSunken = props.editor ? true : expanded && !!props.expand?.body;
  const hasMenu = !!props.menu && props.menu.actions.length > 0;
  const showCluster = !!props.toggle || hasMenu || canExpand;
  return (
    <div
      data-dimmed={props.dimmed ? "true" : undefined}
      style={{
        padding: "var(--sp-3) 0",
        borderBottom: "var(--hairline) solid var(--border-faint)",
      }}
    >
      {/* Title + action cluster. On mobile they stack (title, then the controls
          wrap below) so a long control group never overflows a phone width; on
          sm+ they sit on one row with the controls right-aligned. */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-3">
        <div className="min-w-0 flex-1">
          <RowHeading
            name={props.name}
            source={props.source}
            status={props.status}
            leadingIcon={props.leadingIcon}
            dimmed={props.dimmed}
          />
        </div>
        {showCluster ? (
          <div className="flex flex-wrap items-center gap-1 shrink-0">
            {props.toggle ? (
              <Switch
                checked={props.toggle.checked}
                onCheckedChange={props.toggle.onChange}
                disabled={props.toggle.disabled}
                aria-label={props.toggle.ariaLabel}
              />
            ) : null}
            {props.menu ? <RowActionsMenu actions={props.menu.actions} ariaLabel={props.menu.ariaLabel} /> : null}
            {canExpand ? (
              <Button
                type="button"
                size="xs"
                variant="ghost"
                aria-expanded={expanded}
                aria-label={
                  expanded
                    ? `Collapse${props.expandLabel ? ` ${props.expandLabel}` : ""}`
                    : `Expand${props.expandLabel ? ` ${props.expandLabel}` : ""}`
                }
                onClick={props.expand?.onToggle}
              >
                {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      {showSunken ? (
        <div
          className="text-body"
          style={{
            marginTop: "var(--sp-2)",
            background: "var(--bg-sunken)",
            border: "var(--hairline) solid var(--border-faint)",
            borderRadius: "var(--radius-panel)",
            padding: "var(--sp-3)",
          }}
        >
          {props.editor ? props.editor : props.expand?.body}
        </div>
      ) : props.peek ? (
        <p
          className={cn("m-0 text-caption truncate", props.monoPeek && "mono")}
          style={{ color: "var(--fg-3)", marginTop: "var(--sp-0_5)" }}
        >
          {props.peek}
        </p>
      ) : props.emptyPeek ? (
        <p className="m-0 text-caption text-muted-foreground" style={{ marginTop: "var(--sp-0_5)" }}>
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
}: {
  name: ReactNode | null;
  source: ReactNode;
  status?: RowStatusMarker;
  leadingIcon?: ReactNode;
  dimmed?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-2">
      {leadingIcon ? (
        <span className="inline-flex shrink-0 items-center" style={{ color: "var(--fg-4)" }} aria-hidden>
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
    </span>
  );
}
