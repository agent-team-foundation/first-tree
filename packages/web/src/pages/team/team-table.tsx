import type { Agent } from "@first-tree/shared";
import { Bot, Lock, type LucideIcon, User, Users } from "lucide-react";
import { type CSSProperties, useState } from "react";
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
import { PresenceChip } from "../../components/ui/presence-chip.js";
import { type RowAction, RowActionsMenu } from "../../components/ui/row-actions-menu.js";
import { formatDay } from "../../lib/utils.js";

export type { RowAction };

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
  /**
   * Whether to render the visibility chip (Shared / Private) next to the
   * agent name. Set true for rows inside heterogeneous sections (e.g. "Your
   * agents" mixes both visibilities); false for sections where visibility
   * is already encoded by the section title (Team agents = shared, Other
   * private = private). Keeps chips out of cells where they'd be redundant.
   */
  showVisibilityChip?: boolean;
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
};

type Props = {
  groups: TeamGroup[];
  /** clientId → hostname; agents whose client isn't in the map render runtime alone. */
  clientHostMap: Map<string, string>;
  onAgentClick: (uuid: string) => void;
  getHumanActions: (row: HumanRow) => RowAction[];
  getAgentActions: (row: AgentRow) => RowAction[];
};

const COLUMNS = [
  // Column widths sum to ~870 so the table renders without horizontal
  // compression inside the shared 960 page canvas (960 − 48 layout padding
  // − 40 page padding ≈ 872 content width). Every populated cell already
  // truncates with a `title` tooltip, so realistic long names degrade
  // gracefully without forcing the column wider.
  { key: "name", label: "Name", width: 200 },
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
  { key: "delegate", label: "Delegate", width: 140 },
  { key: "manager", label: "Manager", width: 140 },
  // Runtime cell renders `<runtime-provider> @ <host>` truncated with a
  // tooltip — 170 fits the typical `claude-code @ alice-macbook` form on
  // one line and longer FQDNs ellipsize cleanly. Status (live operational
  // state) is the orthogonal axis and stays in its own column.
  { key: "runtime", label: "Runs on", width: 170 },
  { key: "status", label: "Status", width: 88 },
  { key: "created", label: "Created", width: 88 },
  { key: "actions", label: "", width: 44 },
] as const;

function sectionCellStyle(isLast: boolean, style?: CSSProperties): CSSProperties | undefined {
  if (!isLast) return style;
  return { ...style, borderBottom: 0 };
}

export function TeamTable({ groups, clientHostMap, onAgentClick, getHumanActions, getAgentActions }: Props) {
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
  clientHostMap,
  onAgentClick,
  getHumanActions,
  getAgentActions,
}: {
  group: TeamGroup;
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
    // "yours" mixes visibilities — use the generic Bot icon (same as the
    // old "shared" section) because the per-row visibility chip carries
    // the public/private signal at the row level.
    case "yours":
    case "team":
      return Bot;
    case "other-private":
      return Lock;
    default:
      return null;
  }
}

