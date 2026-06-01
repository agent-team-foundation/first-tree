import type { Agent, PresenceStatus, UsageByAgentRow } from "@first-tree/shared";
import { Bot, ChevronDown, Lock, type LucideIcon, User } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Avatar } from "../../components/avatar.js";
import { DenseBadge } from "../../components/ui/dense-badge.js";
import { Popover } from "../../components/ui/popover.js";
import { PresenceChip, runtimeStateToPresence } from "../../components/ui/presence-chip.js";
import { type RowAction, RowActionsMenu } from "../../components/ui/row-actions-menu.js";
import { SegmentedControl } from "../../components/ui/segmented-control.js";
import { formatCompactCount, formatRelative } from "../../lib/utils.js";

export type { RowAction };

/**
 * Team roster — two stacked sections (Agent teammates first, Human teammates
 * second) replacing the old merged single table. Layout, spacing, and
 * interaction match the approved `/preview/team` prototype; this version is
 * wired to live data via props.
 *
 *   - Agent teammates: Public / Private subgroups (visibility encoded by the
 *     group, no per-row chip). Owner · Runs on · Status · Usage · actions.
 *   - Human teammates: Delegate · Last active · actions.
 *
 * Cross-module alignment (§3 of the design): both sections share ONE row grid
 * so Name (left), the activity column, and Actions (right) line up; the middle
 * band differs per section and is free.
 */

export type HumanRow = {
  kind: "human";
  id: string;
  /** UUID of the type="human" mirror agent — the delegate edit PATCHes this. */
  agentId: string;
  username: string;
  displayName: string;
  role: string;
  isSelf: boolean;
  delegate: { uuid: string; name: string | null; displayName: string } | null;
  /** Whether the viewer can edit this human's delegate (self only, per spec). */
  canEditDelegate: boolean;
  /** Humanized "active X ago"; null renders "—" (Phase 2 wires the data). */
  lastActiveLabel: string | null;
};

export type AgentRow = {
  kind: "agent";
  agent: Agent;
  managerLabel: string | null;
  isOwnedBySelf: boolean;
};

// ── Shared row geometry (cross-module alignment contract) ──────────────────
// Tuned for the app's shared 960 content canvas (Layout maxWidth 960 — same as
// Context / Settings / Agent-detail), NOT the 1280 of the early prototype.
// Lower Name min + trimmer Status/Actions tracks keep the middle band
// (Owner · Runs on · Usage) un-cramped at ~872 usable px.
const ROW_GRID = "minmax(var(--sp-60), 1.6fr) minmax(0, 2.2fr) calc(var(--sp-20) + var(--sp-4)) var(--sp-12)";

/**
 * Make a whole row clickable → open its detail target (the original Team table
 * behaviour; `DenseTableRow` ships the same `interactive` affordance). Inner
 * controls (kebab menu, delegate popover) stopPropagation so they don't also
 * navigate. role+tabIndex+key handler keep it keyboard-accessible.
 */
function rowOpenProps(onOpen: () => void, label: string) {
  return {
    role: "button",
    tabIndex: 0,
    "aria-label": label,
    onClick: onOpen,
    onKeyDown: (e: { key: string; preventDefault: () => void }) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onOpen();
      }
    },
  } as const;
}
const ROW_GAP = "var(--sp-5)";
// Agent middle band sub-grid: Owner | Runs on | Usage. The Usage min width is
// kept generous to fit "1.24M · 142t" cells without ellipsis at the dominant
// content density.
const AGENT_MIDDLE_GRID = "minmax(0, 1.3fr) minmax(0, 1fr) minmax(calc(var(--sp-20) + var(--sp-10)), 1fr)";
// Compact (<64rem): collapse to Name | Status | Actions; fold the rest into
// the name cell's meta line, all actions into one always-visible kebab.
const COMPACT_GRID = "minmax(0, 1fr) auto auto";
// Indent applied to a section's BODY (column header + groups + member rows),
// relative to its section header. This is the disclosure "step": a section
// caret sits at the left edge (x0); everything below — subgroup carets, the
// Name column header, and every member row — shifts one step right (x1) and
// shares that single left edge. So the hierarchy reads from the carets only
// (section at x0, subgroup at x1), while member Name never indents per group:
// Agent members (under Public/Private) and Human members line up on one column.
const SECTION_BODY_INDENT = "var(--sp-6)";

