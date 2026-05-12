import type { Agent } from "@agent-team-foundation/first-tree-hub-shared";
import { Bot, Lock, type LucideIcon, MoreHorizontal, User } from "lucide-react";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import type { RuntimeAgent } from "../../api/activity.js";
import { AgentChip } from "../../components/agent-chip.js";
import { DenseBadge } from "../../components/ui/dense-badge.js";
import {
  DenseTable,
  DenseTableBody,
  DenseTableCell,
  DenseTableHead,
  DenseTableHeader,
  DenseTableRow,
} from "../../components/ui/dense-table.js";
import { StateChip } from "../../components/ui/state-chip.js";
import { formatDay } from "../../lib/utils.js";

/**
 * Merged Team table — humans and agents share one column structure
 * (Name | Manager | Runtime·Status | Created | actions). Sectioning is
 * how visibility/role boundaries are expressed: callers pre-group rows
 * into `Humans`, `Shared agents`, `Your private agents`, optionally
 * `Other members' private agents` (admin governance view).
 *
 * Why one table, not three:
 *   - Shared columns / shared search / shared filter scope.
 *   - "This is the team" reads as a single roster, not three sub-rosters.
 *   - The Manager column being blank for humans is a *visual* expression
 *     of "humans don't have a manager", not a layout compromise.
 */

export type HumanRow = {
  kind: "human";
  id: string;
  /** UUID of the type="human" mirror agent — needed when the row action edits the agent (e.g. setting delegateMention). */
  agentId: string;
  username: string;
  displayName: string;
  role: string;
  createdAt: string;
  isSelf: boolean;
  /** Resolved identity of the personal assistant this human delegates to, or null if none configured. */
  delegate: { name: string | null; displayName: string } | null;
  /** Whether the current viewer can edit this human's delegate (self, or admin viewing anyone). */
  canEditDelegate: boolean;
  /** Open the delegate dialog for this row; only called when canEditDelegate is true. */
  onEditDelegate: () => void;
};

export type AgentRow = {
  kind: "agent";
  agent: Agent;
  managerLabel: string | null;
  isOwnedBySelf: boolean;
};

export type TeamRow = HumanRow | AgentRow;

export type TeamGroup = {
  key: string;
  title: string;
  count: number;
  rows: TeamRow[];
  /** Optional empty-state message; renders when rows.length === 0. */
  emptyMessage?: string;
  /** When set, the group renders as a collapsible disclosure starting collapsed. */
  collapsible?: boolean;
  /**
   * Optional secondary fact rendered next to the count badge in `text-caption` /
   * `--fg-4`. Used by the Humans section to surface admin count (`1 admin`) —
   * the role distribution was previously in the page subtitle, now lives next
   * to the rows it describes.
   */
  subtitle?: string;
};

export type RowAction = {
  key: string;
  label: string;
  destructive?: boolean;
  disabled?: boolean;
  onSelect: () => void;
};

type Props = {
  groups: TeamGroup[];
  runtimeMap: Map<string, RuntimeAgent>;
  /** clientId → hostname; agents whose client isn't in the map render runtime alone. */
  clientHostMap: Map<string, string>;
  onAgentClick: (uuid: string) => void;
  getHumanActions: (row: HumanRow) => RowAction[];
  getAgentActions: (row: AgentRow) => RowAction[];
};