function GroupHeaderRow({ group, open, onToggle }: { group: TeamGroup; open: boolean; onToggle: () => void }) {
  const Icon = sectionIcon(group.key);
  // Alignment contract (must hold across all 4 sections):
  //   - Section icon at cell X=0 ("hangs out" as section marker).
  //   - Section title text at X=sp-6 — same X as row-name text in the
  //     Name column (HumanRowView / AgentRowView set paddingLeft: sp-6
  //     on the first cell). Section titles and the data column align.
  //   - For collapsible sections, the chevron is rendered OUT-OF-FLOW
  //     to the LEFT of the icon (absolute positioning), so the icon
  //     stays at X=0 and the title stays at X=sp-6 — same alignment as
  //     the non-collapsible sections. The chevron visually "hangs" in
  //     the container's left padding (the table sits inside a parent
  //     with sp-5 left padding, plenty of room for the overhang).
  //
  // An earlier iteration reserved a uniform arrow SLOT on every section
  // (transparent for non-collapsible) which aligned the 4 sections to
  // each other but broke alignment with row names. This restores the
  // dominant alignment (title ↔ row-name) and keeps the collapsible
  // chevron from displacing the icon.
  const inner = (
    <span className="inline-flex items-center relative" style={{ gap: "var(--sp-2)" }}>
      {group.collapsible && (
        <span
          aria-hidden
          style={{
            position: "absolute",
            // Pull the chevron to the left of the icon column. sp-3 ≈ 12,
            // enough clearance to read it as a separate glyph without
            // running into the icon glyph.
            //
            // IMPLICIT CONTRACT: this only renders cleanly because the
            // TeamPage container around the table has `padding-left: sp-5`
            // (see packages/web/src/pages/team/index.tsx — the wrapper
            // `<div>` with `padding: var(--sp-2) var(--sp-5) var(--sp-7)`).
            // sp-3 overhang fits inside the sp-5 padding with sp-2 to
            // spare. If that outer padding ever shrinks below sp-3 the
            // chevron will clip against the page chrome — revisit either
            // the outer padding or switch this back to an in-flow slot.
            left: "calc(-1 * var(--sp-3))",
            top: "50%",
            transform: "translateY(-50%)",
            color: "var(--fg-4)",
            lineHeight: 1,
          }}
        >
          {open ? "▾" : "▸"}
        </span>
      )}
      {Icon && <Icon className="h-4 w-4" aria-hidden style={{ color: "var(--fg-3)" }} />}
      <span className="text-body font-medium" style={{ color: "var(--fg)" }}>
        {group.title}
      </span>
      <DenseBadge tone="outline">{group.count}</DenseBadge>
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
              cursor: "pointer",
              color: "inherit",
              // padding-left + matching negative margin-left extends the
              // click target leftward to include the hanging chevron,
              // without visually shifting the icon/title. Users can
              // click the chevron OR the title and either triggers the
              // toggle.
              padding: "0 0 0 var(--sp-3)",
              marginLeft: "calc(-1 * var(--sp-3))",
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
        <NameCell displayName={row.displayName} handle={`@${row.username}`} selfTag={row.isSelf} />
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

  // AgentChip is inline-flex by default which lets long display names
  // wrap into the row. Wrapping the chip in a block-level truncate
  // container (same recipe as the Runs-on column) keeps the cell to a
  // single line, drops an ellipsis on overflow, and surfaces the full
  // "Display Name (@handle)" via the title attribute on hover. Without
  // this, a wide delegate name at the narrow Delegate column width
  // wrapped to two lines — the issue reported by users.
  const fullLabel = row.delegate
    ? row.delegate.name
      ? `${row.delegate.displayName} (@${row.delegate.name})`
      : row.delegate.displayName
    : "Set delegate";

  const value = row.delegate ? (
    <span
      className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap"
      // Cell holds an inline AgentChip — wrapping in `block` + truncate
      // utilities is necessary because the chip itself is inline-flex.
    >
      <AgentChip name={row.delegate.name} displayName={row.delegate.displayName} />
    </span>
  ) : (
    <span style={{ color: "var(--accent-dim)" }}>Set delegate →</span>
  );

  const tooltip = row.delegate ? (row.canEditDelegate ? `Change delegate · ${fullLabel}` : fullLabel) : "Set delegate";

  if (!row.canEditDelegate) {
    return (
      <span className="text-label block max-w-full overflow-hidden" title={tooltip}>
        {value}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={row.onEditDelegate}
      className="text-label hover:underline block max-w-full overflow-hidden"
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
  clientHost,
  actions,
  onClick,
  isLast,
}: {
  row: AgentRow;
  clientHost: string | null;
  actions: RowAction[];
  onClick: () => void;
  isLast: boolean;
}) {
  const { agent, managerLabel, isOwnedBySelf, showVisibilityChip } = row;

  return (
    <DenseTableRow interactive onClick={onClick}>
      <DenseTableCell style={sectionCellStyle(isLast, { paddingLeft: "var(--sp-6)" })}>
        <NameCell
          displayName={agent.displayName}
          handle={agent.name ? `@${agent.name}` : null}
          visibility={showVisibilityChip ? agent.visibility : null}
        />
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
        <PresenceChip status={agent.presenceStatus} />
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

function NameCell({
  displayName,
  handle,
  selfTag,
  visibility,
}: {
  displayName: string;
  handle: string | null;
  selfTag?: boolean;
  /**
   * Optional visibility marker rendered to the right of the display name.
   * Only used in heterogeneous sections (e.g. "Your agents" which mixes
   * shared + private rows) — homogeneous sections skip this prop since
   * the section title already encodes the visibility.
   */
  visibility?: Agent["visibility"] | null;
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-baseline gap-1.5 min-w-0">
        <span className="font-medium text-body truncate" style={{ color: "var(--fg)" }} title={displayName}>
          {displayName}
        </span>
        {selfTag && (
          <span className="text-label italic shrink-0" style={{ color: "var(--fg-3)" }}>
            (you)
          </span>
        )}
        {visibility && <VisibilityChip visibility={visibility} />}
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
 * Inline visibility marker. `shared` = team-mentionable (DenseBadge accent
 * tone matches the agent-detail page's chip). `private` = owner-only (the
 * Lock icon + DenseBadge outline tone reuses the section-icon vocabulary,
 * so a private chip next to a name and the Lock-icon section header carry
 * the same meaning visually).
 */
function VisibilityChip({ visibility }: { visibility: Agent["visibility"] }) {
  if (visibility === "private") {
    return (
      <DenseBadge tone="outline" title="Private — only you can see this agent" className="shrink-0">
        <Lock className="h-2.5 w-2.5" aria-hidden style={{ marginRight: 3 }} />
        Private
      </DenseBadge>
    );
  }
  return (
    <DenseBadge tone="accent" title="Shared — anyone in the team can @mention this agent" className="shrink-0">
      <Users className="h-2.5 w-2.5" aria-hidden style={{ marginRight: 3 }} />
      Shared
    </DenseBadge>
  );
}
