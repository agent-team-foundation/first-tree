import type {
  ContextTreeChangeType,
  ContextTreeNode,
  ContextTreeSnapshot,
  ContextTreeUsageEvent,
} from "@first-tree/shared";
import { useQuery } from "@tanstack/react-query";
import { stratify, tree } from "d3-hierarchy";
import { AlertTriangle, Network, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { getContextTreeSnapshot } from "../api/context-tree.js";
import { useAuth } from "../auth/auth-context.js";
import { resolveAvatarHue } from "../components/chat/chat-row-avatar.js";
import { Panel, PanelBody } from "../components/ui/panel.js";

const CONTEXT_WINDOW = "7d";
// Live-feed refetch cadence. The usage feed inside the snapshot is what wants
// to feel "live" — admins glancing at the page should see timestamps tick and
// new sessions arrive. 20s = 3 req/min sits comfortably under the 6/min rate
// limit even with two Context Tabs open simultaneously (4/min combined).
const CONTEXT_REFETCH_MS = 20_000;

export function ContextPage({ previewSnapshot }: { previewSnapshot?: ContextTreeSnapshot } = {}) {
  const { organizationId } = useAuth();
  const [selectedUpdateId, setSelectedUpdateId] = useState<string | null>(null);
  const preview = previewSnapshot !== undefined;

  const query = useQuery({
    queryKey: ["context-tree-snapshot", organizationId, CONTEXT_WINDOW, preview],
    queryFn: () => {
      if (!organizationId) throw new Error("No organization selected");
      return getContextTreeSnapshot(organizationId, CONTEXT_WINDOW);
    },
    enabled: !preview && !!organizationId,
    refetchInterval: preview ? false : CONTEXT_REFETCH_MS,
    refetchIntervalInBackground: false,
  });

  const snapshot = previewSnapshot ?? query.data;
  const selectedUpdate = useMemo(() => {
    if (!snapshot) return null;
    return snapshot.updates.find((update) => update.id === selectedUpdateId) ?? snapshot.updates[0] ?? null;
  }, [selectedUpdateId, snapshot]);
  const selectedNodeId = selectedUpdate?.nodeId ?? null;

  useEffect(() => {
    if (!snapshot) return;
    if (selectedUpdateId && snapshot.updates.some((update) => update.id === selectedUpdateId)) return;
    setSelectedUpdateId(snapshot.updates[0]?.id ?? null);
  }, [selectedUpdateId, snapshot]);

  return (
    <div
      className="context-live-page"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--sp-10)",
      }}
    >
      {!preview && query.isLoading ? <LoadingState /> : null}
      {!preview && query.error ? (
        <ErrorState message={query.error instanceof Error ? query.error.message : "Failed to load"} />
      ) : null}
      {snapshot && (preview || !query.isLoading) ? (
        snapshot.snapshotStatus === "unavailable" ? (
          <UnavailableState snapshot={snapshot} />
        ) : (
          <>
            <LiveContextHero snapshot={snapshot} />
            <ChangeMap
              snapshot={snapshot}
              selectedNodeId={selectedNodeId}
              onSelectNode={(nodeId) => {
                const matchingUpdate = snapshot.updates.find((update) => update.nodeId === nodeId);
                setSelectedUpdateId(matchingUpdate?.id ?? null);
              }}
            />
            <ContextSignal snapshot={snapshot} />
            <ContextUsageFeed snapshot={snapshot} />
          </>
        )
      ) : null}
    </div>
  );
}

function LiveContextHero({ snapshot }: { snapshot: ContextTreeSnapshot }) {
  const lastUpdated = exactTimeLabel(snapshot.syncedAt) ?? "sync time unknown";
  const statusTone = severityColor(snapshot.contextStatus.severity);
  const statusDetail =
    snapshot.contextStatus.severity === "ok" ? null : (snapshot.contextStatus.detail ?? snapshot.contextStatus.label);

  return (
    <section className="context-live-hero" aria-label={snapshot.contextStatus.label}>
      <div className="context-live-title-row">
        <span
          aria-hidden="true"
          className="context-live-dot"
          style={{
            background: statusTone,
            ["--context-live-dot-color" as string]: statusTone,
          }}
        />
        <h2 className="m-0 context-live-title">Context tree is live</h2>
      </div>
      <div className="text-lead context-live-subtitle">
        Last updated at <strong>{lastUpdated}</strong>
      </div>
      {statusDetail ? <div className="text-body context-live-status-detail">{statusDetail}</div> : null}
    </section>
  );
}

