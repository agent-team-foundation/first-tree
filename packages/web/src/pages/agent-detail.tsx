import type { RuntimeProvider } from "@first-tree/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, MessageSquare, Play } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Outlet, useLocation, useNavigate, useParams } from "react-router";
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
import { Avatar } from "./../components/avatar.js";
import { Breadcrumb, BreadcrumbCurrent, BreadcrumbLink, BreadcrumbSep } from "./../components/ui/breadcrumb.js";
import { Button } from "./../components/ui/button.js";
import { DenseBadge, type DenseBadgeTone } from "./../components/ui/dense-badge.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "./../components/ui/dialog.js";
import { PresenceChip, runtimeStateToPresence } from "./../components/ui/presence-chip.js";
import { humanizeAgentType, humanizeVisibility } from "./../lib/agent-labels.js";
import { cn, formatDate } from "./../lib/utils.js";
import { canManageAgentDetail } from "./agent-detail/access.js";
import { getAgentTestActionState, isBindableClient } from "./agent-detail/action-state.js";
import { ContextBar } from "./agent-detail/context-bar.js";
import type { AgentDetailContext } from "./agent-detail/layout-context.js";
import { ReBindDialog } from "./agent-detail/re-bind-dialog.js";
import { SaveBar } from "./agent-detail/save-bar.js";
import { deriveSaveHint } from "./agent-detail/save-hint.js";
import { type DraftSectionName, useConfigDraft } from "./agent-detail/use-config-draft.js";
import { useLegacyAnchorRedirect } from "./agent-detail/use-legacy-anchor-redirect.js";

const SECTION_TO_TAB: Record<DraftSectionName, string> = {
  prompt: "prompt",
  model: "setup",
  effort: "setup",
  mcp: "tools",
  env: "resources",
  git: "resources",
};

type TabDef = { key: string; label: string; path: string };

function buildTabs(canEditConfig: boolean): TabDef[] {
  const tabs: TabDef[] = [{ key: "profile", label: "Profile", path: "profile" }];
  if (canEditConfig) {
    tabs.push(
      { key: "setup", label: "Setup", path: "setup" },
      { key: "prompt", label: "Prompt", path: "prompt" },
      { key: "tools", label: "Tools", path: "tools" },
      { key: "resources", label: "Resources", path: "resources" },
    );
  }
  // Human agents have no runtime to configure. Danger zone (suspend / delete)
  // lives on the Profile tab, so they don't need a Setup tab entry either —
  // it would render blank without any rows to show.
  return tabs;
}

