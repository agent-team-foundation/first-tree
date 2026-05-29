import type { PresenceStatus } from "@first-tree/shared";
import { Bot, ChevronDown, Link2, Lock, Plus, Search, User } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Avatar } from "../components/avatar.js";
import { FirstTreeLogo } from "../components/first-tree-logo.js";
import { Button } from "../components/ui/button.js";
import { DenseBadge } from "../components/ui/dense-badge.js";
import { Input } from "../components/ui/input.js";
import { Popover } from "../components/ui/popover.js";
import { PresenceChip } from "../components/ui/presence-chip.js";
import { type RowAction, RowActionsMenu } from "../components/ui/row-actions-menu.js";
import { SegmentedControl } from "../components/ui/segmented-control.js";
import { formatCompactCount } from "../lib/utils.js";
import {
  ME_ID,
  MEMBERS,
  myDelegateCandidates,
  PREVIEW_AGENTS,
  PREVIEW_HUMANS,
  type PreviewAgent,
  type PreviewHuman,
  type PreviewUsage,
} from "./team-preview-mock.js";

/**
 * DEV-only visual prototype of the redesigned Team page, mounted at
 * `/preview/team` (gated by `import.meta.env.DEV` in app.tsx). Implements the
 * layout agreed in `drafts/team-teammates-redesign.md`:
 *
 *   - Two stacked sections — Agent teammates (Public / Private groups) FIRST,
 *     Human teammates SECOND.
 *   - Cross-module alignment (§3, highest priority): both sections share ONE
 *     row grid — Name left-anchored same width, the activity column (agent
 *     Status / human Last active) in the same slot, Actions right-anchored
 *     same width. The middle band differs per section and is free.
 *   - Real DESIGN.md tokens + components throughout. NO backend — tagline,
 *     last-active, custom avatar, and self-edit permissions are mocked.
 *
 * A floating control lets reviewers flip "Viewing as Admin / Member" (to see
 * the permission-gated rendering) and toggle light / dark — the two button
 * modes the spec calls out for the New agent (cta) / Invite link (outline)
 * pair.
 */

type ViewerRole = "admin" | "member";
type AgentFilter = "all" | "mine";
type UsageWindow = "7d" | "30d";

// ── Shared row geometry (the cross-module alignment contract, §3) ──────────
// One template for BOTH sections so Name (left), the activity column, and
// Actions (right) line up across the Agent and Human bands. The middle track
// is filled differently by each section (agent: Owner·Runs on·Usage; human:
// Delegate) but its start/end x stays put, so the eye reads two bands of one
// roster. Track sizes use --sp tokens / calc so no raw px slips past lint.
const ROW_GRID =
  "minmax(var(--sp-60), 1.6fr) minmax(0, 2.2fr) calc(var(--sp-20) + var(--sp-8)) calc(var(--sp-20) + var(--sp-16))";
// Gap between the four top-level tracks. Wider than the inner sub-grid gap so
// the Usage→Status seam and the right edge breathe (keeps far-right less bare).
const ROW_GAP = "var(--sp-5)";
// Agent middle band sub-grid: Owner | Runs on | Usage. Header + rows share it.
const AGENT_MIDDLE_GRID = "minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 1fr)";
// Compact (tablet / mobile) grid: the multi-column body can't fit, so rows
// collapse to Name | Status | Actions and fold Owner/Runs-on/Usage (agents) or
// Delegate/Last-active (humans) into the name cell's meta subline — mirrors the
// production team table's narrow mode.
const COMPACT_GRID = "minmax(0, 1fr) auto auto";

/**
 * Collapse the rich multi-column layout below 64rem (~1024 CSS px). Above that the
 * Owner/Runs-on/Usage columns have room; below it they'd truncate to noise, so
 * we fold them into the name cell instead. matchMedia (not raw px) keeps the
 * design-token guardrail clean.
 */
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