function ChangeMap({
  snapshot,
  selectedNodeId,
  onSelectNode,
}: {
  snapshot: ContextTreeSnapshot;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
}) {
  const groups = useMemo(() => changeGroups(snapshot.nodes), [snapshot.nodes]);
  const selectedGroupId = useMemo(
    () => selectedChangeGroupId(snapshot.nodes, selectedNodeId),
    [snapshot.nodes, selectedNodeId],
  );
  const placedGroups = useMemo(() => placeChangeGroups(groups, selectedGroupId), [groups, selectedGroupId]);
  const summaryUpdateCount = Math.max(snapshot.summary.changedNodeCount, snapshot.updates.length);

  return (
    <section className="context-map-section" aria-label="Context Tree update change map">
      <div className="text-label context-map-kicker">Past 7 days · Top updated domains</div>
      <div className="context-map-frame">
        {placedGroups.length === 0 ? (
          <EmptyChanges />
        ) : (
          <svg
            viewBox="0 0 920 420"
            role="img"
            aria-label="Recent Context Tree update branches"
            preserveAspectRatio="xMidYMid meet"
            className="context-network-svg"
          >
            <title>Update Change Map</title>
            <circle className="context-network-live-halo" cx="460" cy="210" r="104" />
            {placedGroups.map((group) => (
              <path
                key={`path:${group.id}`}
                d={connectionPath(group)}
                fill="none"
                stroke={group.selected ? "var(--success)" : "var(--border-strong)"}
                strokeDasharray="5 8"
                strokeLinecap="round"
                strokeOpacity={group.selected ? 0.7 : 0.36}
                strokeWidth={group.selected ? 2 : 1.4}
              />
            ))}
            <foreignObject x="338" y="122" width="244" height="176" className="context-network-card-wrap">
              <div className="context-network-summary-card">
                <span className="context-network-summary-icon" aria-hidden="true">
                  <Network size={30} strokeWidth={2.3} />
                </span>
                <span className="context-network-summary-title">Context Tree</span>
                <span className="context-network-summary-scale">
                  {formatNumber(snapshot.nodes.length)}
                  <span>total nodes</span>
                </span>
                <span className="text-body context-network-summary-badge">
                  +{formatNumber(summaryUpdateCount)} updates
                </span>
              </div>
            </foreignObject>
            {placedGroups.map((group) => (
              <foreignObject
                key={group.id}
                x={group.x}
                y={group.y}
                width={group.width}
                height={group.height}
                className="context-network-card-wrap"
              >
                <button
                  type="button"
                  className={group.selected ? "context-network-card is-live" : "context-network-card"}
                  onClick={() => onSelectNode(group.representativeNodeId)}
                >
                  <span className="context-network-pin" aria-hidden="true" />
                  <span className="text-subtitle context-network-title">{group.title}</span>
                  <span className="context-change-breakdown">
                    {changeBreakdownParts(group.changeCounts).map((part) => (
                      <span key={part.type} data-change-type={part.type}>
                        {formatNumber(part.count)} {part.label}
                      </span>
                    ))}
                  </span>
                </button>
              </foreignObject>
            ))}
          </svg>
        )}
      </div>
    </section>
  );
}

function ContextSignal({ snapshot }: { snapshot: ContextTreeSnapshot }) {
  const windowText = snapshot.usage.windowDays === 1 ? "1 day" : `${snapshot.usage.windowDays} days`;
  const agentText = snapshot.usage.agentCount === 1 ? "1 agent" : `${snapshot.usage.agentCount} agents`;
  const usageText = snapshot.usage.usageCount === 1 ? "once" : `${snapshot.usage.usageCount} times`;

  // Honest copy: each usage event is now a real Read of a Context Tree file
  // (the agent runtime emits one per tree-file read, with the node path). The
  // signal knows the tree was read — not why — so it makes no "design
  // decision" claim. See packages/client/src/handlers/claude-code.ts.
  if (snapshot.usage.usageCount === 0) {
    return (
      <div className="text-lead context-signal" style={{ color: "var(--fg-3)" }}>
        <span>No agent has read the context tree in the last {windowText}.</span>
      </div>
    );
  }

  return (
    <div className="text-lead context-signal" style={{ color: "var(--fg-3)" }}>
      <span>
        In the last {windowText}, <mark>{agentText}</mark>
      </span>
      <span>
        read the context tree <mark>{usageText}</mark>.
      </span>
    </div>
  );
}