export function AgentDetailPage() {
  const params = useParams<{ uuid: string }>();
  const uuid = params.uuid ?? "";
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const location = useLocation();
  const { memberId, role } = useAuth();
  useLegacyAnchorRedirect();

  const agentQuery = useQuery({
    queryKey: ["agent", uuid],
    queryFn: () => getAgent(uuid),
    enabled: !!uuid,
    // The header `<PresenceChip>` and the Test-action gate both derive
    // from `agent.runtimeState` off this query. No admin-WS frame
    // invalidates `["agent"]` today, so without polling an agent that
    // goes offline / reconnects while the page stays open would keep
    // showing the cached value. Match the 10s cadence the legacy
    // `/activity` poll used before this surface migrated off it.
    refetchInterval: 10_000,
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
    // Drives `isUnclaimed` (`!clientStatus?.clientId`), `isOffline`'s
    // bound-vs-unclaimed qualifier, and the "offline since {date}"
    // subtitle. None of those are pushed through the admin WS, so match
    // the 10s polling cadence that `agentQuery` above (and the legacy
    // `/activity` poll) used.
    refetchInterval: 10_000,
  });

  const sessionsQuery = useQuery({
    queryKey: ["agent-sessions-active", uuid],
    queryFn: () => listAgentSessions(uuid, { state: "active" }),
    enabled: !!uuid && agentQuery.data?.type !== "human",
  });

  const allClientsQuery = useQuery({
    queryKey: ["clients"],
    queryFn: listClients,
    enabled: !!uuid && canEditConfig,
    refetchInterval: 30_000,
  });

  const draft = useConfigDraft(cfgQuery.data);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflictMsg, setConflictMsg] = useState<string | null>(null);
  const [dangerError, setDangerError] = useState<string | null>(null);
  const [remoteReloading, setRemoteReloading] = useState(false);
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

  const identityUpdateMutation = useMutation({
    mutationFn: (patch: Parameters<typeof updateAgent>[1]) => updateAgent(uuid, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agent", uuid] });
      queryClient.invalidateQueries({ queryKey: ["agents"] });
    },
  });

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

  const testMutation = useMutation({ mutationFn: () => testAgentConnection(uuid) });

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

  // Sticky ContextBar visibility — sentinel right under the header.
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
        setContextBarVisible(!entry.isIntersecting && entry.boundingClientRect.top < 0);
      },
      { threshold: 0 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [isHumanLocal]);

  const dirtyTabs = useMemo(() => {
    const set = new Set<string>();
    for (const s of draft.summary.dirtySections) set.add(SECTION_TO_TAB[s]);
    return set;
  }, [draft.summary.dirtySections]);

  const tabs = useMemo(() => buildTabs(canEditConfig), [canEditConfig]);
  const currentTabKey = useMemo(() => {
    const segments = location.pathname.split("/");
    const last = segments[segments.length - 1] ?? "";
    return tabs.find((t) => t.path === last)?.key ?? "profile";
  }, [location.pathname, tabs]);

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
    const apiErr = agentQuery.error instanceof ApiError ? agentQuery.error : null;
    const status = apiErr?.status ?? 0;
    const isMissing = status === 404;
    const isServerErr = status >= 500;
    const headline = isMissing ? "Agent not available" : "Couldn't load agent";
    const detail = isMissing
      ? "This agent doesn't exist, has been deleted, or you don't have access to it."
      : isServerErr
        ? "The server hit an error. Try again in a moment."
        : (apiErr?.message ?? (agentQuery.error instanceof Error ? agentQuery.error.message : "Unknown error."));
    return (
      <div className="-m-6 p-6">
        <Breadcrumb style={{ marginBottom: "var(--sp-3)" }}>
          <BreadcrumbLink onClick={() => navigate("/team")}>Team</BreadcrumbLink>
          <BreadcrumbSep />
          <BreadcrumbCurrent>Unable to load</BreadcrumbCurrent>
        </Breadcrumb>
        <div style={{ maxWidth: 480 }}>
          <p className="text-body font-semibold" style={{ color: "var(--state-error)", marginBottom: "var(--sp-1_5)" }}>
            {headline}
          </p>
          <p className="text-body" style={{ color: "var(--fg-3)" }}>
            {detail}
          </p>
          <div className="flex gap-2" style={{ marginTop: "var(--sp-3)" }}>
            <Button variant="outline" size="sm" onClick={() => navigate("/team")}>
              Back to Team
            </Button>
            {isServerErr && (
              <Button size="sm" onClick={() => agentQuery.refetch()}>
                Retry
              </Button>
            )}
          </div>
        </div>
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
  // `isUnclaimed` is the binding-identity question ("does this agent have a
  // computer at all"). `isOffline` is the reachability question, sourced
  // from `runtime_state` (the M1+ authority — null means no runtime is
  // reporting), qualified with `clientStatus?.clientId` so unclaimed agents
  // don't double-count as "offline" (we surface those separately).
  const isOffline = !isHuman && agent.runtimeState == null && !!clientStatus?.clientId;
  const testAction = getAgentTestActionState({
    agentStatus: agent.status,
    clientStatus,
    clientStatusLoading: clientStatusInitialLoading,
    runtimeState: agent.runtimeState,
    testPending: testMutation.isPending,
  });

  const shortId = agent.uuid.slice(0, 8);

  const saveHint = deriveSaveHint({
    activeSessions,
    isUnclaimed,
    isOffline,
  });

  const boundClientId = clientStatus?.clientId ?? null;
  const boundClient: HubClient | null = boundClientId
    ? (allClientsQuery.data?.find((c) => c.id === boundClientId) ?? null)
    : null;
  const boundClientLabel: string | null =
    boundClientId && canEditConfig ? (boundClient?.hostname ?? boundClientId) : null;

  const setupRuntimeProvider: RuntimeProvider = agent.runtimeProvider ?? "claude-code";
  const contextRuntimeLabel = setupRuntimeProvider === "codex" ? "Codex" : "Claude Code";

  const refreshAgent = async () => {
    await queryClient.invalidateQueries({ queryKey: ["agent", uuid] });
    await queryClient.invalidateQueries({ queryKey: ["agents"] });
    await queryClient.invalidateQueries({ queryKey: ["me", "chats"] });
    // chat-detail caches participant displayName / name / type per chat;
    // editing identity must invalidate every cached chat-detail row,
    // otherwise the open chat view shows stale labels until next push.
    await queryClient.invalidateQueries({ queryKey: ["chat-detail"] });
  };

  const outletContext: AgentDetailContext = {
    uuid,
    agent,
    isHuman,
    canManageAgent,
    canEditConfig,
    draft,
    config: cfgQuery.data,
    configLoading: cfgQuery.isLoading,
    configError: cfgQuery.error,
    clientStatus,
    clientStatusLoading: clientStatusInitialLoading,
    clientStatusError,
    isUnclaimed,
    isOffline,
    boundClientLabel,
    setupRuntimeProvider,
    onOpenBindDialog: () => setBindClientOpen(true),
    onOpenRebindDialog: () => setReBindOpen(true),
    bindClientPending: bindClientMutation.isPending,
    saveIdentity: async (patch) => {
      await identityUpdateMutation.mutateAsync(patch);
    },
    refreshAgent,
    suspendPending: suspendMutation.isPending,
    reactivatePending: reactivateMutation.isPending,
    deletePending: deleteMutation.isPending,
    dangerError,
    onSuspend: () => suspendMutation.mutate(),
    onReactivate: () => reactivateMutation.mutate(),
    onDelete: () => deleteMutation.mutate(),
    dryRunText,
    dryRunPending: dryRunMutation.isPending,
    onRunDryRun: () => dryRunMutation.mutate(),
  };

  return (
    <div className="flex flex-col" style={{ minHeight: "calc(100vh - var(--sp-10))" }}>
      <div style={{ padding: "var(--sp-4) var(--sp-5) var(--sp-3)" }}>
        <button
          type="button"
          onClick={() => navigate("/team")}
          className="inline-flex items-center bg-transparent border-0 cursor-pointer transition-colors hover:text-[var(--fg)] text-caption"
          style={{
            color: "var(--fg-3)",
            padding: 0,
            marginBottom: "var(--sp-2)",
            gap: "var(--sp-1)",
          }}
        >
          <ArrowLeft className="h-3 w-3" />
          Team
        </button>
        <div className="flex w-full items-center gap-2">
          <Avatar
            src={agent.avatarImageUrl}
            name={agent.displayName}
            size={28}
            colorToken={agent.avatarColorToken}
            seed={agent.uuid}
          />
          <div className="flex min-w-0 flex-1 items-baseline gap-2">
            <h1 className="m-0 text-subtitle truncate" style={{ color: "var(--fg)" }} title={`agt_${shortId}`}>
              {agent.displayName}
            </h1>
            <span className="mono text-caption shrink-0" style={{ color: "var(--fg-4)" }}>
              @{agent.name ?? shortId}
            </span>
            <span className="text-caption shrink-0" style={{ color: "var(--fg-4)" }}>
              · {humanizeAgentType(agent.type)} · {humanizeVisibility(agent.visibility)}
            </span>
            {clientStatus?.offlineSince && (
              <span className="mono text-caption" style={{ color: "var(--fg-4)" }}>
                offline since {formatDate(clientStatus.offlineSince)}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <PresenceChip status={runtimeStateToPresence(agent.runtimeState)} />
            {activeSessions > 0 && (
              <span className="mono text-caption" style={{ color: "var(--fg-3)" }}>
                {activeSessions} active
              </span>
            )}
            <Button
              variant="ghost"
              size="xs"
              onClick={() => navigate(`/agents/${encodeURIComponent(agent.uuid)}/profile`)}
              title="Open profile"
              aria-label="Open profile"
              style={{ paddingLeft: "var(--sp-1_5)", paddingRight: "var(--sp-1_5)" }}
            >
              <MessageSquare className="h-4 w-4" />
            </Button>
            {!isHuman && canManageAgent && agent.status === "active" && (
              <Button
                variant="ghost"
                size="xs"
                onClick={() => {
                  testMutation.reset();
                  testMutation.mutate();
                }}
                disabled={testAction.disabled}
                title={testMutation.isPending ? "Testing…" : (testAction.title ?? "Test connection")}
                aria-label="Test connection"
                style={{ paddingLeft: "var(--sp-1_5)", paddingRight: "var(--sp-1_5)" }}
              >
                <Play className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      </div>
      <div ref={headerSentinelRef} aria-hidden style={{ height: 0 }} />

      {!isHuman && (
        <ContextBar runtimeLabel={contextRuntimeLabel} computerLabel={boundClientLabel} visible={contextBarVisible} />
      )}

      <TabsNav tabs={tabs} agentUuid={uuid} currentTabKey={currentTabKey} dirtyTabs={dirtyTabs} />

      <div
        className="w-full flex-1"
        style={{
          padding: "var(--sp-3_5) var(--sp-5) var(--sp-7)",
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
        <Outlet context={outletContext} />
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
          onJumpTo={(section) => navigate(`/agents/${uuid}/${SECTION_TO_TAB[section]}`, { replace: true })}
        />
      )}

      <ConfirmDialog
        open={discardDialogOpen}
        onOpenChange={setDiscardDialogOpen}
        title="Discard unsaved changes?"
        description="Your edits to Prompt / Model / Tools / Resources will be reverted to the last saved baseline."
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

function TabsNav({
  tabs,
  agentUuid,
  currentTabKey,
  dirtyTabs,
}: {
  tabs: TabDef[];
  agentUuid: string;
  currentTabKey: string;
  dirtyTabs: ReadonlySet<string>;
}) {
  const navigate = useNavigate();
  return (
    <div
      style={{
        borderBottom: "var(--hairline) solid var(--border)",
      }}
    >
      <div
        role="tablist"
        aria-label="Agent configuration sections"
        className="flex items-end gap-1"
        style={{
          padding: "0 var(--sp-5)",
        }}
      >
        {tabs.map((t) => {
          const active = currentTabKey === t.key;
          const dirty = dirtyTabs.has(t.key);
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => navigate(`/agents/${agentUuid}/${t.path}`, { replace: true })}
              className={cn(
                "bg-transparent border-0 cursor-pointer transition-colors",
                "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                !active && "hover:bg-accent",
              )}
              style={{
                padding: "var(--sp-2_5) var(--sp-3)",
                borderBottom: `var(--hairline-bold) solid ${active ? "var(--accent)" : "transparent"}`,
                color: active ? "var(--fg)" : "var(--fg-3)",
                fontWeight: active ? 500 : 400,
                fontSize: "var(--text-body-size)",
                display: "inline-flex",
                alignItems: "center",
                gap: "var(--sp-1_5)",
              }}
            >
              <span>{t.label}</span>
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
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Simple confirm dialog for the discard-draft action. The delete-agent flow
 * has its own type-the-name guard inside DangerZone.
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
        No connected computers available. Use the <strong>Connect computer</strong> button on the Computers page to set
        one up, then reopen this dialog.
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

const STATUS_LABELS: Record<TestResult["status"], string> = {
  success: "Connected",
  offline: "Offline",
  stale: "Stale",
  error: "Error",
};

const TEST_RESULT_BORDER: Record<TestResult["status"], string> = {
  success: "var(--state-idle)",
  offline: "var(--state-offline)",
  stale: "var(--state-blocked)",
  error: "var(--state-error)",
};

const TEST_RESULT_TONE: Record<TestResult["status"], DenseBadgeTone> = {
  success: "accent",
  stale: "warn",
  offline: "neutral",
  error: "error",
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
        </div>
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}
