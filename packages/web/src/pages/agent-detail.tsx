import { ADAPTER_PLATFORMS } from "@first-tree-hub/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Cable, Copy, Key, Link2, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { createAdapterMapping, deleteAdapterMapping, listAdapterMappings } from "../api/adapter-mappings.js";
import { getAdapterStatuses } from "../api/adapter-status.js";
import { createAdapter, deleteAdapter, listAdapters, updateAdapter } from "../api/adapters.js";
import {
  deleteAgent,
  getAgent,
  reactivateAgent,
  suspendAgent,
  type TestResult,
  testAgentConnection,
} from "../api/agents.js";
import { createToken, listTokens, revokeToken } from "../api/tokens.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog.js";
import { Input } from "../components/ui/input.js";
import { Label } from "../components/ui/label.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.js";
import { cn, formatDate } from "../lib/utils.js";

const platformValues = Object.values(ADAPTER_PLATFORMS);

export function AgentDetailPage() {
  const params = useParams<{ agentId: string }>();
  const agentId = params.agentId ?? "";
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Agent data
  const agentQuery = useQuery({
    queryKey: ["agent", agentId],
    queryFn: () => getAgent(agentId),
    enabled: !!agentId,
  });

  // Tokens data (only for non-human agents)
  const tokensQuery = useQuery({
    queryKey: ["tokens", agentId],
    queryFn: () => listTokens(agentId),
    enabled: !!agentId && agentQuery.isSuccess && agentQuery.data?.type !== "human",
  });

  // Adapter bindings for this agent
  const adaptersQuery = useQuery({ queryKey: ["adapters"], queryFn: listAdapters });
  const mappingsQuery = useQuery({ queryKey: ["adapter-mappings"], queryFn: listAdapterMappings });
  const { data: botStatuses } = useQuery({
    queryKey: ["adapter-statuses"],
    queryFn: getAdapterStatuses,
    refetchInterval: 15_000,
  });

  const agentAdapters = adaptersQuery.data?.filter((a) => a.agentId === agentId) ?? [];
  const agentMappings = mappingsQuery.data?.filter((m) => m.agentId === agentId) ?? [];

  // Token dialog
  const [tokenDialogOpen, setTokenDialogOpen] = useState(false);
  const [tokenName, setTokenName] = useState("");
  const [createdToken, setCreatedToken] = useState<string | null>(null);

  // Binding dialog
  const [bindingDialogOpen, setBindingDialogOpen] = useState(false);
  const [bindingEditId, setBindingEditId] = useState<number | null>(null);
  const [bindingForm, setBindingForm] = useState({
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
  });
  const [bindingCredError, setBindingCredError] = useState("");

  // Mutations — agent lifecycle
  const suspendMutation = useMutation({
    mutationFn: () => suspendAgent(agentId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["agent", agentId] }),
  });

  const reactivateMutation = useMutation({
    mutationFn: () => reactivateAgent(agentId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["agent", agentId] }),
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteAgent(agentId),
    onSuccess: () => navigate("/agents"),
  });

  // Mutations — tokens
  const createTokenMutation = useMutation({
    mutationFn: (name: string) => createToken(agentId, { name: name || undefined }),
    onSuccess: (data) => {
      setCreatedToken(data.token);
      setTokenName("");
      queryClient.invalidateQueries({ queryKey: ["tokens", agentId] });
    },
  });

  const revokeTokenMutation = useMutation({
    mutationFn: (tokenId: string) => revokeToken(agentId, tokenId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["tokens", agentId] }),
  });

  // Mutations — bot binding (non-human agents)
  const createAdapterMutation = useMutation({
    mutationFn: async () => {
      let creds = buildCredentials(bindingForm);
      if (!creds) throw new Error("Credentials are required");

      // For Kael: auto-create a dedicated agent token
      if (bindingForm.platform === "kael" && !creds.agentToken) {
        const tokenResult = await createToken(agentId, { name: "kael-hub-binding" });
        creds = { ...creds, agentToken: tokenResult.token };
      }

      return createAdapter({
        platform: bindingForm.platform as "feishu" | "slack" | "kael",
        agentId,
        credentials: creds,
        status: bindingForm.status as "active" | "inactive",
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["adapters"] });
      queryClient.invalidateQueries({ queryKey: ["tokens", agentId] });
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

  // Mutations — user binding (human agents)
  const createMappingMutation = useMutation({
    mutationFn: () =>
      createAdapterMapping({
        platform: bindingForm.platform as "feishu" | "slack" | "kael",
        externalUserId: bindingForm.externalUserId,
        agentId,
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

  // Test connection
  const testMutation = useMutation({
    mutationFn: () => testAgentConnection(agentId),
  });

  const agent = agentQuery.data;
  const isHuman = agent?.type === "human";

  // -- helpers --

  function closeBindingDialog() {
    setBindingDialogOpen(false);
    setBindingEditId(null);
    setBindingForm({
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
    });
    setBindingCredError("");
  }

  function openEditAdapter(adapter: { id: number; platform: string; status: string }) {
    setBindingEditId(adapter.id);
    setBindingForm({
      platform: adapter.platform,
      feishuAppId: "",
      feishuAppSecret: "",
      credentialsJson: "",
      status: adapter.status,
      externalUserId: "",
      displayName: "",
      kaelUserId: "",
      kaelProjectId: "",
      kaelAgentToken: "",
    });
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

    // Non-human: validate credentials
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

    if (bindingEditId) {
      updateAdapterMutation.mutate();
    } else {
      createAdapterMutation.mutate();
    }
  }

  // -- render guards --

  if (agentQuery.isLoading) {
    return <div className="text-muted-foreground">Loading...</div>;
  }
  if (agentQuery.error) {
    return (
      <div className="text-destructive">
        Failed to load agent: {agentQuery.error instanceof Error ? agentQuery.error.message : "Unknown error"}
      </div>
    );
  }
  if (!agent) {
    return <div className="text-muted-foreground">Agent not found</div>;
  }

  const handleDelete = () => {
    if (window.confirm("Are you sure you want to delete this agent? This cannot be undone.")) {
      deleteMutation.mutate();
    }
  };

  const handleCreateToken = (e: FormEvent) => {
    e.preventDefault();
    createTokenMutation.mutate(tokenName);
  };

  const bindingMutationError =
    createAdapterMutation.error ?? updateAdapterMutation.error ?? createMappingMutation.error;
  const bindingIsPending =
    createAdapterMutation.isPending || updateAdapterMutation.isPending || createMappingMutation.isPending;

  const metadata = agent.metadata as Record<string, unknown> | undefined;
  const treeMeta = metadata?.tree as Record<string, unknown> | undefined;
  const role = treeMeta?.role as string | undefined;
  const domains = treeMeta?.domains as string[] | undefined;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => navigate("/agents")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1">
          <h1 className="text-2xl font-semibold">{agent.displayName ?? agent.id}</h1>
          <p className="text-sm text-muted-foreground font-mono">{agent.id}</p>
        </div>
        {!isHuman && agent.status === "active" && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              testMutation.reset();
              testMutation.mutate();
            }}
            disabled={testMutation.isPending}
          >
            <Play className="h-4 w-4 mr-2" />
            {testMutation.isPending ? "Testing..." : "Test Connection"}
          </Button>
        )}
        {agent.status === "active" && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (window.confirm("Suspend this agent? All tokens will be revoked.")) {
                suspendMutation.mutate();
              }
            }}
            disabled={suspendMutation.isPending}
          >
            {suspendMutation.isPending ? "Suspending..." : "Suspend"}
          </Button>
        )}
        {agent.status === "suspended" && (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => reactivateMutation.mutate()}
              disabled={reactivateMutation.isPending}
            >
              {reactivateMutation.isPending ? "Reactivating..." : "Reactivate"}
            </Button>
            <Button variant="destructive" size="sm" onClick={handleDelete}>
              <Trash2 className="h-4 w-4 mr-2" />
              Delete
            </Button>
          </>
        )}
      </div>

      {/* Test Connection Result */}
      {(testMutation.data || testMutation.error) && (
        <TestResultCard
          result={testMutation.data ?? { status: "error", message: "Failed to reach server" }}
          onDismiss={() => testMutation.reset()}
        />
      )}

      {/* Agent Info */}
      <Card>
        <CardHeader>
          <CardTitle>Agent Info</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <dt className="text-muted-foreground mb-1">Display Name</dt>
              <dd>{agent.displayName ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground mb-1">Type</dt>
              <dd>
                <Badge variant="secondary">{agent.type}</Badge>
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground mb-1">Status</dt>
              <dd>
                <Badge variant={agent.status === "active" ? "default" : "destructive"}>{agent.status}</Badge>
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground mb-1">Inbox ID</dt>
              <dd className="font-mono">{agent.inboxId}</dd>
            </div>
            {agent.delegateMention && (
              <div>
                <dt className="text-muted-foreground mb-1">Delegate Mention</dt>
                <dd className="font-mono">{agent.delegateMention}</dd>
              </div>
            )}
            {role && (
              <div>
                <dt className="text-muted-foreground mb-1">Role</dt>
                <dd>{role}</dd>
              </div>
            )}
            {domains && domains.length > 0 && (
              <div>
                <dt className="text-muted-foreground mb-1">Domains</dt>
                <dd className="flex flex-wrap gap-1">
                  {domains.map((d) => (
                    <Badge key={d} variant="outline">
                      {d}
                    </Badge>
                  ))}
                </dd>
              </div>
            )}
            <div>
              <dt className="text-muted-foreground mb-1">Organization</dt>
              <dd className="font-mono">{agent.organizationId}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground mb-1">Created</dt>
              <dd>{formatDate(agent.createdAt)}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      {/* Platform Bindings */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            {isHuman ? <Link2 className="h-4 w-4" /> : <Cable className="h-4 w-4" />}
            Platform Bindings
          </CardTitle>
          <Button size="sm" onClick={() => setBindingDialogOpen(true)}>
            <Plus className="h-4 w-4 mr-2" />
            {isHuman ? "Bind User" : "Bind Bot"}
          </Button>
        </CardHeader>
        <CardContent>
          {isHuman ? (
            /* Human agent: user mappings */
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
                            if (window.confirm("Remove this binding?")) deleteMappingMutation.mutate(m.id);
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
            /* Non-human agent: bot configs */
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
                    // Kael is server-embedded: connected whenever the config is active (no bot status needed)
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
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => {
                                if (window.confirm("Remove this bot binding?")) deleteAdapterMutation.mutate(a.id);
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

      {/* Token Management — only for non-human agents */}
      {!isHuman && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <Key className="h-4 w-4" />
              Tokens
            </CardTitle>
            <Button
              size="sm"
              onClick={() => {
                setCreatedToken(null);
                setTokenName("");
                setTokenDialogOpen(true);
              }}
            >
              <Plus className="h-4 w-4 mr-2" />
              Create Token
            </Button>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Last Used</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead className="w-20" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {tokensQuery.data?.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center py-4 text-muted-foreground">
                      No tokens
                    </TableCell>
                  </TableRow>
                ) : (
                  tokensQuery.data?.map((token) => (
                    <TableRow key={token.id}>
                      <TableCell>{token.name ?? "—"}</TableCell>
                      <TableCell className="text-muted-foreground">{formatDate(token.createdAt)}</TableCell>
                      <TableCell className="text-muted-foreground">{formatDate(token.lastUsedAt)}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {token.revokedAt ? (
                          <Badge variant="destructive">Revoked</Badge>
                        ) : token.expiresAt ? (
                          formatDate(token.expiresAt)
                        ) : (
                          "Never"
                        )}
                      </TableCell>
                      <TableCell>
                        {!token.revokedAt && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => revokeTokenMutation.mutate(token.id)}
                            disabled={revokeTokenMutation.isPending}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Binding Dialog — adapts based on agent type */}
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
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
              >
                {platformValues.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>

            {isHuman ? (
              /* Human agent: external user ID */
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
              /* Non-human agent: bot credentials */
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
                      className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm font-mono transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
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
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
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

      {/* Create Token Dialog */}
      {!isHuman && (
        <Dialog
          open={tokenDialogOpen}
          onOpenChange={(open) => {
            setTokenDialogOpen(open);
            if (!open) setCreatedToken(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{createdToken ? "Token Created" : "Create Token"}</DialogTitle>
            </DialogHeader>
            {createdToken ? (
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">Copy this token now. It will not be shown again.</p>
                <div className="flex gap-2">
                  <Input value={createdToken} readOnly className="font-mono text-xs" />
                  <Button variant="outline" size="icon" onClick={() => navigator.clipboard.writeText(createdToken)}>
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
                <DialogFooter>
                  <Button onClick={() => setTokenDialogOpen(false)}>Done</Button>
                </DialogFooter>
              </div>
            ) : (
              <form onSubmit={handleCreateToken} className="space-y-4">
                <div className="space-y-2">
                  <Label>Name (optional)</Label>
                  <Input
                    value={tokenName}
                    onChange={(e) => setTokenName(e.target.value)}
                    placeholder="e.g. production"
                  />
                </div>
                {createTokenMutation.error instanceof Error && (
                  <div className="text-sm text-destructive">{createTokenMutation.error.message}</div>
                )}
                <DialogFooter>
                  <Button type="submit" disabled={createTokenMutation.isPending}>
                    {createTokenMutation.isPending ? "Creating..." : "Create"}
                  </Button>
                </DialogFooter>
              </form>
            )}
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

// ── Components ──────────────────────────────────────────────────────

const STATUS_LABELS: Record<TestResult["status"], string> = {
  success: "Connected",
  timeout: "Timed out",
  offline: "Offline",
  error: "Error",
};

function TestResultCard({ result, onDismiss }: { result: TestResult; onDismiss: () => void }) {
  const borderColor = {
    success: "border-l-green-500",
    timeout: "border-l-yellow-500",
    offline: "border-l-gray-400",
    error: "border-l-red-500",
  }[result.status];

  const badgeVariant =
    result.status === "success" ? "default" : result.status === "timeout" ? "secondary" : "destructive";

  return (
    <Card className={cn("border-l-4", borderColor)}>
      <CardContent className="pt-4">
        <div className="flex items-start justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Badge variant={badgeVariant}>{STATUS_LABELS[result.status]}</Badge>
              {result.responseTime != null && (
                <span className="text-xs text-muted-foreground">{(result.responseTime / 1000).toFixed(1)}s</span>
              )}
            </div>
            {result.message && <p className="text-sm text-muted-foreground">{result.message}</p>}
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

// ── Helpers ──────────────────────────────────────────────────────────

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
    // Both fields must be filled or both empty — partial input would corrupt stored credentials
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
    // agentToken is auto-created by the mutation, not from the form
    return {
      kaelUserId: form.kaelUserId,
      kaelProjectId: form.kaelProjectId,
    };
  }
  const trimmed = form.credentialsJson.trim();
  if (!trimmed) return null;
  return JSON.parse(trimmed) as Record<string, unknown>;
}