const CONTEXT_USAGE_FEED_DEFAULT_LIMIT = 10;
// Re-render every 30s so "Xm ago" labels tick without a fresh server roundtrip.
// Pairs with the 20s snapshot refetch above — together they keep the feed
// feeling like a live stream even when no new events arrive.
const CONTEXT_USAGE_TIME_TICK_MS = 30_000;
// CSS animation duration on .fresh — keep this in sync with index.css so the
// className is removed exactly when the flash finishes (no lingering tint when
// React re-renders for an unrelated reason).
const CONTEXT_USAGE_FRESH_MS = 1_200;

function ContextUsageFeed({ snapshot }: { snapshot: ContextTreeSnapshot }) {
  const navigate = useNavigate();
  const [showAll, setShowAll] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [freshIds, setFreshIds] = useState<Set<string>>(() => new Set());
  // Tracks the previous event-id set across renders so we can diff for
  // arrivals on each snapshot refresh without re-flashing on every render.
  const seenIdsRef = useRef<Set<string>>(new Set());
  const events = snapshot.usage.recentEvents;

  // Tick the displayed `Xm ago` labels every 30s. Cheap — only forces a
  // re-render of this subtree.
  useEffect(() => {
    const handle = setInterval(() => setNow(Date.now()), CONTEXT_USAGE_TIME_TICK_MS);
    return () => clearInterval(handle);
  }, []);

  // On every snapshot change, diff against the previously-seen event ids.
  // Anything new gets the `fresh` className for one animation cycle, then is
  // removed so a later unrelated re-render does not retrigger the flash.
  useEffect(() => {
    const currentIds = new Set(events.map((event) => event.id));
    const seen = seenIdsRef.current;
    const newlyArrived = new Set<string>();
    for (const id of currentIds) {
      if (!seen.has(id)) newlyArrived.add(id);
    }
    seenIdsRef.current = currentIds;
    // First mount has no "fresh" — every event is just history. Only after
    // the seen set has been populated once do new ids count as arrivals.
    if (seen.size === 0 || newlyArrived.size === 0) return;
    setFreshIds((prev) => {
      const next = new Set(prev);
      for (const id of newlyArrived) next.add(id);
      return next;
    });
    const handle = setTimeout(() => {
      setFreshIds((prev) => {
        if (prev.size === 0) return prev;
        const next = new Set(prev);
        for (const id of newlyArrived) next.delete(id);
        return next;
      });
    }, CONTEXT_USAGE_FRESH_MS);
    return () => clearTimeout(handle);
  }, [events]);

  if (events.length === 0) return null;

  const visible = showAll ? events : events.slice(0, CONTEXT_USAGE_FEED_DEFAULT_LIMIT);
  const remaining = events.length - visible.length;

  return (
    <section className="context-usage-feed" aria-label="Recent agent usage of the Context Tree">
      <div className="context-usage-feed-header">
        <span className="context-usage-feed-live-dot" aria-hidden="true" />
        <span className="context-usage-feed-live-label">LIVE</span>
        <span className="context-usage-feed-live-sublabel">· streaming agent activity</span>
      </div>
      <ul className="context-usage-feed-list">
        {visible.map((event) => {
          // Pin chatId to a local const so the truthiness narrow survives
          // into the onClick closure — `event.chatId` is `string | null` and
          // TS does not preserve the narrow across a function boundary.
          const chatId = event.chatId;
          const isFresh = freshIds.has(event.id);
          const hue = resolveAvatarHue(event.agentAvatarColorToken, event.agentId);
          return (
            <li key={event.id} className={isFresh ? "context-usage-feed-row is-fresh" : "context-usage-feed-row"}>
              <span className="context-usage-feed-dot" aria-hidden="true" />
              <span className="context-usage-feed-avatar" aria-hidden="true" style={{ background: hue }}>
                {agentInitials(event.agentName)}
              </span>
              <span className="context-usage-feed-text">
                <span className="context-usage-feed-agent">{event.agentName}</span>
                <span className="context-usage-feed-action"> read </span>
                {event.nodePath ? (
                  <span className="context-usage-feed-node" title={event.nodePath}>
                    {event.nodePath}
                  </span>
                ) : (
                  <span className="context-usage-feed-action">the context tree</span>
                )}
                {chatId ? (
                  <>
                    <span className="context-usage-feed-action"> in </span>
                    {event.viewerCanAccess ? (
                      <button
                        type="button"
                        className="context-usage-feed-chat"
                        onClick={() => navigate(`/?c=${encodeURIComponent(chatId)}`)}
                      >
                        {chatLabel(event)}
                      </button>
                    ) : (
                      // Org-wide the label is visible, but a non-member must not
                      // be able to navigate into a chat the server would 404 —
                      // render inert text instead of a link. See
                      // summarizeContextTreeUsage / viewerCanAccess.
                      <span className="context-usage-feed-chat is-static" title="No access to this chat">
                        {chatLabel(event)}
                      </span>
                    )}
                  </>
                ) : null}
              </span>
              <span className="context-usage-feed-time">{relativeTimeLabel(event.createdAt, now)}</span>
            </li>
          );
        })}
      </ul>
      {remaining > 0 ? (
        <button type="button" className="context-usage-feed-more" onClick={() => setShowAll(true)}>
          Show all {events.length} ›
        </button>
      ) : null}
    </section>
  );
}

