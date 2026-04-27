import { ADAPTER_PLATFORMS } from "@agent-team-foundation/first-tree-hub-shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cable, Link2, Plus, Trash2 } from "lucide-react";
import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { type HubClient, listClients } from "./../api/activity.js";
import { createAdapterMapping, deleteAdapterMapping, listAdapterMappings } from "./../api/adapter-mappings.js";
import { getAdapterStatuses } from "./../api/adapter-status.js";
import { createAdapter, deleteAdapter, listAdapters, updateAdapter } from "./../api/adapters.js";
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
import { FirstTreeLogo } from "./../components/first-tree-logo.js";
import { Breadcrumb, BreadcrumbCurrent, BreadcrumbLink, BreadcrumbSep } from "./../components/ui/breadcrumb.js";
import { Button } from "./../components/ui/button.js";
import { DenseBadge, type DenseBadgeTone } from "./../components/ui/dense-badge.js";
import {
  DenseTable,
  DenseTableBody,
  DenseTableCell,
  DenseTableHead,
  DenseTableHeader,
  DenseTableRow,
} from "./../components/ui/dense-table.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "./../components/ui/dialog.js";
import { Input } from "./../components/ui/input.js";
import { Label } from "./../components/ui/label.js";
import { Panel } from "./../components/ui/panel.js";
import { UppercaseLabel } from "./../components/ui/section-header.js";
import { StateChip } from "./../components/ui/state-chip.js";
import { Tile } from "./../components/ui/tile.js";
import { cn, formatDate } from "./../lib/utils.js";
import { ContextBar } from "./agent-detail/context-bar.js";
import { DangerZone } from "./agent-detail/danger-zone.js";
import { EnvSection } from "./agent-detail/env-section.js";
import { GitSection } from "./agent-detail/git-section.js";
import { IdentitySection } from "./agent-detail/identity-section.js";
import { McpSection } from "./agent-detail/mcp-section.js";
import { ModelSection } from "./agent-detail/model-section.js";
import { OverviewSection } from "./agent-detail/overview-section.js";
import { PromptSection } from "./agent-detail/prompt-section.js";
import { SaveBar, sectionAnchorId } from "./agent-detail/save-bar.js";
import { SectionDivider, SectionShell } from "./agent-detail/section-shell.js";
import { type SetupRuntimeKind, SetupSection } from "./agent-detail/setup-section.js";
import { deriveSaveHint } from "./agent-detail/status-bar.js";
import { useConfigDraft } from "./agent-detail/use-config-draft.js";

const platformValues = Object.values(ADAPTER_PLATFORMS);

type SidebarItem = {
  key: string;
  label: string;
  anchor: string;
  /** Items after the divider render with a visual separation. */
  divider?: boolean;
  /** Red-text styling for Danger zone entry. */
  danger?: boolean;
};

const SECTION_ANCHORS = {
  overview: "ad-overview",
  setup: "ad-setup",
  prompt: sectionAnchorId("prompt"),
  tools: sectionAnchorId("mcp"),
  advanced: "ad-advanced",
  danger: "ad-danger",
} as const;

/**
 * Flat sidebar with a divider before Danger zone. Autonomous agents get the
 * full list; human agents collapse to Overview + Danger zone per the ticket
 * "human agent 自然降级" rule.
 */
function buildSidebar(isHuman: boolean): SidebarItem[] {
  const items: SidebarItem[] = [{ key: "overview", label: "Overview", anchor: SECTION_ANCHORS.overview }];
  if (!isHuman) {
    items.push(
      { key: "setup", label: "Setup", anchor: SECTION_ANCHORS.setup },
      { key: "prompt", label: "Prompt", anchor: SECTION_ANCHORS.prompt },
      { key: "tools", label: "Tools", anchor: SECTION_ANCHORS.tools },
      { key: "advanced", label: "Advanced", anchor: SECTION_ANCHORS.advanced },
    );
  }
  items.push({ key: "danger", label: "Danger zone", anchor: SECTION_ANCHORS.danger, divider: true, danger: true });
  return items;
}