const COLUMNS = [
  { key: "name", label: "Name", width: 260 },
  // Delegate and Manager are split into separate columns so each header
  // carries exactly one meaning. Human rows fill Delegate (the assistant
  // acting on their behalf) and leave Manager as `—`; agent rows fill
  // Manager (the human who owns the agent) and leave Delegate as `—`.
  // Order: Delegate before Manager so the Humans section — which renders
  // first in the table — has its populated cell immediately right of the
  // Name column, no `—` gap before the data. Each section uniformly fills
  // one column and leaves the other empty — the half-blank pattern reads
  // as section structure, not missing data, and neither column has to
  // mean two things at once.
  { key: "delegate", label: "Delegate", width: 160 },
  { key: "manager", label: "Manager", width: 160 },
  // The cell renders `<runtime-provider> @ <host>` in one line — covers
  // both framework and host together (plain "Runtime" only described the
  // framework half). Wider than the other middle columns because the
  // combined `claude-code @ alice-macbook` form runs roughly 25-30 chars;
  // this wider column fits most everyday cases, and longer corporate
  // FQDNs gracefully truncate with the `title` tooltip showing full value.
  // Status (live operational state) is the orthogonal axis and stays in
  // its own column so config and live state don't share a cell. Both
  // blank for human rows.
  { key: "runtime", label: "Runs on", width: 220 },
  { key: "status", label: "Status", width: 160 },
  { key: "created", label: "Created", width: 160 },
  // Middle columns mostly pin to 160 for grid rhythm. Runs on opts out at
  // 220 because its content (provider + host) is denser than the others.
  // Name stays wider (variable display-name + @handle) and Actions stays
  // narrow (single kebab icon) — those sit at the content-density extremes.
  { key: "actions", label: "", width: 44 },
] as const;

function sectionCellStyle(isLast: boolean, style?: CSSProperties): CSSProperties | undefined {
  if (!isLast) return style;
  return { ...style, borderBottom: 0 };
}

export function TeamTable({
  groups,
  runtimeMap,
  clientHostMap,
  onAgentClick,
  getHumanActions,
  getAgentActions,
}: Props) {
  return (
    <DenseTable className="table-fixed">
      <DenseTableHeader>
        <DenseTableRow>
          {COLUMNS.map((col) => (
            <DenseTableHead
              key={col.key}
              // The first column (Name) also shifts to `sp-6` left padding
              // so the column header sits in the same vertical alignment
              // line as the section title text and the row name text.
              style={{ width: col.width, ...(col.key === "name" ? { paddingLeft: "var(--sp-6)" } : null) }}
              aria-hidden={col.key === "actions"}
            >
              {col.label}
            </DenseTableHead>
          ))}
        </DenseTableRow>
      </DenseTableHeader>
      {groups.map((group) => (
        <GroupBody
          key={group.key}
          group={group}
          runtimeMap={runtimeMap}
          clientHostMap={clientHostMap}
          onAgentClick={onAgentClick}
          getHumanActions={getHumanActions}
          getAgentActions={getAgentActions}
        />
      ))}
    </DenseTable>
  );
}

function GroupBody({
  group,
  runtimeMap,
  clientHostMap,
  onAgentClick,
  getHumanActions,
  getAgentActions,
}: {
  group: TeamGroup;
  runtimeMap: Map<string, RuntimeAgent>;
  clientHostMap: Map<string, string>;
  onAgentClick: (uuid: string) => void;
  getHumanActions: (row: HumanRow) => RowAction[];
  getAgentActions: (row: AgentRow) => RowAction[];
}) {
  const [open, setOpen] = useState(!group.collapsible);

  return (
    <DenseTableBody>
      <GroupHeaderRow group={group} open={open} onToggle={() => setOpen((v) => !v)} />
      {open && group.rows.length === 0 && group.emptyMessage && (
        <DenseTableRow>
          <DenseTableCell
            colSpan={COLUMNS.length}
            style={{
              color: "var(--fg-4)",
              textAlign: "left",
              padding: "0 var(--sp-3_5) var(--sp-3) var(--sp-6)",
              borderBottom: 0,
            }}
          >
            {group.emptyMessage}
          </DenseTableCell>
        </DenseTableRow>
      )}
      {open &&
        group.rows.map((row, index) => {
          const isLast = index === group.rows.length - 1;
          return row.kind === "human" ? (
            <HumanRowView key={`h:${row.id}`} row={row} actions={getHumanActions(row)} isLast={isLast} />
          ) : (
            <AgentRowView
              key={`a:${row.agent.uuid}`}
              row={row}
              runtime={runtimeMap.get(row.agent.uuid) ?? null}
              clientHost={row.agent.clientId ? (clientHostMap.get(row.agent.clientId) ?? null) : null}
              actions={getAgentActions(row)}
              onClick={() => onAgentClick(row.agent.uuid)}
              isLast={isLast}
            />
          );
        })}
    </DenseTableBody>
  );
}

