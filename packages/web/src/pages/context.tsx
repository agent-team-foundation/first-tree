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
import { useAuth } from "../auth/auth-context.js";
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
  const { organizationId } = useAuth();
  const [window, setWindow] = useState<ContextTreeWindow>("7d");
  const [selectedUpdateId, setSelectedUpdateId] = useState<string | null>(null);
  const [selectedOverviewNodeId, setSelectedOverviewNodeId] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ["context-tree-snapshot", organizationId, window],
    queryFn: () => {
      if (!organizationId) throw new Error("No organization selected");
      return getContextTreeSnapshot(organizationId, window);
    },
    enabled: !!organizationId,
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
  const statusTitle = snapshot.contextStatus.label;
  const revisionLabel = contextRevisionLabel(snapshot);
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
                  {statusTitle}
                </div>
                {revisionLabel ? (
                  <div className="text-label font-medium" style={{ color: "var(--fg-3)" }}>
                    {revisionLabel}
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
  const counts = useMemo(() => changedCounts(snapshot.nodes), [snapshot.nodes]);
  const visibleNodes = useMemo(
    () => layoutTree(snapshot.nodes, selectedNodeId, counts),
    [selectedNodeId, snapshot.nodes, counts],
  );
  const width = Math.max(760, ...visibleNodes.map((node) => node.x + 280));
  const height = Math.max(280, ...visibleNodes.map((node) => node.y + 48));
  // Render the SVG at its natural pixel height so nodes never get squished by
  // `preserveAspectRatio="meet"`. When the tree is taller than the soft cap, the
  // container scrolls instead — keeps small trees compact, big trees readable.
  const naturalHeight = Math.max(220, height + 24);
  const SOFT_HEIGHT_CAP = 360;
  const overflowsCap = naturalHeight > SOFT_HEIGHT_CAP;
  const selectedPath = overviewSelectedPath(snapshot.nodes, selectedNodeId);

  return (
    <Panel>
      <PanelHeader>
        <div>
          <PanelTitle>
            <FolderTree size={17} />
            Where Context Changed
          </PanelTitle>
          <div className="text-label" style={{ color: "var(--fg-3)", marginTop: "var(--sp-1)" }}>
            Numbers = updated areas under each branch.
          </div>
        </div>
      </PanelHeader>
      <PanelBody>
        {visibleNodes.length === 0 ? (
          <UnavailableState snapshot={snapshot} />
        ) : (
          <div className="flex flex-col" style={{ gap: "var(--sp-3)" }}>
            <div
              className="flex flex-wrap items-center"
              style={{
                columnGap: "var(--sp-4)",
                rowGap: "var(--sp-1_5)",
              }}
            >
              <div
                className="flex flex-wrap items-center text-label"
                style={{ color: "var(--fg-3)", gap: "var(--sp-1_5)" }}
              >
                <span className="font-semibold" style={{ color: "var(--fg-2)" }}>
                  Selected
                </span>
                <span>{selectedPath ?? "No update selected"}</span>
              </div>
              <div className="flex flex-wrap items-center" style={{ gap: "var(--sp-2)" }}>
                <OverviewLegendItem color="var(--accent)" label="Selected path" />
                <OverviewLegendItem color="var(--accent-bg)" label="Updated" />
                <OverviewLegendItem color="var(--bg-raised)" label="Quiet / hidden" />
              </div>
            </div>
            <div
              style={{
                overflow: overflowsCap ? "auto" : "hidden",
                maxHeight: overflowsCap ? `${SOFT_HEIGHT_CAP}px` : undefined,
              }}
            >
              <svg
                viewBox={`0 0 ${width} ${height}`}
                role="img"
                aria-label="Context Tree overview"
                preserveAspectRatio="xMinYMin meet"
                style={{ display: "block", width: "100%", height: `${naturalHeight}px` }}
              >
                {visibleNodes.map((node) =>
                  node.parent ? (
                    <line
                      key={`edge:${node.id}`}
                      x1={node.parent.x}
                      y1={node.parent.y}
                      x2={node.x}
                      y2={node.y}
                      stroke={node.selectedPath && node.parent.selectedPath ? "var(--accent)" : "var(--border)"}
                      strokeOpacity={node.muted ? 0.34 : node.selectedPath ? 0.72 : 0.56}
                      strokeWidth={node.selectedPath && node.parent.selectedPath ? 1.6 : 1}
                    />
                  ) : null,
                )}
                {visibleNodes.map((node) => {
                  return (
                    <foreignObject key={node.id} x={node.x - 10} y={node.y - 15} width={width - node.x - 8} height={30}>
                      <button
                        type="button"
                        disabled={node.sourceNodeId === null}
                        onClick={() => {
                          if (node.sourceNodeId) onSelectNode(node.sourceNodeId);
                        }}
                        className="flex w-full items-center text-left text-label"
                        style={{
                          color: node.muted ? "var(--fg-3)" : "var(--fg)",
                          cursor: node.sourceNodeId ? "pointer" : "default",
                          gap: "var(--sp-2)",
                          opacity: node.muted ? 0.66 : 1,
                        }}
                      >
                        <span
                          aria-hidden="true"
                          style={{
                            width: node.selected ? "var(--sp-4)" : "var(--sp-3)",
                            height: node.selected ? "var(--sp-4)" : "var(--sp-3)",
                            borderRadius: "50%",
                            background: overviewNodeColor(node),
                            border: `${node.selected ? "var(--hairline-bold)" : "var(--hairline)"} solid ${
                              node.selected ? "var(--accent)" : "var(--border-strong)"
                            }`,
                            flex: "0 0 auto",
                          }}
                        />
                        <span
                          className={node.selectedPath ? "font-semibold" : "font-medium"}
                          style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                        >
                          {node.title}
                        </span>
                        {node.updateCount > 0 && !node.isSummary ? (
                          <span
                            className="font-semibold"
                            style={{
                              background: "var(--accent-bg)",
                              border: "var(--hairline) solid var(--border-faint)",
                              borderRadius: "var(--radius-chip)",
                              color: "var(--fg-2)",
                              flex: "0 0 auto",
                              padding: "0 var(--sp-1)",
                            }}
                          >
                            {node.updateCount}
                          </span>
                        ) : null}
                      </button>
                    </foreignObject>
                  );
                })}
              </svg>
            </div>
          </div>
        )}
      </PanelBody>
    </Panel>
  );
}

function OverviewLegendItem({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center text-label" style={{ color: "var(--fg-3)", gap: "var(--sp-1)" }}>
      <span
        aria-hidden="true"
        style={{
          background: color,
          border: "var(--hairline) solid var(--border-strong)",
          borderRadius: "50%",
          height: "var(--sp-2)",
          width: "var(--sp-2)",
        }}
      />
      <span>{label}</span>
    </span>
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
  const syncDetail = snapshot.contextStatus.detail;
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

const OVERVIEW_DEFAULT_DEPTH = 2;
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
  selected: boolean;
  selectedPath: boolean;
  muted: boolean;
};

type LayoutNode = OverviewDatum & {
  x: number;
  y: number;
  parent: LayoutNode | null;
};

function layoutTree(
  nodes: ContextTreeNode[],
  selectedNodeId: string | null,
  counts: Map<string, number>,
): LayoutNode[] {
  const overviewNodes = buildOverviewNodes(nodes, selectedNodeId, counts);
  if (overviewNodes.length === 0) return [];

  const root = stratify<OverviewDatum>()
    .id((node) => node.id)
    .parentId((node) => node.parentId)(overviewNodes)
    .sort((a, b) => {
      if (a.data.isSummary !== b.data.isSummary) return a.data.isSummary ? 1 : -1;
      return a.data.path.localeCompare(b.data.path);
    });
  const pointRoot = tree<OverviewDatum>().nodeSize([42, 190])(root);
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

function buildOverviewNodes(
  nodes: ContextTreeNode[],
  selectedNodeId: string | null,
  counts: Map<string, number>,
): OverviewDatum[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const validNodes = nodes
    .filter((node) => !node.parentId || byId.has(node.parentId))
    .sort((a, b) => a.path.localeCompare(b.path));
  if (validNodes.length === 0) return [];

  const childrenByParent = childMap(validNodes);
  const selectedPath = selectedPathIds(selectedNodeId, byId);
  const visibleIds = new Set<string>();
  const depthById = new Map<string, number>();

  for (const node of validNodes) {
    const depth = nodeDepth(node, byId, depthById);
    const updateCount = counts.get(node.id) ?? 0;
    if (
      depth <= OVERVIEW_DEFAULT_DEPTH ||
      selectedPath.has(node.id) ||
      (updateCount > 0 && depth <= OVERVIEW_CHANGED_BRANCH_DEPTH && node.kind !== "leaf")
    ) {
      addWithAncestors(node.id, byId, visibleIds);
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
        selected: selectedNodeId === node.id,
        selectedPath: selectedPathNode,
        muted: selectedActive && !selectedPathNode && updateCount === 0,
      };
    });

  const summaryNodes: OverviewDatum[] = [];
  for (const node of validNodes) {
    if (!visibleIds.has(node.id)) continue;
    const hiddenChildren = (childrenByParent.get(node.id) ?? []).filter((child) => !visibleIds.has(child.id));
    if (hiddenChildren.length === 0) continue;
    const changedHiddenCount = hiddenChildren.filter((child) => (counts.get(child.id) ?? 0) > 0).length;
    summaryNodes.push({
      id: `summary:${node.id}`,
      parentId: node.id,
      sourceNodeId: null,
      title: summaryTitle(hiddenChildren.length, changedHiddenCount),
      path: `${node.path}/~summary`,
      changeType: null,
      updateCount: changedHiddenCount,
      isSummary: true,
      selected: false,
      selectedPath: selectedPath.has(node.id),
      muted: selectedActive && !selectedPath.has(node.id),
    });
  }

  return [...realNodes, ...summaryNodes];
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

function overviewSelectedPath(nodes: ContextTreeNode[], selectedNodeId: string | null): string | null {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const path: string[] = [];
  let current = selectedNodeId ? byId.get(selectedNodeId) : undefined;
  while (current) {
    path.unshift(current.title);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path.length > 0 ? path.join(" / ") : null;
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
    return `${hiddenCount} hidden · ${changedHiddenCount} updated`;
  }
  return `${hiddenCount} hidden quiet area${hiddenCount === 1 ? "" : "s"}`;
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

function contextRevisionLabel(snapshot: ContextTreeSnapshot): string | null {
  const shortCommit = snapshot.headCommit?.slice(0, 7) ?? null;
  if (snapshot.branch && shortCommit) return `Source: ${snapshot.branch} @ ${shortCommit}`;
  if (snapshot.branch) return `Branch: ${snapshot.branch}`;
  if (shortCommit) return `Commit: ${shortCommit}`;
  return null;
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

function overviewNodeColor(node: LayoutNode): string {
  if (node.isSummary) return "var(--bg-sunken)";
  if (node.selected) return "var(--accent)";
  // Any updated node (leaf with a changeType, or branch with rollup updates) uses
  // accent-bg so the legend stays honest. Type details (added/edited/removed) are
  // still surfaced via ChangePill in the update list and Selected Change panel.
  if (node.changeType || node.updateCount > 0) return "var(--accent-bg)";
  return "var(--bg-raised)";
}
