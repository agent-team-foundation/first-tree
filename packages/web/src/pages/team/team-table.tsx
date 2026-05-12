import type { Agent } from "@agent-team-foundation/first-tree-hub-shared";
import { Bot, Lock, User } from "lucide-react";
import { type ReactNode, useState } from "react";
import type { RuntimeAgent } from "../../api/activity.js";
import {
  DenseTable,
  DenseTableBody,
  DenseTableCell,
  DenseTableHead,
  DenseTableHeader,
  DenseTableRow,
} from "../../components/ui/dense-table.js";
import { type RowAction, RowActionsMenu } from "../../components/ui/row-actions-menu.js";
import { StateChip } from "../../components/ui/state-chip.js";
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
  username: string;
  displayName: string;
  role: string;
  createdAt: string;
  isSelf: boolean;
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
};

type Props = {
  groups: TeamGroup[];
  runtimeMap: Map<string, RuntimeAgent>;
  onAgentClick: (uuid: string) => void;
  getHumanActions: (row: HumanRow) => RowAction[];
  getAgentActions: (row: AgentRow) => RowAction[];
};

const COLUMNS = [
  { key: "name", label: "Name", width: 260 },
  { key: "manager", label: "Manager", width: 140 },
  { key: "runtime", label: "Runtime · Status", width: 170 },
  { key: "created", label: "Created", width: 120 },
  { key: "actions", label: "", width: 44 },
] as const;

export function TeamTable({ groups, runtimeMap, onAgentClick, getHumanActions, getAgentActions }: Props) {
  return (
    <DenseTable className="table-fixed">
      <DenseTableHeader>
        <DenseTableRow>
          {COLUMNS.map((col) => (
            <DenseTableHead key={col.key} style={{ width: col.width }} aria-hidden={col.key === "actions"}>
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
  onAgentClick,
  getHumanActions,
  getAgentActions,
}: {
  group: TeamGroup;
  runtimeMap: Map<string, RuntimeAgent>;
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
            style={{ color: "var(--fg-4)", textAlign: "center", padding: "var(--sp-4)" }}
          >
            {group.emptyMessage}
          </DenseTableCell>
        </DenseTableRow>
      )}
      {open &&
        group.rows.map((row) =>
          row.kind === "human" ? (
            <HumanRowView key={`h:${row.id}`} row={row} actions={getHumanActions(row)} />
          ) : (
            <AgentRowView
              key={`a:${row.agent.uuid}`}
              row={row}
              runtime={runtimeMap.get(row.agent.uuid) ?? null}
              actions={getAgentActions(row)}
              onClick={() => onAgentClick(row.agent.uuid)}
            />
          ),
        )}
    </DenseTableBody>
  );
}

function GroupHeaderRow({ group, open, onToggle }: { group: TeamGroup; open: boolean; onToggle: () => void }) {
  return (
    <DenseTableRow>
      <td
        colSpan={COLUMNS.length}
        style={{
          padding: "var(--sp-3) var(--sp-3_5) var(--sp-1_5)",
          borderBottom: "var(--hairline) solid var(--border-faint)",
        }}
      >
        {group.collapsible ? (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            className="inline-flex items-baseline gap-2 text-eyebrow uppercase"
            style={{
              color: "var(--fg-3)",
              background: "transparent",
              border: 0,
              padding: 0,
              cursor: "pointer",
            }}
          >
            <span aria-hidden style={{ display: "inline-block", width: 10 }}>
              {open ? "▾" : "▸"}
            </span>
            <span>{group.title}</span>
            <span style={{ color: "var(--fg-4)" }}>({group.count})</span>
          </button>
        ) : (
          <div className="inline-flex items-baseline gap-2 text-eyebrow uppercase" style={{ color: "var(--fg-3)" }}>
            <span>{group.title}</span>
            <span style={{ color: "var(--fg-4)" }}>({group.count})</span>
          </div>
        )}
      </td>
    </DenseTableRow>
  );
}

function HumanRowView({ row, actions }: { row: HumanRow; actions: RowAction[] }) {
  return (
    <DenseTableRow>
      <DenseTableCell>
        <NameCell
          icon={<User className="h-3.5 w-3.5" aria-hidden style={{ color: "var(--fg-3)" }} />}
          displayName={row.displayName}
          handle={`@${row.username}`}
          selfTag={row.isSelf}
        />
      </DenseTableCell>
      <DenseTableCell className="text-label" style={{ color: "var(--fg-4)" }}>
        —
      </DenseTableCell>
      <DenseTableCell className="text-label" style={{ color: "var(--fg-4)" }}>
        —
      </DenseTableCell>
      <DenseTableCell className="mono text-caption" style={{ color: "var(--fg-4)" }}>
        {formatDay(row.createdAt)}
      </DenseTableCell>
      <DenseTableCell style={{ padding: 0, textAlign: "right" }}>
        <RowActionsMenu actions={actions} ariaLabel={`Actions for ${row.displayName}`} />
      </DenseTableCell>
    </DenseTableRow>
  );
}

function AgentRowView({
  row,
  runtime,
  actions,
  onClick,
}: {
  row: AgentRow;
  runtime: RuntimeAgent | null;
  actions: RowAction[];
  onClick: () => void;
}) {
  const { agent, managerLabel, isOwnedBySelf } = row;
  const isPrivate = agent.visibility === "private";
  const icon = isPrivate ? (
    <Lock className="h-3.5 w-3.5" aria-hidden style={{ color: "var(--fg-3)" }} />
  ) : (
    <Bot className="h-3.5 w-3.5" aria-hidden style={{ color: "var(--fg-3)" }} />
  );

  return (
    <DenseTableRow interactive onClick={onClick}>
      <DenseTableCell>
        <NameCell icon={icon} displayName={agent.displayName} handle={agent.name ? `@${agent.name}` : null} />
      </DenseTableCell>
      <DenseTableCell className="text-label" style={{ color: "var(--fg-2)" }}>
        {managerLabel ?? "—"}
        {isOwnedBySelf && (
          <span className="text-label italic" style={{ marginLeft: 6, color: "var(--fg-3)" }}>
            (you)
          </span>
        )}
      </DenseTableCell>
      <DenseTableCell>
        <RuntimeStatusCell runtimeState={runtime?.runtimeState ?? null} runtimeProvider={agent.runtimeProvider} />
      </DenseTableCell>
      <DenseTableCell className="mono text-caption" style={{ color: "var(--fg-4)" }}>
        {formatDay(agent.createdAt)}
      </DenseTableCell>
      <DenseTableCell style={{ padding: 0, textAlign: "right" }} onClick={(e) => e.stopPropagation()}>
        <RowActionsMenu actions={actions} ariaLabel={`Actions for ${agent.displayName}`} />
      </DenseTableCell>
    </DenseTableRow>
  );
}

function NameCell({
  icon,
  displayName,
  handle,
  selfTag,
}: {
  icon: ReactNode;
  displayName: string;
  handle: string | null;
  selfTag?: boolean;
}) {
  return (
    <div className="flex items-start gap-2">
      <span style={{ marginTop: 2 }}>{icon}</span>
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
    </div>
  );
}

function RuntimeStatusCell({
  runtimeState,
  runtimeProvider,
}: {
  runtimeState: string | null;
  runtimeProvider: string;
}) {
  return (
    <div className="flex flex-col" style={{ gap: 2 }}>
      <StateChip state={runtimeState} />
      <span className="mono text-caption" style={{ color: "var(--fg-4)" }}>
        {runtimeProvider}
      </span>
    </div>
  );
}
