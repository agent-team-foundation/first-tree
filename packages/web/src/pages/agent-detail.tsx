import { ADAPTER_PLATFORMS } from "@agent-team-foundation/first-tree-hub-shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cable, Link2, Play, Plus, Trash2 } from "lucide-react";
import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
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
import { useAuth } from "./../auth/auth-context.js";
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
import { DangerZone } from "./agent-detail/danger-zone.js";
import { EnvSection } from "./agent-detail/env-section.js";
import { GitSection } from "./agent-detail/git-section.js";
import { IdentitySection } from "./agent-detail/identity-section.js";
import { McpSection } from "./agent-detail/mcp-section.js";
import { ModelSection } from "./agent-detail/model-section.js";
import { PromptSection } from "./agent-detail/prompt-section.js";
import { SaveBar, sectionAnchorId } from "./agent-detail/save-bar.js";
import { deriveSaveHint } from "./agent-detail/status-bar.js";
import { useConfigDraft } from "./agent-detail/use-config-draft.js";

const platformValues = Object.values(ADAPTER_PLATFORMS);

type SidebarItem = {
  key: string;
  label: string;
  anchor: string;
};

type SidebarGroup = {
  label: string;
  items: SidebarItem[];
};

function buildSidebar(isHuman: boolean, isManager: boolean): SidebarGroup[] {
  // Non-managers see only the profile card — Runtime (behavior config) and
  // Danger zone are manager-only per the backend guard `assertCanManage`.
  // Bindings are also filtered server-side for non-managers, so we drop
  // the anchor rather than showing a no-op section.
  const identity: SidebarItem[] = [{ key: "identity", label: "Profile", anchor: "ad-identity" }];
  if (isManager) identity.push({ key: "bindings", label: "Bindings", anchor: "ad-bindings" });
  const runtime: SidebarItem[] =
    !isHuman && isManager
      ? [
          { key: "prompt", label: "Prompt", anchor: sectionAnchorId("prompt") },
          { key: "model", label: "Model", anchor: sectionAnchorId("model") },
          { key: "mcp", label: "MCP tools", anchor: sectionAnchorId("mcp") },
          { key: "env", label: "Environment", anchor: sectionAnchorId("env") },
          { key: "git", label: "Git", anchor: sectionAnchorId("git") },
        ]
      : [];
  const groups: SidebarGroup[] = [{ label: "Identity", items: identity }];
  if (runtime.length > 0) groups.push({ label: "Runtime", items: runtime });
  if (isManager) {
    groups.push({
      label: "Danger zone",
      items: [{ key: "danger", label: "Danger zone", anchor: "ad-danger" }],
    });
  }
  return groups;
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

  // Manager-only gating — mirrors the backend `assertCanManage` guard on
  // /admin/agents/:uuid/config. The backend is the authoritative check; this
  // UI gate just avoids no-op fetches and confusing error states.
  //
  // IMPORTANT — null-is-permissive: `useAuth()` leaves `memberId`/`role` null
  // when the initial /me call transiently fails (non-401 errors are swallowed
  // in auth-context.tsx without retry). Treating null as "can't manage" would
  // lock real managers out of their own agent for the rest of the session
  // whenever /me flaked once. Default to permissive when auth is unresolved —
  // a non-manager seeing transient edit UI is a cosmetic bug the backend
  // rejects; a manager locked out is a regression.
  const canManage =
    agentQuery.data != null && (memberId == null || role === "admin" || agentQuery.data.managerId === memberId);

  const cfgQuery = useQuery({
    queryKey: ["agent-config", uuid],
    queryFn: () => getAgentConfig(uuid),
    enabled: !!uuid && agentQuery.data?.type !== "human" && canManage,
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

  // -- Config draft
  const draft = useConfigDraft(cfgQuery.data);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflictMsg, setConflictMsg] = useState<string | null>(null);

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
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409) {
        setConflictMsg("Someone else saved a newer version while you were editing.");
        setSaveError(null);
        return;
      }
      setSaveError(err instanceof Error ? err.message : String(err));
    },
  });

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
  const sidebarGroups = useMemo(() => buildSidebar(isHumanLocal, canManage), [isHumanLocal, canManage]);

  if (agentQuery.isLoading) {
    return (
      <div className="-m-6 flex" style={{ minHeight: "100%" }}>
        <div className="p-6" style={{ color: "var(--fg-3)", fontSize: 12 }}>
          Loading…
        </div>
      </div>
    );
  }
  if (agentQuery.error) {
    return (
      <div className="-m-6 p-6" style={{ color: "var(--state-error)", fontSize: 12 }}>
        Failed to load agent: {agentQuery.error instanceof Error ? agentQuery.error.message : "Unknown error"}
      </div>
    );
  }
  const agent = agentQuery.data;
  if (!agent) {
    return (
      <div className="-m-6 p-6" style={{ color: "var(--fg-3)", fontSize: 12 }}>
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

  return (
    <div className="-m-6 flex" style={{ minHeight: "calc(100vh - 40px)" }}>
      <aside
        className="shrink-0 overflow-auto"
        style={{
          width: 220,
          borderRight: "1px solid var(--border)",
          background: "var(--bg-raised)",
          padding: "12px 0",
        }}
      >
        {sidebarGroups.map((group) => (
          <div key={group.label} style={{ marginBottom: 12 }}>
            <UppercaseLabel style={{ display: "block", padding: "4px 16px" }}>{group.label}</UppercaseLabel>
            {group.items.map((it) => (
              <button
                key={it.key}
                type="button"
                onClick={() => jumpTo(it.anchor)}
                className="block w-full text-left bg-transparent"
                style={{
                  padding: "5px 16px 5px 14px",
                  fontSize: 12,
                  color: "var(--fg-3)",
                  border: "none",
                  borderLeft: "2px solid transparent",
                  cursor: "pointer",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.color = "var(--fg)";
                  e.currentTarget.style.background = "var(--bg-hover)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = "var(--fg-3)";
                  e.currentTarget.style.background = "transparent";
                }}
              >
                {it.label}
              </button>
            ))}
          </div>
        ))}
      </aside>

      <div className="flex-1 min-w-0 overflow-auto" style={{ background: "var(--bg)" }}>
        <div
          style={{
            padding: "14px 20px",
            borderBottom: "1px solid var(--border-faint)",
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
                borderRadius: 6,
                background: "var(--bg-active)",
                border: "1px solid var(--border-strong)",
              }}
            >
              <FirstTreeLogo width={18} height={20} style={{ color: "var(--accent)" }} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline gap-2">
                <span style={{ fontSize: 16, fontWeight: 600, letterSpacing: -0.2 }}>
                  {agent.displayName ?? agent.name ?? shortId}
                </span>
                <span className="mono" style={{ fontSize: 11, color: "var(--fg-4)" }}>
                  @{agent.name ?? shortId}
                </span>
              </div>
              <div className="mono" style={{ fontSize: 10.5, color: "var(--fg-4)" }}>
                agt_{shortId} · {agent.type}
                {agent.visibility ? ` · ${agent.visibility}` : ""}
              </div>
            </div>
            <StateChip state={runtimeState} />
            <div className="flex gap-1.5">
              <Button variant="ghost" size="xs" onClick={() => navigate(`/?a=${agent.uuid}`)}>
                Open chat →
              </Button>
              {!isHuman && agent.status === "active" && canManage && (
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => {
                    testMutation.reset();
                    testMutation.mutate();
                  }}
                  disabled={testMutation.isPending}
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

        <div
          className="mx-auto"
          style={{ padding: "14px 20px 28px", maxWidth: 960, display: "flex", flexDirection: "column", gap: 16 }}
        >
          {(testMutation.data || testMutation.error) && (
            <TestResultCard
              result={testMutation.data ?? { status: "error", message: "Failed to reach server" }}
              onDismiss={() => testMutation.reset()}
            />
          )}

          {isUnclaimed && agent.status === "active" && canManage && (
            <div
              className="flex items-center justify-between gap-3"
              style={{
                borderRadius: 6,
                padding: "10px 14px",
                background: "color-mix(in oklch, var(--state-blocked) 10%, transparent)",
                border: "1px solid color-mix(in oklch, var(--state-blocked) 28%, transparent)",
              }}
            >
              <div style={{ fontSize: 12 }}>
                <div style={{ fontWeight: 500 }}>No computer bound</div>
                <div style={{ color: "var(--fg-3)", fontSize: 11 }}>
                  Bind this agent to a computer so it can run. A computer will also claim it on first WebSocket connect.
                </div>
              </div>
              <Button size="xs" variant="outline" onClick={() => setBindClientOpen(true)}>
                <Link2 className="h-3 w-3" />
                Bind computer
              </Button>
            </div>
          )}

          <div id="ad-identity">
            <IdentitySection
              agent={agent}
              onSave={async (patch) => {
                await identityUpdateMutation.mutateAsync(patch);
              }}
            />
          </div>

          {!isHuman && canManage && (
            <BehaviorSection
              loaded={!!cfgQuery.data}
              loading={cfgQuery.isLoading}
              error={cfgQuery.error ? String(cfgQuery.error) : null}
              version={cfgQuery.data?.version ?? null}
              dirty={draft.summary.anyDirty}
            >
              <div id={sectionAnchorId("prompt")}>
                <PromptSection
                  value={draft.draft.promptAppend}
                  baseline={cfgQuery.data?.payload.prompt.append ?? ""}
                  onChange={draft.setPromptAppend}
                  onRevert={draft.revertPrompt}
                  disabled={agent.status !== "active"}
                />
              </div>
              <div id={sectionAnchorId("model")}>
                <ModelSection
                  value={draft.draft.model}
                  baseline={cfgQuery.data?.payload.model ?? ""}
                  onChange={draft.setModel}
                  onRevert={draft.revertModel}
                  disabled={agent.status !== "active"}
                />
              </div>
              <div id={sectionAnchorId("mcp")}>
                <McpSection
                  items={draft.draft.mcp}
                  otherNames={mcpOtherNames}
                  onAdd={draft.addMcp}
                  onUpdate={draft.updateMcp}
                  onDelete={draft.deleteMcp}
                  onUndoDelete={draft.undoDeleteMcp}
                  disabled={agent.status !== "active"}
                />
              </div>
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
                  className="whitespace-pre-wrap mono"
                  style={{
                    padding: 8,
                    borderRadius: 4,
                    background: "var(--bg-sunken)",
                    border: "1px solid var(--border-faint)",
                    fontSize: 11,
                    color: "var(--fg-2)",
                  }}
                >
                  {dryRunText}
                </pre>
              )}
            </BehaviorSection>
          )}

          {canManage && (
            <div id="ad-bindings">
              <Panel>
                <div
                  className="flex items-center justify-between"
                  style={{ padding: "10px 14px", borderBottom: "1px solid var(--border-faint)" }}
                >
                  <div className="inline-flex items-center gap-2" style={{ fontSize: 12, fontWeight: 600 }}>
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
                          <DenseTableCell
                            colSpan={6}
                            style={{ textAlign: "center", color: "var(--fg-3)", padding: 16 }}
                          >
                            No platform bindings
                          </DenseTableCell>
                        </DenseTableRow>
                      ) : (
                        agentMappings.map((m) => (
                          <DenseTableRow key={m.id}>
                            <DenseTableCell>
                              <DenseBadge>{m.platform}</DenseBadge>
                            </DenseTableCell>
                            <DenseTableCell className="mono" style={{ fontSize: 11 }}>
                              {m.externalUserId}
                            </DenseTableCell>
                            <DenseTableCell>{m.displayName ?? "—"}</DenseTableCell>
                            <DenseTableCell>
                              <DenseBadge tone="outline">{m.boundVia ?? "—"}</DenseBadge>
                            </DenseTableCell>
                            <DenseTableCell className="mono" style={{ fontSize: 10.5, color: "var(--fg-4)" }}>
                              {formatDate(m.createdAt)}
                            </DenseTableCell>
                            <DenseTableCell>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7"
                                onClick={() => {
                                  if (confirm("Remove this binding?")) deleteMappingMutation.mutate(m.id);
                                }}
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
                          <DenseTableCell
                            colSpan={5}
                            style={{ textAlign: "center", color: "var(--fg-3)", padding: 16 }}
                          >
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
                              <DenseTableCell className="mono" style={{ fontSize: 10.5, color: "var(--fg-4)" }}>
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
                                    onClick={() => {
                                      if (confirm("Remove this bot binding?")) deleteAdapterMutation.mutate(a.id);
                                    }}
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
            </div>
          )}

          {canManage && (
            <div id="ad-danger">
              <DangerZone
                agent={agent}
                suspendPending={suspendMutation.isPending}
                reactivatePending={reactivateMutation.isPending}
                deletePending={deleteMutation.isPending}
                onSuspend={() => {
                  if (confirm("Suspend this agent? Runtime binds and HTTP calls will be refused."))
                    suspendMutation.mutate();
                }}
                onReactivate={() => reactivateMutation.mutate()}
                onDelete={() => deleteMutation.mutate()}
              />
            </div>
          )}

          {!isHuman && canManage && draft.summary.anyDirty && (
            <div style={{ fontSize: 11, color: "var(--fg-3)" }}>
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

        {!isHuman && canManage && (
          <SaveBar
            summary={draft.summary}
            saveHint={saveHint}
            conflictMessage={conflictMsg}
            errorMessage={saveError}
            saving={saveMutation.isPending}
            onSave={() => saveMutation.mutate()}
            onDiscard={() => {
              if (!draft.summary.anyDirty || confirm("Discard all unsaved changes?")) {
                draft.resetAll();
                setSaveError(null);
                setConflictMsg(null);
              }
            }}
            onReloadRemote={reloadRemote}
            onJumpTo={(section) => jumpTo(sectionAnchorId(section))}
          />
        )}
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
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm" style={{ color: "var(--fg-3)" }}>
              Pick a computer you own to pin this agent to. The bind is one-shot — once set, moving the agent requires
              deleting and re-creating it on the target computer.
            </p>
            {clientsQuery.isLoading ? (
              <div className="text-sm" style={{ color: "var(--fg-3)" }}>
                Loading computers…
              </div>
            ) : clientsQuery.error ? (
              <div className="text-sm" style={{ color: "var(--state-error)" }}>
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
              <div className="text-sm" style={{ color: "var(--state-error)" }}>
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
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
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
                      <p className="text-sm" style={{ color: "var(--fg-3)" }}>
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
                      className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm font-mono focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      placeholder='{"bot_token": "xoxb-...", "signing_secret": "..."}'
                    />
                  </div>
                )}
                {bindingCredError && (
                  <p className="text-sm" style={{ color: "var(--state-error)" }}>
                    {bindingCredError}
                  </p>
                )}
                <div className="space-y-2">
                  <Label htmlFor="binding-status">Status</Label>
                  <select
                    id="binding-status"
                    value={bindingForm.status}
                    onChange={(e) => setBindingForm({ ...bindingForm, status: e.target.value })}
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <option value="active">active</option>
                    <option value="inactive">inactive</option>
                  </select>
                </div>
              </>
            )}

            {bindingMutationError instanceof Error && (
              <div className="text-sm" style={{ color: "var(--state-error)" }}>
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

function BehaviorSection(props: {
  loaded: boolean;
  loading: boolean;
  error: string | null;
  version: number | null;
  dirty: boolean;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="inline-flex items-baseline gap-2">
          <h2 style={{ fontSize: 13, fontWeight: 600 }}>Behavior</h2>
          {props.version != null && (
            <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-4)" }}>
              v{props.version}
            </span>
          )}
          {props.dirty && <UppercaseLabel style={{ color: "var(--state-blocked)" }}>draft</UppercaseLabel>}
        </div>
      </div>
      {props.loading && <div style={{ fontSize: 12, color: "var(--fg-3)" }}>Loading configuration…</div>}
      {props.error && (
        <div style={{ fontSize: 12, color: "var(--state-error)" }}>Failed to load configuration: {props.error}</div>
      )}
      {props.loaded && <div className="space-y-3">{props.children}</div>}
    </section>
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
        className="text-sm"
        style={{
          background: "var(--bg-sunken)",
          border: "1px solid var(--border-faint)",
          borderRadius: 4,
          padding: "10px 12px",
          color: "var(--fg-3)",
        }}
      >
        No connected computers available. Run{" "}
        <code className="mono" style={{ fontSize: 11 }}>
          first-tree-hub client connect &lt;url&gt;
        </code>{" "}
        on the computer that should run this agent, then reopen this dialog.
      </div>
    );
  }
  return (
    <ul
      className="max-h-64 overflow-y-auto"
      style={{ border: "1px solid var(--border)", borderRadius: 4, margin: 0, padding: 0, listStyle: "none" }}
    >
      {bindable.map((c) => {
        const picked = c.id === selected;
        const online = c.status === "online" || c.status === "active";
        return (
          <li key={c.id} style={{ borderTop: "1px solid var(--border-faint)" }}>
            <button
              type="button"
              onClick={() => onSelect(c.id)}
              className={cn("w-full text-left flex items-center gap-3")}
              style={{
                padding: "8px 12px",
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
                <span className="block text-sm font-medium truncate">{c.hostname ?? c.id}</span>
                <span className="block mono truncate" style={{ fontSize: 10.5, color: "var(--fg-4)" }}>
                  {c.id}
                  {c.os ? ` · ${c.os}` : ""}
                  {c.sdkVersion ? ` · SDK ${c.sdkVersion}` : ""}
                </span>
              </span>
              <span style={{ fontSize: 11, color: "var(--fg-3)" }}>{c.status}</span>
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
        border: "1px solid var(--border)",
        borderLeft: `3px solid ${borderColor}`,
        borderRadius: 6,
        padding: "12px 14px",
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <DenseBadge tone={badgeTone}>{STATUS_LABELS[result.status]}</DenseBadge>
            {result.responseTime != null && (
              <span className="mono" style={{ fontSize: 11, color: "var(--fg-4)" }}>
                {(result.responseTime / 1000).toFixed(1)}s
              </span>
            )}
          </div>
          {result.message && <p style={{ fontSize: 12, color: "var(--fg-3)" }}>{result.message}</p>}
          {conn && (
            <div
              style={{
                fontSize: 11,
                color: "var(--fg-3)",
                borderTop: "1px solid var(--border-faint)",
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
              className="mono whitespace-pre-wrap"
              style={{
                background: "var(--bg-sunken)",
                border: "1px solid var(--border-faint)",
                borderRadius: 4,
                padding: 8,
                fontSize: 11,
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