function chatLabel(event: ContextTreeUsageEvent): string {
  const trimmed = event.chatTitle?.trim();
  if (trimmed && trimmed.length > 0) return `#${trimmed}`;
  if (event.chatId) return `#${event.chatId.slice(-6)}`;
  return "";
}

/**
 * Two-letter initials from an agent display name. Handles space-separated
 * names ("Test Agent" → "TA"), kebab/snake/dot separators
 * ("gandy-coder" → "GC", "qa.bot" → "QB"), and falls back to the first
 * two characters when there is only one token ("reviewer" → "RE").
 * Always uppercase.
 */
function agentInitials(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "??";
  const tokens = trimmed.split(/[\s._-]+/).filter((part) => part.length > 0);
  if (tokens.length >= 2) {
    return `${tokens[0]?.[0] ?? ""}${tokens[1]?.[0] ?? ""}`.toUpperCase();
  }
  return trimmed.slice(0, 2).toUpperCase();
}

function relativeTimeLabel(value: string, nowMs: number): string {
  const diffMs = nowMs - new Date(value).getTime();
  if (Number.isNaN(diffMs) || diffMs < 0) return "just now";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function LoadingState() {
  // Cold-load only (no cached snapshot). Center an intentional loading state
  // in the content area with a spinning icon, rather than a single static line
  // pinned to the top-left. `animate-spin` is the same spinner utility used
  // across the app (see save-bar / agent-row).
  return (
    <div
      className="flex flex-col items-center justify-center text-body"
      style={{ color: "var(--fg-2)", gap: "var(--sp-3)", minHeight: "50vh", textAlign: "center" }}
    >
      <RefreshCw size={22} className="animate-spin" aria-hidden="true" />
      <span>Loading team context...</span>
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <Panel>
      <PanelBody>
        <div className="flex items-center text-body" style={{ color: "var(--danger)", gap: "var(--sp-2)" }}>
          <AlertTriangle size={17} />
          {message}
        </div>
      </PanelBody>
    </Panel>
  );
}

function UnavailableState({ snapshot }: { snapshot: ContextTreeSnapshot }) {
  const title = snapshot.repo ? "Context Tree sync unavailable" : "Connect Context Tree";
  const detail = snapshot.repo
    ? "First Tree cannot read the team Context Tree yet. Agents and users will see context here after the server can sync the configured repo."
    : "Connect a Context Tree repo to show the team knowledge agents can use.";
  const syncDetail = snapshot.contextStatus.detail;
  const repoLabel = snapshot.repo ? redactRepoForDisplay(snapshot.repo) : null;
  return (
    <Panel>
      <PanelBody>
        <div className="flex items-start text-body" style={{ color: "var(--fg-2)", gap: "var(--sp-2)" }}>
          <AlertTriangle size={18} style={{ color: "var(--warning)" }} />
          <div>
            <div className="font-semibold" style={{ color: "var(--fg)" }}>
              {title}
            </div>
            <div style={{ marginTop: "var(--sp-1)" }}>{detail}</div>
            {syncDetail ? (
              <div className="text-label" style={{ color: "var(--fg-3)", marginTop: "var(--sp-2)" }}>
                {syncDetail}
              </div>
            ) : null}
            {snapshot.repo || snapshot.branch ? (
              <div className="text-label" style={{ color: "var(--fg-3)", marginTop: "var(--sp-2)" }}>
                {repoLabel ? `Repo: ${repoLabel}` : null}
                {snapshot.repo && snapshot.branch ? " · " : null}
                {snapshot.branch ? `Branch: ${snapshot.branch}` : null}
              </div>
            ) : null}
          </div>
        </div>
      </PanelBody>
    </Panel>
  );
}

function EmptyChanges() {
  return (
    <div className="text-body" style={{ color: "var(--fg-3)" }}>
      No context updates in the past 7 days.
    </div>
  );
}

const OVERVIEW_DEFAULT_DEPTH = 1;
const OVERVIEW_CHANGED_BRANCH_DEPTH = 3;

type OverviewDatum = {
  id: string;
  parentId: string | null;
  sourceNodeId: string | null;
  title: string;
  path: string;
  changeType: ContextTreeChangeType | null;
  updateCount: number;
  isSummary: boolean;
  isExpanded: boolean;
  selected: boolean;
  selectedPath: boolean;
  muted: boolean;
};

type LayoutNode = OverviewDatum & {
  x: number;
  y: number;
  parent: LayoutNode | null;
};

type ChangeCounts = {
  added: number;
  edited: number;
  removed: number;
};

type ChangeGroup = {
  id: string;
  title: string;
  path: string;
  representativeNodeId: string;
  updateCount: number;
  changeCounts: ChangeCounts;
};

type PlacedChangeGroup = ChangeGroup & {
  selected: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  anchorX: number;
  anchorY: number;
};

export function layoutTree(
  nodes: ContextTreeNode[],
  selectedNodeId: string | null,
  counts: Map<string, number>,
  expandedParents: Set<string>,
): LayoutNode[] {
  const overviewNodes = buildOverviewNodes(nodes, selectedNodeId, counts, expandedParents);
  if (overviewNodes.length === 0) return [];

  const root = stratify<OverviewDatum>()
    .id((node) => node.id)
    .parentId((node) => node.parentId)(overviewNodes)
    .sort((a, b) => {
      if (a.data.isSummary !== b.data.isSummary) return a.data.isSummary ? -1 : 1;
      return a.data.path.localeCompare(b.data.path);
    });
  const pointRoot = tree<OverviewDatum>().nodeSize([30, 170])(root);
  const points = pointRoot.descendants();
  const minX = Math.min(...points.map((point) => point.x));
  const laidOut = points.map((point) => ({
    ...point.data,
    x: 28 + point.y,
    y: 28 + point.x - minX,
    parent: null,
  }));

  return laidOut.map((node, _index, all) => ({
    ...node,
    parent: node.parentId ? (all.find((candidate) => candidate.id === node.parentId) ?? null) : null,
  }));
}

export function buildOverviewNodes(
  nodes: ContextTreeNode[],
  selectedNodeId: string | null,
  counts: Map<string, number>,
  expandedParents: Set<string>,
): OverviewDatum[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const validNodes = nodes
    .filter((node) => !node.parentId || byId.has(node.parentId))
    .sort((a, b) => a.path.localeCompare(b.path));
  if (validNodes.length === 0) return [];

  const childrenByParent = childMap(validNodes);
  const selectedPath = selectedPathIds(selectedNodeId, byId);
  const compactVisibleIds = new Set<string>();
  const depthById = new Map<string, number>();

  for (const node of validNodes) {
    const depth = nodeDepth(node, byId, depthById);
    const updateCount = counts.get(node.id) ?? 0;
    if (
      depth <= OVERVIEW_DEFAULT_DEPTH ||
      selectedPath.has(node.id) ||
      (updateCount > 0 && depth <= OVERVIEW_CHANGED_BRANCH_DEPTH)
    ) {
      addWithAncestors(node.id, byId, compactVisibleIds);
    }
  }

  let promotedSomething = true;
  while (promotedSomething) {
    promotedSomething = false;
    for (const parentId of [...compactVisibleIds]) {
      const hiddenChildren = (childrenByParent.get(parentId) ?? []).filter((child) => !compactVisibleIds.has(child.id));
      if (hiddenChildren.length === 1) {
        const only = hiddenChildren[0];
        if (only) {
          compactVisibleIds.add(only.id);
          promotedSomething = true;
        }
      }
    }
  }

  const visibleIds = new Set(compactVisibleIds);
  for (const parentId of expandedParents) {
    if (!visibleIds.has(parentId)) continue;
    for (const child of childrenByParent.get(parentId) ?? []) {
      visibleIds.add(child.id);
    }
  }

  const selectedActive = selectedPath.size > 0;
  const realNodes = validNodes
    .filter((node) => visibleIds.has(node.id))
    .map((node): OverviewDatum => {
      const updateCount = counts.get(node.id) ?? 0;
      const selectedPathNode = selectedPath.has(node.id);
      return {
        id: node.id,
        parentId: node.parentId && visibleIds.has(node.parentId) ? node.parentId : null,
        sourceNodeId: node.id,
        title: node.title,
        path: node.path,
        changeType: node.changeType,
        updateCount,
        isSummary: false,
        isExpanded: false,
        selected: selectedNodeId === node.id,
        selectedPath: selectedPathNode,
        muted: selectedActive && !selectedPathNode && updateCount === 0,
      };
    });

  const summaryNodes: OverviewDatum[] = [];
  for (const node of validNodes) {
    if (!visibleIds.has(node.id)) continue;
    const naturallyHidden = (childrenByParent.get(node.id) ?? []).filter((child) => !compactVisibleIds.has(child.id));
    if (naturallyHidden.length === 0) continue;
    const isExpanded = expandedParents.has(node.id);
    const changedHiddenCount = naturallyHidden.filter((child) => (counts.get(child.id) ?? 0) > 0).length;
    summaryNodes.push({
      id: `summary:${node.id}`,
      parentId: node.id,
      sourceNodeId: null,
      title: isExpanded ? "Show less" : summaryTitle(naturallyHidden.length, changedHiddenCount),
      path: `${node.path}/~summary`,
      changeType: null,
      updateCount: changedHiddenCount,
      isSummary: true,
      isExpanded,
      selected: false,
      selectedPath: selectedPath.has(node.id),
      muted: selectedActive && !selectedPath.has(node.id),
    });
  }

  return [...realNodes, ...summaryNodes];
}

function updateChangeNodes(nodes: ContextTreeNode[]): ContextTreeNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const ids = new Set<string>();
  for (const node of nodes) {
    if (!node.changeType) continue;
    addWithAncestors(node.id, byId, ids);
  }
  return nodes.filter((node) => ids.has(node.id));
}

