import { ADAPTER_PLATFORMS } from "@agent-team-foundation/first-tree-hub-shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Cable, Link2, MoreHorizontal, Play, Plus, Trash2 } from "lucide-react";
import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
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
import { Badge } from "./../components/ui/badge.js";
import { Button } from "./../components/ui/button.js";
import { Card, CardContent, CardHeader, CardTitle } from "./../components/ui/card.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "./../components/ui/dialog.js";
import { Input } from "./../components/ui/input.js";
import { Label } from "./../components/ui/label.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./../components/ui/table.js";
import { cn, formatDate } from "./../lib/utils.js";
import { DangerZone } from "./agent-detail/danger-zone.js";
import { EnvSection } from "./agent-detail/env-section.js";
import { GitSection } from "./agent-detail/git-section.js";
import { IdentitySection } from "./agent-detail/identity-section.js";
import { McpSection } from "./agent-detail/mcp-section.js";
import { ModelSection } from "./agent-detail/model-section.js";
import { PromptSection } from "./agent-detail/prompt-section.js";
import { SaveBar, sectionAnchorId } from "./agent-detail/save-bar.js";
import { deriveSaveHint, StatusBar } from "./agent-detail/status-bar.js";
import { type DraftSectionName, useConfigDraft } from "./agent-detail/use-config-draft.js";

