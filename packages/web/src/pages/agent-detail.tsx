import type { RuntimeProvider } from "@first-tree/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquare, Monitor } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Outlet, useLocation, useNavigate, useParams } from "react-router";
import { type HubClient, listClients } from "./../api/activity.js";
import { type ClientStatusInfo, getAgentClientStatus, getAgentConfig } from "./../api/agent-config.js";
import { deleteAgent, getAgent, reactivateAgent, suspendAgent, updateAgent } from "./../api/agents.js";
import { ApiError } from "./../api/client.js";
import { listAgentSessions } from "./../api/sessions.js";
import { useAuth } from "./../auth/auth-context.js";
import { Avatar } from "./../components/avatar.js";
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
import { PresenceChip, runtimeStateToPresence } from "./../components/ui/presence-chip.js";
import { Tab, TabBadge, TabBar } from "./../components/ui/tab-bar.js";
import { useWorkspaceViewport } from "./../hooks/use-viewport.js";
import { cn } from "./../lib/utils.js";
import { canManageAgentDetail } from "./agent-detail/access.js";
import { isBindableClient } from "./agent-detail/action-state.js";
import { AgentSwitcherStrip } from "./agent-detail/agent-switcher-strip.js";
import { useAgentResources } from "./agent-detail/capability-section.js";
import { ContextBar } from "./agent-detail/context-bar.js";
import type { AgentDetailContext } from "./agent-detail/layout-context.js";
import { buildTabs, type TabDef } from "./agent-detail/tabs.js";
import { useAgentConfigSave } from "./agent-detail/use-agent-config-save.js";
import { useLegacyAnchorRedirect } from "./agent-detail/use-legacy-anchor-redirect.js";

export function AgentDetailPage() {
  const params = useParams<{ uuid: string }>();
  // Remount the whole page on agent switch. The switcher navigates in place
  // (only `:uuid` changes), so the route element stays mounted; without a key the
  // previous agent's dialog / bind state would leak into the next agent.
  return <AgentDetailPageView key={params.uuid ?? ""} />;
}

