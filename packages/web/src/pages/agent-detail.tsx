import type { RuntimeProvider } from "@first-tree/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquare, Monitor } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Outlet, useLocation, useNavigate, useParams } from "react-router";
import { type HubClient, listClients } from "./../api/activity.js";
import { type ClientStatusInfo, getAgentClientStatus, getAgentConfig } from "./../api/agent-config.js";
import { listAgentTemplates } from "./../api/agent-templates.js";
import {
  deleteAgent,
  getAgent,
  reactivateAgent,
  recoverAgentRuntimeSwitch,
  suspendAgent,
  switchAgentRuntime,
  updateAgent,
} from "./../api/agents.js";
import { ApiError } from "./../api/client.js";
import { useAuth } from "./../auth/auth-context.js";
import { Avatar } from "./../components/avatar.js";
import { AgentAvailability } from "./../components/ui/agent-availability.js";
import { Breadcrumb, BreadcrumbCurrent, BreadcrumbLink, BreadcrumbSep } from "./../components/ui/breadcrumb.js";
import { Button } from "./../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./../components/ui/dialog.js";
import { LocalNavLink } from "./../components/ui/local-nav-link.js";
import { Select } from "./../components/ui/select.js";
import { useWorkspaceViewport } from "./../hooks/use-viewport.js";
import { deriveAgentAvailability } from "./../lib/agent-availability.js";
import { invalidateDisplayNameQueries } from "./../lib/identity-cache.js";
import { cn } from "./../lib/utils.js";
import { canManageAgentDetail } from "./agent-detail/access.js";
import { isBindableClient } from "./agent-detail/action-state.js";
import { AgentSwitcher } from "./agent-detail/agent-switcher.js";
import { useAgentResources } from "./agent-detail/capability-section.js";
import type { AgentDetailContext, RuntimeSwitchClaimView } from "./agent-detail/layout-context.js";
import {
  buildTabs,
  responsibilitiesSideFromQuery,
  shouldShowResponsibilitiesTab,
  type TabDef,
} from "./agent-detail/tabs.js";
import { useAgentConfigSave } from "./agent-detail/use-agent-config-save.js";
import { useLegacyAnchorRedirect } from "./agent-detail/use-legacy-anchor-redirect.js";
import { PROVIDER_ORDER, runtimeProviderLabel } from "./clients/cards/shared/providers.js";

const MIN_RUNTIME_SWITCH_CLIENT_VERSION = "0.5.11";
type RuntimeSwitchDialogStep = "target" | "confirm";

export function AgentDetailPage() {
  const params = useParams<{ uuid: string }>();
  // Remount the whole page when navigation changes only `:uuid`; without a key,
  // the previous agent's dialog / bind state would leak into the next agent.
  return <AgentDetailPageView key={params.uuid ?? ""} />;
}