const platformValues = Object.values(ADAPTER_PLATFORMS);

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

  const jumpTo = useCallback((section: DraftSectionName) => {
    const el = document.getElementById(sectionAnchorId(section));
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

  // Header ⋯ menu + binding dialogs
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!moreOpen) return;
    function onClickAway(e: MouseEvent) {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreOpen(false);
    }
    window.addEventListener("mousedown", onClickAway);
    return () => window.removeEventListener("mousedown", onClickAway);
  }, [moreOpen]);

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

  // Binding dialog state (unchanged from previous)
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

  // Dry-run (surfaced via small helper button next to Save)
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

  if (agentQuery.isLoading) return <div className="text-muted-foreground">Loading...</div>;
  if (agentQuery.error) {
    return (
      <div className="text-destructive">
        Failed to load agent: {agentQuery.error instanceof Error ? agentQuery.error.message : "Unknown error"}
      </div>
    );
  }
  const agent = agentQuery.data;
  if (!agent) return <div className="text-muted-foreground">Agent not found</div>;

  const isHuman = agent.type === "human";

  const clientStatus: ClientStatusInfo | undefined = clientStatusQuery.data;
  const activeSessions = sessionsQuery.data?.length ?? 0;
  const isUnclaimed = !isHuman && !clientStatus?.clientId;
  const isOffline = !isHuman && clientStatus ? !clientStatus.online && !!clientStatus.clientId : false;

  const runtimeExt = agent as Record<string, unknown>;
  const runtimeState = (runtimeExt.runtimeState as string | null) ?? null;
  const runtimeType = (runtimeExt.runtimeType as string | null) ?? null;

  // -- helpers local to this component
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

  return (
    <div className="space-y-5 pb-24">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate("/agents")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl font-semibold truncate">{agent.displayName ?? agent.name}</h1>
          <p className="text-xs text-muted-foreground font-mono truncate">
            @{agent.name ?? agent.uuid} · {agent.type}
          </p>
        </div>
        <div className="relative" ref={moreRef}>
          <Button variant="outline" size="icon" onClick={() => setMoreOpen((v) => !v)} title="More actions">
            <MoreHorizontal className="h-4 w-4" />
          </Button>
          {moreOpen && (
            <div className="absolute right-0 mt-1 z-40 min-w-48 rounded-md border bg-white shadow-lg text-sm">
              <ul className="py-1">
                {!isHuman && agent.status === "active" && (
                  <li>
                    <button
                      type="button"
                      onClick={() => {
                        setMoreOpen(false);
                        testMutation.reset();
                        testMutation.mutate();
                      }}
                      className="w-full text-left px-3 py-1.5 hover:bg-gray-50 flex items-center gap-2"
                      disabled={testMutation.isPending}
                    >
                      <Play className="h-3.5 w-3.5" />
                      {testMutation.isPending ? "Testing…" : "Test connection"}
                    </button>
                  </li>
                )}
                {agent.status === "active" ? (
                  <li>
                    <button
                      type="button"
                      onClick={() => {
                        setMoreOpen(false);
                        if (confirm("Suspend this agent? All tokens will be revoked.")) {
                          suspendMutation.mutate();
                        }
                      }}
                      className="w-full text-left px-3 py-1.5 hover:bg-gray-50"
                    >
                      Suspend
                    </button>
                  </li>
                ) : (
                  <li>
                    <button
                      type="button"
                      onClick={() => {
                        setMoreOpen(false);
                        reactivateMutation.mutate();
                      }}
                      className="w-full text-left px-3 py-1.5 hover:bg-gray-50"
                    >
                      Reactivate
                    </button>
                  </li>
                )}
                <li className="border-t">
                  <a
                    href={`#${sectionAnchorId("prompt")}`}
                    onClick={() => setMoreOpen(false)}
                    className="block px-3 py-1.5 text-xs text-muted-foreground hover:bg-gray-50"
                  >
                    Jump to Behavior
                  </a>
                </li>
              </ul>
            </div>
          )}
        </div>
      </div>

      {(testMutation.data || testMutation.error) && (
        <TestResultCard
          result={testMutation.data ?? { status: "error", message: "Failed to reach server" }}
          onDismiss={() => testMutation.reset()}
        />
      )}

      {/* Status Bar */}
      <StatusBar
        agent={agent}
        cfg={cfgQuery.data}
        clientStatus={clientStatus}
        runtimeState={runtimeState}
        runtimeType={runtimeType}
        activeSessions={activeSessions}
        isHuman={isHuman}
      />

      {isUnclaimed && agent.status === "active" && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 flex items-center justify-between gap-3">
          <div className="text-sm text-amber-900">
            <div className="font-medium">No client bound</div>
            <div className="text-xs text-amber-800/80">
              Bind this agent to a client machine so it can run. A client will also claim it on first WebSocket connect.
            </div>
          </div>
          <Button size="sm" variant="outline" onClick={() => setBindClientOpen(true)}>
            <Link2 className="h-4 w-4 mr-2" />
            Bind Client
          </Button>
        </div>
      )}

      {/* Identity */}
      <IdentitySection
        agent={agent}
        onSave={async (patch) => {
          await identityUpdateMutation.mutateAsync(patch);
        }}
      />

      {/* Behavior */}
      {!isHuman && (
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
          {dryRunText && <pre className="whitespace-pre-wrap rounded border bg-gray-50 p-2 text-xs">{dryRunText}</pre>}
        </BehaviorSection>
      )}

      {/* Platform Bindings (secondary) */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            {isHuman ? <Link2 className="h-4 w-4" /> : <Cable className="h-4 w-4" />}
            Platform Bindings
          </CardTitle>
          <Button size="sm" variant="outline" onClick={() => setBindingDialogOpen(true)}>
            <Plus className="h-4 w-4 mr-2" />
            {isHuman ? "Bind User" : "Bind Bot"}
          </Button>
        </CardHeader>
        <CardContent>
          {isHuman ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Platform</TableHead>
                  <TableHead>External User ID</TableHead>
                  <TableHead>Display Name</TableHead>
                  <TableHead>Bound Via</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="w-16" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {agentMappings.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center py-4 text-muted-foreground">
                      No platform bindings
                    </TableCell>
                  </TableRow>
                ) : (
                  agentMappings.map((m) => (
                    <TableRow key={m.id}>
                      <TableCell>
                        <Badge variant="secondary">{m.platform}</Badge>
                      </TableCell>
                      <TableCell className="font-mono text-sm">{m.externalUserId}</TableCell>
                      <TableCell>{m.displayName ?? "—"}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{m.boundVia ?? "—"}</Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{formatDate(m.createdAt)}</TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => {
                            if (confirm("Remove this binding?")) deleteMappingMutation.mutate(m.id);
                          }}
                          disabled={deleteMappingMutation.isPending}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Platform</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Connection</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="w-24" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {agentAdapters.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center py-4 text-muted-foreground">
                      No platform bindings
                    </TableCell>
                  </TableRow>
                ) : (
                  agentAdapters.map((a) => {
                    const status = botStatuses?.find((s) => s.configId === a.id);
                    const isConnected = a.platform === "kael" ? a.status === "active" : !!status?.connected;
                    return (
                      <TableRow key={a.id}>
                        <TableCell>
                          <Badge variant="secondary">{a.platform}</Badge>
                        </TableCell>
                        <TableCell>
                          <Badge variant={a.status === "active" ? "default" : "destructive"}>{a.status}</Badge>
                        </TableCell>
                        <TableCell>
                          <span className="flex items-center gap-1.5">
                            <span
                              className={cn(
                                "inline-block h-2 w-2 rounded-full",
                                isConnected ? "bg-green-500" : "bg-gray-300",
                              )}
                            />
                            <span className="text-xs text-muted-foreground">{isConnected ? "Online" : "Offline"}</span>
                          </span>
                        </TableCell>
                        <TableCell className="text-muted-foreground">{formatDate(a.createdAt)}</TableCell>
                        <TableCell>
                          <div className="flex gap-1">
                            <Button variant="ghost" size="icon" onClick={() => openEditAdapter(a)} title="Edit">
                              …
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => {
                                if (confirm("Remove this bot binding?")) deleteAdapterMutation.mutate(a.id);
                              }}
                              disabled={deleteAdapterMutation.isPending}
                              title="Delete"
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Danger Zone */}
      <DangerZone
        agent={agent}
        suspendPending={suspendMutation.isPending}
        reactivatePending={reactivateMutation.isPending}
        deletePending={deleteMutation.isPending}
        onSuspend={() => {
          if (confirm("Suspend this agent? Runtime binds and HTTP calls will be refused.")) suspendMutation.mutate();
        }}
        onReactivate={() => reactivateMutation.mutate()}
        onDelete={() => deleteMutation.mutate()}
      />

      {/* Save Bar */}
      {!isHuman && (
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
          onJumpTo={jumpTo}
        />
      )}

      {/* Dry-run helper (below Save Bar to avoid clutter) */}
      {!isHuman && draft.summary.anyDirty && (
        <div className="text-xs text-muted-foreground">
          <button
            type="button"
            onClick={() => dryRunMutation.mutate()}
            className="underline hover:text-gray-900"
            disabled={dryRunMutation.isPending}
          >
            {dryRunMutation.isPending ? "Computing dry-run…" : "Preview server-side diff"}
          </button>
        </div>
      )}

      {/* Bind Client Dialog — first-time NULL → ID bind only */}
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
            <DialogTitle>Bind client</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Pick a client machine you own to pin this agent to. The bind is one-shot — once set, moving the agent
              requires deleting and re-creating it on the target client.
            </p>
            {clientsQuery.isLoading ? (
              <div className="text-sm text-muted-foreground">Loading clients…</div>
            ) : clientsQuery.error ? (
              <div className="text-sm text-destructive">
                Failed to load clients: {clientsQuery.error instanceof Error ? clientsQuery.error.message : "Unknown"}
              </div>
            ) : (
              <BindClientList
                clients={clientsQuery.data ?? []}
                selected={bindClientSelected}
                onSelect={setBindClientSelected}
              />
            )}
            {bindClientError && <div className="text-sm text-destructive">{bindClientError}</div>}
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

      {/* Binding Dialog */}
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
                      <p className="text-sm text-muted-foreground">
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
                {bindingCredError && <p className="text-sm text-destructive">{bindingCredError}</p>}
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
              <div className="text-sm text-destructive">{bindingMutationError.message}</div>
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
        <h2 className="text-base font-semibold">Behavior</h2>
        <div className="text-xs text-muted-foreground">
          {props.version != null && <span>v{props.version}</span>}
          {props.dirty && <span className="ml-2 text-amber-700">· draft</span>}
        </div>
      </div>
      {props.loading && <div className="text-sm text-muted-foreground">Loading configuration…</div>}
      {props.error && <div className="text-sm text-destructive">Failed to load configuration: {props.error}</div>}
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
      <div className="rounded border bg-muted/40 px-3 py-4 text-sm text-muted-foreground">
        No connected clients available. Run{" "}
        <code className="font-mono text-xs">first-tree-hub client connect &lt;url&gt;</code> on the machine that should
        run this agent, then reopen this dialog.
      </div>
    );
  }
  return (
    <ul className="divide-y rounded border max-h-64 overflow-y-auto">
      {bindable.map((c) => {
        const picked = c.id === selected;
        const online = c.status === "online" || c.status === "active";
        return (
          <li key={c.id}>
            <button
              type="button"
              onClick={() => onSelect(c.id)}
              className={cn(
                "w-full text-left px-3 py-2 flex items-center gap-3 hover:bg-gray-50",
                picked && "bg-blue-50",
              )}
            >
              <span
                className={cn("inline-block h-2 w-2 rounded-full", online ? "bg-green-500" : "bg-gray-400")}
                aria-hidden
              />
              <span className="flex-1 min-w-0">
                <span className="block text-sm font-medium truncate">{c.hostname ?? c.id}</span>
                <span className="block text-xs text-muted-foreground font-mono truncate">
                  {c.id}
                  {c.os ? ` · ${c.os}` : ""}
                  {c.sdkVersion ? ` · SDK ${c.sdkVersion}` : ""}
                </span>
              </span>
              <span className="text-xs text-muted-foreground">{c.status}</span>
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

const HEALTH_INDICATOR: Record<string, { icon: string; color: string; label: string }> = {
  connected: { icon: "●", color: "text-green-500", label: "Connected" },
  stale: { icon: "◐", color: "text-yellow-500", label: "Stale" },
  disconnected: { icon: "○", color: "text-gray-400", label: "Disconnected" },
};

function TestResultCard({ result, onDismiss }: { result: TestResult; onDismiss: () => void }) {
  const borderColor = {
    success: "border-l-green-500",
    timeout: "border-l-yellow-500",
    offline: "border-l-gray-400",
    stale: "border-l-yellow-500",
    error: "border-l-red-500",
  }[result.status];

  const badgeVariant =
    result.status === "success"
      ? "default"
      : result.status === "timeout" || result.status === "stale"
        ? "secondary"
        : "destructive";

  const conn = result.connection;
  const healthInfo = conn ? HEALTH_INDICATOR[conn.health] : null;

  return (
    <Card className={cn("border-l-4", borderColor)}>
      <CardContent className="pt-4">
        <div className="flex items-start justify-between">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Badge variant={badgeVariant}>{STATUS_LABELS[result.status]}</Badge>
              {result.responseTime != null && (
                <span className="text-xs text-muted-foreground">{(result.responseTime / 1000).toFixed(1)}s</span>
              )}
            </div>
            {result.message && <p className="text-sm text-muted-foreground">{result.message}</p>}
            {conn && (
              <div className="text-xs space-y-1 border-t pt-2 mt-1">
                <div className="flex items-center gap-2">
                  {healthInfo && (
                    <span className={healthInfo.color}>
                      {healthInfo.icon} {healthInfo.label}
                    </span>
                  )}
                  {conn.runtimeState && <span className="text-muted-foreground">runtime: {conn.runtimeState}</span>}
                </div>
                {conn.client ? (
                  <div className="text-muted-foreground">
                    Computer: {conn.client.hostname ?? conn.client.id}
                    {conn.client.os && ` (${conn.client.os})`}
                    {conn.client.sdkVersion && ` · SDK ${conn.client.sdkVersion}`}
                  </div>
                ) : (
                  <div className="text-muted-foreground">No computer bound</div>
                )}
                {conn.lastSeenAt && (
                  <div className="text-muted-foreground">Last seen: {new Date(conn.lastSeenAt).toLocaleString()}</div>
                )}
              </div>
            )}
            {result.responseContent && (
              <p className="text-sm mt-2 whitespace-pre-wrap bg-muted rounded p-2 max-h-40 overflow-auto">
                {result.responseContent}
              </p>
            )}
          </div>
          <Button variant="ghost" size="sm" onClick={onDismiss}>
            Dismiss
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
