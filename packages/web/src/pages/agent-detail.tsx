import type { RuntimeProvider } from "@agent-team-foundation/first-tree-hub-shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link2, MessageSquare, Play } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { type HubClient, listClients } from "./../api/activity.js";
import {
  type ClientStatusInfo,
  dryRunAgentConfig,
  getAgentClientStatus,
  getAgentConfig,
  updateAgentConfig,
} from "./../api/agent-config.js";
import {
  deleteAgent,
  getAgent,
  reactivateAgent,
  suspendAgent,
  type TestResult,
  testAgentConnection,
  updateAgent,
} from "./../api/agents.js";
import { ApiError } from "./../api/client.js";
import { listAgentSessions } from "./../api/sessions.js";
import { useAuth } from "./../auth/auth-context.js";
import { FirstTreeLogo } from "./../components/first-tree-logo.js";
import { Breadcrumb, BreadcrumbCurrent, BreadcrumbLink, BreadcrumbSep } from "./../components/ui/breadcrumb.js";
import { Button } from "./../components/ui/button.js";
import { DenseBadge, type DenseBadgeTone } from "./../components/ui/dense-badge.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "./../components/ui/dialog.js";
import { UppercaseLabel } from "./../components/ui/section-header.js";
import { StateChip } from "./../components/ui/state-chip.js";
import { Tile } from "./../components/ui/tile.js";
import { cn, formatDate } from "./../lib/utils.js";
import { canManageAgentDetail } from "./agent-detail/access.js";
import { getAgentTestActionState, isBindableClient } from "./agent-detail/action-state.js";
import { ContextBar } from "./agent-detail/context-bar.js";
import { DangerZone } from "./agent-detail/danger-zone.js";
import { EnvSection } from "./agent-detail/env-section.js";
import { GitSection } from "./agent-detail/git-section.js";
import { IdentitySection } from "./agent-detail/identity-section.js";
import { McpSection } from "./agent-detail/mcp-section.js";
import { ModelSection } from "./agent-detail/model-section.js";
import { PromptSection } from "./agent-detail/prompt-section.js";
import { ReBindDialog } from "./agent-detail/re-bind-dialog.js";
import { SaveBar, sectionAnchorId } from "./agent-detail/save-bar.js";
import { SectionDivider, SectionShell } from "./agent-detail/section-shell.js";
import { SetupSection } from "./agent-detail/setup-section.js";
import { deriveSaveHint } from "./agent-detail/status-bar.js";
import { type DraftSectionName, useConfigDraft } from "./agent-detail/use-config-draft.js";

type SidebarItem = {
  key: string;
  label: string;
  anchor: string;
  /** Items after the divider render with a visual separation. */
  divider?: boolean;
  /** Red dot accent for the Danger zone entry; the label itself stays neutral. */
  danger?: boolean;
};

const SECTION_ANCHORS = {
  // Anchor id stays "ad-overview" for back-compat with deep links from older
  // sessions; the visible heading reads "Profile" now.
  overview: "ad-overview",
  setup: "ad-setup",
  prompt: sectionAnchorId("prompt"),
  tools: sectionAnchorId("mcp"),
  advanced: "ad-advanced",
  danger: "ad-danger",
} as const;

function sectionToAnchor(section: DraftSectionName): string {
  if (section === "model") return SECTION_ANCHORS.setup;
  if (section === "mcp") return SECTION_ANCHORS.tools;
  if (section === "env" || section === "git") return SECTION_ANCHORS.advanced;
  return SECTION_ANCHORS.prompt;
}

/**
 * Flat sidebar with a divider before Danger zone. Autonomous agents get the
 * full editable list only when the caller can manage them; shared read-only
 * agents collapse to Profile because config and lifecycle routes are manage-only.
 */
function buildSidebar(isHuman: boolean, canManage: boolean): SidebarItem[] {
  const items: SidebarItem[] = [{ key: "overview", label: "Profile", anchor: SECTION_ANCHORS.overview }];
  if (!isHuman && canManage) {
    items.push(
      { key: "setup", label: "Setup", anchor: SECTION_ANCHORS.setup },
      { key: "prompt", label: "Prompt", anchor: SECTION_ANCHORS.prompt },
      { key: "tools", label: "Tools", anchor: SECTION_ANCHORS.tools },
      { key: "advanced", label: "Advanced", anchor: SECTION_ANCHORS.advanced },
    );
  }
  if (canManage) {
    items.push({ key: "danger", label: "Danger zone", anchor: SECTION_ANCHORS.danger, divider: true, danger: true });
  }
  return items;
}