function AgentDetailPageView() {
  const params = useParams<{ uuid: string }>();
  const uuid = params.uuid ?? "";
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const location = useLocation();
  const { memberId, role } = useAuth();
  // Narrow web viewports trade the local navigation rail for a section selector.
  const isNarrow = useWorkspaceViewport() === "narrow";
  useLegacyAnchorRedirect();

  const agentQuery = useQuery({
    queryKey: ["agent", uuid],
    queryFn: () => getAgent(uuid),
    enabled: !!uuid,
    // The header availability presentation derives from `agent.runtimeState` off this
    // query. No admin-WS frame invalidates `["agent"]` today, so without
    // polling an agent that goes offline / reconnects while the page stays
    // open would keep showing the cached value. Match the 10s cadence the
    // legacy `/activity` poll used before this surface migrated off it.
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
    // Supplies secondary computer detail such as offlineSince. Availability
    // itself comes from the Agent read model, shared with Team, so this query
    // cannot create a second online/offline authority. Match
    // the 10s polling cadence that `agentQuery` above (and the legacy
    // `/activity` poll) used.
    refetchInterval: 10_000,
  });

  const allClientsQuery = useQuery({
    queryKey: ["clients"],
    queryFn: listClients,
    enabled: !!uuid && canEditConfig,
    refetchInterval: 30_000,
  });

  // Shared agent-resources cache feeds Responsibilities visibility from the
  // adopted template IDs. Responsibilities, Tools & skills, and Repositories
  // reuse the same query key, so their own observers read this cache.
  const toolsResources = useAgentResources(uuid, { enabled: !!uuid && agentQuery.data?.type !== "human" });

  // Public official Template catalog — same key as the Responsibilities editor
  // so the shell and the edit dialog share one cache. Drives whether the
  // Responsibilities exists when there are official starting points to adopt,
  // or when this agent already has adopted Template provenance to explain.
  const templateCatalogQuery = useQuery({
    queryKey: ["agent-templates-catalog"],
    queryFn: listAgentTemplates,
    enabled: !!uuid && agentQuery.data?.type !== "human",
    retry: 1,
  });

  // Immediate-save controller for model / reasoning effort / env. Lives in the
  // shell (not the Runtime tab) so its "Saved" flash and pending state survive a
  // tab switch and a deferred Undo toast can still call `save`.
  const configSave = useAgentConfigSave(uuid);

  const [dangerError, setDangerError] = useState<string | null>(null);
  const [reactivateError, setReactivateError] = useState<string | null>(null);

  const currentAgentStatus = agentQuery.data?.status;
  const currentAgentClientId = agentQuery.data?.clientId;
  useEffect(() => {
    if (!currentAgentStatus || currentAgentStatus !== "suspended" || !currentAgentClientId) {
      setReactivateError(null);
    }
  }, [currentAgentClientId, currentAgentStatus]);

  const identityUpdateMutation = useMutation({
    mutationFn: (patch: Parameters<typeof updateAgent>[1]) => updateAgent(uuid, patch),
    onSuccess: async (_agent, patch) => {
      if (patch.displayName !== undefined) {
        await invalidateDisplayNameQueries(queryClient);
        return;
      }
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
    onMutate: () => setReactivateError(null),
    onSuccess: () => {
      setReactivateError(null);
      queryClient.invalidateQueries({ queryKey: ["agent", uuid] });
    },
    onError: (err) => setReactivateError(err instanceof Error ? err.message : String(err)),
  });
  const deleteMutation = useMutation({
    mutationFn: () => deleteAgent(uuid),
    onMutate: () => setDangerError(null),
    onSuccess: () => navigate("/team"),
    onError: (err) => setDangerError(err instanceof Error ? err.message : String(err)),
  });

  const [bindClientOpen, setBindClientOpen] = useState(false);
  const [bindClientSelected, setBindClientSelected] = useState<string>("");
  const [bindClientError, setBindClientError] = useState<string | null>(null);
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

  const [runtimeSwitchOpen, setRuntimeSwitchOpen] = useState(false);
  const [runtimeSwitchClientId, setRuntimeSwitchClientId] = useState("");
  const [runtimeSwitchProvider, setRuntimeSwitchProvider] = useState<RuntimeProvider>("claude-code");
  const [runtimeSwitchStep, setRuntimeSwitchStep] = useState<RuntimeSwitchDialogStep>("target");
  const [runtimeSwitchAcknowledged, setRuntimeSwitchAcknowledged] = useState(false);
  const [runtimeSwitchError, setRuntimeSwitchError] = useState<string | null>(null);
  const runtimeSwitchMutation = useMutation({
    mutationFn: (target: { clientId: string; runtimeProvider: RuntimeProvider }) =>
      switchAgentRuntime(uuid, {
        clientId: target.clientId,
        runtimeProvider: target.runtimeProvider,
        confirmLocalDataLoss: true,
      }),
    onSuccess: () => {
      setRuntimeSwitchOpen(false);
      setRuntimeSwitchError(null);
      queryClient.invalidateQueries({ queryKey: ["agent", uuid] });
      queryClient.invalidateQueries({ queryKey: ["agent-config", uuid] });
      queryClient.invalidateQueries({ queryKey: ["agent-client-status", uuid] });
      queryClient.invalidateQueries({ queryKey: ["agent-sessions-active", uuid] });
      queryClient.invalidateQueries({ queryKey: ["agents"] });
    },
    onError: (err) => setRuntimeSwitchError(err instanceof Error ? err.message : String(err)),
  });
  const runtimeSwitchRecoveryMutation = useMutation({
    mutationFn: () => recoverAgentRuntimeSwitch(uuid),
    onSuccess: () => {
      setRuntimeSwitchError(null);
      queryClient.invalidateQueries({ queryKey: ["agent", uuid] });
      queryClient.invalidateQueries({ queryKey: ["agent-config", uuid] });
      queryClient.invalidateQueries({ queryKey: ["agent-client-status", uuid] });
      queryClient.invalidateQueries({ queryKey: ["agent-sessions-active", uuid] });
      queryClient.invalidateQueries({ queryKey: ["agents"] });
    },
  });

  // Every setting saves immediately, so leaving the page is never destructive —
  // this is just `navigate`, exposed to controls that leave the current agent
  // (chat, Usage deep links, Settings, Computers, and Team).
  const navigateAway = useCallback((to: string) => navigate(to), [navigate]);

  const isHumanLocal = agentQuery.data?.type === "human";

  const showResponsibilities = useMemo(
    () =>
      shouldShowResponsibilitiesTab(isHumanLocal, {
        catalog: responsibilitiesSideFromQuery({
          count: templateCatalogQuery.data ? templateCatalogQuery.data.templates.length : null,
          isFetching: templateCatalogQuery.isFetching,
          isError: templateCatalogQuery.isError,
        }),
        agentResources: responsibilitiesSideFromQuery({
          count: toolsResources.data ? toolsResources.data.templateIds.length : null,
          isFetching: toolsResources.isFetching,
          isError: toolsResources.isError,
        }),
      }),
    [
      isHumanLocal,
      templateCatalogQuery.data,
      templateCatalogQuery.isFetching,
      templateCatalogQuery.isError,
      toolsResources.data,
      toolsResources.isFetching,
      toolsResources.isError,
    ],
  );
  const tabs = useMemo(
    () => buildTabs(canEditConfig, isHumanLocal, showResponsibilities),
    [canEditConfig, isHumanLocal, showResponsibilities],
  );
  const currentTabKey = useMemo(() => {
    const segments = location.pathname.split("/");
    const last = segments[segments.length - 1] ?? "";
    return tabs.find((t) => t.path === last)?.key ?? "profile";
  }, [location.pathname, tabs]);
  const currentTab = tabs.find((tab) => tab.key === currentTabKey) ?? tabs[0];

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
          <BreadcrumbLink onClick={() => navigate("/team")}>Agents</BreadcrumbLink>
          <BreadcrumbSep />
          <BreadcrumbCurrent>Unable to load</BreadcrumbCurrent>
        </Breadcrumb>
        <div style={{ maxWidth: "var(--agent-detail-error-rail)" }}>
          <p className="text-body font-semibold" style={{ color: "var(--state-error)", marginBottom: "var(--sp-1_5)" }}>
            {headline}
          </p>
          <p className="text-body" style={{ color: "var(--fg-3)" }}>
            {detail}
          </p>
          <div className="flex gap-2" style={{ marginTop: "var(--sp-3)" }}>
            <Button variant="outline" size="sm" onClick={() => navigate("/team")}>
              Back to Agents
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
  const runtimeSwitchClaim = readRuntimeSwitchClaim(agent.metadata);

  const clientStatus: ClientStatusInfo | undefined = clientStatusQuery.data;
  const isUnclaimed = !isHuman && !agent.clientId;

  const shortId = agent.uuid.slice(0, 8);

  const boundClientId = agent.clientId ?? null;
  const boundClient: HubClient | null = boundClientId
    ? (allClientsQuery.data?.find((c) => c.id === boundClientId) ?? null)
    : null;
  const boundClientLabel: string | null =
    boundClientId && canEditConfig ? (boundClient?.hostname ?? boundClientId) : null;

  const availability = deriveAgentAvailability({
    status: agent.status,
    clientId: agent.clientId,
    connection: agent.runtimeState == null ? "offline" : "online",
    clientLabel: boundClientLabel,
    offlineSince: clientStatus?.offlineSince ?? agent.lastSeenAt,
  });
  const isOffline = availability.kind === "offline";

  const setupRuntimeProvider: RuntimeProvider = agent.runtimeProvider ?? "claude-code";

  const openRuntimeSwitchDialog = () => {
    const clients = allClientsQuery.data ?? [];
    const currentCandidate = clients.find(
      (client) => client.id === boundClientId && isRuntimeSwitchCandidateClient(client),
    );
    setRuntimeSwitchClientId(currentCandidate?.id ?? clients.find(isRuntimeSwitchCandidateClient)?.id ?? "");
    setRuntimeSwitchProvider(setupRuntimeProvider);
    setRuntimeSwitchStep("target");
    setRuntimeSwitchAcknowledged(false);
    setRuntimeSwitchError(null);
    setRuntimeSwitchOpen(true);
  };
  const runtimeSwitchSelectedClient =
    allClientsQuery.data?.find((client) => client.id === runtimeSwitchClientId) ?? null;
  const runtimeSwitchProviderAvailable = runtimeSwitchSelectedClient
    ? runtimeSwitchAvailableProviders(runtimeSwitchSelectedClient).some(
        (provider) => provider === runtimeSwitchProvider,
      )
    : false;

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
    navigateAway,
    config: cfgQuery.data,
    configLoading: cfgQuery.isLoading,
    configError: cfgQuery.error,
    configSave,
    clientStatus,
    isUnclaimed,
    isOffline,
    boundClientLabel,
    setupRuntimeProvider,
    runtimeSwitchClaim,
    onOpenBindDialog: () => setBindClientOpen(true),
    bindClientPending: bindClientMutation.isPending,
    onOpenRuntimeSwitchDialog: openRuntimeSwitchDialog,
    runtimeSwitchPending: runtimeSwitchMutation.isPending,
    runtimeSwitchRecoveryPending: runtimeSwitchRecoveryMutation.isPending,
    runtimeSwitchRecoveryError:
      runtimeSwitchRecoveryMutation.error instanceof Error
        ? runtimeSwitchRecoveryMutation.error.message
        : runtimeSwitchRecoveryMutation.error
          ? String(runtimeSwitchRecoveryMutation.error)
          : null,
    onRecoverRuntimeSwitch: () => runtimeSwitchRecoveryMutation.mutate(),
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
  };

  const openChat = () => {
    const search = new URLSearchParams({ c: "draft", with: agent.uuid });
    navigateAway(`/?${search.toString()}`);
  };
  const canReactivateFromHeader =
    agent.status === "suspended" && !!agent.clientId && canManageAgent && !runtimeSwitchClaim;
  const canChooseRuntimeFromHeader =
    agent.status === "suspended" && !agent.clientId && canManageAgent && !runtimeSwitchClaim;
  const canConnectFromHeader = agent.status === "active" && availability.kind === "needs-setup" && canEditConfig;
  const canStartChatFromHeader = agent.status === "active" && availability.kind !== "needs-setup" && !isHuman;

  return (
    <div className="flex flex-col" style={{ minHeight: "calc(100vh - var(--sp-10))", gap: "var(--sp-5)" }}>
      <header style={{ paddingBottom: "var(--sp-5)", borderBottom: "var(--hairline) solid var(--border-faint)" }}>
        <Breadcrumb style={{ marginBottom: "var(--sp-4)" }}>
          <BreadcrumbLink className="inline-flex min-h-11 items-center" onClick={() => navigateAway("/team")}>
            Team
          </BreadcrumbLink>
          <BreadcrumbSep />
          {/* Humans have no switcher: the list is agents only, so their own
              row would never be in it. */}
          {isHuman ? (
            <BreadcrumbCurrent>{agent.displayName}</BreadcrumbCurrent>
          ) : (
            <AgentSwitcher
              currentAgent={agent}
              onSelect={(nextUuid) =>
                // Keep the section the user is reading. A pushed entry (not
                // `replace`, unlike the section links) makes Back return to
                // the previous agent.
                navigateAway(`/agents/${encodeURIComponent(nextUuid)}/${currentTab?.path ?? "profile"}`)
              }
            />
          )}
        </Breadcrumb>

        <div className={cn("flex gap-4", isNarrow ? "flex-col items-stretch" : "items-center justify-between")}>
          <div className="flex min-w-0 items-center gap-3">
            <Avatar
              src={agent.avatarImageUrl}
              name={agent.displayName}
              size={48}
              colorToken={agent.avatarColorToken}
              seed={agent.uuid}
            />
            <div className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
                <h1 className="m-0 text-title truncate" style={{ color: "var(--fg)" }} title={`agt_${shortId}`}>
                  {agent.displayName}
                </h1>
                <span className="mono text-caption shrink-0" style={{ color: "var(--fg-3)" }}>
                  @{agent.name ?? shortId}
                </span>
              </div>
              {!isHuman ? (
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1" style={{ marginTop: "var(--sp-1)" }}>
                  <AgentAvailability view={availability} />
                  {availability.detail ? (
                    <>
                      <span aria-hidden style={{ color: "var(--border-strong)" }}>
                        ·
                      </span>
                      <span className="text-caption" style={{ color: "var(--fg-3)" }}>
                        {availability.detail}
                      </span>
                    </>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>

          {!isHuman &&
          (canReactivateFromHeader || canChooseRuntimeFromHeader || canConnectFromHeader || canStartChatFromHeader) ? (
            <div className={cn("flex shrink-0 items-center gap-2", isNarrow && "w-full")}>
              {canReactivateFromHeader ? (
                <Button
                  size="sm"
                  className={cn("min-h-11", isNarrow && "w-full")}
                  onClick={() => reactivateMutation.mutate()}
                  disabled={reactivateMutation.isPending}
                >
                  {reactivateMutation.isPending ? "Reactivating…" : "Reactivate agent"}
                </Button>
              ) : canChooseRuntimeFromHeader ? (
                <Button
                  size="sm"
                  className={cn("min-h-11", isNarrow && "w-full")}
                  onClick={openRuntimeSwitchDialog}
                  disabled={runtimeSwitchMutation.isPending}
                >
                  Choose runtime
                </Button>
              ) : canConnectFromHeader ? (
                <Button
                  size="sm"
                  className={cn("min-h-11", isNarrow && "w-full")}
                  onClick={() => setBindClientOpen(true)}
                >
                  Choose computer
                </Button>
              ) : (
                <Button
                  size="sm"
                  className={cn("min-h-11", isNarrow && "w-full")}
                  onClick={openChat}
                  title="Start a chat with this agent"
                  aria-label="Start chat"
                >
                  <MessageSquare className="h-4 w-4" />
                  Start chat
                </Button>
              )}
            </div>
          ) : null}
        </div>
        {reactivateError && canReactivateFromHeader ? (
          <div
            className={cn("flex flex-wrap items-center gap-2", !isNarrow && "justify-end")}
            style={{ marginTop: "var(--sp-2)" }}
            role="alert"
          >
            <span className="text-caption" style={{ color: "var(--state-error)" }}>
              Couldn’t reactivate this agent. {reactivateError}
            </span>
            <Button
              size="xs"
              className="min-h-11"
              variant="outline"
              onClick={() => reactivateMutation.mutate()}
              disabled={reactivateMutation.isPending}
            >
              Retry
            </Button>
          </div>
        ) : null}
      </header>

      <div
        className={cn("w-full flex-1", isNarrow || tabs.length <= 1 ? "flex flex-col" : "grid items-start")}
        style={{
          gap: isNarrow ? "var(--sp-4)" : "var(--sp-8)",
          gridTemplateColumns:
            !isNarrow && tabs.length > 1 ? "var(--agent-detail-local-nav) minmax(0, 1fr)" : undefined,
        }}
      >
        <AgentSectionNavigation tabs={tabs} agentUuid={uuid} currentTabKey={currentTabKey} isNarrow={isNarrow} />
        <section
          aria-labelledby="agent-detail-section-title"
          className="min-w-0"
          style={{
            width: "100%",
            maxWidth: "var(--agent-detail-rail)",
            marginLeft: tabs.length <= 1 ? "auto" : undefined,
            marginRight: tabs.length <= 1 ? "auto" : undefined,
          }}
        >
          {currentTab ? (
            <div style={{ marginBottom: "var(--sp-5)" }}>
              <h2 id="agent-detail-section-title" className="sr-only">
                {currentTab.label}
              </h2>
              <p className="m-0 text-body" style={{ color: "var(--fg-3)" }}>
                {currentTab.description}
              </p>
            </div>
          ) : null}
          <div className="flex flex-col" style={{ gap: "var(--sp-5)", paddingBottom: "var(--sp-7)" }}>
            <Outlet context={outletContext} />
          </div>
        </section>
      </div>

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
            <DialogTitle>Choose a computer</DialogTitle>
            <DialogDescription>
              Assign this agent to a connected computer. The change applies immediately.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
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
                onOpenComputers={() => navigateAway("/settings/computers")}
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
              {bindClientMutation.isPending ? "Assigning…" : "Assign"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={runtimeSwitchOpen}
        onOpenChange={(open) => {
          setRuntimeSwitchOpen(open);
          if (!open) {
            setRuntimeSwitchError(null);
            setRuntimeSwitchStep("target");
            setRuntimeSwitchAcknowledged(false);
            runtimeSwitchMutation.reset();
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Switch runtime</DialogTitle>
            <DialogDescription>
              {runtimeSwitchStep === "target"
                ? "Choose the computer and provider that will own this agent after the switch."
                : "Confirm the interruption and local-state boundary before the switch starts."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {allClientsQuery.isLoading ? (
              <div className="text-body" style={{ color: "var(--fg-3)" }}>
                Loading computers…
              </div>
            ) : allClientsQuery.error ? (
              <div className="text-body" style={{ color: "var(--state-error)" }}>
                Failed to load computers:{" "}
                {allClientsQuery.error instanceof Error ? allClientsQuery.error.message : "Unknown"}
              </div>
            ) : (
              <RuntimeSwitchControls
                clients={allClientsQuery.data ?? []}
                currentClientId={boundClientId}
                currentProvider={setupRuntimeProvider}
                selectedClientId={runtimeSwitchClientId}
                selectedProvider={runtimeSwitchProvider}
                onSelectClient={(clientId) => {
                  setRuntimeSwitchClientId(clientId);
                  const client = allClientsQuery.data?.find((c) => c.id === clientId);
                  const available = client ? runtimeSwitchAvailableProviders(client) : [];
                  if (!available.some((provider) => provider === runtimeSwitchProvider) && available[0]) {
                    setRuntimeSwitchProvider(available[0]);
                  }
                  setRuntimeSwitchStep("target");
                  setRuntimeSwitchAcknowledged(false);
                }}
                onSelectProvider={(provider) => {
                  setRuntimeSwitchProvider(provider);
                  setRuntimeSwitchStep("target");
                  setRuntimeSwitchAcknowledged(false);
                }}
                onOpenComputers={() => navigateAway("/settings/computers")}
              />
            )}
            {runtimeSwitchStep === "confirm" && (
              <RuntimeSwitchConfirmation
                agentLabel={agent.displayName}
                client={runtimeSwitchSelectedClient}
                provider={runtimeSwitchProvider}
                checked={runtimeSwitchAcknowledged}
                onCheckedChange={setRuntimeSwitchAcknowledged}
              />
            )}
            {runtimeSwitchError && (
              <div className="text-body" style={{ color: "var(--state-error)" }}>
                {runtimeSwitchError}
              </div>
            )}
          </div>
          <DialogFooter>
            {runtimeSwitchStep === "confirm" ? (
              <Button
                variant="outline"
                onClick={() => {
                  setRuntimeSwitchStep("target");
                  setRuntimeSwitchAcknowledged(false);
                }}
              >
                Back
              </Button>
            ) : (
              <Button variant="outline" onClick={() => setRuntimeSwitchOpen(false)}>
                Cancel
              </Button>
            )}
            {runtimeSwitchStep === "target" ? (
              <Button
                disabled={
                  !runtimeSwitchClientId ||
                  !runtimeSwitchProvider ||
                  !runtimeSwitchProviderAvailable ||
                  (runtimeSwitchClientId === boundClientId && runtimeSwitchProvider === setupRuntimeProvider) ||
                  runtimeSwitchMutation.isPending
                }
                onClick={() => {
                  setRuntimeSwitchError(null);
                  setRuntimeSwitchStep("confirm");
                  setRuntimeSwitchAcknowledged(false);
                }}
              >
                Review impact
              </Button>
            ) : (
              <Button
                variant="destructive"
                disabled={!runtimeSwitchAcknowledged || runtimeSwitchMutation.isPending}
                onClick={() => {
                  setRuntimeSwitchError(null);
                  runtimeSwitchMutation.mutate({
                    clientId: runtimeSwitchClientId,
                    runtimeProvider: runtimeSwitchProvider,
                  });
                }}
              >
                {runtimeSwitchMutation.isPending ? "Switching…" : "Switch runtime"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function AgentSectionNavigation({
  tabs,
  agentUuid,
  currentTabKey,
  isNarrow,
}: {
  tabs: TabDef[];
  agentUuid: string;
  currentTabKey: string;
  isNarrow: boolean;
}) {
  const navigate = useNavigate();
  if (tabs.length <= 1) return null;

  if (isNarrow) {
    return (
      <div className="w-full">
        <label
          htmlFor="agent-configuration-section"
          className="text-label block"
          style={{ color: "var(--fg-3)", marginBottom: "var(--sp-1)" }}
        >
          Section
        </label>
        <Select
          id="agent-configuration-section"
          aria-label="Agent section"
          value={currentTabKey}
          options={tabs.map((tab) => ({ value: tab.key, label: tab.label }))}
          onChange={(key) => {
            const next = tabs.find((tab) => tab.key === key);
            if (next) navigate(`/agents/${agentUuid}/${next.path}`, { replace: true });
          }}
          className="w-full"
          triggerClassName="w-full"
        />
      </div>
    );
  }

  return (
    <aside style={{ position: "sticky", top: "var(--sp-4)", alignSelf: "start" }}>
      <nav aria-label="Agent sections">
        <ul className="m-0 flex list-none flex-col p-0" style={{ gap: "var(--sp-0_5)" }}>
          {tabs.map((tab) => {
            const active = currentTabKey === tab.key;
            return (
              <li key={tab.key}>
                <LocalNavLink to={`/agents/${agentUuid}/${tab.path}`} label={tab.label} active={active} replace />
              </li>
            );
          })}
        </ul>
      </nav>
    </aside>
  );
}

function BindClientList({
  clients,
  selected,
  onSelect,
  onOpenComputers,
}: {
  clients: HubClient[];
  selected: string;
  onSelect: (id: string) => void;
  onOpenComputers: () => void;
}) {
  const bindable = clients.filter(isBindableClient);
  if (bindable.length === 0) {
    return (
      <div
        className="flex items-start gap-3"
        style={{
          border: "var(--hairline) solid var(--border)",
          borderRadius: "var(--radius-panel)",
          padding: "var(--sp-3)",
        }}
      >
        <div
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-input)]"
          style={{ background: "var(--bg-sunken)", color: "var(--fg-3)" }}
          aria-hidden
        >
          <Monitor className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <div>
            <p className="m-0 text-body font-medium" style={{ color: "var(--fg)" }}>
              No connected computers
            </p>
            <p className="m-0 text-caption" style={{ color: "var(--fg-3)", marginTop: "var(--sp-0_5)" }}>
              Connect a computer first, then return here to assign this agent.
            </p>
          </div>
          <Button type="button" variant="outline" size="xs" onClick={onOpenComputers}>
            Open Computers
          </Button>
        </div>
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
      {bindable.map((c, index) => {
        const picked = c.id === selected;
        return (
          <li key={c.id} style={index > 0 ? { borderTop: "var(--hairline) solid var(--border-faint)" } : undefined}>
            <button
              type="button"
              onClick={() => onSelect(c.id)}
              className={cn("w-full text-left flex items-center gap-3")}
              style={{
                padding: "var(--sp-2) var(--sp-3)",
                background: picked ? "var(--bg-active)" : "transparent",
                border: "none",
                cursor: "pointer",
              }}
            >
              <span
                className={cn("inline-block h-2 w-2 rounded-full shrink-0")}
                style={{ background: isBindableClient(c) ? "var(--success)" : "var(--fg-4)" }}
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

function readRuntimeSwitchClaim(metadata: Record<string, unknown>): RuntimeSwitchClaimView | null {
  const value = metadata.runtimeSwitch;
  if (value === undefined) return null;
  if (!value || typeof value !== "object") return { claimId: null, phase: null };
  const record = value as Record<string, unknown>;
  return {
    claimId: typeof record.claimId === "string" ? record.claimId : null,
    phase: typeof record.phase === "string" ? record.phase : null,
  };
}

function isVersionAtLeast(version: string | null, minimum: string): boolean {
  if (!version) return false;
  const parse = (value: string) =>
    value
      .replace(/^v/, "")
      .split(/[.-]/)
      .slice(0, 3)
      .map((part) => Number.parseInt(part, 10));
  const actual = parse(version);
  const required = parse(minimum);
  for (let i = 0; i < 3; i += 1) {
    const actualPart = actual[i] ?? 0;
    const requiredPart = required[i] ?? 0;
    const a = Number.isFinite(actualPart) ? actualPart : 0;
    const b = Number.isFinite(requiredPart) ? requiredPart : 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return true;
}

function capabilitiesReported(client: HubClient): boolean {
  return Object.keys(client.capabilities ?? {}).length > 0;
}

export function runtimeSwitchAvailableProviders(client: HubClient): RuntimeProvider[] {
  if (!capabilitiesReported(client)) return [...PROVIDER_ORDER];
  return PROVIDER_ORDER.filter((provider) => client.capabilities[provider]?.available === true);
}

function isRuntimeSwitchCandidateClient(client: HubClient): boolean {
  return (
    client.authState === "ok" &&
    isVersionAtLeast(client.sdkVersion, MIN_RUNTIME_SWITCH_CLIENT_VERSION) &&
    runtimeSwitchAvailableProviders(client).length > 0
  );
}

function runtimeSwitchClientBlocker(client: HubClient): string | null {
  if (client.authState !== "ok") return "Credentials expired";
  if (!isVersionAtLeast(client.sdkVersion, MIN_RUNTIME_SWITCH_CLIENT_VERSION)) {
    return `Requires CLI ${MIN_RUNTIME_SWITCH_CLIENT_VERSION}+`;
  }
  if (runtimeSwitchAvailableProviders(client).length === 0) return "No available runtime provider";
  return null;
}

function RuntimeSwitchControls({
  clients,
  currentClientId,
  currentProvider,
  selectedClientId,
  selectedProvider,
  onSelectClient,
  onSelectProvider,
  onOpenComputers,
}: {
  clients: HubClient[];
  currentClientId: string | null;
  currentProvider: RuntimeProvider;
  selectedClientId: string;
  selectedProvider: RuntimeProvider;
  onSelectClient: (id: string) => void;
  onSelectProvider: (provider: RuntimeProvider) => void;
  onOpenComputers: () => void;
}) {
  const candidates = clients.filter(isRuntimeSwitchCandidateClient);
  const selectedClient = candidates.find((client) => client.id === selectedClientId) ?? null;
  const providers = selectedClient ? runtimeSwitchAvailableProviders(selectedClient) : [];

  if (candidates.length === 0) {
    return (
      <div
        className="flex items-start gap-3"
        style={{
          border: "var(--hairline) solid var(--border)",
          borderRadius: "var(--radius-panel)",
          padding: "var(--sp-3)",
        }}
      >
        <div
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-input)]"
          style={{ background: "var(--bg-sunken)", color: "var(--fg-3)" }}
          aria-hidden
        >
          <Monitor className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <div>
            <p className="m-0 text-body font-medium" style={{ color: "var(--fg)" }}>
              No eligible computers
            </p>
            <p className="m-0 text-caption" style={{ color: "var(--fg-3)", marginTop: "var(--sp-0_5)" }}>
              Connect or upgrade a computer that can run the target runtime before switching.
            </p>
          </div>
          <Button type="button" variant="outline" size="xs" onClick={onOpenComputers}>
            Open Computers
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <p className="m-0 text-label" style={{ color: "var(--fg-3)", marginBottom: "var(--sp-1)" }}>
          Computer
        </p>
        <ul
          className="max-h-48 overflow-y-auto"
          style={{
            border: "var(--hairline) solid var(--border)",
            borderRadius: "var(--radius-input)",
            margin: 0,
            padding: 0,
            listStyle: "none",
          }}
        >
          {clients.map((client, index) => {
            const picked = client.id === selectedClientId;
            const blocker = runtimeSwitchClientBlocker(client);
            const disabled = blocker !== null;
            return (
              <li
                key={client.id}
                style={index > 0 ? { borderTop: "var(--hairline) solid var(--border-faint)" } : undefined}
              >
                <button
                  type="button"
                  onClick={() => {
                    if (!disabled) onSelectClient(client.id);
                  }}
                  className={cn("w-full text-left flex items-center gap-3")}
                  style={{
                    padding: "var(--sp-2) var(--sp-3)",
                    background: picked ? "var(--bg-active)" : "transparent",
                    border: "none",
                    cursor: disabled ? "not-allowed" : "pointer",
                    opacity: disabled ? 0.62 : 1,
                  }}
                  disabled={disabled}
                  aria-pressed={picked}
                  title={blocker ?? undefined}
                >
                  <span
                    className="inline-block h-2 w-2 rounded-full shrink-0"
                    style={{ background: client.status === "connected" ? "var(--success)" : "var(--fg-4)" }}
                    aria-hidden
                  />
                  <span className="flex-1 min-w-0">
                    <span className="block text-body truncate font-medium">{client.hostname ?? client.id}</span>
                    <span className="block mono truncate text-caption" style={{ color: "var(--fg-4)" }}>
                      {client.id}
                      {client.id === currentClientId ? " · current" : ""}
                      {client.status !== "connected" ? " · offline" : ""}
                      {client.sdkVersion ? ` · SDK ${client.sdkVersion}` : ""}
                    </span>
                  </span>
                  {blocker && (
                    <span className="text-label" style={{ color: "var(--fg-4)" }}>
                      {blocker}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
        {selectedClient?.status !== "connected" && (
          <p className="m-0 text-caption" style={{ color: "var(--fg-3)", marginTop: "var(--sp-1_5)" }}>
            Target computer is offline. The cloud binding changes now; the runtime starts when that computer reconnects.
          </p>
        )}
        {selectedClient && !capabilitiesReported(selectedClient) && (
          <p className="m-0 text-caption" style={{ color: "var(--state-blocked)", marginTop: "var(--sp-1_5)" }}>
            This computer has not reported runtime capabilities yet. The server will allow the switch and the runtime
            will validate on bind.
          </p>
        )}
      </div>

      <div>
        <p className="m-0 text-label" style={{ color: "var(--fg-3)", marginBottom: "var(--sp-1)" }}>
          Runtime
        </p>
        {providers.length === 0 ? (
          <p className="m-0 text-body" style={{ color: "var(--state-error)" }}>
            This computer has not reported an available runtime provider yet.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {providers.map((provider) => {
              const picked = provider === selectedProvider;
              return (
                <button
                  key={provider}
                  type="button"
                  onClick={() => onSelectProvider(provider)}
                  aria-pressed={picked}
                  className="text-body"
                  style={{
                    border: "var(--hairline) solid var(--border)",
                    borderColor: picked ? "var(--primary)" : "var(--border)",
                    borderRadius: "var(--radius-input)",
                    background: picked ? "var(--bg-active)" : "var(--bg)",
                    color: "var(--fg)",
                    padding: "var(--sp-1_5) var(--sp-2)",
                    cursor: "pointer",
                  }}
                >
                  {runtimeProviderLabel(provider)}
                  {provider === currentProvider ? " · current" : ""}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function RuntimeSwitchConfirmation({
  agentLabel,
  client,
  provider,
  checked,
  onCheckedChange,
}: {
  agentLabel: string;
  client: HubClient | null;
  provider: RuntimeProvider;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const targetLabel = client?.hostname ?? client?.id ?? "selected computer";
  return (
    <div
      style={{
        border: "var(--hairline) solid var(--state-blocked)",
        borderRadius: "var(--radius-panel)",
        padding: "var(--sp-3)",
      }}
    >
      <p className="m-0 text-body font-medium" style={{ color: "var(--fg)" }}>
        {agentLabel} will move to {targetLabel} using {runtimeProviderLabel(provider)}.
      </p>
      <ul className="text-caption" style={{ color: "var(--fg-3)", margin: "var(--sp-2) 0", paddingLeft: "1.2rem" }}>
        <li>Existing runtime sessions stop and their live activity trace is cleared.</li>
        <li>
          Local workspace files, unpushed changes, provider sessions, provider login state, and nearby local files do
          not move.
        </li>
        <li>
          Messages sent during the switch window are not delivered to the agent and are not replayed after recovery.
        </li>
        <li>Cloud cannot force-kill external commands already running on the old computer.</li>
        {client?.status !== "connected" && (
          <li>The target computer is offline; the agent waits there until it reconnects.</li>
        )}
      </ul>
      <label className="flex items-start gap-2 text-body" style={{ color: "var(--fg)" }}>
        <input
          type="checkbox"
          checked={checked}
          onChange={(event) => onCheckedChange(event.currentTarget.checked)}
          style={{ marginTop: 3 }}
        />
        <span>I understand this switch can abandon local runtime state and active sessions.</span>
      </label>
    </div>
  );
}