export function TeamPreviewPage() {
  const [viewerRole, setViewerRole] = useState<ViewerRole>("member");
  const [query, setQuery] = useState("");
  const [agentFilter, setAgentFilter] = useState<AgentFilter>("all");
  const [usageWindow, setUsageWindow] = useState<UsageWindow>("30d");
  // Only the signed-in viewer can edit their own delegate — backed by local
  // state so the selector popover is interactive in the preview.
  const [myDelegateUuid, setMyDelegateUuid] = useState<string | null>("a-scout");
  const compact = useIsCompact();

  return (
    <div className="flex flex-col overflow-hidden" style={{ height: "100vh", background: "var(--bg)" }}>
      <PreviewHeader compact={compact} />
      <main className="flex-1 overflow-auto">
        <div className="p-6 mx-auto" style={{ maxWidth: 1280 }}>
          <PageHeaderBar viewerRole={viewerRole} query={query} onQuery={setQuery} compact={compact} />
          <AgentSection
            viewerRole={viewerRole}
            query={query}
            filter={agentFilter}
            onFilter={setAgentFilter}
            usageWindow={usageWindow}
            onUsageWindow={setUsageWindow}
            compact={compact}
          />
          <HumanSection
            viewerRole={viewerRole}
            query={query}
            myDelegateUuid={myDelegateUuid}
            onSetDelegate={setMyDelegateUuid}
            compact={compact}
          />
        </div>
      </main>
      <PreviewControls viewerRole={viewerRole} onViewerRole={setViewerRole} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Page chrome
// ─────────────────────────────────────────────────────────────────────────

function PageHeaderBar({
  viewerRole,
  query,
  onQuery,
  compact,
}: {
  viewerRole: ViewerRole;
  query: string;
  onQuery: (next: string) => void;
  compact: boolean;
}) {
  return (
    <div
      className={compact ? "flex flex-col" : "flex items-end justify-between"}
      style={{ gap: compact ? "var(--sp-3)" : "var(--sp-4)", marginBottom: "var(--sp-2)" }}
    >
      <div className="min-w-0">
        <h1 className="text-title m-0" style={{ color: "var(--fg)" }}>
          Team
        </h1>
        <p className="text-caption m-0" style={{ color: "var(--fg-3)", marginTop: "var(--sp-0_5)" }}>
          Preview · mock data — Agent & Human teammates redesign
        </p>
      </div>
      <div className={compact ? "flex items-center" : "flex items-center shrink-0"} style={{ gap: "var(--sp-2)" }}>
        <div className={compact ? "relative inline-flex items-center flex-1" : "relative inline-flex items-center"}>
          <Search
            className="h-3.5 w-3.5 pointer-events-none absolute"
            aria-hidden
            style={{ left: "var(--sp-2)", color: "var(--fg-4)" }}
          />
          <Input
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder="Search name or @handle"
            className="text-body"
            style={{ width: compact ? "100%" : "var(--sp-60)", paddingLeft: "var(--sp-7)" }}
          />
        </div>
        {/* Green `cta` is reserved for the single hero/creation action per surface. */}
        <Button variant="cta" size="sm">
          <Plus className="h-3.5 w-3.5" aria-hidden />
          New agent
        </Button>
        {/* Invite link is a secondary, admin-only action — neutral `outline`, never green. */}
        {viewerRole === "admin" && (
          <Button variant="outline" size="sm">
            <Link2 className="h-3.5 w-3.5" aria-hidden />
            Invite link
          </Button>
        )}
      </div>
    </div>
  );
}

function PreviewHeader({ compact }: { compact: boolean }) {
  const tabs = [
    { label: "Workspace", active: false },
    { label: "Context", active: false },
    { label: "Team", active: true },
    { label: "Settings", active: false },
  ];
  return (
    <header
      className="relative shrink-0 grid items-center"
      style={{
        height: "var(--sp-12)",
        gridTemplateColumns: "1fr auto 1fr",
        gap: "var(--sp-3)",
        padding: "0 var(--sp-3)",
        borderBottom: "var(--hairline) solid var(--border)",
        background: "var(--bg-raised)",
      }}
    >
      <div className="flex items-center" style={{ gap: "var(--sp-3_5)", justifySelf: "start", minWidth: 0 }}>
        <span className="flex items-center" style={{ gap: "var(--sp-2_5)", flexShrink: 0 }}>
          <FirstTreeLogo width={16} height={18} style={{ color: "var(--fg)" }} />
          <span className="text-title" style={{ color: "var(--fg)" }}>
            First Tree
          </span>
        </span>
      </div>
      {/* Tabs would collide with the brand on a phone — drop them when compact
          (the real top bar does the same below its narrow breakpoint). */}
      <nav className="flex" style={{ gap: "var(--sp-0_5)", justifySelf: "center" }}>
        {(compact ? [] : tabs).map((tab) => (
          <span
            key={tab.label}
            className="inline-flex items-center text-subtitle"
            style={{
              padding: "var(--sp-1_5) var(--sp-3)",
              gap: "var(--sp-1_5)",
              borderRadius: "var(--radius-input)",
              color: tab.active ? "var(--fg)" : "var(--fg-3)",
              background: tab.active ? "var(--bg-hover)" : "transparent",
            }}
          >
            {tab.label}
          </span>
        ))}
      </nav>
      <div style={{ justifySelf: "end" }} />
    </header>
  );
}

/** Floating dev control: switch viewer role + theme to exercise every variant. */
function PreviewControls({
  viewerRole,
  onViewerRole,
}: {
  viewerRole: ViewerRole;
  onViewerRole: (next: ViewerRole) => void;
}) {
  return (
    <div
      className="fixed flex items-center"
      style={{
        bottom: "var(--sp-4)",
        // Anchored bottom-LEFT so it never collides with the app's global
        // feedback bubble (bottom-right).
        left: "var(--sp-4)",
        gap: "var(--sp-3)",
        padding: "var(--sp-1_5) var(--sp-2_5)",
        background: "var(--bg-raised)",
        border: "var(--hairline) solid var(--border)",
        borderRadius: "var(--radius-panel)",
        boxShadow: "var(--shadow-md)",
      }}
    >
      <span className="inline-flex items-center" style={{ gap: "var(--sp-1_5)" }}>
        <span className="text-label mono" style={{ color: "var(--fg-3)" }}>
          viewing as
        </span>
        <SegmentedControl
          value={viewerRole}
          onChange={onViewerRole}
          options={[
            { value: "admin", label: "Admin" },
            { value: "member", label: "Member" },
          ]}
        />
      </span>
      <span style={{ width: "var(--hairline)", height: "var(--sp-4)", background: "var(--border)" }} />
      <button
        type="button"
        className="text-caption mono"
        onClick={() => {
          document.documentElement.classList.toggle("dark");
        }}
        style={{
          padding: "var(--sp-1) var(--sp-2)",
          border: "var(--hairline) solid var(--border)",
          borderRadius: "var(--radius-input)",
          background: "var(--bg-hover)",
          color: "var(--fg-2)",
          cursor: "pointer",
        }}
      >
        theme
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Agent teammates section
// ─────────────────────────────────────────────────────────────────────────

function AgentSection({
  viewerRole,
  query,
  filter,
  onFilter,
  usageWindow,
  onUsageWindow,
  compact,
}: {
  viewerRole: ViewerRole;
  query: string;
  filter: AgentFilter;
  onFilter: (next: AgentFilter) => void;
  usageWindow: UsageWindow;
  onUsageWindow: (next: UsageWindow) => void;
  compact: boolean;
}) {
  const q = query.trim().toLowerCase();
  const visible = PREVIEW_AGENTS.filter((a) => {
    // Members only see their own private agents; admins see all private ones.
    if (a.visibility === "private" && viewerRole !== "admin" && a.managerId !== ME_ID) return false;
    if (filter === "mine" && a.managerId !== ME_ID) return false;
    if (q && !agentMatches(a, q)) return false;
    return true;
  });
  const total = visible.length;
  const publicAgents = sortAgents(visible.filter((a) => a.visibility === "organization"));
  const privateAgents = sortAgents(visible.filter((a) => a.visibility === "private"));
  // Members' private group is all-self → owner column adds no signal, so it's
  // visually softened (kept for layout consistency, never removed).
  const dimPrivateOwner = viewerRole === "member";

  return (
    <section style={{ marginTop: "var(--sp-4)" }}>
      <div className="flex items-center justify-between" style={{ padding: "var(--sp-5) var(--sp-1) var(--sp-3)" }}>
        <div className="flex items-center" style={{ gap: "var(--sp-2)" }}>
          <Bot className="h-4 w-4" aria-hidden style={{ color: "var(--fg-3)" }} />
          <h2 className="text-title m-0" style={{ color: "var(--fg)" }}>
            Agent teammates
          </h2>
          <span className="text-label" style={{ color: "var(--fg-4)" }}>
            {total}
          </span>
        </div>
        <SegmentedControl
          value={filter}
          onChange={onFilter}
          options={[
            { value: "all", label: "All" },
            { value: "mine", label: "Mine" },
          ]}
        />
      </div>

      {compact ? <UsageWindowBar usageWindow={usageWindow} onUsageWindow={onUsageWindow} /> : null}
      {compact ? null : <AgentColumnHeader usageWindow={usageWindow} onUsageWindow={onUsageWindow} />}

      <AgentGroup
        icon={Bot}
        title="Public"
        agents={publicAgents}
        usageWindow={usageWindow}
        dimOwner={false}
        compact={compact}
      />
      <AgentGroup
        icon={Lock}
        title="Private"
        agents={privateAgents}
        usageWindow={usageWindow}
        dimOwner={dimPrivateOwner}
        compact={compact}
      />
    </section>
  );
}

function AgentColumnHeader({
  usageWindow,
  onUsageWindow,
}: {
  usageWindow: UsageWindow;
  onUsageWindow: (next: UsageWindow) => void;
}) {
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
        <span className="inline-flex items-center" style={{ gap: "var(--sp-1_5)" }}>
          <HeaderLabel>Usage</HeaderLabel>
          <SegmentedControl
            value={usageWindow}
            onChange={onUsageWindow}
            options={[
              { value: "7d", label: "7d" },
              { value: "30d", label: "30d" },
            ]}
          />
        </span>
      </div>
      <HeaderLabel>Status</HeaderLabel>
      <span />
    </div>
  );
}

/** Compact-only 7d/30d switch — the column header (which normally hosts it) is
 *  hidden on small screens, so the window control surfaces here instead. */
function UsageWindowBar({
  usageWindow,
  onUsageWindow,
}: {
  usageWindow: UsageWindow;
  onUsageWindow: (next: UsageWindow) => void;
}) {
  return (
    <div
      className="flex items-center justify-end"
      style={{ gap: "var(--sp-1_5)", padding: "0 var(--sp-2) var(--sp-1)" }}
    >
      <span className="text-eyebrow" style={{ color: "var(--fg-4)" }}>
        Usage
      </span>
      <SegmentedControl
        value={usageWindow}
        onChange={onUsageWindow}
        options={[
          { value: "7d", label: "7d" },
          { value: "30d", label: "30d" },
        ]}
      />
    </div>
  );
}

function AgentGroup({
  icon: Icon,
  title,
  agents,
  usageWindow,
  dimOwner,
  compact,
}: {
  icon: typeof Bot;
  title: string;
  agents: PreviewAgent[];
  usageWindow: UsageWindow;
  dimOwner: boolean;
  compact: boolean;
}) {
  return (
    <div>
      <div
        className="flex items-center"
        style={{ gap: "var(--sp-2)", padding: "var(--sp-3_5) var(--sp-2) var(--sp-1_5)" }}
      >
        <Icon className="h-3.5 w-3.5" aria-hidden style={{ color: "var(--fg-4)" }} />
        <span className="text-eyebrow" style={{ color: "var(--fg-4)" }}>
          {title}
        </span>
        <DenseBadge tone="outline">{agents.length}</DenseBadge>
      </div>
      {agents.length === 0 ? (
        <div className="text-caption" style={{ color: "var(--fg-4)", padding: "0 var(--sp-2) var(--sp-3)" }}>
          No agents here.
        </div>
      ) : (
        agents.map((agent) => (
          <AgentRow key={agent.uuid} agent={agent} usageWindow={usageWindow} dimOwner={dimOwner} compact={compact} />
        ))
      )}
    </div>
  );
}

function AgentRow({
  agent,
  usageWindow,
  dimOwner,
  compact,
}: {
  agent: PreviewAgent;
  usageWindow: UsageWindow;
  dimOwner: boolean;
  compact: boolean;
}) {
  const isMine = agent.managerId === ME_ID;
  const canManage = isMine; // owner; in the real page admins also qualify
  const usage = usageWindow === "7d" ? agent.usage7d : agent.usage30d;

  // Manage actions (kebab on desktop; also folded into the compact kebab).
  const manageActions: RowAction[] = canManage
    ? [
        {
          key: agent.status === "online" ? "suspend" : "reactivate",
          label: agent.status === "online" ? "Suspend" : "Reactivate",
          onSelect: () => {},
        },
        { key: "delete", label: "Delete", destructive: true, onSelect: () => {} },
      ]
    : [];

  if (compact) {
    // Compact: one kebab carries every action (no hover on touch).
    const actions: RowAction[] = [
      { key: "chat", label: "Chat", onSelect: () => {} },
      { key: "details", label: "Details", onSelect: () => {} },
      ...manageActions,
    ];
    return (
      <CompactRow
        displayName={agent.displayName}
        handle={agent.name}
        handleTone="brand"
        tagline={agent.tagline}
        taglineEditable={canManage}
        hasTaglineSlot
        avatarUrl={agent.avatarUrl}
        seed={agent.uuid}
        meta={agentMetaLine(agent, isMine, usage)}
        status={agent.status}
        lastActiveLabel={agent.lastActiveLabel}
        actions={actions}
      />
    );
  }

  return (
    <div
      className="group grid items-center transition-colors hover:bg-[var(--bg-hover)]"
      style={{
        gridTemplateColumns: ROW_GRID,
        gap: ROW_GAP,
        padding: "var(--sp-2) var(--sp-2)",
        borderBottom: "var(--hairline) solid var(--border-faint)",
      }}
    >
      <NameCell
        displayName={agent.displayName}
        handle={agent.name}
        tagline={agent.tagline}
        avatarUrl={agent.avatarUrl}
        seed={agent.uuid}
        hasTaglineSlot
        taglineEditable={canManage}
      />
      <div className="grid items-center min-w-0" style={{ gridTemplateColumns: AGENT_MIDDLE_GRID, gap: "var(--sp-4)" }}>
        <OwnerCell managerId={agent.managerId} dim={dimOwner} />
        <RunsOnCell provider={agent.runtimeProvider} host={agent.clientHost} />
        <UsageCell usage={usage} />
      </div>
      <StatusCell status={agent.status} lastActiveLabel={agent.lastActiveLabel} />
      <ActionsCell ariaLabel={`Actions for ${agent.displayName}`} menuActions={manageActions}>
        <InlineAction label="Chat" />
        <InlineAction label="Details" />
      </ActionsCell>
    </div>
  );
}

function OwnerCell({ managerId, dim }: { managerId: string; dim: boolean }) {
  const isSelf = managerId === ME_ID;
  const member = MEMBERS[managerId];
  return (
    <div className="flex items-center min-w-0" style={{ gap: "var(--sp-1_5)", opacity: dim ? 0.5 : 1 }}>
      <Avatar name={member?.displayName ?? "?"} src={member?.avatarUrl} seed={managerId} size={18} />
      {isSelf ? (
        <span className="text-body font-semibold truncate" style={{ color: "var(--fg)" }}>
          You
        </span>
      ) : (
        <span className="text-body truncate" style={{ color: "var(--fg-2)" }} title={member?.displayName}>
          {member?.displayName}
        </span>
      )}
    </div>
  );
}

function RunsOnCell({ provider, host }: { provider: string; host: string | null }) {
  // Provider is the primary signal; the host (operational detail) hides in the
  // hover title. When the agent runs on another member's machine and the host
  // can't be resolved, we show provider alone — no fallback host string.
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

function UsageCell({ usage }: { usage: PreviewUsage | null }) {
  if (!usage || usage.turns === 0) {
    return (
      <span className="text-caption mono" style={{ color: "var(--fg-4)" }}>
        —
      </span>
    );
  }
  const totalTokens = usage.inputTokens + usage.cachedInputTokens + usage.outputTokens;
  return (
    <span
      className="text-caption mono truncate"
      style={{ color: "var(--fg-2)" }}
      title={`Input ${usage.inputTokens.toLocaleString()} · Cached ${usage.cachedInputTokens.toLocaleString()} · Output ${usage.outputTokens.toLocaleString()} · ${usage.turns} turns`}
    >
      {formatCompactCount(totalTokens)}
      <span style={{ color: "var(--fg-4)" }}>{` · ${formatCompactCount(usage.turns)}t`}</span>
    </span>
  );
}

function StatusCell({ status, lastActiveLabel }: { status: PresenceStatus; lastActiveLabel: string }) {
  return (
    <span title={lastActiveLabel}>
      <PresenceChip status={status} />
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Human teammates section
// ─────────────────────────────────────────────────────────────────────────

function HumanSection({
  viewerRole,
  query,
  myDelegateUuid,
  onSetDelegate,
  compact,
}: {
  viewerRole: ViewerRole;
  query: string;
  myDelegateUuid: string | null;
  onSetDelegate: (next: string | null) => void;
  compact: boolean;
}) {
  const q = query.trim().toLowerCase();
  const humans = PREVIEW_HUMANS.filter((h) => !q || humanMatches(h, q));

  return (
    <section style={{ marginTop: "var(--sp-6)" }}>
      <div className="flex items-center" style={{ gap: "var(--sp-2)", padding: "var(--sp-5) var(--sp-1) var(--sp-3)" }}>
        <User className="h-4 w-4" aria-hidden style={{ color: "var(--fg-3)" }} />
        <h2 className="text-title m-0" style={{ color: "var(--fg)" }}>
          Human teammates
        </h2>
        <span className="text-label" style={{ color: "var(--fg-4)" }}>
          {humans.length}
        </span>
      </div>

      {compact ? null : <HumanColumnHeader />}

      {humans.map((human) => (
        <HumanRow
          key={human.id}
          human={human}
          viewerRole={viewerRole}
          myDelegateUuid={myDelegateUuid}
          onSetDelegate={onSetDelegate}
          compact={compact}
        />
      ))}
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
      <HeaderLabel>Last active</HeaderLabel>
      <span />
    </div>
  );
}

function HumanRow({
  human,
  viewerRole,
  myDelegateUuid,
  onSetDelegate,
  compact,
}: {
  human: PreviewHuman;
  viewerRole: ViewerRole;
  myDelegateUuid: string | null;
  onSetDelegate: (next: string | null) => void;
  compact: boolean;
}) {
  const isMe = human.id === ME_ID;
  // The viewer's own role is driven by the "Viewing as" toggle.
  const role = isMe ? viewerRole : human.role;

  // Admins can remove others (never themselves).
  const canRemove = viewerRole === "admin" && !isMe;

  const menuActions: RowAction[] = canRemove
    ? [{ key: "remove", label: "Remove from org", destructive: true, onSelect: () => {} }]
    : [];

  if (compact) {
    const delegate = isMe ? resolveAgent(myDelegateUuid) : human.delegate;
    const meta = `${delegate ? `Delegate: ${delegate.displayName}` : "No delegate"} · ${human.lastActiveLabel}`;
    const actions: RowAction[] = [{ key: "details", label: "Details", onSelect: () => {} }, ...menuActions];
    return (
      <CompactRow
        displayName={human.displayName}
        handle={human.username}
        handleTone="neutral"
        avatarUrl={human.avatarUrl}
        seed={human.id}
        selfTag={isMe}
        adminBadge={role === "admin"}
        meta={meta}
        actions={actions}
      />
    );
  }

  return (
    <div
      className="group grid items-center transition-colors hover:bg-[var(--bg-hover)]"
      style={{
        gridTemplateColumns: ROW_GRID,
        gap: ROW_GAP,
        padding: "var(--sp-2) var(--sp-2)",
        borderBottom: "var(--hairline) solid var(--border-faint)",
      }}
    >
      <NameCell
        displayName={human.displayName}
        handle={human.username}
        handleTone="neutral"
        tagline={null}
        avatarUrl={human.avatarUrl}
        seed={human.id}
        selfTag={isMe}
        adminBadge={role === "admin"}
      />
      <DelegateCell human={human} isMe={isMe} myDelegateUuid={myDelegateUuid} onSetDelegate={onSetDelegate} />
      <span className="text-caption" style={{ color: "var(--fg-3)" }}>
        {human.lastActiveLabel}
      </span>
      {/* Unified with the agent row: "Details" opens this teammate's page; edit
          controls live inside, gated by permission (self / admin). */}
      <ActionsCell ariaLabel={`Actions for ${human.displayName}`} menuActions={menuActions}>
        <InlineAction label="Details" />
      </ActionsCell>
    </div>
  );
}

function DelegateCell({
  human,
  isMe,
  myDelegateUuid,
  onSetDelegate,
}: {
  human: PreviewHuman;
  isMe: boolean;
  myDelegateUuid: string | null;
  onSetDelegate: (next: string | null) => void;
}) {
  // For the signed-in viewer, the delegate is editable via the popover
  // selector (the issue 669 fix: filtered candidates, no clipping). For everyone
  // else it's a read-only chip (or em-dash) — admins cannot set it for others.
  const delegate = isMe ? resolveAgent(myDelegateUuid) : human.delegate;

  if (isMe) {
    return (
      <Popover
        align="start"
        panelStyle={{ minWidth: "var(--sp-75)" }}
        trigger={({ open, toggle }) => (
          <button
            type="button"
            onClick={toggle}
            aria-haspopup="menu"
            aria-expanded={open}
            className="inline-flex items-center min-w-0 transition-colors hover:bg-[var(--bg-hover)]"
            style={{
              gap: "var(--sp-1)",
              padding: "var(--sp-0_5) var(--sp-1_5)",
              // Negative left margin cancels the button's left padding so the
              // delegate avatar lines up with the read-only chips below (which
              // have no padding). The button keeps its internal padding for the
              // hover/open pill highlight without shifting content right.
              marginLeft: "calc(-1 * var(--sp-1_5))",
              borderRadius: "var(--radius-chip)",
              border: 0,
              background: open ? "var(--bg-hover)" : "transparent",
              cursor: "pointer",
              maxWidth: "100%",
            }}
            title={delegate ? "Change delegate" : "Set delegate"}
          >
            {delegate ? (
              <DelegateChip delegate={delegate} />
            ) : (
              <span className="text-caption" style={{ color: "var(--primary)" }}>
                Set delegate
              </span>
            )}
            {/* Always-visible caret signals this cell is an editable dropdown
                (only the viewer's own row is editable). */}
            <ChevronDown className="h-3 w-3 shrink-0" aria-hidden style={{ color: "var(--fg-4)" }} />
          </button>
        )}
      >
        {({ close }) => (
          <DelegateSelector
            current={myDelegateUuid}
            onPick={(uuid) => {
              onSetDelegate(uuid);
              close();
            }}
          />
        )}
      </Popover>
    );
  }

  if (!delegate) {
    // Small left nudge so the flat em-dash optically lines up with the rounded
    // delegate avatars above it (a dash flush at the box edge reads as poking
    // out left next to circles, which only touch that edge at one point).
    return (
      <span className="text-caption" style={{ color: "var(--fg-4)", paddingLeft: "var(--sp-0_5)" }}>
        —
      </span>
    );
  }
  return <DelegateChip delegate={delegate} />;
}

function DelegateChip({ delegate }: { delegate: { uuid: string; name: string | null; displayName: string } }) {
  return (
    <span className="inline-flex items-center min-w-0" style={{ gap: "var(--sp-1_5)" }}>
      <Avatar name={delegate.displayName} seed={delegate.uuid} size={18} />
      <span className="text-body truncate" style={{ color: "var(--fg-2)" }} title={delegate.displayName}>
        {delegate.displayName}
      </span>
    </span>
  );
}

/** Delegate picker body — candidates filtered to the viewer's own agents, no
 *  search box (small set), capped height with internal scroll (never clips). */
function DelegateSelector({ current, onPick }: { current: string | null; onPick: (uuid: string | null) => void }) {
  const candidates = myDelegateCandidates();
  return (
    <div style={{ padding: "var(--sp-1)", maxHeight: "var(--sp-60)", overflowY: "auto" }}>
      <DelegateOption
        active={current === null}
        onClick={() => onPick(null)}
        primary={<span style={{ color: "var(--fg-3)" }}>None</span>}
      />
      {candidates.map((agent) => (
        <DelegateOption
          key={agent.uuid}
          active={current === agent.uuid}
          onClick={() => onPick(agent.uuid)}
          primary={
            <span className="inline-flex items-center" style={{ gap: "var(--sp-2)" }}>
              <Avatar name={agent.displayName} seed={agent.uuid} size={20} />
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
      ))}
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
  tagline,
  avatarUrl,
  seed,
  selfTag,
  adminBadge,
  hasTaglineSlot,
  taglineEditable,
  metaLine,
}: {
  displayName: string;
  handle: string | null;
  /** Agents use brand-green @handles (legal @mention color); humans neutral. */
  handleTone?: "brand" | "neutral";
  tagline: string | null;
  avatarUrl: string | null;
  seed: string;
  selfTag?: boolean;
  adminBadge?: boolean;
  /**
   * Agents reserve the tagline subline so row heights stay uniform even when a
   * tagline isn't set yet (it's a new, optional field). Humans don't have a
   * tagline concept, so they omit the slot entirely (single-line name cell).
   */
  hasTaglineSlot?: boolean;
  /** Owner/admin of a tagline-less agent gets a subtle "add one" affordance. */
  taglineEditable?: boolean;
  /**
   * Compact-mode folded line (agent: Owner · Runs on · Usage; human: Delegate ·
   * Last active). Only set on small screens — desktop keeps those as columns.
   */
  metaLine?: ReactNode;
}) {
  return (
    <div className="flex items-center min-w-0" style={{ gap: "var(--sp-2_5)" }}>
      <Avatar name={displayName} src={avatarUrl} seed={seed} size={30} />
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
        {hasTaglineSlot ? (
          <div className="text-caption truncate" style={{ color: "var(--fg-3)" }} title={tagline ?? undefined}>
            {tagline ? (
              tagline
            ) : taglineEditable ? (
              // Dimmer than a real tagline (fg-3) so the empty state never
              // shouts louder than filled rows; still legible as an owner nudge.
              <span className="italic" style={{ color: "var(--fg-4)" }}>
                Add a description
              </span>
            ) : null}
          </div>
        ) : (
          tagline && (
            <div className="text-caption truncate" style={{ color: "var(--fg-3)" }} title={tagline}>
              {tagline}
            </div>
          )
        )}
        {metaLine && (
          <div className="text-caption truncate" style={{ color: "var(--fg-4)", marginTop: "var(--sp-0_5)" }}>
            {metaLine}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Compact (tablet / mobile) row: Name (with folded meta) | Status | Actions.
 * All row actions collapse into a single always-visible kebab (no hover on
 * touch). Shared by both sections so the two bands stay visually consistent.
 */
function CompactRow({
  displayName,
  handle,
  handleTone,
  tagline,
  taglineEditable,
  hasTaglineSlot,
  avatarUrl,
  seed,
  meta,
  status,
  lastActiveLabel,
  actions,
  selfTag,
  adminBadge,
}: {
  displayName: string;
  handle: string | null;
  handleTone?: "brand" | "neutral";
  tagline?: string | null;
  taglineEditable?: boolean;
  hasTaglineSlot?: boolean;
  avatarUrl: string | null;
  seed: string;
  meta: ReactNode;
  /** Agents pass a presence status; humans omit it (no presence). */
  status?: PresenceStatus | null;
  lastActiveLabel?: string;
  actions: RowAction[];
  selfTag?: boolean;
  adminBadge?: boolean;
}) {
  return (
    <div
      className="grid items-start"
      style={{
        gridTemplateColumns: COMPACT_GRID,
        gap: "var(--sp-2)",
        padding: "var(--sp-2_5) var(--sp-2)",
        borderBottom: "var(--hairline) solid var(--border-faint)",
      }}
    >
      <NameCell
        displayName={displayName}
        handle={handle}
        handleTone={handleTone}
        tagline={tagline ?? null}
        avatarUrl={avatarUrl}
        seed={seed}
        selfTag={selfTag}
        adminBadge={adminBadge}
        hasTaglineSlot={hasTaglineSlot}
        taglineEditable={taglineEditable}
        metaLine={meta}
      />
      <span title={lastActiveLabel}>{status != null ? <PresenceChip status={status} /> : null}</span>
      <RowActionsMenu actions={actions} ariaLabel={`Actions for ${displayName}`} />
    </div>
  );
}

/** Compact folded meta for an agent row: Owner · provider · usage. */
function agentMetaLine(agent: PreviewAgent, isMine: boolean, usage: PreviewUsage | null): string {
  const owner = isMine ? "You" : (MEMBERS[agent.managerId]?.displayName ?? "—");
  const usageStr =
    usage && usage.turns > 0
      ? `${formatCompactCount(usage.inputTokens + usage.cachedInputTokens + usage.outputTokens)} · ${formatCompactCount(usage.turns)}t`
      : "—";
  return `${owner} · ${agent.runtimeProvider} · ${usageStr}`;
}

/**
 * Right-anchored actions cluster. Inline buttons + the kebab reveal on row
 * hover / focus (quiet by default), so the destructive items stay tucked away
 * and the resting row reads clean. The Actions track is the same width in both
 * sections so the right edge lines up (§3).
 */
function ActionsCell({
  ariaLabel,
  menuActions,
  children,
}: {
  ariaLabel: string;
  menuActions: RowAction[];
  children?: ReactNode;
}) {
  return (
    <div
      className="flex items-center justify-end opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
      style={{ gap: "var(--sp-1)" }}
    >
      {children}
      <RowActionsMenu actions={menuActions} ariaLabel={ariaLabel} />
    </div>
  );
}

function InlineAction({ label }: { label: string }) {
  return (
    <button
      type="button"
      className="text-caption transition-colors hover:bg-[var(--bg-hover)]"
      style={{
        padding: "var(--sp-0_5) var(--sp-1_5)",
        borderRadius: "var(--radius-chip)",
        border: 0,
        background: "transparent",
        color: "var(--fg-2)",
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}

function HeaderLabel({ children }: { children: ReactNode }) {
  return (
    <span className="text-eyebrow" style={{ color: "var(--fg-4)" }}>
      {children}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────

function agentMatches(agent: PreviewAgent, q: string): boolean {
  return agent.displayName.toLowerCase().includes(q) || (agent.name?.toLowerCase().includes(q) ?? false);
}

function humanMatches(human: PreviewHuman, q: string): boolean {
  return human.displayName.toLowerCase().includes(q) || human.username.toLowerCase().includes(q);
}

function sortAgents(agents: PreviewAgent[]): PreviewAgent[] {
  // Mine first (so the viewer finds their own agents fast), then alphabetical.
  return [...agents].sort((a, b) => {
    const mineA = a.managerId === ME_ID ? 0 : 1;
    const mineB = b.managerId === ME_ID ? 0 : 1;
    if (mineA !== mineB) return mineA - mineB;
    return a.displayName.localeCompare(b.displayName);
  });
}

function resolveAgent(uuid: string | null): { uuid: string; name: string | null; displayName: string } | null {
  if (!uuid) return null;
  const agent = PREVIEW_AGENTS.find((a) => a.uuid === uuid);
  if (!agent) return null;
  return { uuid: agent.uuid, name: agent.name, displayName: agent.displayName };
}