function changeGroups(nodes: ContextTreeNode[]): ChangeGroup[] {
  const changedNodes = updateChangeNodes(nodes).filter((node) => node.changeType);
  if (changedNodes.length === 0) return [];

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const grouped = new Map<string, ChangeGroup>();

  for (const node of changedNodes) {
    const branch = topLevelBranch(node, byId);
    const existing = grouped.get(branch.id);
    if (existing) {
      grouped.set(branch.id, {
        ...existing,
        updateCount: existing.updateCount + 1,
        changeCounts: incrementChangeCount(existing.changeCounts, node.changeType),
        representativeNodeId: existing.representativeNodeId === branch.id ? node.id : existing.representativeNodeId,
      });
      continue;
    }

    grouped.set(branch.id, {
      id: branch.id,
      title: branch.title,
      path: branch.path,
      representativeNodeId: node.id,
      updateCount: 1,
      changeCounts: incrementChangeCount(emptyChangeCounts(), node.changeType),
    });
  }

  return [...grouped.values()]
    .sort((a, b) => b.updateCount - a.updateCount || a.path.localeCompare(b.path))
    .slice(0, 4);
}

function emptyChangeCounts(): ChangeCounts {
  return { added: 0, edited: 0, removed: 0 };
}

function incrementChangeCount(counts: ChangeCounts, type: ContextTreeChangeType | null): ChangeCounts {
  if (type === "added") return { ...counts, added: counts.added + 1 };
  if (type === "edited") return { ...counts, edited: counts.edited + 1 };
  if (type === "removed") return { ...counts, removed: counts.removed + 1 };
  return counts;
}