/**
 * Per-section collapse state, persisted to localStorage so a member's
 * expand/collapse choices survive across visits (default: expanded — a missing
 * key reads as not-collapsed). One key per section (`team.collapse.<id>`).
 */
function useCollapsed(storageKey: string): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(storageKey) === "1";
  });
  const toggle = () => {
    setCollapsed((prev) => {
      const next = !prev;
      if (typeof window !== "undefined") window.localStorage.setItem(storageKey, next ? "1" : "0");
      return next;
    });
  };
  return [collapsed, toggle];
}

/** Disclosure caret for a collapsible section header — points down when open, right when collapsed. */
function CollapseCaret({ collapsed }: { collapsed: boolean }) {
  return (
    <ChevronDown
      className="h-3.5 w-3.5 shrink-0 transition-transform"
      aria-hidden
      style={{ color: "var(--fg-4)", transform: collapsed ? "rotate(-90deg)" : "none" }}
    />
  );
}

/** Collapse the multi-column layout below 64rem. matchMedia keeps lint clean. */
function useIsCompact(): boolean {
  const query = "(min-width: 64rem)";
  const [compact, setCompact] = useState(() =>
    typeof window === "undefined" ? false : !window.matchMedia(query).matches,
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia(query);
    const update = () => setCompact(!mq.matches);
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return compact;
}

export type TeamTableProps = {
  publicAgents: AgentRow[];
  privateAgents: AgentRow[];
  humans: HumanRow[];
  isAdmin: boolean;
  /** True while a member views their own all-self Private group → soften Owner. */
  dimPrivateOwner: boolean;
  agentFilter: "all" | "mine";
  onAgentFilter: (next: "all" | "mine") => void;
  agentCount: number;
  /** clientId → hostname; agents on unknown clients show provider alone. */
  clientHostMap: Map<string, string>;
  usageByAgentId: Map<string, UsageByAgentRow> | null;
  usageLoading: boolean;
  onChat: (uuid: string) => void;
  onAgentDetails: (uuid: string) => void;
  getAgentMenuActions: (row: AgentRow) => RowAction[];
  onHumanDetails: (row: HumanRow) => void;
  getHumanMenuActions: (row: HumanRow) => RowAction[];
  /** Personal-assistant candidates for the viewer's own delegate selector. */
  delegateCandidates: Agent[];
  onSetDelegate: (humanAgentId: string, delegateUuid: string | null) => void;
  /** Empty-state copy when search filters everything out. */
  searchActive: boolean;
};

export function TeamTable(props: TeamTableProps) {
  const compact = useIsCompact();
  return (
    <div>
      <AgentSection {...props} compact={compact} />
      <HumanSection {...props} compact={compact} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Agent teammates
// ─────────────────────────────────────────────────────────────────────────

function AgentSection(props: TeamTableProps & { compact: boolean }) {
  const { publicAgents, privateAgents, agentFilter, onAgentFilter, agentCount, compact } = props;
  const [collapsed, toggle] = useCollapsed("team.collapse.agents");
  return (
    <section>
      {/* Section header is now collapsible, matching Human teammates: a caret at
          the left edge (x0) + a clickable title that toggles the whole section.
          The All/Mine filter keeps its place at the right of this row — it is a
          sibling of the toggle button (not nested in it) and the toggle button
          flex-grows to fill the rest of the row, so most of the row collapses
          while the filter stays put and still works. */}
      <div className="flex items-center justify-between" style={{ paddingRight: "var(--sp-1)" }}>
        <button
          type="button"
          onClick={toggle}
          aria-expanded={!collapsed}
          className="flex flex-1 items-center text-left transition-colors hover:bg-[var(--bg-hover)]"
          style={{
            gap: "var(--sp-2)",
            padding: "var(--sp-5) var(--sp-1) var(--sp-3)",
            border: 0,
            background: "transparent",
            cursor: "pointer",
            borderRadius: "var(--radius-input)",
          }}
        >
          <CollapseCaret collapsed={collapsed} />
          <Bot className="h-4 w-4" aria-hidden style={{ color: "var(--fg-3)" }} />
          <h2 className="text-title m-0" style={{ color: "var(--fg)" }}>
            Agent teammates
          </h2>
          <span className="text-label" style={{ color: "var(--fg-4)" }}>
            {agentCount}
          </span>
        </button>
        <SegmentedControl
          value={agentFilter}
          onChange={onAgentFilter}
          options={[
            { value: "all", label: "All" },
            { value: "mine", label: "Mine" },
          ]}
        />
      </div>

      {collapsed ? null : (
        <div style={{ paddingLeft: SECTION_BODY_INDENT }}>
          {compact ? null : <AgentColumnHeader />}

          <AgentGroup
            icon={Bot}
            title="Public"
            rows={publicAgents}
            dimOwner={false}
            collapseKey="team.collapse.agents.public"
            {...props}
          />
          <AgentGroup
            icon={Lock}
            title="Private"
            rows={privateAgents}
            dimOwner={props.dimPrivateOwner}
            collapseKey="team.collapse.agents.private"
            {...props}
          />
        </div>
      )}
    </section>
  );
}

// Usage aggregation window is fixed at 7 days — the header is a plain
// "Usage" label with no picker. Compact viewport omits the header row
// entirely (the row's value still renders, just no column legend), which
// matches the prior behavior where the compact UsageWindowBar was the only
// place the window choice surfaced.
function AgentColumnHeader() {
  return (
    <div
      className="grid items-center"
      style={{
        gridTemplateColumns: ROW_GRID,
        gap: ROW_GAP,
        padding: "var(--sp-1_5) var(--sp-2)",
        borderBottom: "var(--hairline) solid var(--border-faint)",
      }}
    >
      <HeaderLabel>Name</HeaderLabel>
      <div className="grid items-center" style={{ gridTemplateColumns: AGENT_MIDDLE_GRID, gap: "var(--sp-4)" }}>
        <HeaderLabel>Owner</HeaderLabel>
        <HeaderLabel>Runs on</HeaderLabel>
        {/* Right-aligned: Usage is a numeric column, so it reads as one and
            sits clear of the Runs-on column to its left. */}
        <span className="inline-flex items-center" style={{ justifySelf: "end" }}>
          <HeaderLabel>Usage</HeaderLabel>
        </span>
      </div>
      <span className="text-eyebrow" style={{ color: "var(--fg-4)", justifySelf: "end" }}>
        Status
      </span>
      <span />
    </div>
  );
}

function AgentGroup(
  props: TeamTableProps & {
    compact: boolean;
    icon: LucideIcon;
    title: string;
    rows: AgentRow[];
    dimOwner: boolean;
    collapseKey: string;
  },
) {
  const { icon: Icon, title, rows, searchActive, collapseKey } = props;
  const [collapsed, toggle] = useCollapsed(collapseKey);
  return (
    <div>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={!collapsed}
        className="flex w-full items-center text-left transition-colors hover:bg-[var(--bg-hover)]"
        style={{
          gap: "var(--sp-2)",
          padding: "var(--sp-3_5) var(--sp-2) var(--sp-1_5)",
          border: 0,
          background: "transparent",
          cursor: "pointer",
        }}
      >
        <CollapseCaret collapsed={collapsed} />
        <Icon className="h-3.5 w-3.5" aria-hidden style={{ color: "var(--fg-4)" }} />
        <span className="text-eyebrow" style={{ color: "var(--fg-4)" }}>
          {title}
        </span>
        <DenseBadge tone="outline">{rows.length}</DenseBadge>
      </button>
      {collapsed ? null : rows.length === 0 ? (
        <div className="text-caption" style={{ color: "var(--fg-4)", padding: "0 var(--sp-2) var(--sp-3)" }}>
          {searchActive ? "No agents match this search." : "No agents here."}
        </div>
      ) : (
        rows.map((row) => <AgentRowView key={row.agent.uuid} row={row} {...props} />)
      )}
    </div>
  );
}

function AgentRowView(props: TeamTableProps & { compact: boolean; row: AgentRow; dimOwner: boolean }) {
  const {
    row,
    dimOwner,
    compact,
    clientHostMap,
    usageByAgentId,
    usageLoading,
    onChat,
    onAgentDetails,
    getAgentMenuActions,
  } = props;
  const { agent, managerLabel, isOwnedBySelf } = row;
  const clientHost = agent.clientId ? (clientHostMap.get(agent.clientId) ?? null) : null;
  const usage = usageByAgentId ? (usageByAgentId.get(agent.uuid) ?? null) : null;
  // Row-click opens Details, so "Details" leaves the menu; the kebab holds the
  // remaining actions (Chat, plus owner/admin Suspend/Delete).
  const open = () => onAgentDetails(agent.uuid);
  const kebabActions: RowAction[] = [
    { key: "chat", label: "Chat", onSelect: () => onChat(agent.uuid) },
    ...getAgentMenuActions(row),
  ];

  if (compact) {
    return (
      <CompactRow
        displayName={agent.displayName}
        handle={agent.name}
        handleTone="brand"
        avatarUrl={agent.avatarImageUrl}
        seed={agent.uuid}
        colorToken={agent.avatarColorToken}
        meta={agentMetaLine(managerLabel, isOwnedBySelf, agent.runtimeProvider, usage)}
        status={runtimeStateToPresence(agent.runtimeState)}
        actions={kebabActions}
        onOpen={open}
      />
    );
  }

  return (
    <div
      {...rowOpenProps(open, `Open ${agent.displayName}`)}
      className="group grid items-center transition-colors hover:bg-[var(--bg-hover)]"
      style={{
        gridTemplateColumns: ROW_GRID,
        gap: ROW_GAP,
        padding: "var(--sp-2) var(--sp-2)",
        borderBottom: "var(--hairline) solid var(--border-faint)",
        cursor: "pointer",
      }}
    >
      <NameCell
        displayName={agent.displayName}
        handle={agent.name}
        avatarUrl={agent.avatarImageUrl}
        seed={agent.uuid}
        colorToken={agent.avatarColorToken}
        hasTaglineSlot={false}
      />
      <div className="grid items-center min-w-0" style={{ gridTemplateColumns: AGENT_MIDDLE_GRID, gap: "var(--sp-4)" }}>
        <OwnerCell managerLabel={managerLabel} isSelf={isOwnedBySelf} dim={dimOwner} />
        <RunsOnCell provider={agent.runtimeProvider} host={clientHost} />
        <UsageCell usage={usage} loading={usageLoading} />
      </div>
      <StatusCell status={runtimeStateToPresence(agent.runtimeState)} lastSeenAt={agent.lastSeenAt} />
      <ActionsCell ariaLabel={`Actions for ${agent.displayName}`} menuActions={kebabActions} />
    </div>
  );
}

function OwnerCell({ managerLabel, isSelf, dim }: { managerLabel: string | null; isSelf: boolean; dim: boolean }) {
  if (!managerLabel) {
    return (
      <span className="text-label" style={{ color: "var(--fg-4)" }}>
        —
      </span>
    );
  }
  // Name only — the Owner chip intentionally drops the avatar (the leftmost
  // Name column keeps its avatar). Keeps the middle band lean.
  return (
    <div className="flex items-center min-w-0" style={{ opacity: dim ? 0.5 : 1 }}>
      {isSelf ? (
        <span className="text-body font-semibold truncate" style={{ color: "var(--fg)" }}>
          You
        </span>
      ) : (
        <span className="text-body truncate" style={{ color: "var(--fg-2)" }} title={managerLabel}>
          {managerLabel}
        </span>
      )}
    </div>
  );
}

function RunsOnCell({ provider, host }: { provider: string; host: string | null }) {
  return (
    <span
      className="mono text-caption truncate"
      style={{ color: "var(--fg-3)" }}
      title={host ? `${provider} @ ${host}` : provider}
    >
      {provider}
    </span>
  );
}

// Right-aligned numeric cell (textAlign on the block grid item pushes the
// value to the right of its track, clear of the Runs-on column on its left).
function UsageCell({ usage, loading }: { usage: UsageByAgentRow | null; loading: boolean }) {
  if (loading && !usage) {
    return (
      <div className="text-caption mono" style={{ color: "var(--fg-4)", textAlign: "right" }}>
        …
      </div>
    );
  }
  if (!usage || usage.turns === 0) {
    return (
      <div className="text-caption mono" style={{ color: "var(--fg-4)", textAlign: "right" }}>
        —
      </div>
    );
  }
  const totalTokens = usage.inputTokens + usage.cachedInputTokens + usage.outputTokens;
  return (
    <div
      className="text-caption mono truncate"
      style={{ color: "var(--fg-2)", textAlign: "right" }}
      title={`Input ${usage.inputTokens.toLocaleString()} · Cached ${usage.cachedInputTokens.toLocaleString()} · Output ${usage.outputTokens.toLocaleString()} · ${usage.turns} turns`}
    >
      {formatCompactCount(totalTokens)}
      <span style={{ color: "var(--fg-4)" }}>{` · ${usage.turns} turn${usage.turns === 1 ? "" : "s"}`}</span>
    </div>
  );
}

// Right-aligned within its track so it forms a tidy right-hand cluster with
// the (also right-aligned) Usage column, clear of the columns on the left.
// `lastSeenAt` (from agent_presence) surfaces an "active X ago" hover — free
// signal, no extra storage.
function StatusCell({ status, lastSeenAt }: { status: PresenceStatus; lastSeenAt?: string | null }) {
  const title = lastSeenAt ? `Active ${formatRelative(lastSeenAt)}` : undefined;
  return (
    <div style={{ justifySelf: "end" }} title={title}>
      <PresenceChip status={status} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Human teammates
// ─────────────────────────────────────────────────────────────────────────

function HumanSection(props: TeamTableProps & { compact: boolean }) {
  const { humans, compact, searchActive } = props;
  const [collapsed, toggle] = useCollapsed("team.collapse.humans");
  return (
    <section style={{ marginTop: "var(--sp-6)" }}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={!collapsed}
        className="flex w-full items-center text-left transition-colors hover:bg-[var(--bg-hover)]"
        style={{
          gap: "var(--sp-2)",
          padding: "var(--sp-5) var(--sp-1) var(--sp-3)",
          border: 0,
          background: "transparent",
          cursor: "pointer",
        }}
      >
        <CollapseCaret collapsed={collapsed} />
        <User className="h-4 w-4" aria-hidden style={{ color: "var(--fg-3)" }} />
        <h2 className="text-title m-0" style={{ color: "var(--fg)" }}>
          Human teammates
        </h2>
        <span className="text-label" style={{ color: "var(--fg-4)" }}>
          {humans.length}
        </span>
      </button>

      {collapsed ? null : (
        // Same body indent (x1) as the Agent section so Human member Name lines
        // up with Agent member Name on one column.
        <div style={{ paddingLeft: SECTION_BODY_INDENT }}>
          {compact ? null : <HumanColumnHeader />}
          {humans.length === 0 ? (
            <div className="text-caption" style={{ color: "var(--fg-4)", padding: "0 var(--sp-2) var(--sp-3)" }}>
              {searchActive ? "No humans match this search." : "No members yet."}
            </div>
          ) : (
            humans.map((row) => <HumanRowView key={row.id} row={row} {...props} />)
          )}
        </div>
      )}
    </section>
  );
}

function HumanColumnHeader() {
  return (
    <div
      className="grid items-center"
      style={{
        gridTemplateColumns: ROW_GRID,
        gap: ROW_GAP,
        padding: "var(--sp-1_5) var(--sp-2)",
        borderBottom: "var(--hairline) solid var(--border-faint)",
      }}
    >
      <HeaderLabel>Name</HeaderLabel>
      <HeaderLabel>Delegate</HeaderLabel>
      <span className="text-eyebrow" style={{ color: "var(--fg-4)", justifySelf: "end" }}>
        Last active
      </span>
      <span />
    </div>
  );
}

function HumanRowView(props: TeamTableProps & { compact: boolean; row: HumanRow }) {
  const { row, compact, onHumanDetails, getHumanMenuActions, delegateCandidates, onSetDelegate } = props;
  const menuActions = getHumanMenuActions(row);
  const lastActive = row.lastActiveLabel ?? "—";
  // Row-click opens the profile dialog (Details); the kebab holds the rest
  // (admin "Remove from org"). Non-admins get no kebab.
  const open = () => onHumanDetails(row);

  if (compact) {
    const delegateText = row.delegate ? `Delegate: ${row.delegate.displayName}` : "No delegate";
    // Self keeps the interactive delegate selector even on narrow screens
    // (otherwise there'd be no entry to set/change it — the kebab is empty
    // for self). Others get plain meta text.
    const meta = row.canEditDelegate ? (
      <span className="inline-flex items-center min-w-0" style={{ gap: "var(--sp-1)" }}>
        <DelegateCell row={row} candidates={delegateCandidates} onSetDelegate={onSetDelegate} />
        <span style={{ color: "var(--fg-4)" }}>· {lastActive}</span>
      </span>
    ) : (
      `${delegateText} · ${lastActive}`
    );
    return (
      <CompactRow
        displayName={row.displayName}
        handle={row.username}
        handleTone="neutral"
        avatarUrl={null}
        seed={row.id}
        selfTag={row.isSelf}
        adminBadge={row.role === "admin"}
        meta={meta}
        actions={menuActions}
        onOpen={open}
      />
    );
  }

  return (
    <div
      {...rowOpenProps(open, `Open ${row.displayName}`)}
      className="group grid items-center transition-colors hover:bg-[var(--bg-hover)]"
      style={{
        gridTemplateColumns: ROW_GRID,
        gap: ROW_GAP,
        padding: "var(--sp-2) var(--sp-2)",
        borderBottom: "var(--hairline) solid var(--border-faint)",
        cursor: "pointer",
      }}
    >
      <NameCell
        displayName={row.displayName}
        handle={row.username}
        handleTone="neutral"
        avatarUrl={null}
        seed={row.id}
        selfTag={row.isSelf}
        adminBadge={row.role === "admin"}
        hasTaglineSlot={false}
      />
      <DelegateCell row={row} candidates={delegateCandidates} onSetDelegate={onSetDelegate} />
      <span
        className="text-caption"
        style={{ color: row.lastActiveLabel ? "var(--fg-3)" : "var(--fg-4)", justifySelf: "end" }}
      >
        {lastActive}
      </span>
      <ActionsCell ariaLabel={`Actions for ${row.displayName}`} menuActions={menuActions} />
    </div>
  );
}

function DelegateCell({
  row,
  candidates,
  onSetDelegate,
}: {
  row: HumanRow;
  candidates: Agent[];
  onSetDelegate: (humanAgentId: string, delegateUuid: string | null) => void;
}) {
  // Editable only for the viewer's own row (per spec — admins cannot set
  // delegates for others). The popover is portal-rendered (no clipping) and
  // its candidate list is the viewer's own agents — this is the issue 669 fix.
  if (row.canEditDelegate) {
    return (
      <Popover
        align="start"
        panelStyle={{ minWidth: "var(--sp-75)" }}
        trigger={({ open, toggle }) => (
          <button
            type="button"
            onClick={(e) => {
              // Don't let the row's open-details click fire when editing delegate.
              e.stopPropagation();
              toggle();
            }}
            aria-haspopup="menu"
            aria-expanded={open}
            className="inline-flex items-center min-w-0 transition-colors hover:bg-[var(--bg-hover)]"
            style={{
              gap: "var(--sp-1)",
              padding: "var(--sp-0_5) var(--sp-1_5)",
              marginLeft: "calc(-1 * var(--sp-1_5))",
              borderRadius: "var(--radius-chip)",
              border: 0,
              background: open ? "var(--bg-hover)" : "transparent",
              cursor: "pointer",
              maxWidth: "100%",
            }}
            title={row.delegate ? "Change delegate" : "Set delegate"}
          >
            {row.delegate ? (
              <DelegateChip delegate={row.delegate} />
            ) : (
              <span className="text-caption" style={{ color: "var(--primary)" }}>
                Set delegate
              </span>
            )}
            <ChevronDown className="h-3 w-3 shrink-0" aria-hidden style={{ color: "var(--fg-4)" }} />
          </button>
        )}
      >
        {({ close }) => (
          <DelegateSelector
            current={row.delegate?.uuid ?? null}
            candidates={candidates}
            onPick={(uuid) => {
              onSetDelegate(row.agentId, uuid);
              close();
            }}
          />
        )}
      </Popover>
    );
  }

  if (!row.delegate) {
    return (
      <span className="text-caption" style={{ color: "var(--fg-4)", paddingLeft: "var(--sp-0_5)" }}>
        —
      </span>
    );
  }
  return <DelegateChip delegate={row.delegate} />;
}

function DelegateChip({ delegate }: { delegate: { uuid: string; name: string | null; displayName: string } }) {
  // Name only — the Delegate chip drops the avatar (parallels the Owner chip).
  return (
    <span className="inline-flex items-center min-w-0">
      <span className="text-body truncate" style={{ color: "var(--fg-2)" }} title={delegate.displayName}>
        {delegate.displayName}
      </span>
    </span>
  );
}

function DelegateSelector({
  current,
  candidates,
  onPick,
}: {
  current: string | null;
  candidates: Agent[];
  onPick: (uuid: string | null) => void;
}) {
  return (
    <div style={{ padding: "var(--sp-1)", maxHeight: "var(--sp-60)", overflowY: "auto" }}>
      <DelegateOption
        active={current === null}
        onClick={() => onPick(null)}
        primary={<span style={{ color: "var(--fg-3)" }}>None</span>}
      />
      {candidates.length === 0 ? (
        <div className="text-caption" style={{ color: "var(--fg-4)", padding: "var(--sp-1_5) var(--sp-2)" }}>
          No personal assistants yet.
        </div>
      ) : (
        candidates.map((agent) => (
          <DelegateOption
            key={agent.uuid}
            active={current === agent.uuid}
            onClick={() => onPick(agent.uuid)}
            primary={
              <span className="inline-flex items-center" style={{ gap: "var(--sp-2)" }}>
                <Avatar
                  name={agent.displayName}
                  seed={agent.uuid}
                  size={20}
                  colorToken={agent.avatarColorToken}
                  src={agent.avatarImageUrl}
                />
                <span className="inline-flex flex-col leading-tight">
                  <span className="text-body" style={{ color: "var(--fg)" }}>
                    {agent.displayName}
                  </span>
                  {agent.name && (
                    <span className="mono text-caption" style={{ color: "var(--fg-3)" }}>
                      @{agent.name}
                    </span>
                  )}
                </span>
              </span>
            }
          />
        ))
      )}
    </div>
  );
}

function DelegateOption({ active, onClick, primary }: { active: boolean; onClick: () => void; primary: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center text-left transition-colors hover:bg-[var(--bg-hover)]"
      style={{
        gap: "var(--sp-2)",
        padding: "var(--sp-1_5) var(--sp-2)",
        borderRadius: "var(--radius-chip)",
        border: 0,
        background: active ? "var(--bg-active)" : "transparent",
        cursor: "pointer",
      }}
    >
      {primary}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Shared cells
// ─────────────────────────────────────────────────────────────────────────

function NameCell({
  displayName,
  handle,
  handleTone = "brand",
  avatarUrl,
  colorToken,
  seed,
  selfTag,
  adminBadge,
  hasTaglineSlot,
  metaLine,
}: {
  displayName: string;
  handle: string | null;
  handleTone?: "brand" | "neutral";
  avatarUrl: string | null;
  colorToken?: string | null;
  seed: string;
  selfTag?: boolean;
  adminBadge?: boolean;
  /** Reserved for the Phase-2 tagline subline; false today (no tagline field). */
  hasTaglineSlot?: boolean;
  metaLine?: ReactNode;
}) {
  return (
    <div className="flex items-center min-w-0" style={{ gap: "var(--sp-2_5)" }}>
      <Avatar name={displayName} src={avatarUrl} colorToken={colorToken} seed={seed} size={30} />
      <div className="min-w-0">
        <div className="flex items-baseline min-w-0" style={{ gap: "var(--sp-1_5)" }}>
          <span className="text-subtitle truncate" style={{ color: "var(--fg)" }} title={displayName}>
            {displayName}
          </span>
          {handle && (
            <span
              className="mono text-caption shrink-0"
              style={{ color: handleTone === "brand" ? "var(--brand)" : "var(--fg-4)" }}
            >
              @{handle}
            </span>
          )}
          {selfTag && (
            <span className="text-label italic shrink-0" style={{ color: "var(--fg-3)" }}>
              you
            </span>
          )}
          {adminBadge && (
            <DenseBadge tone="neutral" className="shrink-0">
              Admin
            </DenseBadge>
          )}
        </div>
        {/* hasTaglineSlot is wired for Phase 2 (tagline field); unused today. */}
        {hasTaglineSlot ? <div className="text-caption truncate" style={{ color: "var(--fg-3)" }} /> : null}
        {metaLine && (
          <div className="text-caption truncate" style={{ color: "var(--fg-4)", marginTop: "var(--sp-0_5)" }}>
            {metaLine}
          </div>
        )}
      </div>
    </div>
  );
}

function CompactRow({
  displayName,
  handle,
  handleTone,
  avatarUrl,
  colorToken,
  seed,
  meta,
  status,
  actions,
  selfTag,
  adminBadge,
  onOpen,
}: {
  displayName: string;
  handle: string | null;
  handleTone?: "brand" | "neutral";
  avatarUrl: string | null;
  colorToken?: string | null;
  seed: string;
  meta: ReactNode;
  status?: PresenceStatus | null;
  actions: RowAction[];
  selfTag?: boolean;
  adminBadge?: boolean;
  onOpen: () => void;
}) {
  return (
    <div
      {...rowOpenProps(onOpen, `Open ${displayName}`)}
      className="grid items-start"
      style={{
        gridTemplateColumns: COMPACT_GRID,
        gap: "var(--sp-2)",
        padding: "var(--sp-2_5) var(--sp-2)",
        borderBottom: "var(--hairline) solid var(--border-faint)",
        cursor: "pointer",
      }}
    >
      <NameCell
        displayName={displayName}
        handle={handle}
        handleTone={handleTone}
        avatarUrl={avatarUrl}
        colorToken={colorToken}
        seed={seed}
        selfTag={selfTag}
        adminBadge={adminBadge}
        metaLine={meta}
      />
      <span>{status != null ? <PresenceChip status={status} /> : null}</span>
      <RowActionsMenu actions={actions} ariaLabel={`Actions for ${displayName}`} />
    </div>
  );
}

// Always-visible right-aligned kebab (no hover-reveal). The trigger + menu
// items stopPropagation (in RowActionsMenu) so they don't fire the row's
// open-details click. Returns null when there are no actions.
function ActionsCell({ ariaLabel, menuActions }: { ariaLabel: string; menuActions: RowAction[] }) {
  return (
    <div className="flex items-center justify-end">
      <RowActionsMenu actions={menuActions} ariaLabel={ariaLabel} />
    </div>
  );
}

function HeaderLabel({ children }: { children: ReactNode }) {
  return (
    <span className="text-eyebrow" style={{ color: "var(--fg-4)" }}>
      {children}
    </span>
  );
}

/** Compact folded meta for an agent: Owner · provider · usage. */
function agentMetaLine(
  managerLabel: string | null,
  isSelf: boolean,
  provider: string,
  usage: UsageByAgentRow | null,
): string {
  const owner = isSelf ? "You" : (managerLabel ?? "—");
  const usageStr =
    usage && usage.turns > 0
      ? `${formatCompactCount(usage.inputTokens + usage.cachedInputTokens + usage.outputTokens)} · ${usage.turns} turn${usage.turns === 1 ? "" : "s"}`
      : "—";
  return `${owner} · ${provider} · ${usageStr}`;
}