function AgentDetailPageView() {
  const params = useParams<{ uuid: string }>();
  const uuid = params.uuid ?? "";
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const location = useLocation();
  const { memberId, role } = useAuth();
  // On phones the header drops its secondary metadata line (type · visibility,
  // offline-since) — those are all repeated on the Profile tab — so the
  // avatar, name, presence chip, and action buttons keep their natural size
  // instead of being shoved off the row.
  const isNarrow = useWorkspaceViewport() === "narrow";
  useLegacyAnchorRedirect();

  const agentQuery = useQuery({
    queryKey: ["agent", uuid],
    queryFn: () => getAgent(uuid),
    enabled: !!uuid,
    // The header `<PresenceChip>` derives from `agent.runtimeState` off this
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

  // Shared agent-resources cache (skills / MCP / repos). Fetched here so the
  // Tools & skills badge shows its effective count on first paint — the badge's
  // whole point is "tell me there's something in here before I click". One light
  // query in the same tier as agent-config / client-status; the Tools & skills
  // and Environment tabs then read+write this same ["agent-resources", uuid]
  // cache, so their useAgentResources calls become cache hits.
  const toolsResources = useAgentResources(uuid, { enabled: !!uuid && agentQuery.data?.type !== "human" });

  // Immediate-save controller for model / reasoning effort / env. Lives in the
  // shell (not the Runtime tab) so its "Saved" flash and pending state survive a
  // tab switch and a deferred Undo toast can still call `save`.
  const configSave = useAgentConfigSave(uuid);

  const [dangerError, setDangerError] = useState<string | null>(null);

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

  // Every setting saves immediately, so leaving the page is never destructive —
  // this is just `navigate`, exposed to controls that leave the current agent
  // (switcher, Chat, Usage deep links, "Manage in Settings", "Open Computers").
  const navigateAway = useCallback((to: string) => navigate(to), [navigate]);

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

  const tabBadges = useMemo<Record<string, number>>(() => {
    const badges: Record<string, number> = {};
    const d = toolsResources.data;
    if (d) {
      const count = d.effective.skills.length + d.effective.mcp.length;
      // Don't badge an empty Tools & skills tab with a "0" — a count only earns
      // its space when there's something to count.
      if (count > 0) badges.capabilities = count;
    }
    return badges;
  }, [toolsResources.data]);

  const tabs = useMemo(() => buildTabs(canEditConfig, isHumanLocal), [canEditConfig, isHumanLocal]);
  const currentTabKey = useMemo(() => {
    const segments = location.pathname.split("/");
    const last = segments[segments.length - 1] ?? "";
    return tabs.find((t) => t.path === last)?.key ?? "profile";
  }, [location.pathname, tabs]);
  // The actual current tab PATH (what the switcher preserves when switching
  // agents). Derived from the key rather than assuming key === path.
  const currentTabPath = useMemo(
    () => tabs.find((t) => t.key === currentTabKey)?.path ?? "profile",
    [tabs, currentTabKey],
  );

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

  const shortId = agent.uuid.slice(0, 8);

  const boundClientId = clientStatus?.clientId ?? null;
  const boundClient: HubClient | null = boundClientId
    ? (allClientsQuery.data?.find((c) => c.id === boundClientId) ?? null)
    : null;
  const boundClientLabel: string | null =
    boundClientId && canEditConfig ? (boundClient?.hostname ?? boundClientId) : null;
  // The bound computer's OWN connection state (the matched client row), distinct
  // from this agent's presence: a connected computer with no active agent presence
  // row must still read as online. null when no computer is bound / unknown.
  const boundComputerOnline: boolean | null = boundClient ? boundClient.status === "connected" : null;

  const setupRuntimeProvider: RuntimeProvider = agent.runtimeProvider ?? "claude-code";

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
    clientStatusLoading: clientStatusInitialLoading,
    clientStatusError,
    isUnclaimed,
    isOffline,
    boundClientLabel,
    boundComputerOnline,
    setupRuntimeProvider,
    onOpenBindDialog: () => setBindClientOpen(true),
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
  };

  return (
    <div className="flex flex-col" style={{ minHeight: "calc(100vh - var(--sp-10))" }}>
      <div style={{ padding: "var(--sp-4) 0 var(--sp-4)" }}>
        {/* Inner content sits in the same centered rail as the tabs + tab content,
            so the switcher and title row align with everything below. */}
        <div
          style={{
            maxWidth: "var(--agent-detail-rail)",
            marginLeft: "auto",
            marginRight: "auto",
            paddingLeft: "var(--sp-5)",
            paddingRight: "var(--sp-5)",
          }}
        >
          {/* Agent switcher (vertical-B) replaces the breadcrumb: jump between agents
              (and back to Team) without losing the agent context. */}
          {/* sp-3 gap to the title row: the switcher is demoted nav above the
              page's primary identity, so it sits a touch apart rather than crowding
              the title (part of the 16/12 top rhythm). */}
          <div style={{ marginBottom: "var(--sp-3)" }}>
            <AgentSwitcherStrip currentAgent={agent} currentTabPath={currentTabPath} onNavigate={navigateAway} />
          </div>
          <div className="flex w-full items-center gap-2">
            {/* Primary identity avatar — the largest on the page (switcher nav 28,
                sticky context bar 20), so the title row clearly owns "which agent". */}
            <Avatar
              src={agent.avatarImageUrl}
              name={agent.displayName}
              size={36}
              colorToken={agent.avatarColorToken}
              seed={agent.uuid}
            />
            <div className="flex min-w-0 flex-1 items-baseline gap-2">
              <h1 className="m-0 text-subtitle truncate" style={{ color: "var(--fg)" }} title={`agt_${shortId}`}>
                {agent.displayName}
              </h1>
              {!isNarrow && (
                <span className="mono text-caption shrink-0" style={{ color: "var(--fg-4)" }}>
                  @{agent.name ?? shortId}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {/* One status cluster: presence (with label) + active-session count
                folded in, instead of scattered indicators. */}
              <span className="inline-flex items-center gap-1.5">
                <PresenceChip status={runtimeStateToPresence(agent.runtimeState)} />
                {activeSessions > 0 && (
                  <span className="mono text-caption" style={{ color: "var(--fg-4)" }}>
                    · {activeSessions} active
                  </span>
                )}
              </span>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => {
                  const search = new URLSearchParams({ c: "draft", with: agent.uuid });
                  navigateAway(`/?${search.toString()}`);
                }}
                title="Start a chat with this agent"
                aria-label="Start chat"
                style={{ paddingLeft: "var(--sp-1_5)", paddingRight: "var(--sp-1_5)" }}
              >
                <MessageSquare className="h-4 w-4" />
                Chat
              </Button>
            </div>
          </div>
        </div>
      </div>
      <div ref={headerSentinelRef} aria-hidden style={{ height: 0 }} />

      {!isHuman && (
        <ContextBar
          displayName={agent.displayName}
          avatarImageUrl={agent.avatarImageUrl}
          avatarColorToken={agent.avatarColorToken}
          seed={agent.uuid}
          runtimeState={agent.runtimeState}
          visible={contextBarVisible}
        />
      )}

      <TabsNav tabs={tabs} agentUuid={uuid} currentTabKey={currentTabKey} badges={tabBadges} />

      <div
        className="w-full flex-1"
        style={{
          padding: "var(--sp-3_5) var(--sp-5) var(--sp-7)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--sp-5)",
          width: "100%",
          // One uniform rail across every tab (no per-tab width jump), centered
          // to match the context / team / settings pages.
          maxWidth: "var(--agent-detail-rail)",
          marginLeft: "auto",
          marginRight: "auto",
        }}
      >
        <Outlet context={outletContext} />
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
            <DialogTitle>Bind computer</DialogTitle>
            <DialogDescription>Pin this agent to a connected computer. The bind applies immediately.</DialogDescription>
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
              {bindClientMutation.isPending ? "Binding…" : "Bind"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TabsNav({
  tabs,
  agentUuid,
  currentTabKey,
  badges,
}: {
  tabs: TabDef[];
  agentUuid: string;
  currentTabKey: string;
  badges: Record<string, number>;
}) {
  const navigate = useNavigate();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  // A single-tab agent (e.g. a human, who only has Profile) doesn't need a tab
  // bar at all — rendering one lone underlined tab reads like chrome with no
  // purpose.
  const showBar = tabs.length > 1;

  const updateEdges = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const maxScroll = el.scrollWidth - el.clientWidth;
    setEdges({ left: el.scrollLeft > 1, right: el.scrollLeft < maxScroll - 1 });
  }, []);

  // Keep the active tab in view when the route changes (e.g. a deep link to a
  // tab that sits off the right edge on a narrow screen) and recompute the
  // overflow fades.
  // `currentTabKey`, `tabs` and `badges` are intentional dependencies even though
  // the body reads the active tab from the DOM rather than these variables:
  //  - currentTabKey: programmatic route changes (a deep link to an off-screen
  //    tab) must re-scroll the active tab into view.
  //  - tabs / badges: changing the tab set or a tab's badge changes the row's
  //    scrollWidth, which ResizeObserver (it watches the box, not scrollWidth)
  //    doesn't catch — so recompute the edge fades when they change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: these deps drive the re-run; see comment above.
  useEffect(() => {
    if (!showBar) return;
    const el = scrollRef.current;
    if (!el) return;
    el.querySelector('[aria-selected="true"]')?.scrollIntoView({ inline: "nearest", block: "nearest" });
    updateEdges();
  }, [showBar, currentTabKey, tabs, badges, updateEdges]);

  useEffect(() => {
    if (!showBar) return;
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(updateEdges);
    ro.observe(el);
    return () => ro.disconnect();
  }, [showBar, updateEdges]);

  if (!showBar) return null;

  return (
    // The full tab set can overflow a phone-width row, so the bar scrolls
    // horizontally instead of wrapping; `shrink-0 whitespace-nowrap` on each Tab
    // keeps labels at natural width and swipeable. Edge fades hint at content
    // scrolled out of view; they sit above the bar and ignore pointer events.
    <div style={{ position: "relative" }}>
      <TabBar
        ref={scrollRef}
        role="tablist"
        aria-label="Agent configuration sections"
        // The bar's bottom border + background stay FULL-BLEED (the horizontal
        // rule reads cleaner edge-to-edge); only the tab labels are constrained
        // to the centered rail by the inner wrapper below. So drop the baked-in
        // `padding: 0 var(--sp-5)` here and re-apply it on the rail wrapper.
        //
        // overflowY:hidden (not just minHeight): the active Tab's marginBottom:-1
        // makes its border-box one pixel taller than the bar, and overflowX:auto
        // coerces overflow-y from visible to auto → a spurious VERTICAL scrollbar
        // over that extra pixel. Hiding overflow-y suppresses the scrollbar while
        // keeping the active underline on the baseline and the focus ring intact
        // (verified visually).
        style={{ overflowX: "auto", overflowY: "hidden", padding: 0 }}
        onScroll={updateEdges}
      >
        {/* Centered rail for the tab labels: caps the labels to the same width as
            the header + content, while the TabBar (scroll container) and its
            border stay full-width. */}
        <div
          className="flex items-end"
          style={{
            gap: "var(--sp-0_5)",
            width: "100%",
            maxWidth: "var(--agent-detail-rail)",
            marginLeft: "auto",
            marginRight: "auto",
            paddingLeft: "var(--sp-5)",
            paddingRight: "var(--sp-5)",
          }}
        >
          {tabs.map((t) => {
            const active = currentTabKey === t.key;
            const badge = badges[t.key];
            return (
              <Tab
                key={t.key}
                role="tab"
                aria-selected={active}
                active={active}
                onClick={() => navigate(`/agents/${agentUuid}/${t.path}`, { replace: true })}
                className="shrink-0 whitespace-nowrap"
              >
                {t.label}
                {badge != null ? <TabBadge>{badge}</TabBadge> : null}
              </Tab>
            );
          })}
        </div>
      </TabBar>
      {edges.left ? <TabEdgeFade side="left" /> : null}
      {edges.right ? <TabEdgeFade side="right" /> : null}
    </div>
  );
}

function TabEdgeFade({ side }: { side: "left" | "right" }) {
  return (
    <div
      aria-hidden
      style={{
        position: "absolute",
        top: 0,
        bottom: 0,
        left: side === "left" ? 0 : undefined,
        right: side === "right" ? 0 : undefined,
        width: "var(--sp-6)",
        pointerEvents: "none",
        background: `linear-gradient(to ${side === "left" ? "right" : "left"}, var(--bg-raised), transparent)`,
      }}
    />
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
              Connect a computer first, then return here to bind this agent.
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