function changeBreakdownParts(
  counts: ChangeCounts,
): Array<{ type: ContextTreeChangeType; label: string; count: number }> {
  const parts: Array<{ type: ContextTreeChangeType; label: string; count: number }> = [];
  if (counts.added > 0) parts.push({ type: "added", label: "added", count: counts.added });
  if (counts.edited > 0) parts.push({ type: "edited", label: "edited", count: counts.edited });
  if (counts.removed > 0) parts.push({ type: "removed", label: "removed", count: counts.removed });
  return parts;
}

function selectedChangeGroupId(nodes: ContextTreeNode[], selectedNodeId: string | null): string | null {
  if (!selectedNodeId) return null;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const selectedNode = byId.get(selectedNodeId);
  return selectedNode ? topLevelBranch(selectedNode, byId).id : null;
}

function placeChangeGroups(groups: ChangeGroup[], selectedGroupId: string | null): PlacedChangeGroup[] {
  const slots: Array<Pick<PlacedChangeGroup, "x" | "y" | "width" | "height" | "anchorX" | "anchorY">> = [
    { x: 96, y: 34, width: 196, height: 98, anchorX: 292, anchorY: 83 },
    { x: 628, y: 34, width: 196, height: 98, anchorX: 628, anchorY: 83 },
    { x: 96, y: 286, width: 196, height: 98, anchorX: 292, anchorY: 335 },
    { x: 628, y: 286, width: 196, height: 98, anchorX: 628, anchorY: 335 },
  ];
  const fallbackSlot = slots[slots.length - 1];
  if (!fallbackSlot) return [];

  return groups.map((group, index) => {
    const slot = slots[index] ?? fallbackSlot;
    return {
      ...group,
      ...slot,
      selected: group.id === selectedGroupId || (selectedGroupId === null && index === 0),
    };
  });
}