export function AgentDetailPage() {
  const params = useParams<{ uuid: string }>();
  const uuid = params.uuid ?? "";
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Agent identity data
  const agentQuery = useQuery({
    queryKey: ["agent", uuid],
    queryFn: () => getAgent(uuid),
    enabled: !!uuid,
  });

  const cfgQuery = useQuery({
    queryKey: ["agent-config", uuid],
    queryFn: () => getAgentConfig(uuid),
    enabled: !!uuid && agentQuery.data?.type !== "human",
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

  const adaptersQuery = useQuery({ queryKey: ["adapters"], queryFn: listAdapters });
  const mappingsQuery = useQuery({ queryKey: ["adapter-mappings"], queryFn: listAdapterMappings });
  const { data: botStatuses } = useQuery({
    queryKey: ["adapter-statuses"],
    queryFn: getAdapterStatuses,
    refetchInterval: 15_000,
  });

  const agentAdapters = adaptersQuery.data?.filter((a) => a.agentId === uuid) ?? [];
  const agentMappings = mappingsQuery.data?.filter((m) => m.agentId === uuid) ?? [];

  // All connected/known clients; used to resolve the bound computer's hostname
  // for the sticky context bar and Overview. This is distinct from the
  // bind-dialog-gated query below (that one only fires when the dialog opens).
  const allClientsQuery = useQuery({
    queryKey: ["clients"],
    queryFn: listClients,
    enabled: !!uuid && agentQuery.data?.type !== "human",
    refetchInterval: 30_000,
  });

  // -- Config draft
  const draft = useConfigDraft(cfgQuery.data);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflictMsg, setConflictMsg] = useState<string | null>(null);
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

  const reloadRemote = useCallback(() => {
    setConflictMsg(null);
    setSaveError(null);
    queryClient.invalidateQueries({ queryKey: ["agent-config", uuid] });
    draft.resetAll();
  }, [queryClient, uuid, draft]);

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
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["agent", uuid] }),
  });
  const reactivateMutation = useMutation({
    mutationFn: () => reactivateAgent(uuid),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["agent", uuid] }),
  });
  const deleteMutation = useMutation({
    mutationFn: () => deleteAgent(uuid),
    onSuccess: () => navigate("/agents"),
  });

  // Test connection
  const testMutation = useMutation({ mutationFn: () => testAgentConnection(uuid) });

  // Bind-client (agent ↔ client first-time binding) dialog state
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

  const [bindingDialogOpen, setBindingDialogOpen] = useState(false);
  const [bindingEditId, setBindingEditId] = useState<number | null>(null);
  const [bindingForm, setBindingForm] = useState(EMPTY_BINDING_FORM);
  const [bindingCredError, setBindingCredError] = useState("");
  // Confirm-dialog state that used to be handled by window.confirm(). Holding
  // the target id (or `true` for discard) keeps the corresponding Radix Dialog
  // open; null/false closes it.
  const [mappingToDelete, setMappingToDelete] = useState<number | null>(null);
  const [adapterToDelete, setAdapterToDelete] = useState<number | null>(null);
  const [discardDialogOpen, setDiscardDialogOpen] = useState(false);
  const createAdapterMutation = useMutation({
    mutationFn: async () => {
      const creds = buildCredentials(bindingForm);
      if (!creds) throw new Error("Credentials are required");
      return createAdapter({
        platform: bindingForm.platform as "feishu" | "slack" | "kael",
        agentId: uuid,
        credentials: creds,
        status: bindingForm.status as "active" | "inactive",
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["adapters"] });
      closeBindingDialog();
    },
  });
  const updateAdapterMutation = useMutation({
    mutationFn: () => {
      if (!bindingEditId) throw new Error("No adapter selected");
      const data: Record<string, unknown> = { status: bindingForm.status };
      const creds = buildCredentials(bindingForm);
      if (creds) data.credentials = creds;
      return updateAdapter(bindingEditId, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["adapters"] });
      closeBindingDialog();
    },
  });
  const deleteAdapterMutation = useMutation({
    mutationFn: deleteAdapter,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["adapters"] }),
  });
  const createMappingMutation = useMutation({
    mutationFn: () =>
      createAdapterMapping({
        platform: bindingForm.platform as "feishu" | "slack" | "kael",
        externalUserId: bindingForm.externalUserId,
        agentId: uuid,
        boundVia: "manual",
        displayName: bindingForm.displayName || undefined,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["adapter-mappings"] });
      closeBindingDialog();
    },
  });
  const deleteMappingMutation = useMutation({
    mutationFn: deleteAdapterMapping,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["adapter-mappings"] }),
  });

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
  const sidebarItems = useMemo(() => buildSidebar(isHumanLocal), [isHumanLocal]);

  // Sticky ContextBar visibility: hide while the Overview section is on screen
  // (its Status & Health card already shows runtime/computer/model), show once
  // the operator has scrolled past it. Driven by an IntersectionObserver on a
  // zero-height sentinel placed at the bottom of the Overview section.
  const overviewSentinelRef = useRef<HTMLDivElement | null>(null);
  const [contextBarVisible, setContextBarVisible] = useState(false);
  useEffect(() => {
    if (isHumanLocal) return;
    const el = overviewSentinelRef.current;
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
  const isUnclaimed = !isHuman && !clientStatus?.clientId;
  const isOffline = !isHuman && clientStatus ? !clientStatus.online && !!clientStatus.clientId : false;

  const runtimeExt = agent as Record<string, unknown>;
  const runtimeState = (runtimeExt.runtimeState as string | null) ?? null;
  const runtimeType = (runtimeExt.runtimeType as string | null) ?? null;
  const totalSessions = (runtimeExt.totalSessions as number | null) ?? null;

  const shortId = agent.uuid.slice(0, 8);

  function closeBindingDialog() {
    setBindingDialogOpen(false);
    setBindingEditId(null);
    setBindingForm(EMPTY_BINDING_FORM);
    setBindingCredError("");
  }
  function openEditAdapter(adapter: { id: number; platform: string; status: string }) {
    setBindingEditId(adapter.id);
    setBindingForm({ ...EMPTY_BINDING_FORM, platform: adapter.platform, status: adapter.status });
    setBindingDialogOpen(true);
  }
  function handleBindingSubmit(e: FormEvent) {
    e.preventDefault();
    setBindingCredError("");
    if (isHuman) {
      if (!bindingForm.externalUserId) return;
      createMappingMutation.mutate();
      return;
    }
    if (bindingForm.platform === "feishu") {
      if (!bindingEditId && (!bindingForm.feishuAppId || !bindingForm.feishuAppSecret)) {
        setBindingCredError("App ID and App Secret are required");
        return;
      }
    } else if (bindingForm.platform === "kael") {
      if (!bindingEditId && (!bindingForm.kaelUserId || !bindingForm.kaelProjectId)) {
        setBindingCredError("User ID and Project ID are required");
        return;
      }
    } else {
      const trimmed = bindingForm.credentialsJson.trim();
      if (!bindingEditId && !trimmed) {
        setBindingCredError("Credentials are required");
        return;
      }
      if (trimmed) {
        try {
          JSON.parse(trimmed);
        } catch {
          setBindingCredError("Invalid JSON");
          return;
        }
      }
    }
    if (bindingEditId) updateAdapterMutation.mutate();
    else createAdapterMutation.mutate();
  }

  const bindingMutationError =
    createAdapterMutation.error ?? updateAdapterMutation.error ?? createMappingMutation.error;
  const bindingIsPending =
    createAdapterMutation.isPending || updateAdapterMutation.isPending || createMappingMutation.isPending;

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
  const boundClientLabel: string | null = boundClientId ? (boundClient?.hostname ?? boundClientId) : null;

  // Runtime kind label for the Setup "Where it runs" card. The agent schema
  // does not currently carry a first-class runtime field; we derive from
  // `runtimeType` when the backend reports it ("kael"), otherwise treat the
  // agent as Claude Code, which matches today's only shipping runtime.
  const setupRuntimeKind: SetupRuntimeKind = runtimeType === "kael" ? "kael" : "claude-code";
  const contextRuntimeLabel =
    setupRuntimeKind === "kael" ? "Kael" : setupRuntimeKind === "claude-code" ? "Claude Code" : (runtimeType ?? "—");

  const bindingsPanel = (
    <Panel>
      <div
        className="flex items-center justify-between"
        style={{
          padding: "var(--sp-2_5) var(--sp-3_5)",
          borderBottom: "var(--hairline) solid var(--border-faint)",
        }}
      >
        <div className="inline-flex items-center gap-2 text-body font-semibold">
          {isHuman ? <Link2 className="h-3.5 w-3.5" /> : <Cable className="h-3.5 w-3.5" />}
          Platform bindings
        </div>
        <Button size="xs" variant="outline" onClick={() => setBindingDialogOpen(true)}>
          <Plus className="h-3 w-3" />
          {isHuman ? "Bind user" : "Bind bot"}
        </Button>
      </div>
      {isHuman ? (
        <DenseTable>
          <DenseTableHeader>
            <DenseTableRow>
              <DenseTableHead>Platform</DenseTableHead>
              <DenseTableHead>External user ID</DenseTableHead>
              <DenseTableHead>Display name</DenseTableHead>
              <DenseTableHead>Bound via</DenseTableHead>
              <DenseTableHead>Created</DenseTableHead>
              <DenseTableHead style={{ width: 32 }} />
            </DenseTableRow>
          </DenseTableHeader>
          <DenseTableBody>
            {agentMappings.length === 0 ? (
              <DenseTableRow>
                <DenseTableCell colSpan={6} style={{ textAlign: "center", color: "var(--fg-3)", padding: 16 }}>
                  No platform bindings
                </DenseTableCell>
              </DenseTableRow>
            ) : (
              agentMappings.map((m) => (
                <DenseTableRow key={m.id}>
                  <DenseTableCell>
                    <DenseBadge>{m.platform}</DenseBadge>
                  </DenseTableCell>
                  <DenseTableCell className="mono text-label">{m.externalUserId}</DenseTableCell>
                  <DenseTableCell>{m.displayName ?? "—"}</DenseTableCell>
                  <DenseTableCell>
                    <DenseBadge tone="outline">{m.boundVia ?? "—"}</DenseBadge>
                  </DenseTableCell>
                  <DenseTableCell className="mono text-caption" style={{ color: "var(--fg-4)" }}>
                    {formatDate(m.createdAt)}
                  </DenseTableCell>
                  <DenseTableCell>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => setMappingToDelete(m.id)}
                      disabled={deleteMappingMutation.isPending}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </DenseTableCell>
                </DenseTableRow>
              ))
            )}
          </DenseTableBody>
        </DenseTable>
      ) : (
        <DenseTable>
          <DenseTableHeader>
            <DenseTableRow>
              <DenseTableHead>Platform</DenseTableHead>
              <DenseTableHead>Status</DenseTableHead>
              <DenseTableHead>Connection</DenseTableHead>
              <DenseTableHead>Created</DenseTableHead>
              <DenseTableHead style={{ width: 64 }} />
            </DenseTableRow>
          </DenseTableHeader>
          <DenseTableBody>
            {agentAdapters.length === 0 ? (
              <DenseTableRow>
                <DenseTableCell colSpan={5} style={{ textAlign: "center", color: "var(--fg-3)", padding: 16 }}>
                  No platform bindings
                </DenseTableCell>
              </DenseTableRow>
            ) : (
              agentAdapters.map((a) => {
                const status = botStatuses?.find((s) => s.configId === a.id);
                const isConnected = a.platform === "kael" ? a.status === "active" : !!status?.connected;
                return (
                  <DenseTableRow key={a.id}>
                    <DenseTableCell>
                      <DenseBadge>{a.platform}</DenseBadge>
                    </DenseTableCell>
                    <DenseTableCell>
                      <DenseBadge tone={a.status === "active" ? "accent" : "outline"}>{a.status}</DenseBadge>
                    </DenseTableCell>
                    <DenseTableCell>
                      <StateChip state={isConnected ? "idle" : "offline"} />
                    </DenseTableCell>
                    <DenseTableCell className="mono text-caption" style={{ color: "var(--fg-4)" }}>
                      {formatDate(a.createdAt)}
                    </DenseTableCell>
                    <DenseTableCell>
                      <div className="flex gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => openEditAdapter(a)}
                          title="Edit"
                        >
                          …
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => setAdapterToDelete(a.id)}
                          disabled={deleteAdapterMutation.isPending}
                          title="Delete"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </DenseTableCell>
                  </DenseTableRow>
                );
              })
            )}
          </DenseTableBody>
        </DenseTable>
      )}
    </Panel>
  );

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
            <button
              type="button"
              onClick={() => jumpTo(it.anchor)}
              className="block w-full text-left bg-transparent text-body"
              style={{
                padding: "var(--sp-1_25) var(--sp-4) var(--sp-1_25) var(--sp-3_5)",
                color: it.danger ? "var(--state-error)" : "var(--fg-3)",
                border: "none",
                borderLeft: "var(--hairline-bold) solid transparent",
                cursor: "pointer",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = it.danger ? "var(--state-error)" : "var(--fg)";
                e.currentTarget.style.background = "var(--bg-hover)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = it.danger ? "var(--state-error)" : "var(--fg-3)";
                e.currentTarget.style.background = "transparent";
              }}
            >
              {it.label}
            </button>
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
          <Breadcrumb style={{ marginBottom: 8 }}>
            <BreadcrumbLink onClick={() => navigate("/agents")}>Agents</BreadcrumbLink>
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
                <span className="text-title">{agent.displayName ?? agent.name ?? shortId}</span>
                <span className="mono text-label" style={{ color: "var(--fg-4)" }}>
                  @{agent.name ?? shortId}
                </span>
              </div>
              <div className="mono text-caption" style={{ color: "var(--fg-4)" }}>
                agt_{shortId} · {agent.type}
                {agent.visibility ? ` · ${agent.visibility}` : ""}
              </div>
            </div>
            <StateChip state={runtimeState} />
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

        {!isHuman && (
          <ContextBar
            runtimeLabel={contextRuntimeLabel}
            computerLabel={boundClientLabel}
            modelLabel={tileValues.model}
            visible={contextBarVisible}
          />
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

          <SectionShell anchorId={SECTION_ANCHORS.overview} title="Overview">
            <OverviewSection
              agent={agent}
              isHuman={isHuman}
              profileSlot={
                <IdentitySection
                  agent={agent}
                  onSave={async (patch) => {
                    await identityUpdateMutation.mutateAsync(patch);
                  }}
                />
              }
              bindingsSlot={bindingsPanel}
              health={{
                runtimeState,
                model: tileValues.model,
                activeSessions,
                totalSessions: tileValues.sessions,
                offlineSince: clientStatus?.offlineSince ?? null,
              }}
              onOpenChat={() => navigate(`/?a=${agent.uuid}`)}
              onTest={() => {
                testMutation.reset();
                testMutation.mutate();
              }}
              testPending={testMutation.isPending}
            />
          </SectionShell>
          {/* Sentinel observed by the ContextBar IntersectionObserver above. */}
          <div ref={overviewSentinelRef} aria-hidden style={{ height: 0 }} />

          {!isHuman && (
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
                    runtimeKind={setupRuntimeKind}
                    computerLabel={boundClientLabel}
                    canBindComputer={isUnclaimed && agent.status === "active"}
                    bindComputerPending={bindClientMutation.isPending}
                    onBindComputer={() => setBindClientOpen(true)}
                    modelSlot={
                      <ModelSection
                        value={draft.draft.model}
                        baseline={cfgQuery.data?.payload.model ?? ""}
                        onChange={draft.setModel}
                        onRevert={draft.revertModel}
                        disabled={agent.status !== "active"}
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
                    <div id={sectionAnchorId("env")} className="space-y-2">
                      <h3 className="text-body font-medium" style={{ color: "var(--fg)" }}>
                        Environment variables
                      </h3>
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
                    <hr aria-hidden style={{ border: 0, borderTop: "var(--hairline) solid var(--border-faint)" }} />
                    <div id={sectionAnchorId("git")} className="space-y-2">
                      <h3 className="text-body font-medium" style={{ color: "var(--fg)" }}>
                        Git repositories
                      </h3>
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
                          padding: 8,
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

          <SectionDivider />

          <DangerZone
            agent={agent}
            suspendPending={suspendMutation.isPending}
            reactivatePending={reactivateMutation.isPending}
            deletePending={deleteMutation.isPending}
            onSuspend={() => suspendMutation.mutate()}
            onReactivate={() => reactivateMutation.mutate()}
            onDelete={() => deleteMutation.mutate()}
          />
        </div>

        {!isHuman && (
          <SaveBar
            summary={draft.summary}
            saveHint={saveHint}
            conflictMessage={conflictMsg}
            errorMessage={saveError}
            saving={saveMutation.isPending}
            justSaved={justSaved}
            onSave={() => saveMutation.mutate()}
            onDiscard={() => {
              if (!draft.summary.anyDirty) return;
              setDiscardDialogOpen(true);
            }}
            onReloadRemote={reloadRemote}
            onJumpTo={(section) => jumpTo(sectionAnchorId(section))}
          />
        )}
      </div>

      <ConfirmDialog
        open={mappingToDelete != null}
        onOpenChange={(o) => !o && setMappingToDelete(null)}
        title="Remove this binding?"
        description="The external user will stop routing to this agent. You can add the mapping again later."
        confirmLabel="Remove binding"
        pending={deleteMappingMutation.isPending}
        onConfirm={() => {
          if (mappingToDelete != null) {
            deleteMappingMutation.mutate(mappingToDelete);
            setMappingToDelete(null);
          }
        }}
      />

      <ConfirmDialog
        open={adapterToDelete != null}
        onOpenChange={(o) => !o && setAdapterToDelete(null)}
        title="Remove this bot binding?"
        description="The bot will stop routing to this agent and any platform credentials stored here will be dropped."
        confirmLabel="Remove binding"
        pending={deleteAdapterMutation.isPending}
        onConfirm={() => {
          if (adapterToDelete != null) {
            deleteAdapterMutation.mutate(adapterToDelete);
            setAdapterToDelete(null);
          }
        }}
      />

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

      <Dialog
        open={bindingDialogOpen}
        onOpenChange={(open) => (open ? setBindingDialogOpen(true) : closeBindingDialog())}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {isHuman ? "Bind External User" : bindingEditId ? "Edit Bot Binding" : "Bind Bot"}
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={handleBindingSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="binding-platform">Platform</Label>
              <select
                id="binding-platform"
                value={bindingForm.platform}
                onChange={(e) => setBindingForm({ ...bindingForm, platform: e.target.value })}
                disabled={!!bindingEditId}
                className="flex h-9 w-full rounded-[var(--radius-input)] border border-input bg-transparent px-3 py-1 text-body shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
              >
                {platformValues.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>

            {isHuman ? (
              <>
                <div className="space-y-2">
                  <Label htmlFor="binding-ext-id">External User ID</Label>
                  <Input
                    id="binding-ext-id"
                    value={bindingForm.externalUserId}
                    onChange={(e) => setBindingForm({ ...bindingForm, externalUserId: e.target.value })}
                    placeholder="ou_xxxxxxxx..."
                    className="font-mono"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="binding-name">Display Name (optional)</Label>
                  <Input
                    id="binding-name"
                    value={bindingForm.displayName}
                    onChange={(e) => setBindingForm({ ...bindingForm, displayName: e.target.value })}
                  />
                </div>
              </>
            ) : (
              <>
                {bindingForm.platform === "feishu" ? (
                  <>
                    <div className="space-y-2">
                      <Label htmlFor="feishu-app-id">
                        App ID{bindingEditId ? " — leave empty to keep existing" : ""}
                      </Label>
                      <Input
                        id="feishu-app-id"
                        value={bindingForm.feishuAppId}
                        onChange={(e) => setBindingForm({ ...bindingForm, feishuAppId: e.target.value })}
                        placeholder="cli_xxxxxxxx"
                        className="font-mono"
                        autoComplete="off"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="feishu-app-secret">
                        App Secret{bindingEditId ? " — leave empty to keep existing" : ""}
                      </Label>
                      <Input
                        id="feishu-app-secret"
                        type="password"
                        autoComplete="new-password"
                        value={bindingForm.feishuAppSecret}
                        onChange={(e) => setBindingForm({ ...bindingForm, feishuAppSecret: e.target.value })}
                        placeholder="••••••••"
                      />
                    </div>
                  </>
                ) : bindingForm.platform === "kael" ? (
                  <>
                    <div className="space-y-2">
                      <Label htmlFor="kael-user-id">
                        User ID{bindingEditId ? " — leave empty to keep existing" : ""}
                      </Label>
                      <Input
                        id="kael-user-id"
                        value={bindingForm.kaelUserId}
                        onChange={(e) => setBindingForm({ ...bindingForm, kaelUserId: e.target.value })}
                        placeholder="user_xxxxxxxx"
                        className="font-mono"
                        autoComplete="off"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="kael-project-id">
                        Project ID{bindingEditId ? " — leave empty to keep existing" : ""}
                      </Label>
                      <Input
                        id="kael-project-id"
                        value={bindingForm.kaelProjectId}
                        onChange={(e) => setBindingForm({ ...bindingForm, kaelProjectId: e.target.value })}
                        placeholder="proj_xxxxxxxx"
                        className="font-mono"
                        autoComplete="off"
                      />
                    </div>
                    {!bindingEditId && (
                      <p className="text-body" style={{ color: "var(--fg-3)" }}>
                        Agent Token will be created automatically when you save.
                      </p>
                    )}
                  </>
                ) : (
                  <div className="space-y-2">
                    <Label htmlFor="binding-creds">
                      Credentials (JSON){bindingEditId ? " — leave empty to keep existing" : ""}
                    </Label>
                    <textarea
                      id="binding-creds"
                      value={bindingForm.credentialsJson}
                      onChange={(e) => setBindingForm({ ...bindingForm, credentialsJson: e.target.value })}
                      rows={4}
                      className="flex w-full rounded-[var(--radius-input)] border border-input bg-transparent px-3 py-2 text-body shadow-sm font-mono focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      placeholder='{"bot_token": "xoxb-...", "signing_secret": "..."}'
                    />
                  </div>
                )}
                {bindingCredError && (
                  <p className="text-body" style={{ color: "var(--state-error)" }}>
                    {bindingCredError}
                  </p>
                )}
                <div className="space-y-2">
                  <Label htmlFor="binding-status">Status</Label>
                  <select
                    id="binding-status"
                    value={bindingForm.status}
                    onChange={(e) => setBindingForm({ ...bindingForm, status: e.target.value })}
                    className="flex h-9 w-full rounded-[var(--radius-input)] border border-input bg-transparent px-3 py-1 text-body shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <option value="active">active</option>
                    <option value="inactive">inactive</option>
                  </select>
                </div>
              </>
            )}

            {bindingMutationError instanceof Error && (
              <div className="text-body" style={{ color: "var(--state-error)" }}>
                {bindingMutationError.message}
              </div>
            )}
            <DialogFooter>
              <Button type="submit" disabled={bindingIsPending}>
                {bindingIsPending ? "Saving..." : bindingEditId ? "Update" : "Create"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
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

// ─── binding helpers ──────────────────────────────────────────────────

const EMPTY_BINDING_FORM = {
  platform: "feishu",
  feishuAppId: "",
  feishuAppSecret: "",
  credentialsJson: "{}",
  status: "active",
  externalUserId: "",
  displayName: "",
  kaelUserId: "",
  kaelProjectId: "",
  kaelAgentToken: "",
};

function buildCredentials(form: {
  platform: string;
  feishuAppId: string;
  feishuAppSecret: string;
  credentialsJson: string;
  kaelUserId: string;
  kaelProjectId: string;
  kaelAgentToken: string;
}): Record<string, unknown> | null {
  if (form.platform === "feishu") {
    if (!form.feishuAppId && !form.feishuAppSecret) return null;
    if (!form.feishuAppId || !form.feishuAppSecret) {
      throw new Error("Both App ID and App Secret are required");
    }
    return { app_id: form.feishuAppId, app_secret: form.feishuAppSecret };
  }
  if (form.platform === "kael") {
    if (!form.kaelUserId && !form.kaelProjectId) return null;
    if (!form.kaelUserId || !form.kaelProjectId) {
      throw new Error("User ID and Project ID are required");
    }
    return { kaelUserId: form.kaelUserId, kaelProjectId: form.kaelProjectId };
  }
  const trimmed = form.credentialsJson.trim();
  if (!trimmed) return null;
  return JSON.parse(trimmed) as Record<string, unknown>;
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
  const bindable = clients.filter((c) => c.status === "connected");
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
        const online = c.status === "online" || c.status === "active";
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
                style={{ background: online ? "var(--state-idle)" : "var(--fg-4)" }}
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
