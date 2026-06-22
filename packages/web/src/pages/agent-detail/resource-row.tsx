import { ChevronDown, ChevronUp, Pencil, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../../components/ui/button.js";
import { StatusGlyph } from "../../components/ui/status-glyph.js";
import { cn } from "../../lib/utils.js";

/**
 * The single flat row primitive for every "effective resource" on the agent
 * detail page — instructions (Instructions tab), skills + MCP (Tools & skills),
 * and repositories (Environment). Before this, the Instructions tab and the
 * shared resource sections rendered near-identical-but-divergent rows: the
 * metadata order was reversed (name → source → status here vs name → status →
 * source there), row padding differed, and only Instructions could expand.
 *
 * `ResourceRow` locks all of that down so the rows read identically wherever
 * they appear:
 *   - line 1: name → source → status, then a right-aligned action group, then an
 *     optional expand chevron;
 *   - line 2 (collapsed): a single-line truncated `peek`;
 *   - expanded / editing: a sunken contained block below.
 */
export type RowStatusMarker = { label: string; color: string } | null;

export function ResourceRowView(props: {
  /** Row title. `null` when the row has no resource name (inline custom prompt);
   *  the peek then carries identity. */
  name: ReactNode | null;
  /** Already-resolved source label text (e.g. "From your team"). */
  source: ReactNode;
  /** Off / Overridden / Can't load marker — omitted for a normal enabled row. */
  status?: RowStatusMarker;
  /** Collapsed single-line preview. */
  peek?: ReactNode;
  /** Render the peek in mono — for technical content (repo URL, MCP command),
   *  NOT for prose (a skill description). */
  monoPeek?: boolean;
  /** Right-aligned ghost action group (use `RowAction`). */
  actions?: ReactNode;
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
}): ReactNode {
  const expanded = !!props.expand?.expanded;
  const canExpand = !props.editor && !!props.expand?.canExpand;
  const showSunken = props.editor ? true : expanded && !!props.expand?.body;
  return (
    <div
      style={{
        padding: "var(--sp-3) 0",
        borderBottom: "var(--hairline) solid var(--border-faint)",
      }}
    >
      {/* Title + actions. On mobile they stack (title, then the action group wraps
          below) so long management buttons never overflow a phone width; on sm+
          they sit on one row with the actions right-aligned. */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-3">
        <div className="min-w-0 flex-1">
          <RowHeading name={props.name} source={props.source} status={props.status} />
        </div>
        {props.actions || canExpand ? (
          <div className="flex flex-wrap items-center gap-1 shrink-0">
            {props.actions}
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

function RowHeading({ name, source, status }: { name: ReactNode | null; source: ReactNode; status?: RowStatusMarker }) {
  return (
    <span className="inline-flex items-center gap-2">
      {name ? (
        <span className="text-body font-medium truncate" style={{ color: "var(--fg)" }}>
          {name}
        </span>
      ) : null}
      <span className="text-caption font-normal" style={{ color: "var(--fg-4)" }}>
        {source}
      </span>
      {status ? (
        <span
          className="mono inline-flex items-center gap-1.5 text-caption font-normal"
          style={{ color: status.color }}
        >
          <StatusGlyph colorVar={status.color} shape="dot" size={7} ariaLabel={status.label} />
          {status.label}
        </span>
      ) : null}
    </span>
  );
}

/**
 * One ghost action button for a ResourceRow. `icon` collapses the control to a
 * single glyph (label moves to aria-label/title) so the widest controls don't
 * overflow the flat row on narrow screens; text mode keeps the label inline.
 */
export function RowAction(props: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  icon?: "edit" | "remove";
}): ReactNode {
  if (props.icon) {
    const Icon = props.icon === "remove" ? Trash2 : Pencil;
    return (
      <Button
        type="button"
        size="xs"
        variant="ghost"
        disabled={props.disabled}
        aria-label={props.label}
        title={props.label}
        onClick={props.onClick}
      >
        <Icon className="h-4 w-4" />
      </Button>
    );
  }
  return (
    <Button type="button" size="xs" variant="ghost" disabled={props.disabled} onClick={props.onClick}>
      {props.label}
    </Button>
  );
}
