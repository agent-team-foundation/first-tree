import type {
  ContextTreeChangeType,
  ContextTreeNode,
  ContextTreeSnapshot,
  ContextTreeUpdate,
} from "@agent-team-foundation/first-tree-hub-shared";
import { useQuery } from "@tanstack/react-query";
import { stratify, tree } from "d3-hierarchy";
import { AlertTriangle, CheckCircle2, Copy, FolderTree, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { type ContextTreeWindow, getContextTreeSnapshot } from "../api/context-tree.js";
import { Button } from "../components/ui/button.js";
import { Markdown } from "../components/ui/markdown.js";
import { PageHeader } from "../components/ui/page-header.js";
import { Panel, PanelBody, PanelHeader, PanelTitle } from "../components/ui/panel.js";

const CONTEXT_WINDOWS: Array<{ value: ContextTreeWindow; label: string; summary: string }> = [
  { value: "1d", label: "1 day", summary: "last 1 day" },
  { value: "7d", label: "7 days", summary: "last 7 days" },
  { value: "30d", label: "30 days", summary: "last 30 days" },
];

export function ContextPage() {
  const [window, setWindow] = useState<ContextTreeWindow>("7d");
  const [selectedUpdateId, setSelectedUpdateId] = useState<string | null>(null);
  const [selectedOverviewNodeId, setSelectedOverviewNodeId] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ["context-tree-snapshot", window],
    queryFn: () => getContextTreeSnapshot(window),
  });

  const snapshot = query.data;
  const selectedUpdate = useMemo(() => {
    if (!snapshot) return null;
    return snapshot.updates.find((update) => update.id === selectedUpdateId) ?? snapshot.updates[0] ?? null;
  }, [selectedUpdateId, snapshot]);

  const selectedUpdateNode = useMemo(() => {
    if (!snapshot) return null;
    return selectedUpdate?.nodeId ? (snapshot.nodes.find((node) => node.id === selectedUpdate.nodeId) ?? null) : null;
  }, [selectedUpdate, snapshot]);

  const selectedOverviewNode = selectedOverviewNodeId ?? selectedUpdate?.nodeId ?? selectedUpdateNode?.id ?? null;

  useEffect(() => {
    if (!snapshot) return;
    if (selectedUpdateId && snapshot.updates.some((update) => update.id === selectedUpdateId)) return;
    setSelectedUpdateId(snapshot.updates[0]?.id ?? null);
  }, [selectedUpdateId, snapshot]);

  return (
    <div className="-m-6">
      <PageHeader title="Context" subtitle="Team context available to agents, and how it is changing" />
      <div style={{ padding: "var(--sp-4) var(--sp-5) var(--sp-7)" }}>
        {query.isLoading ? <LoadingState /> : null}
        {query.error ? (
          <ErrorState message={query.error instanceof Error ? query.error.message : "Failed to load"} />
        ) : null}
        {snapshot && !query.isLoading ? (
          <div className="flex flex-col" style={{ gap: "var(--sp-4)" }}>
            {snapshot.snapshotStatus === "unavailable" ? (
              <UnavailableState snapshot={snapshot} />
            ) : (
              <>
                <ContextStatus snapshot={snapshot} window={window} onWindowChange={setWindow} />
                <UpdatesView
                  snapshot={snapshot}
                  selectedUpdate={selectedUpdate}
                  selectedUpdateNode={selectedUpdateNode}
                  selectedOverviewNodeId={selectedOverviewNode}
                  onSelectUpdate={(update) => {
                    setSelectedUpdateId(update.id);
                    setSelectedOverviewNodeId(update.nodeId);
                  }}
                  onSelectOverviewNode={setSelectedOverviewNodeId}
                />
              </>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ContextStatus({
  snapshot,
  window,
  onWindowChange,
}: {
  snapshot: ContextTreeSnapshot;
  window: ContextTreeWindow;
  onWindowChange: (window: ContextTreeWindow) => void;
}) {
  const statusIcon =
    snapshot.contextStatus.severity === "ok" ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />;
  const currentWindow = windowSummary(window);
  return (
    <Panel>
      <PanelBody style={{ padding: "var(--sp-2_5) var(--sp-3_5)" }}>
        <div className="flex flex-wrap items-center justify-between" style={{ gap: "var(--sp-3)" }}>
          <div className="flex items-center" style={{ gap: "var(--sp-2)", minWidth: 0 }}>
            <span style={{ color: severityColor(snapshot.contextStatus.severity), flex: "0 0 auto" }}>
              {statusIcon}
            </span>
            <div style={{ minWidth: 0 }}>
              <div className="flex flex-wrap items-baseline" style={{ gap: "var(--sp-2)" }}>
                <div className="text-subtitle font-semibold" style={{ color: "var(--fg)" }}>
                  {snapshot.contextStatus.label}
                </div>
                {snapshot.branch || snapshot.headCommit ? (
                  <div className="text-label font-medium" style={{ color: "var(--fg-3)" }}>
                    {snapshot.branch ?? "unknown"}
                    {snapshot.headCommit ? `@${snapshot.headCommit.slice(0, 7)}` : ""}
                  </div>
                ) : null}
              </div>
              <div
                className="text-label"
                style={{
                  color: "var(--fg-3)",
                  marginTop: "var(--sp-0_5)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {snapshot.contextStatus.detail ?? "Agents have a synced team context snapshot available."}
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-end" style={{ gap: "var(--sp-3)" }}>
            <div className="flex flex-wrap items-center" style={{ gap: "var(--sp-2)" }}>
              <StatusMetric value={snapshot.summary.changedNodeCount} label={`updates in the ${currentWindow}`} />
              <StatusMetric value={snapshot.summary.addedCount} label="added" tone="added" />
              <StatusMetric value={snapshot.summary.editedCount} label="edited" tone="edited" />
              <StatusMetric value={snapshot.summary.removedCount} label="removed" tone="removed" />
            </div>
            <fieldset className="flex flex-wrap" style={{ gap: "var(--sp-1)" }}>
              <legend className="sr-only">Context update window</legend>
              {CONTEXT_WINDOWS.map((option) => (
                <Button
                  key={option.value}
                  variant={option.value === window ? "default" : "outline"}
                  size="xs"
                  onClick={() => onWindowChange(option.value)}
                >
                  {option.label}
                </Button>
              ))}
            </fieldset>
          </div>
        </div>
      </PanelBody>
    </Panel>
  );
}

function UpdatesView({
  snapshot,
  selectedUpdate,
  selectedUpdateNode,
  selectedOverviewNodeId,
  onSelectUpdate,
  onSelectOverviewNode,
}: {
  snapshot: ContextTreeSnapshot;
  selectedUpdate: ContextTreeUpdate | null;
  selectedUpdateNode: ContextTreeNode | null;
  selectedOverviewNodeId: string | null;
  onSelectUpdate: (update: ContextTreeUpdate) => void;
  onSelectOverviewNode: (nodeId: string) => void;
}) {
  const handleSelectNode = (nodeId: string) => {
    onSelectOverviewNode(nodeId);
    const matchingUpdate = snapshot.updates.find((update) => update.nodeId === nodeId);
    if (matchingUpdate) {
      onSelectUpdate(matchingUpdate);
    }
  };

  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-4)" }}>
      <div
        className="grid grid-cols-1 xl:grid-cols-[minmax(26rem,1fr)_minmax(0,1fr)]"
        style={{ gap: "var(--sp-4)", alignItems: "stretch" }}
      >
        <Panel className="flex h-full flex-col">
          <PanelHeader>
            <div className="flex flex-col">
              <PanelTitle>Context Updates</PanelTitle>
              <span className="text-label" style={{ color: "var(--fg-3)", marginTop: "var(--sp-1)" }}>
                {snapshot.updates.length} team context changes agents may use
              </span>
            </div>
          </PanelHeader>
          <PanelBody className="flex-1">
            {snapshot.updates.length === 0 ? (
              <EmptyChanges />
            ) : (
              <div
                className="flex flex-col"
                style={{
                  gap: "var(--sp-1_5)",
                  height: "min(52vh, 30rem)",
                  overflow: "auto",
                  paddingRight: "var(--sp-0_5)",
                }}
              >
                {snapshot.updates.map((update) => (
                  <UpdateCard
                    key={update.id}
                    update={update}
                    selected={update.id === selectedUpdate?.id}
                    onClick={() => onSelectUpdate(update)}
                  />
                ))}
              </div>
            )}
          </PanelBody>
        </Panel>
        <UpdateDetail
          key={selectedUpdate?.id ?? "empty"}
          update={selectedUpdate}
          node={selectedUpdateNode}
          snapshot={snapshot}
        />
      </div>
      <TreeOverview snapshot={snapshot} selectedNodeId={selectedOverviewNodeId} onSelectNode={handleSelectNode} />
    </div>
  );
}

function UpdateCard({
  update,
  selected,
  onClick,
}: {
  update: ContextTreeUpdate;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left transition-colors"
      style={{
        border: "var(--hairline) solid var(--border)",
        borderColor: selected ? "var(--accent)" : "var(--border)",
        borderRadius: "var(--radius-panel)",
        background: selected ? "var(--bg-sunken)" : "var(--bg)",
        padding: "var(--sp-2_5)",
      }}
    >
      <div className="flex items-start justify-between" style={{ gap: "var(--sp-2)" }}>
        <div style={{ minWidth: 0 }}>
          <div className="flex flex-wrap items-center" style={{ gap: "var(--sp-2)" }}>
            <ChangePill type={update.changeType} />
            <span
              className="text-body font-semibold"
              style={{
                color: "var(--fg)",
                display: "-webkit-box",
                WebkitBoxOrient: "vertical",
                WebkitLineClamp: 2,
                overflow: "hidden",
              }}
            >
              {updateCardHeadline(update)}
            </span>
          </div>
          <div
            className="text-label"
            style={{
              color: "var(--fg-3)",
              marginTop: "var(--sp-2)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            In {pathLabel(update.path)}
          </div>
        </div>
      </div>
      <div
        className="flex flex-wrap text-label"
        style={{ color: "var(--fg-3)", gap: "var(--sp-2)", marginTop: "var(--sp-2)" }}
      >
        <span>{ownerLine(update.owners)}</span>
        {update.relatedNodeIds.length > 0 ? <span>{relatedText(update.relatedNodeIds.length)}</span> : null}
      </div>
    </button>
  );
}

function UpdateDetail({
  update,
  node,
  snapshot,
}: {
  update: ContextTreeUpdate | null;
  node: ContextTreeNode | null;
  snapshot: ContextTreeSnapshot;
}) {
  const [sourceExpanded, setSourceExpanded] = useState(false);
  const related = node?.relatedNodeIds
    .map((id) => snapshot.nodes.find((candidate) => candidate.id === id))
    .filter((candidate): candidate is ContextTreeNode => Boolean(candidate));
  const sourcePath = node?.sourcePath ?? update?.path ?? null;
  const sourceCommit = update?.sourceCommit ? update.sourceCommit.slice(0, 7) : "no commit";
  const ownership = update ? ownerText(update.owners) : "No owner";
  const linkedContextItems =
    related && related.length > 0 ? related.map((item) => item.title || item.path || "root") : [];
  const contextArea = update ? areaLabel(update.path) || pathLabel(update.path) : "root";

  return (
    <Panel className="flex h-full flex-col">
      <PanelHeader>
        <div>
          <PanelTitle>Selected Change</PanelTitle>
          <div className="text-label" style={{ color: "var(--fg-3)", marginTop: "var(--sp-1)" }}>
            Summary and source context
          </div>
        </div>
        {update ? <ChangePill type={update.changeType} /> : null}
      </PanelHeader>
      <PanelBody className="flex-1">
        {!update ? (
          <EmptyChanges />
        ) : (
          <div className="flex flex-col" style={{ gap: "var(--sp-3)" }}>
            <div>
              <div className="text-title font-semibold" style={{ color: "var(--fg)" }}>
                {update.title}
              </div>
              <div
                className="text-label"
                style={{
                  color: "var(--fg-3)",
                  marginTop: "var(--sp-1)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {changedByLabel(update)} · {changeTypeLabel(update.changeType)} · {contextArea}
              </div>
              <div
                className="text-label font-mono"
                style={{
                  color: "var(--fg-4)",
                  marginTop: "var(--sp-0_5)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {update.path}
              </div>
            </div>

            <div
              style={{
                borderTop: "var(--hairline) solid var(--border-faint)",
                paddingTop: "var(--sp-3)",
              }}
            >
              <SummaryBlock value={updateDetailActivity(update)} impact={updateDetailMeaning(update)} />
            </div>

            <div
              style={{
                borderTop: "var(--hairline) solid var(--border-faint)",
                paddingTop: "var(--sp-3)",
              }}
            >
              <ReferenceBlock
                commit={sourceCommit}
                linkedContextItems={linkedContextItems}
                owner={ownership}
                path={sourcePath ?? update.path}
                preview={node?.preview ?? null}
                sourceExpanded={sourceExpanded}
                onTogglePreview={() => {
                  setSourceExpanded((value) => !value);
                }}
              />
            </div>
          </div>
        )}
      </PanelBody>
    </Panel>
  );
}

function TreeOverview({
  snapshot,
  selectedNodeId,
  onSelectNode,
}: {
  snapshot: ContextTreeSnapshot;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
}) {
  const visibleNodes = useMemo(() => layoutTree(snapshot.nodes), [snapshot.nodes]);
  const changedDescendants = useMemo(() => changedCounts(snapshot.nodes), [snapshot.nodes]);
  const width = Math.max(920, ...visibleNodes.map((node) => node.x + 300));
  const height = Math.max(340, visibleNodes.length * 34);

  return (
    <Panel>
      <PanelHeader>
        <div>
          <PanelTitle>
            <FolderTree size={17} />
            Context Tree Overview
          </PanelTitle>
          <div className="text-label" style={{ color: "var(--fg-3)", marginTop: "var(--sp-1)" }}>
            Shows where recent context updates are concentrated across the team tree
          </div>
        </div>
      </PanelHeader>
      <PanelBody>
        {visibleNodes.length === 0 ? (
          <UnavailableState snapshot={snapshot} />
        ) : (
          <div style={{ overflow: "auto", maxHeight: "min(72vh, 52rem)" }}>
            <svg
              viewBox={`0 0 ${width} ${height}`}
              role="img"
              aria-label="Context Tree overview"
              style={{ width: "100%", minWidth: "44rem" }}
            >
              {visibleNodes.map((node) =>
                node.parent ? (
                  <line
                    key={`edge:${node.id}`}
                    x1={node.parent.x}
                    y1={node.parent.y}
                    x2={node.x}
                    y2={node.y}
                    stroke="var(--border)"
                    strokeWidth={1}
                  />
                ) : null,
              )}
              {visibleNodes.map((node) => {
                const selected = node.id === selectedNodeId;
                const count = changedDescendants.get(node.id) ?? 0;
                return (
                  <foreignObject key={node.id} x={node.x - 8} y={node.y - 12} width={width - node.x + 8} height={24}>
                    <button
                      type="button"
                      onClick={() => onSelectNode(node.id)}
                      className="flex w-full items-center text-left text-label"
                      style={{ color: "var(--fg)", gap: "var(--sp-2)" }}
                    >
                      <span
                        aria-hidden="true"
                        style={{
                          width: selected ? "var(--sp-4)" : "var(--sp-3)",
                          height: selected ? "var(--sp-4)" : "var(--sp-3)",
                          borderRadius: "50%",
                          background: nodeColor(node.changeType, selected),
                          border: `${selected ? "var(--hairline-bold)" : "var(--hairline)"} solid ${
                            selected ? "var(--accent)" : "var(--border-strong)"
                          }`,
                          flex: "0 0 auto",
                        }}
                      />
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {node.title}
                      </span>
                      {count > 0 ? (
                        <span style={{ color: "var(--fg-3)", marginLeft: "auto", paddingRight: "var(--sp-2)" }}>
                          {count}
                        </span>
                      ) : null}
                    </button>
                  </foreignObject>
                );
              })}
            </svg>
          </div>
        )}
      </PanelBody>
    </Panel>
  );
}

function StatusMetric({ value, label, tone }: { value: number; label: string; tone?: ContextTreeChangeType }) {
  return (
    <span className="inline-flex items-baseline text-label" style={{ color: "var(--fg-3)", gap: "var(--sp-1)" }}>
      <span className="font-semibold" style={{ color: tone ? changeColor(tone) : "var(--fg)" }}>
        {value}
      </span>
      <span>{label}</span>
    </span>
  );
}

function SummaryPill({ label, tone, strong }: { label: string; tone?: ContextTreeChangeType; strong?: boolean }) {
  return (
    <span
      className={`text-label ${strong ? "font-semibold" : "font-medium"}`}
      style={{
        color: tone ? changeColor(tone) : "var(--fg)",
        background: tone ? "var(--accent-bg)" : "var(--bg-sunken)",
        border: "var(--hairline) solid var(--border-faint)",
        borderRadius: "var(--radius-chip)",
        padding: "var(--sp-0_5) var(--sp-1_5)",
      }}
    >
      {label}
    </span>
  );
}

function ChangePill({ type }: { type: ContextTreeChangeType }) {
  return <SummaryPill label={changeBadgeLabel(type)} tone={type} />;
}

function SummaryBlock({ value, impact }: { value: string; impact: string }) {
  return (
    <div style={{ color: "var(--fg-2)" }}>
      <div className="text-label font-semibold" style={{ color: "var(--fg)", marginBottom: "var(--sp-1)" }}>
        Change summary
      </div>
      <div className="text-body">{value}</div>
      <div className="text-label" style={{ color: "var(--fg-3)", marginTop: "var(--sp-2)" }}>
        Impact: {impact}
      </div>
    </div>
  );
}

function ReferenceBlock({
  path,
  commit,
  linkedContextItems,
  owner,
  preview,
  sourceExpanded,
  onTogglePreview,
}: {
  path: string;
  commit: string;
  linkedContextItems: string[];
  owner: string;
  preview: string | null;
  sourceExpanded: boolean;
  onTogglePreview: () => void;
}) {
  const items: Array<{ label: string; value: string; mono?: boolean }> = [
    { label: "Owner", value: owner },
    ...(linkedContextItems.length > 0 ? [{ label: "Linked", value: linkedContextItems.join(", ") }] : []),
    { label: "Source", value: path, mono: true },
    { label: "Commit", value: commit, mono: true },
  ];

  return (
    <div>
      <div className="text-label font-semibold" style={{ color: "var(--fg-3)", marginBottom: "var(--sp-1)" }}>
        Reference
      </div>
      <dl className="grid grid-cols-1 md:grid-cols-2" style={{ columnGap: "var(--sp-4)", rowGap: "var(--sp-2)" }}>
        {items.map((item) => (
          <div
            key={item.label}
            className="grid"
            style={{ gridTemplateColumns: "4rem minmax(0,1fr)", gap: "var(--sp-2)" }}
          >
            <dt className="text-label font-semibold" style={{ color: "var(--fg-3)" }}>
              {item.label}
            </dt>
            <dd
              className={`text-label ${item.mono ? "font-mono" : "font-medium"}`}
              style={{
                color: "var(--fg-2)",
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {item.value}
            </dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-wrap" style={{ gap: "var(--sp-1)", marginTop: "var(--sp-3)" }}>
        <Button variant="outline" size="xs" onClick={onTogglePreview}>
          {sourceExpanded ? "Hide source" : "Preview source"}
        </Button>
        <Button variant="ghost" size="xs" onClick={() => void navigator.clipboard.writeText(path)}>
          <Copy size={14} />
          Copy path
        </Button>
      </div>
      {sourceExpanded ? (
        <div
          style={{
            borderTop: "var(--hairline) solid var(--border-faint)",
            marginTop: "var(--sp-3)",
            paddingTop: "var(--sp-3)",
          }}
        >
          {preview ? (
            <Markdown>{preview}</Markdown>
          ) : (
            <div className="text-body" style={{ color: "var(--fg-3)" }}>
              No source preview available.
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function LoadingState() {
  return (
    <Panel>
      <PanelBody>
        <div className="flex items-center text-body" style={{ color: "var(--fg-2)", gap: "var(--sp-2)" }}>
          <RefreshCw size={17} />
          Loading team context...
        </div>
      </PanelBody>
    </Panel>
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
    ? "Hub cannot read the team Context Tree yet. Agents and users will see context here after the server can sync the configured repo."
    : "Connect a Context Tree repo to show the team knowledge agents can use.";
  const repoLabel = snapshot.repo ? redactRepoForDisplay(snapshot.repo) : null;
  return (
    <Panel>
      <PanelBody>
        <div className="flex items-start text-body" style={{ color: "var(--fg-2)", gap: "var(--sp-2)" }}>
          <AlertTriangle size={18} style={{ color: "var(--warn)" }} />
          <div>
            <div className="font-semibold" style={{ color: "var(--fg)" }}>
              {title}
            </div>
            <div style={{ marginTop: "var(--sp-1)" }}>{detail}</div>
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

function redactRepoForDisplay(repo: string): string {
  return repo.replace(/(https?:\/\/)[^/@\s]+@/g, "$1[redacted]@");
}

function EmptyChanges() {
  return (
    <div className="text-body" style={{ color: "var(--fg-3)" }}>
      No context updates in this time window.
    </div>
  );
}

type LayoutNode = ContextTreeNode & {
  x: number;
  y: number;
  parent: LayoutNode | null;
};

function layoutTree(nodes: ContextTreeNode[]): LayoutNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const validNodes = nodes
    .filter((node) => !node.parentId || byId.has(node.parentId))
    .sort((a, b) => a.path.localeCompare(b.path));
  if (validNodes.length === 0) return [];

  const root = stratify<ContextTreeNode>()
    .id((node) => node.id)
    .parentId((node) => node.parentId)(validNodes)
    .sort((a, b) => a.data.path.localeCompare(b.data.path));
  const pointRoot = tree<ContextTreeNode>().nodeSize([34, 96])(root);
  const points = pointRoot.descendants();
  const minX = Math.min(...points.map((point) => point.x));
  const laidOut = points.map((point) => ({
    ...point.data,
    x: 24 + point.y,
    y: 24 + point.x - minX,
    parent: null,
  }));

  return laidOut.map((node, _index, all) => ({
    ...node,
    parent: node.parentId ? (all.find((candidate) => candidate.id === node.parentId) ?? null) : null,
  }));
}

function changedCounts(nodes: ContextTreeNode[]): Map<string, number> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const counts = new Map<string, number>();
  for (const node of nodes) {
    if (!node.changeType) continue;
    let current: ContextTreeNode | undefined = node;
    while (current) {
      counts.set(current.id, (counts.get(current.id) ?? 0) + 1);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
  }
  return counts;
}

function windowSummary(window: ContextTreeWindow): string {
  return CONTEXT_WINDOWS.find((option) => option.value === window)?.summary ?? "last 7 days";
}

function severityColor(severity: ContextTreeSnapshot["contextStatus"]["severity"]): string {
  if (severity === "ok") return "var(--ok)";
  if (severity === "warning") return "var(--warn)";
  return "var(--danger)";
}

function changeBadgeLabel(type: ContextTreeChangeType): string {
  if (type === "added") return "New";
  if (type === "removed") return "Removed";
  return "Updated";
}

function changeTypeLabel(type: ContextTreeChangeType): string {
  if (type === "added") return "New knowledge";
  if (type === "removed") return "Removed knowledge";
  return "Updated knowledge";
}

function updateDetailMeaning(update: ContextTreeUpdate): string {
  if (update.changeType === "added") {
    return `Agents can use new team knowledge when working on ${update.affectedContextArea}.`;
  }
  if (update.changeType === "removed") {
    return `Agents should stop using the old team knowledge for ${update.affectedContextArea}.`;
  }
  return `Agents can use updated team knowledge when working on ${update.affectedContextArea}.`;
}

function updateCardHeadline(update: ContextTreeUpdate): string {
  const actor = update.changedBy ?? "Someone";
  const action = update.changeType === "added" ? "added" : update.changeType === "removed" ? "removed" : "updated";
  return `${actor} ${action} ${update.title}`;
}

function changedByLabel(update: ContextTreeUpdate): string {
  const actor = update.changedBy ?? "Someone";
  const action = update.changeType === "added" ? "Added" : update.changeType === "removed" ? "Removed" : "Updated";
  return `${action} by ${actor}`;
}

function updateDetailActivity(update: ContextTreeUpdate): string {
  const actor = update.changedBy ?? "Someone";
  const action = update.changeType === "added" ? "added" : update.changeType === "removed" ? "removed" : "updated";
  const summary = usefulSummary(update);
  return summary ? `${actor} ${action} ${update.title}: ${summary}` : `${actor} ${action} ${update.title}.`;
}

function summaryText(update: ContextTreeUpdate): string {
  return update.summary.replace(/^updated:\s*/i, "");
}

function usefulSummary(update: ContextTreeUpdate): string | null {
  const summary = summaryText(update);
  const generic = new Set(["updated this team knowledge", "added this team knowledge", "removed this team knowledge"]);
  if (generic.has(summary.toLowerCase())) return null;
  if (summary.length < 12) return null;
  if (/[,;:]$/.test(summary)) return null;
  return summary;
}

function ownerText(owners: string[]): string {
  if (owners.length === 0) return "No owner";
  if (owners.length === 1) return owners[0] ?? "No owner";
  return owners.join(", ");
}

function ownerLine(owners: string[]): string {
  if (owners.length === 0) return "Owner not set";
  if (owners.length === 1) return `Owner: ${owners[0] ?? "Unknown"}`;
  return `Owners: ${owners.join(", ")}`;
}

function relatedText(count: number): string {
  return `${count} linked context${count === 1 ? "" : "s"}`;
}

function areaLabel(path: string): string | null {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 1) return null;
  return parts.slice(0, -1).map(titleFromPathSegment).join(" / ");
}

function pathLabel(path: string): string {
  return path.split("/").filter(Boolean).map(titleFromPathSegment).join(" / ") || "root";
}

function titleFromPathSegment(segment: string): string {
  return segment
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim();
}

function changeColor(type: ContextTreeChangeType): string {
  if (type === "added") return "var(--ok)";
  if (type === "edited") return "var(--warn)";
  return "var(--danger)";
}

function nodeColor(type: ContextTreeChangeType | null, selected: boolean): string {
  if (selected) return "var(--accent)";
  if (type === "added") return "var(--ok)";
  if (type === "edited") return "var(--warn)";
  if (type === "removed") return "var(--danger)";
  return "var(--bg-raised)";
}