export function AgentDetailPage() {
  const params = useParams<{ uuid: string }>();
  const uuid = params.uuid ?? "";
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { memberId, role } = useAuth();

  // Agent identity data
  const agentQuery = useQuery({
    queryKey: ["agent", uuid],
    queryFn: () => getAgent(uuid),
    enabled: !!uuid,
  });
  const canManageAgent = canManageAgentDetail(agentQuery.data, memberId, role);
  const canEditConfig = agentQuery.data?.type !== "human" && canManageAgent;

  const cfgQuery = useQuery({
    queryKey: ["agent-config", uuid],
    queryFn: () => getAgentConfig(uuid),
    enabled: !!uuid && canEditConfig,
  });

  const clientStatusQuery = useQuery({
    queryKey: ["agent-client-status", uuid],
    queryFn: () => getAgentClientStatus(uuid),
    enabled: !!uuid && agentQuery.data?.type !== "human",
  });

  const sessionsQuery = useQuery({
    queryKey: ["agent-sessions-active", uuid],
    queryFn: () => listAgentSessions(uuid, { state: "active" }),
    enabled: !!uuid && agentQuery.data?.type !== "human",
  });

  // All connected/known clients; used to resolve the bound computer's hostname
  // for the sticky context bar and Setup section. This is distinct from the
  // bind-dialog-gated query below (that one only fires when the dialog opens).
  const allClientsQuery = useQuery({
    queryKey: ["clients"],
    queryFn: listClients,
    enabled: !!uuid && canEditConfig,
    refetchInterval: 30_000,
  });

  // -- Config draft
  const draft = useConfigDraft(cfgQuery.data);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflictMsg, setConflictMsg] = useState<string | null>(null);
  const [dangerError, setDangerError] = useState<string | null>(null);
  const [remoteReloading, setRemoteReloading] = useState(false);
  // Flash an inline "Saved" check in the SaveBar for a short window after a
  // successful save. Cleared by any subsequent edit, error, or timer.
  const [justSaved, setJustSaved] = useState(false);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!cfgQuery.data) throw new Error("config not loaded");
      const patch = draft.buildPayloadPatch();
      return updateAgentConfig(uuid, { expectedVersion: cfgQuery.data.version, payload: patch });
    },
    onSuccess: (next) => {
      queryClient.setQueryData(["agent-config", uuid], next);
      draft.resetToConfig(next);
      setSaveError(null);
      setConflictMsg(null);
      setJustSaved(true);
    },
    onError: (err) => {
      setJustSaved(false);
      if (err instanceof ApiError && err.status === 409) {
        setConflictMsg("Someone else saved a newer version while you were editing.");
        setSaveError(null);
        return;
      }
      setSaveError(err instanceof Error ? err.message : String(err));
    },
  });

  // Clear the "Saved" flash shortly after it appears, and also whenever the
  // user touches the draft again (a new edit shouldn't show a stale success).
  useEffect(() => {
    if (!justSaved) return;
    const t = setTimeout(() => setJustSaved(false), 2500);
    return () => clearTimeout(t);
  }, [justSaved]);
  useEffect(() => {
    if (draft.summary.anyDirty) setJustSaved(false);
  }, [draft.summary.anyDirty]);

  const resetDraftToConfig = draft.resetToConfig;
  const reloadRemote = useCallback(async () => {
    setSaveError(null);
    setRemoteReloading(true);
    try {
      const latest = await queryClient.fetchQuery({
        queryKey: ["agent-config", uuid],
        queryFn: () => getAgentConfig(uuid),
        staleTime: 0,
      });
      resetDraftToConfig(latest);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setRemoteReloading(false);
      setConflictMsg(null);
    }
  }, [queryClient, uuid, resetDraftToConfig]);

  const jumpTo = useCallback((anchor: string) => {
    const el = document.getElementById(anchor);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  // Identity mutations
  const identityUpdateMutation = useMutation({
    mutationFn: (patch: Parameters<typeof updateAgent>[1]) => updateAgent(uuid, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agent", uuid] });
      queryClient.invalidateQueries({ queryKey: ["agents"] });
    },
  });

  // Lifecycle mutations
  const suspendMutation = useMutation({
    mutationFn: () => suspendAgent(uuid),
    onMutate: () => setDangerError(null),
    onSuccess: () => {
      setDangerError(null);
      queryClient.invalidateQueries({ queryKey: ["agent", uuid] });
    },
    onError: (err) => setDangerError(err instanceof Error ? err.message : String(err)),
  });
  const reactivateMutation = useMutation({
    mutationFn: () => reactivateAgent(uuid),
    onMutate: () => setDangerError(null),
    onSuccess: () => {
      setDangerError(null);
      queryClient.invalidateQueries({ queryKey: ["agent", uuid] });
    },
    onError: (err) => setDangerError(err instanceof Error ? err.message : String(err)),
  });
  const deleteMutation = useMutation({
    mutationFn: () => deleteAgent(uuid),
    onMutate: () => setDangerError(null),
    onSuccess: () => navigate("/team"),
    onError: (err) => setDangerError(err instanceof Error ? err.message : String(err)),
  });

  // Test connection
  const testMutation = useMutation({ mutationFn: () => testAgentConnection(uuid) });

  // Bind-client (agent ↔ client first-time binding) dialog state
  const [bindClientOpen, setBindClientOpen] = useState(false);
  const [bindClientSelected, setBindClientSelected] = useState<string>("");
  const [bindClientError, setBindClientError] = useState<string | null>(null);
  const [reBindOpen, setReBindOpen] = useState(false);
  const clientsQuery = useQuery({
    queryKey: ["clients"],
    queryFn: listClients,
    enabled: bindClientOpen,
  });
  const bindClientMutation = useMutation({
    mutationFn: (clientId: string) => updateAgent(uuid, { clientId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agent", uuid] });
      queryClient.invalidateQueries({ queryKey: ["agent-client-status", uuid] });
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      setBindClientOpen(false);
      setBindClientSelected("");
      setBindClientError(null);
    },
    onError: (err) => setBindClientError(err instanceof Error ? err.message : String(err)),
  });

  // Discard-draft confirm. Other delete confirms (adapter / user binding) live
  // in the Integrations page now that bindings CRUD has moved there.
  const [discardDialogOpen, setDiscardDialogOpen] = useState(false);

  const [dryRunText, setDryRunText] = useState<string | null>(null);
  const dryRunMutation = useMutation({
    mutationFn: () => dryRunAgentConfig(uuid, draft.buildPayloadPatch()),
    onSuccess: (result) => {
      const lines = result.diff.length ? result.diff.map((d) => `${d.op} ${d.path}`).join("\n") : "(no changes)";
      setDryRunText(lines);
    },
    onError: (err) => setDryRunText(`Dry run failed: ${err instanceof Error ? err.message : String(err)}`),
  });

  // Before navigating away with unsaved changes, warn.
  useEffect(() => {
    if (!draft.summary.anyDirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [draft.summary.anyDirty]);

  const isHumanLocal = agentQuery.data?.type === "human";
  const sidebarItems = useMemo(() => buildSidebar(isHumanLocal, canManageAgent), [isHumanLocal, canManageAgent]);

  // Sticky ContextBar visibility: hide while the page-top header is on screen,
  // show once the operator has scrolled past it. Driven by an IntersectionObserver
  // on a zero-height sentinel placed right under the top header.
  const headerSentinelRef = useRef<HTMLDivElement | null>(null);
  const [contextBarVisible, setContextBarVisible] = useState(false);
  useEffect(() => {
    if (isHumanLocal) return;
    const el = headerSentinelRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) return;
        // Show the bar only after the sentinel has scrolled *above* the viewport.
        setContextBarVisible(!entry.isIntersecting && entry.boundingClientRect.top < 0);
      },
      { threshold: 0 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [isHumanLocal]);

  // Sidebar scroll-spy: marks the section currently nearest the top of the
  // viewport as active, giving the operator a sense of place while scrolling.
  // rootMargin shrinks the observation window to a strip near the top so only
  // one section is "active" at a time.
  const [activeAnchor, setActiveAnchor] = useState<string>(SECTION_ANCHORS.overview);
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const observers: IntersectionObserver[] = [];
    for (const item of sidebarItems) {
      const el = document.getElementById(item.anchor);
      if (!el) continue;
      const obs = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) setActiveAnchor(item.anchor);
          }
        },
        // rootMargin shrinks the observation strip to the top 30% of the
        // viewport so only one section is "active" at a time as the user
        // scrolls. CSS margin allows unitless zero; this avoids the design-
        // token lint rule that bans `Npx` literals.
        { rootMargin: "0% 0% -70% 0%", threshold: 0 },
      );
      obs.observe(el);
      observers.push(obs);
    }
    return () => {
      for (const o of observers) o.disconnect();
    };
  }, [sidebarItems]);

  // Map dirty draft sections to their sidebar anchors so each item can render
  // a small dot when there are unsaved edits below.
  const dirtyAnchors = useMemo(() => {
    const set = new Set<string>();
    for (const s of draft.summary.dirtySections) {
      set.add(sectionToAnchor(s));
    }
    return set;
  }, [draft.summary.dirtySections]);

  if (agentQuery.isLoading) {
    return (
      <div className="-m-6 flex" style={{ minHeight: "100%" }}>
        <div className="p-6 text-body" style={{ color: "var(--fg-3)" }}>
          Loading…
        </div>
      </div>
    );
  }
  if (agentQuery.error) {
    return (
      <div className="-m-6 p-6 text-body" style={{ color: "var(--state-error)" }}>
        Failed to load agent: {agentQuery.error instanceof Error ? agentQuery.error.message : "Unknown error"}
      </div>
    );
  }
  const agent = agentQuery.data;
  if (!agent) {
    return (
      <div className="-m-6 p-6 text-body" style={{ color: "var(--fg-3)" }}>
        Agent not found
      </div>
    );
  }

  const isHuman = agent.type === "human";

  const clientStatus: ClientStatusInfo | undefined = clientStatusQuery.data;
  const activeSessions = sessionsQuery.data?.length ?? 0;
  const clientStatusInitialLoading = !isHuman && !clientStatus && clientStatusQuery.isLoading;
  const clientStatusError =
    clientStatusQuery.error instanceof Error
      ? clientStatusQuery.error.message
      : clientStatusQuery.error
        ? "Unknown"
        : null;
  const isUnclaimed = !isHuman && clientStatusQuery.isSuccess && !clientStatus?.clientId;
  const isOffline = !isHuman && clientStatus ? !clientStatus.online && !!clientStatus.clientId : false;
  const testAction = getAgentTestActionState({
    agentStatus: agent.status,
    clientStatus,
    clientStatusLoading: clientStatusInitialLoading,
    testPending: testMutation.isPending,
  });

  const runtimeExt = agent as Record<string, unknown>;
  const runtimeState = (runtimeExt.runtimeState as string | null) ?? null;
  const runtimeType = (runtimeExt.runtimeType as string | null) ?? null;
  const totalSessions = (runtimeExt.totalSessions as number | null) ?? null;

  const shortId = agent.uuid.slice(0, 8);

  const saveHint = deriveSaveHint({
    activeSessions,
    isUnclaimed,
    isOffline,
  });

  const mcpActive = draft.draft.mcp.filter((i) => i.status !== "deleted");
  const envActive = draft.draft.env.filter((i) => i.status !== "deleted");
  const gitActive = draft.draft.git.filter((i) => i.status !== "deleted");

  const mcpOtherNames = (exceptKey: string | null): ReadonlySet<string> =>
    new Set(mcpActive.filter((i) => i.key !== exceptKey).map((i) => i.value.name.toLowerCase()));
  const envOtherKeys = (exceptKey: string | null): ReadonlySet<string> =>
    new Set(envActive.filter((i) => i.key !== exceptKey).map((i) => i.value.key));
  const gitOtherPaths = (exceptKey: string | null): ReadonlySet<string> =>
    new Set(
      gitActive
        .filter((i) => i.key !== exceptKey)
        .map((i) => {
          const { value } = i;
          if (value.localPath) return value.localPath;
          const noQuery = value.url.split(/[?#]/)[0] ?? "";
          const last = noQuery.split(/[/:]/).filter(Boolean).pop() ?? "";
          return last.replace(/\.git$/i, "");
        })
        .filter(Boolean),
    );

  const tileValues = {
    sessions: totalSessions ?? "—",
    active: activeSessions,
    runtime: runtimeType ?? (isHuman ? "human" : "—"),
    model: cfgQuery.data?.payload.model?.trim() || "—",
  };

  // Resolve the bound client's display name (hostname, fallback to id) for the
  // sticky context bar and the Overview "Runs on …" row. The client list is
  // refetched in the background so a hostname that hasn't reported yet fills
  // in lazily rather than forcing a page reload.
  const boundClientId = clientStatus?.clientId ?? null;
  const boundClient: HubClient | null = boundClientId
    ? (allClientsQuery.data?.find((c) => c.id === boundClientId) ?? null)
    : null;
  const boundClientLabel: string | null =
    boundClientId && canEditConfig ? (boundClient?.hostname ?? boundClientId) : null;

  // Runtime provider label for the Setup "Where it runs" card. The agent
  // schema carries the authoritative `runtimeProvider` field post-0026; the
  // legacy `runtimeType` from presence is the *running* shape and may lag
  // briefly during a re-bind.
  const setupRuntimeProvider: RuntimeProvider = agent.runtimeProvider ?? "claude-code";
  const contextRuntimeLabel = setupRuntimeProvider === "codex" ? "Codex" : "Claude Code";

  return (
    <div className="-m-6 flex" style={{ minHeight: "calc(100vh - var(--sp-10))" }}>
      <aside
        className="shrink-0 overflow-auto"
        style={{
          width: 220,
          borderRight: "var(--hairline) solid var(--border)",
          background: "var(--bg-raised)",
          padding: "var(--sp-3) 0",
        }}
      >
        <UppercaseLabel style={{ display: "block", padding: "var(--sp-1) var(--sp-4) var(--sp-2)" }}>
          Agent
        </UppercaseLabel>
        {sidebarItems.map((it) => (
          <div key={it.key}>
            {it.divider && (
              <div
                aria-hidden
                style={{
                  margin: "var(--sp-2) var(--sp-3_5)",
                  borderTop: "var(--hairline) solid var(--border)",
                }}
              />
            )}
            <SidebarItem
              label={it.label}
              active={activeAnchor === it.anchor}
              danger={it.danger ?? false}
              dirty={dirtyAnchors.has(it.anchor)}
              onClick={() => jumpTo(it.anchor)}
            />
          </div>
        ))}
      </aside>

      <div className="flex-1 min-w-0 overflow-auto" style={{ background: "var(--bg)" }}>
        <div
          style={{
            padding: "var(--sp-3_5) var(--sp-5)",
            borderBottom: "var(--hairline) solid var(--border-faint)",
            background: "var(--bg-raised)",
          }}
        >
          <Breadcrumb style={{ marginBottom: "var(--sp-2)" }}>
            <BreadcrumbLink onClick={() => navigate("/team")}>Agents</BreadcrumbLink>
            <BreadcrumbSep />
            <BreadcrumbCurrent mono>{agent.name ?? shortId}</BreadcrumbCurrent>
          </Breadcrumb>
          <div className="flex items-center gap-3">
            <div
              className="inline-flex items-center justify-center"
              style={{
                width: 36,
                height: 36,
                borderRadius: "var(--radius-panel)",
                background: "var(--bg-active)",
                border: "var(--hairline) solid var(--border-strong)",
              }}
            >
              <FirstTreeLogo width={18} height={20} style={{ color: "var(--accent)" }} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline gap-2">
                <span className="text-title" title={`agt_${shortId}`}>
                  {agent.displayName}
                </span>
                <span className="mono text-label" style={{ color: "var(--fg-4)" }}>
                  @{agent.name ?? shortId}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-1.5 text-caption" style={{ color: "var(--fg-4)" }}>
                <DenseBadge tone={agent.type === "autonomous_agent" ? "accent" : "neutral"}>{agent.type}</DenseBadge>
                {agent.visibility && (
                  <DenseBadge tone={agent.visibility === "organization" ? "accent" : "outline"}>
                    {agent.visibility}
                  </DenseBadge>
                )}
                {clientStatus?.offlineSince && (
                  <span className="mono">offline since {formatDate(clientStatus.offlineSince)}</span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <StateChip state={runtimeState} />
              <Button variant="ghost" size="xs" onClick={() => navigate(`/?a=${agent.uuid}`)}>
                <MessageSquare className="h-3 w-3" /> Open chat
              </Button>
              {!isHuman && canManageAgent && agent.status === "active" && (
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => {
                    testMutation.reset();
                    testMutation.mutate();
                  }}
                  disabled={testAction.disabled}
                  title={testAction.title}
                >
                  <Play className="h-3 w-3" />
                  {testMutation.isPending ? "Testing…" : "Test"}
                </Button>
              )}
            </div>
          </div>
          <div className="grid gap-1.5 mt-3" style={{ gridTemplateColumns: "repeat(4, 1fr)" }}>
            <Tile label="sessions" value={tileValues.sessions} />
            <Tile
              label="active"
              value={tileValues.active}
              accent={typeof tileValues.active === "number" && tileValues.active > 0 ? "var(--accent)" : undefined}
            />
            <Tile label="runtime" value={tileValues.runtime} />
            <Tile label="model" value={tileValues.model} />
          </div>
        </div>
        {/* Sentinel observed by the ContextBar IntersectionObserver above. */}
        <div ref={headerSentinelRef} aria-hidden style={{ height: 0 }} />

        {!isHuman && (
          <ContextBar runtimeLabel={contextRuntimeLabel} computerLabel={boundClientLabel} visible={contextBarVisible} />
        )}

        <div
          className="mx-auto"
          style={{
            padding: "var(--sp-3_5) var(--sp-5) var(--sp-7)",
            maxWidth: 960,
            display: "flex",
            flexDirection: "column",
            gap: 20,
          }}
        >
          {(testMutation.data || testMutation.error) && (
            <TestResultCard
              result={testMutation.data ?? { status: "error", message: "Failed to reach server" }}
              onDismiss={() => testMutation.reset()}
            />
          )}

          <SectionShell
            anchorId={SECTION_ANCHORS.overview}
            title="Profile"
            right={
              canManageAgent ? (
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => navigate(`/settings/integrations?agent=${agent.uuid}`)}
                  title="Manage platform bindings in Integrations"
                >
                  <Link2 className="h-3 w-3" />
                  Manage bindings
                </Button>
              ) : null
            }
          >
            <IdentitySection
              agent={agent}
              canEdit={canManageAgent}
              onSave={async (patch) => {
                await identityUpdateMutation.mutateAsync(patch);
              }}
            />
          </SectionShell>

          {!isHuman && !canManageAgent && <ReadOnlyConfigNotice />}

          {canEditConfig && (
            <>
              <SectionShell
                anchorId={SECTION_ANCHORS.setup}
                title="Setup"
                caption={
                  cfgQuery.data?.version != null ? (
                    <span className="mono">
                      config v{cfgQuery.data.version}
                      {draft.summary.anyDirty && (
                        <>
                          {" · "}
                          <span style={{ color: "var(--state-blocked)" }}>draft</span>
                        </>
                      )}
                    </span>
                  ) : null
                }
              >
                {cfgQuery.isLoading && (
                  <div className="text-body" style={{ color: "var(--fg-3)" }}>
                    Loading configuration…
                  </div>
                )}
                {cfgQuery.error && (
                  <div className="text-body" style={{ color: "var(--state-error)" }}>
                    Failed to load configuration: {String(cfgQuery.error)}
                  </div>
                )}
                {cfgQuery.data && (
                  <SetupSection
                    runtimeProvider={setupRuntimeProvider}
                    computerLabel={boundClientLabel}
                    computerStatusLoading={clientStatusInitialLoading}
                    computerStatusError={clientStatusError}
                    canBindComputer={isUnclaimed && agent.status === "active"}
                    bindComputerPending={bindClientMutation.isPending}
                    onBindComputer={() => setBindClientOpen(true)}
                    onRebind={agent.clientId ? () => setReBindOpen(true) : undefined}
                    modelSlot={
                      <ModelSection
                        value={draft.draft.model}
                        baseline={cfgQuery.data?.payload.model ?? ""}
                        onChange={draft.setModel}
                        onRevert={draft.revertModel}
                        disabled={agent.status !== "active"}
                        provider={setupRuntimeProvider}
                      />
                    }
                  />
                )}
              </SectionShell>

              <SectionShell anchorId={SECTION_ANCHORS.prompt} title="Prompt">
                {cfgQuery.data ? (
                  <PromptSection
                    value={draft.draft.promptAppend}
                    baseline={cfgQuery.data?.payload.prompt.append ?? ""}
                    onChange={draft.setPromptAppend}
                    onRevert={draft.revertPrompt}
                    disabled={agent.status !== "active"}
                  />
                ) : null}
              </SectionShell>

              <SectionShell
                anchorId={SECTION_ANCHORS.tools}
                title="Tools"
                caption="MCP servers available to this agent"
              >
                {cfgQuery.data ? (
                  <McpSection
                    items={draft.draft.mcp}
                    otherNames={mcpOtherNames}
                    onAdd={draft.addMcp}
                    onUpdate={draft.updateMcp}
                    onDelete={draft.deleteMcp}
                    onUndoDelete={draft.undoDeleteMcp}
                    disabled={agent.status !== "active"}
                  />
                ) : null}
              </SectionShell>

              <SectionShell
                anchorId={SECTION_ANCHORS.advanced}
                title="Advanced"
                caption="Environment variables and git repositories the runtime clones into each session."
              >
                {cfgQuery.data && (
                  <div className="space-y-4">
                    <div id={sectionAnchorId("env")}>
                      <EnvSection
                        items={draft.draft.env}
                        otherKeys={envOtherKeys}
                        onAdd={draft.addEnv}
                        onUpdate={draft.updateEnv}
                        onDelete={draft.deleteEnv}
                        onUndoDelete={draft.undoDeleteEnv}
                        disabled={agent.status !== "active"}
                      />
                    </div>
                    <div id={sectionAnchorId("git")}>
                      <GitSection
                        items={draft.draft.git}
                        otherPaths={gitOtherPaths}
                        onAdd={draft.addGit}
                        onUpdate={draft.updateGit}
                        onDelete={draft.deleteGit}
                        onUndoDelete={draft.undoDeleteGit}
                        disabled={agent.status !== "active"}
                      />
                    </div>
                    {dryRunText && (
                      <pre
                        className="whitespace-pre-wrap mono text-label"
                        style={{
                          padding: "var(--sp-2)",
                          borderRadius: "var(--radius-input)",
                          background: "var(--bg-sunken)",
                          border: "var(--hairline) solid var(--border-faint)",
                          color: "var(--fg-2)",
                        }}
                      >
                        {dryRunText}
                      </pre>
                    )}
                    {draft.summary.anyDirty && (
                      <div className="text-label" style={{ color: "var(--fg-3)" }}>
                        <button
                          type="button"
                          onClick={() => dryRunMutation.mutate()}
                          className="underline bg-transparent border-0 cursor-pointer"
                          style={{ color: "var(--fg-3)" }}
                          disabled={dryRunMutation.isPending}
                        >
                          {dryRunMutation.isPending ? "Computing dry-run…" : "Preview server-side diff"}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </SectionShell>
            </>
          )}

          {canManageAgent && (
            <>
              <SectionDivider />

              <DangerZone
                agent={agent}
                suspendPending={suspendMutation.isPending}
                reactivatePending={reactivateMutation.isPending}
                deletePending={deleteMutation.isPending}
                errorMessage={dangerError}
                onSuspend={() => suspendMutation.mutate()}
                onReactivate={() => reactivateMutation.mutate()}
                onDelete={() => deleteMutation.mutate()}
              />
            </>
          )}
        </div>

        {canEditConfig && (
          <SaveBar
            summary={draft.summary}
            saveHint={saveHint}
            conflictMessage={conflictMsg}
            errorMessage={saveError}
            saving={saveMutation.isPending}
            reloadingRemote={remoteReloading}
            justSaved={justSaved}
            onSave={() => saveMutation.mutate()}
            onDiscard={() => {
              if (!draft.summary.anyDirty) return;
              setDiscardDialogOpen(true);
            }}
            onReloadRemote={() => {
              void reloadRemote();
            }}
            onJumpTo={(section) => jumpTo(sectionToAnchor(section))}
          />
        )}
      </div>

      <ConfirmDialog
        open={discardDialogOpen}
        onOpenChange={setDiscardDialogOpen}
        title="Discard unsaved changes?"
        description="Your edits to Prompt / Model / Tools / Advanced will be reverted to the last saved baseline."
        confirmLabel="Discard changes"
        destructive
        onConfirm={() => {
          draft.resetAll();
          setSaveError(null);
          setConflictMsg(null);
          setDiscardDialogOpen(false);
        }}
      />

      <Dialog
        open={bindClientOpen}
        onOpenChange={(open) => {
          setBindClientOpen(open);
          if (!open) {
            setBindClientSelected("");
            setBindClientError(null);
            bindClientMutation.reset();
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Bind computer</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-body" style={{ color: "var(--fg-3)" }}>
              Pick a computer you own to pin this agent to. The bind is one-shot — once set, moving the agent requires
              deleting and re-creating it on the target computer.
            </p>
            {clientsQuery.isLoading ? (
              <div className="text-body" style={{ color: "var(--fg-3)" }}>
                Loading computers…
              </div>
            ) : clientsQuery.error ? (
              <div className="text-body" style={{ color: "var(--state-error)" }}>
                Failed to load computers: {clientsQuery.error instanceof Error ? clientsQuery.error.message : "Unknown"}
              </div>
            ) : (
              <BindClientList
                clients={clientsQuery.data ?? []}
                selected={bindClientSelected}
                onSelect={setBindClientSelected}
              />
            )}
            {bindClientError && (
              <div className="text-body" style={{ color: "var(--state-error)" }}>
                {bindClientError}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBindClientOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!bindClientSelected || bindClientMutation.isPending}
              onClick={() => {
                setBindClientError(null);
                bindClientMutation.mutate(bindClientSelected);
              }}
            >
              {bindClientMutation.isPending ? "Binding…" : "Bind"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ReBindDialog open={reBindOpen} onOpenChange={setReBindOpen} agent={agent} />
    </div>
  );
}

function ReadOnlyConfigNotice() {
  return (
    <SectionShell anchorId="ad-runtime-readonly" title="Runtime configuration">
      <div
        className="text-body"
        style={{
          padding: "var(--sp-3)",
          border: "var(--hairline) solid var(--border-faint)",
          borderRadius: "var(--radius-panel)",
          background: "var(--bg-raised)",
          color: "var(--fg-3)",
        }}
      >
        You can view this shared agent profile. Runtime configuration, bindings, testing, and lifecycle controls are
        limited to the agent manager or an organization admin.
      </div>
    </SectionShell>
  );
}

/**
 * Sidebar entry. Renders an active-state left bar, a small unsaved-changes dot
 * for sections that hold draft edits below them, and a softened danger
 * treatment (neutral text with a red dot) for the Danger zone link.
 */
function SidebarItem({
  label,
  active,
  danger,
  dirty,
  onClick,
}: {
  label: string;
  active: boolean;
  danger: boolean;
  dirty: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "block w-full text-left bg-transparent text-body transition-colors cursor-pointer",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        active ? "" : "hover:bg-accent",
      )}
      style={{
        padding: "var(--sp-1_25) var(--sp-4) var(--sp-1_25) var(--sp-3_5)",
        border: "none",
        borderLeft: `var(--hairline-bold) solid ${active ? "var(--accent)" : "transparent"}`,
        background: active ? "var(--bg-active)" : "transparent",
        color: active ? "var(--fg)" : "var(--fg-3)",
        fontWeight: active ? 500 : 400,
      }}
    >
      <span className="flex items-center gap-2">
        <span className="flex-1 truncate">{label}</span>
        {dirty && (
          <span
            role="img"
            aria-label="unsaved changes"
            style={{
              width: "var(--sp-1_5)",
              height: "var(--sp-1_5)",
              borderRadius: "50%",
              background: "var(--state-blocked)",
              flexShrink: 0,
            }}
          />
        )}
        {danger && !dirty && (
          <span
            aria-hidden
            style={{
              width: "var(--sp-1_5)",
              height: "var(--sp-1_5)",
              borderRadius: "50%",
              background: "var(--state-error)",
              flexShrink: 0,
            }}
          />
        )}
      </span>
    </button>
  );
}

/**
 * Simple confirm dialog used for the remaining non-delete destructive actions
 * (remove binding / remove bot binding / discard draft). The delete-agent flow
 * lives in `DangerZone` and has its own type-the-name guard.
 */
function ConfirmDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  pending?: boolean;
  destructive?: boolean;
}) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-body" style={{ color: "var(--fg-2)" }}>
          {props.description}
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => props.onOpenChange(false)} disabled={props.pending}>
            Cancel
          </Button>
          <Button
            type="button"
            variant={props.destructive ? "destructive" : "default"}
            onClick={props.onConfirm}
            disabled={props.pending}
          >
            {props.pending ? "Working…" : props.confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── bind-client picker ──────────────────────────────────────────────

function BindClientList({
  clients,
  selected,
  onSelect,
}: {
  clients: HubClient[];
  selected: string;
  onSelect: (id: string) => void;
}) {
  const bindable = clients.filter(isBindableClient);
  if (bindable.length === 0) {
    return (
      <div
        className="text-body"
        style={{
          background: "var(--bg-sunken)",
          border: "var(--hairline) solid var(--border-faint)",
          borderRadius: "var(--radius-input)",
          padding: "var(--sp-2_5) var(--sp-3)",
          color: "var(--fg-3)",
        }}
      >
        No connected computers available. Run{" "}
        <code className="mono text-label">first-tree-hub client connect &lt;url&gt;</code> on the computer that should
        run this agent, then reopen this dialog.
      </div>
    );
  }
  return (
    <ul
      className="max-h-64 overflow-y-auto"
      style={{
        border: "var(--hairline) solid var(--border)",
        borderRadius: "var(--radius-input)",
        margin: 0,
        padding: 0,
        listStyle: "none",
      }}
    >
      {bindable.map((c) => {
        const picked = c.id === selected;
        return (
          <li key={c.id} style={{ borderTop: "var(--hairline) solid var(--border-faint)" }}>
            <button
              type="button"
              onClick={() => onSelect(c.id)}
              className={cn("w-full text-left flex items-center gap-3")}
              style={{
                padding: "var(--sp-2) var(--sp-3)",
                background: picked ? "var(--accent-bg)" : "transparent",
                border: "none",
                cursor: "pointer",
              }}
            >
              <span
                className={cn("inline-block h-2 w-2 rounded-full shrink-0")}
                style={{ background: isBindableClient(c) ? "var(--state-idle)" : "var(--fg-4)" }}
                aria-hidden
              />
              <span className="flex-1 min-w-0">
                <span className="block text-body truncate font-medium">{c.hostname ?? c.id}</span>
                <span className="block mono truncate text-caption" style={{ color: "var(--fg-4)" }}>
                  {c.id}
                  {c.os ? ` · ${c.os}` : ""}
                  {c.sdkVersion ? ` · SDK ${c.sdkVersion}` : ""}
                </span>
              </span>
              <span className="text-label" style={{ color: "var(--fg-3)" }}>
                {c.status}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// ─── test connection card ────────────────────────────────────────────

const STATUS_LABELS: Record<TestResult["status"], string> = {
  success: "Connected",
  timeout: "Timed out",
  offline: "Offline",
  stale: "Stale",
  error: "Error",
};

const TEST_RESULT_BORDER: Record<TestResult["status"], string> = {
  success: "var(--state-idle)",
  timeout: "var(--state-blocked)",
  offline: "var(--state-offline)",
  stale: "var(--state-blocked)",
  error: "var(--state-error)",
};

const TEST_RESULT_TONE: Record<TestResult["status"], DenseBadgeTone> = {
  success: "accent",
  timeout: "warn",
  stale: "warn",
  error: "error",
  offline: "neutral",
};

function TestResultCard({ result, onDismiss }: { result: TestResult; onDismiss: () => void }) {
  const borderColor = TEST_RESULT_BORDER[result.status];
  const badgeTone = TEST_RESULT_TONE[result.status];

  const conn = result.connection;

  return (
    <div
      style={{
        background: "var(--bg-raised)",
        border: "var(--hairline) solid var(--border)",
        borderLeft: `var(--sp-0_75) solid ${borderColor}`,
        borderRadius: "var(--radius-panel)",
        padding: "var(--sp-3) var(--sp-3_5)",
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <DenseBadge tone={badgeTone}>{STATUS_LABELS[result.status]}</DenseBadge>
            {result.responseTime != null && (
              <span className="mono text-label" style={{ color: "var(--fg-4)" }}>
                {(result.responseTime / 1000).toFixed(1)}s
              </span>
            )}
          </div>
          {result.message && (
            <p className="text-body" style={{ color: "var(--fg-3)" }}>
              {result.message}
            </p>
          )}
          {conn && (
            <div
              className="text-label"
              style={{
                color: "var(--fg-3)",
                borderTop: "var(--hairline) solid var(--border-faint)",
                paddingTop: 6,
                marginTop: 2,
              }}
            >
              <div>{conn.runtimeState && <span className="mono">runtime: {conn.runtimeState}</span>}</div>
              {conn.client ? (
                <div>
                  Computer: {conn.client.hostname ?? conn.client.id}
                  {conn.client.os && ` (${conn.client.os})`}
                  {conn.client.sdkVersion && ` · SDK ${conn.client.sdkVersion}`}
                </div>
              ) : (
                <div>No computer bound</div>
              )}
              {conn.lastSeenAt && <div>Last seen: {new Date(conn.lastSeenAt).toLocaleString()}</div>}
            </div>
          )}
          {result.responseContent && (
            <p
              className="mono whitespace-pre-wrap text-label"
              style={{
                background: "var(--bg-sunken)",
                border: "var(--hairline) solid var(--border-faint)",
                borderRadius: "var(--radius-input)",
                padding: 8,
                maxHeight: 160,
                overflow: "auto",
              }}
            >
              {result.responseContent}
            </p>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}