/**
 * Map a section's key to the lucide icon that ties it back to the row icons
 * inside it. Humans use User (matches HumanRowView's name-cell icon), Shared
 * agents use Bot, and private agent buckets use Lock — same visual vocabulary
 * the rows themselves use, so the section header becomes a "tab" for that
 * row-type rather than a separate label scheme.
 */
function sectionIcon(key: string): LucideIcon | null {
  switch (key) {
    case "humans":
      return User;
    case "shared":
      return Bot;
    case "private":
    case "other-private":
      return Lock;
    default:
      return null;
  }
}

function GroupHeaderRow({ group, open, onToggle }: { group: TeamGroup; open: boolean; onToggle: () => void }) {
  const Icon = sectionIcon(group.key);
  const inner = (
    <span className="inline-flex items-center" style={{ gap: "var(--sp-2)" }}>
      {group.collapsible && (
        <span aria-hidden style={{ display: "inline-block", width: 10, color: "var(--fg-4)" }}>
          {open ? "▾" : "▸"}
        </span>
      )}
      {Icon && <Icon className="h-4 w-4" aria-hidden style={{ color: "var(--fg-3)" }} />}
      <span className="text-body font-medium" style={{ color: "var(--fg)" }}>
        {group.title}
      </span>
      <DenseBadge tone="outline">{group.count}</DenseBadge>
      {group.subtitle && (
        <span className="text-caption" style={{ color: "var(--fg-4)" }}>
          · {group.subtitle}
        </span>
      )}
    </span>
  );
  return (
    <DenseTableRow>
      <td
        colSpan={COLUMNS.length}
        style={{
          // Section header sits at the table's left edge (padding-left: 0);
          // its icon (sp-4 wide) + gap (sp-2) puts the section TITLE TEXT
          // at sp-6 from the cell edge. Row first-cells override their
          // padding-left to sp-6 (see HumanRowView / AgentRowView) so row
          // names line up vertically with the section title text, while
          // the section icon "hangs out" to the left as a section marker.
          // sp-6 top, sp-2 bottom — generous breathing room above, tight
          // below so the section visually "owns" the rows under it.
          padding: "var(--sp-6) var(--sp-3_5) var(--sp-2) 0",
        }}
      >
        {group.collapsible ? (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            style={{
              background: "transparent",
              border: 0,
              padding: 0,
              cursor: "pointer",
              color: "inherit",
            }}
          >
            {inner}
          </button>
        ) : (
          inner
        )}
      </td>
    </DenseTableRow>
  );
}

function HumanRowView({ row, actions, isLast }: { row: HumanRow; actions: RowAction[]; isLast: boolean }) {
  return (
    <DenseTableRow>
      <DenseTableCell style={sectionCellStyle(isLast, { paddingLeft: "var(--sp-6)" })}>
        <div className="flex min-w-0 items-start" style={{ gap: "var(--sp-2)" }}>
          <div className="min-w-0 flex-1">
            <NameCell displayName={row.displayName} handle={`@${row.username}`} selfTag={row.isSelf} />
          </div>
          {row.role === "admin" && (
            <DenseBadge tone="outline" style={{ flexShrink: 0, marginTop: 1 }}>
              admin
            </DenseBadge>
          )}
        </div>
      </DenseTableCell>
      <DenseTableCell style={sectionCellStyle(isLast)}>
        <HumanDelegateCell row={row} />
      </DenseTableCell>
      <DenseTableCell className="text-label" style={sectionCellStyle(isLast, { color: "var(--fg-4)" })}>
        —
      </DenseTableCell>
      <DenseTableCell className="text-label" style={sectionCellStyle(isLast, { color: "var(--fg-4)" })}>
        —
      </DenseTableCell>
      <DenseTableCell className="text-label" style={sectionCellStyle(isLast, { color: "var(--fg-4)" })}>
        —
      </DenseTableCell>
      <DenseTableCell className="mono text-caption" style={sectionCellStyle(isLast, { color: "var(--fg-4)" })}>
        {formatDay(row.createdAt)}
      </DenseTableCell>
      <DenseTableCell style={sectionCellStyle(isLast, { padding: 0, textAlign: "right" })}>
        <RowActionsMenu actions={actions} ariaLabel={`Actions for ${row.displayName}`} />
      </DenseTableCell>
    </DenseTableRow>
  );
}