function connectionPath(group: PlacedChangeGroup): string {
  const centerX = 460;
  const centerY = 210;
  const direction = group.anchorX < centerX ? -1 : 1;
  const startX = centerX + direction * 124;
  const startY = centerY + (group.anchorY > centerY ? 48 : -48);
  const controlX = (startX + group.anchorX) / 2;
  const controlY = group.anchorY > centerY ? startY + 62 : startY - 62;
  return `M ${startX} ${startY} Q ${controlX} ${controlY} ${group.anchorX} ${group.anchorY}`;
}

function topLevelBranch(node: ContextTreeNode, byId: Map<string, ContextTreeNode>): ContextTreeNode {
  let current = node;
  let parent = current.parentId ? byId.get(current.parentId) : undefined;
  while (parent && parent.parentId !== null) {
    current = parent;
    parent = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return current;
}

function childMap(nodes: ContextTreeNode[]): Map<string, ContextTreeNode[]> {
  const childrenByParent = new Map<string, ContextTreeNode[]>();
  for (const node of nodes) {
    if (!node.parentId) continue;
    const siblings = childrenByParent.get(node.parentId) ?? [];
    siblings.push(node);
    childrenByParent.set(node.parentId, siblings);
  }
  for (const siblings of childrenByParent.values()) {
    siblings.sort((a, b) => a.path.localeCompare(b.path));
  }
  return childrenByParent;
}

function selectedPathIds(selectedNodeId: string | null, byId: Map<string, ContextTreeNode>): Set<string> {
  const pathIds = new Set<string>();
  let current = selectedNodeId ? byId.get(selectedNodeId) : undefined;
  while (current) {
    pathIds.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return pathIds;
}

function addWithAncestors(nodeId: string, byId: Map<string, ContextTreeNode>, visibleIds: Set<string>): void {
  let current = byId.get(nodeId);
  while (current) {
    visibleIds.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
}

function nodeDepth(node: ContextTreeNode, byId: Map<string, ContextTreeNode>, depthById: Map<string, number>): number {
  const known = depthById.get(node.id);
  if (known !== undefined) return known;
  const parent = node.parentId ? byId.get(node.parentId) : undefined;
  const depth = parent ? nodeDepth(parent, byId, depthById) + 1 : 0;
  depthById.set(node.id, depth);
  return depth;
}

function summaryTitle(hiddenCount: number, changedHiddenCount: number): string {
  if (changedHiddenCount > 0) {
    return `Show ${hiddenCount} more · ${changedHiddenCount} changed`;
  }
  return `Show ${hiddenCount} more`;
}

function severityColor(severity: ContextTreeSnapshot["contextStatus"]["severity"]): string {
  if (severity === "ok") return "var(--success)";
  if (severity === "warning") return "var(--warning)";
  return "var(--danger)";
}

function redactRepoForDisplay(repo: string): string {
  return repo.replace(/(https?:\/\/)[^/@\s]+@/g, "$1[redacted]@");
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function exactTimeLabel(value: string | null): string | null {
  if (!value) return null;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}