/**
 * The Manager column has no meaning for humans (they don't have a manager —
 * they ARE the principals). We repurpose the cell to surface the
 * `delegateMention` linkage instead: who the human has delegated their
 * @mention handling to. Showing it inline (rather than only in the kebab
 * menu) turned an invisible feature into an obvious one — the screenshot
 * audit found the row felt empty because three of four columns rendered "—".
 *
 * Editable affordance shows only when the viewer can persist the change
 * (self, or admin). For other viewers, the chip is shown read-only or "—".
 */
function HumanDelegateCell({ row }: { row: HumanRow }) {
  // Read-only viewer + no delegate → just the em-dash.
  if (!row.delegate && !row.canEditDelegate) {
    return (
      <span className="text-label" style={{ color: "var(--fg-4)" }}>
        —
      </span>
    );
  }

  const value = row.delegate ? (
    <AgentChip name={row.delegate.name} displayName={row.delegate.displayName} />
  ) : (
    <span style={{ color: "var(--accent-dim)" }}>Set delegate →</span>
  );

  const tooltip = row.delegate ? (row.canEditDelegate ? "Change delegate" : undefined) : "Set delegate";

  if (!row.canEditDelegate) {
    return (
      <span className="text-label" title={tooltip}>
        {value}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={row.onEditDelegate}
      className="text-label hover:underline"
      style={{
        background: "transparent",
        border: 0,
        padding: 0,
        cursor: "pointer",
        color: "inherit",
        textAlign: "left",
      }}
      title={tooltip}
    >
      {value}
    </button>
  );
}

function AgentRowView({
  row,
  runtime,
  clientHost,
  actions,
  onClick,
  isLast,
}: {
  row: AgentRow;
  runtime: RuntimeAgent | null;
  clientHost: string | null;
  actions: RowAction[];
  onClick: () => void;
  isLast: boolean;
}) {
  const { agent, managerLabel, isOwnedBySelf } = row;

  return (
    <DenseTableRow interactive onClick={onClick}>
      <DenseTableCell style={sectionCellStyle(isLast, { paddingLeft: "var(--sp-6)" })}>
        <NameCell displayName={agent.displayName} handle={agent.name ? `@${agent.name}` : null} />
      </DenseTableCell>
      <DenseTableCell className="text-label" style={sectionCellStyle(isLast, { color: "var(--fg-4)" })}>
        —
      </DenseTableCell>
      <DenseTableCell className="text-label" style={sectionCellStyle(isLast, { color: "var(--fg-2)" })}>
        {managerLabel ? (
          <span className="truncate inline-block max-w-full" title={managerLabel}>
            {managerLabel}
            {isOwnedBySelf && (
              <span className="text-label italic" style={{ marginLeft: 6, color: "var(--fg-3)" }}>
                (you)
              </span>
            )}
          </span>
        ) : (
          <span style={{ color: "var(--fg-4)" }}>—</span>
        )}
      </DenseTableCell>
      <DenseTableCell className="mono text-caption" style={sectionCellStyle(isLast, { color: "var(--fg-3)" })}>
        <div
          className="truncate"
          title={clientHost ? `${agent.runtimeProvider} @ ${clientHost}` : agent.runtimeProvider}
        >
          {agent.runtimeProvider}
          {clientHost && (
            <span style={{ color: "var(--fg-4)" }}>
              {" @ "}
              {clientHost}
            </span>
          )}
        </div>
      </DenseTableCell>
      <DenseTableCell style={sectionCellStyle(isLast)}>
        <StateChip state={runtime?.runtimeState ?? null} />
      </DenseTableCell>
      <DenseTableCell className="mono text-caption" style={sectionCellStyle(isLast, { color: "var(--fg-4)" })}>
        {formatDay(agent.createdAt)}
      </DenseTableCell>
      <DenseTableCell
        style={sectionCellStyle(isLast, { padding: 0, textAlign: "right" })}
        onClick={(e) => e.stopPropagation()}
      >
        <RowActionsMenu actions={actions} ariaLabel={`Actions for ${agent.displayName}`} />
      </DenseTableCell>
    </DenseTableRow>
  );
}

function NameCell({ displayName, handle, selfTag }: { displayName: string; handle: string | null; selfTag?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="font-medium text-body truncate" style={{ color: "var(--fg)" }} title={displayName}>
        {displayName}
        {selfTag && (
          <span className="text-label italic" style={{ marginLeft: 6, color: "var(--fg-3)" }}>
            (you)
          </span>
        )}
      </div>
      {handle && (
        <div className="mono text-caption truncate" style={{ color: "var(--fg-4)" }} title={handle}>
          {handle}
        </div>
      )}
    </div>
  );
}

/**
 * Self-contained kebab menu. Click-outside / Escape close. Anchored to its
 * trigger button. Each call site supplies its own action list — keeps the
 * permission logic in the page and the menu purely presentational.
 *
 * Returns `null` when actions is empty so the cell stays clean instead of
 * dangling an icon that does nothing.
 */
function RowActionsMenu({ actions, ariaLabel }: { actions: RowAction[]; ariaLabel: string }) {
  const [open, setOpen] = useState(false);
  // Flip direction up when the kebab is close to the viewport bottom and the
  // estimated menu height would clip below. Approximating menu height as
  // ITEM_HEIGHT_ESTIMATE * action count is close enough — pixel-perfect
  // collision detection isn't worth the dependency on a positioning lib.
  const [direction, setDirection] = useState<"down" | "up">("down");
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open || !buttonRef.current) return;
    const ITEM_HEIGHT_ESTIMATE = 32;
    const MENU_PADDING = 8;
    const rect = buttonRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const estimatedHeight = actions.length * ITEM_HEIGHT_ESTIMATE + MENU_PADDING;
    setDirection(spaceBelow >= estimatedHeight ? "down" : "up");
  }, [open, actions.length]);

  if (actions.length === 0) return null;

  return (
    <div ref={ref} className="relative inline-flex">
      <button
        ref={buttonRef}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="inline-flex items-center justify-center"
        style={{
          width: 28,
          height: 28,
          borderRadius: 4,
          background: "transparent",
          color: "var(--fg-3)",
          cursor: "pointer",
          border: 0,
        }}
      >
        <MoreHorizontal className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-30 rounded-md border bg-popover shadow-md"
          style={{
            minWidth: 180,
            borderColor: "var(--border)",
            ...(direction === "up" ? { bottom: "100%", marginBottom: 4 } : { top: "100%", marginTop: 4 }),
          }}
        >
          {actions.map((action) => (
            <button
              key={action.key}
              type="button"
              role="menuitem"
              disabled={action.disabled}
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                action.onSelect();
              }}
              className="flex w-full items-center px-3 py-1.5 text-left text-body hover:bg-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              style={{
                color: action.destructive ? "var(--state-error)" : "var(--fg)",
                background: "transparent",
                border: 0,
                cursor: action.disabled ? "not-allowed" : "pointer",
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
