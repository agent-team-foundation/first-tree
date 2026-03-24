import { ADAPTER_PLATFORMS } from "@agent-hub/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { createAdapter, deleteAdapter, listAdapters, updateAdapter } from "../api/adapters.js";
import { listAgents } from "../api/agents.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../components/ui/dialog.js";
import { Input } from "../components/ui/input.js";
import { Label } from "../components/ui/label.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.js";
import { formatDate } from "../lib/utils.js";

const platformValues = Object.values(ADAPTER_PLATFORMS);

type FormState = {
  platform: string;
  agentId: string;
  /** Raw JSON fallback for non-feishu platforms */
  credentialsJson: string;
  /** Feishu-specific fields */
  feishuAppId: string;
  feishuAppSecret: string;
  status: string;
};

const emptyForm: FormState = {
  platform: "feishu",
  agentId: "",
  credentialsJson: "{}",
  feishuAppId: "",
  feishuAppSecret: "",
  status: "active",
};

/** Build credentials object from form state. Returns null if empty (edit mode, keep existing). */
function buildCredentials(form: FormState, isCreate: boolean): Record<string, unknown> | null {
  if (form.platform === "feishu") {
    if (!form.feishuAppId && !form.feishuAppSecret) {
      return isCreate ? null : null; // empty = keep existing in edit mode
    }
    return { app_id: form.feishuAppId, app_secret: form.feishuAppSecret };
  }
  // Fallback: raw JSON for other platforms
  const trimmed = form.credentialsJson.trim();
  if (!trimmed) return null;
  return JSON.parse(trimmed) as Record<string, unknown>;
}

export function AdaptersPage() {
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [credError, setCredError] = useState("");

  const { data: adapters, isLoading, error } = useQuery({ queryKey: ["adapters"], queryFn: listAdapters });

  const { data: agentsData } = useQuery({
    queryKey: ["agents", "all"],
    queryFn: () => listAgents({ limit: 100 }),
  });

  const createMutation = useMutation({
    mutationFn: () => {
      const creds = buildCredentials(form, true);
      if (!creds) throw new Error("Credentials are required");
      return createAdapter({
        platform: form.platform as "feishu" | "slack",
        agentId: form.agentId,
        credentials: creds,
        status: form.status as "active" | "inactive",
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["adapters"] });
      closeDialog();
    },
  });

  const updateMutation = useMutation({
    mutationFn: () => {
      const data: Record<string, unknown> = { status: form.status as "active" | "inactive" };
      if (form.agentId) data.agentId = form.agentId;
      const creds = buildCredentials(form, false);
      if (creds) data.credentials = creds;
      if (!editingId) throw new Error("No adapter selected for editing");
      return updateAdapter(editingId, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["adapters"] });
      closeDialog();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteAdapter,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["adapters"] }),
  });

  function closeDialog() {
    setDialogOpen(false);
    setEditingId(null);
    setForm(emptyForm);
    setCredError("");
  }

  function openEdit(adapter: { id: number; platform: string; agentId: string; status: string }) {
    setEditingId(adapter.id);
    setForm({
      platform: adapter.platform,
      agentId: adapter.agentId,
      credentialsJson: "",
      feishuAppId: "",
      feishuAppSecret: "",
      status: adapter.status,
    });
    setDialogOpen(true);
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setCredError("");

    if (!editingId && !form.agentId) return;

    // Validate credentials
    if (form.platform === "feishu") {
      if (!editingId && (!form.feishuAppId || !form.feishuAppSecret)) {
        setCredError("App ID and App Secret are required");
        return;
      }
    } else {
      const trimmed = form.credentialsJson.trim();
      if (!editingId && !trimmed) {
        setCredError("Credentials are required");
        return;
      }
      if (trimmed) {
        try {
          JSON.parse(trimmed);
        } catch {
          setCredError("Invalid JSON");
          return;
        }
      }
    }

    if (editingId) {
      updateMutation.mutate();
    } else {
      createMutation.mutate();
    }
  }

  function handleDelete(id: number) {
    if (window.confirm("Delete this adapter config?")) {
      deleteMutation.mutate(id);
    }
  }

  const mutationError = createMutation.error ?? updateMutation.error;
  const isPending = createMutation.isPending || updateMutation.isPending;
  const availableAgents = agentsData?.items?.filter((a) => a.type !== "human") ?? [];
  const isFeishu = form.platform === "feishu";

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold">Adapters</h1>
        <Dialog open={dialogOpen} onOpenChange={(open) => (open ? setDialogOpen(true) : closeDialog())}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="h-4 w-4 mr-2" />
              Add Adapter
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{editingId ? "Edit Adapter" : "Add Adapter"}</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="adapter-platform">Platform</Label>
                <select
                  id="adapter-platform"
                  value={form.platform}
                  onChange={(e) => setForm({ ...form, platform: e.target.value })}
                  disabled={!!editingId}
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
                >
                  {platformValues.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="adapter-agent">Agent</Label>
                <select
                  id="adapter-agent"
                  value={form.agentId}
                  onChange={(e) => setForm({ ...form, agentId: e.target.value })}
                  required={!editingId}
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
                >
                  <option value="">Select an agent...</option>
                  {availableAgents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.displayName ? `${a.displayName} (${a.id})` : a.id}
                    </option>
                  ))}
                </select>
              </div>

              {/* Platform-specific credential fields */}
              {isFeishu ? (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="feishu-app-id">App ID{editingId ? " — leave empty to keep existing" : ""}</Label>
                    <Input
                      id="feishu-app-id"
                      value={form.feishuAppId}
                      onChange={(e) => setForm({ ...form, feishuAppId: e.target.value })}
                      placeholder="cli_xxxxxxxx"
                      className="font-mono"
                      autoComplete="off"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="feishu-app-secret">
                      App Secret{editingId ? " — leave empty to keep existing" : ""}
                    </Label>
                    <Input
                      id="feishu-app-secret"
                      type="password"
                      autoComplete="new-password"
                      value={form.feishuAppSecret}
                      onChange={(e) => setForm({ ...form, feishuAppSecret: e.target.value })}
                      placeholder="••••••••"
                    />
                  </div>
                </>
              ) : (
                <div className="space-y-2">
                  <Label htmlFor="adapter-creds">
                    Credentials (JSON){editingId ? " — leave empty to keep existing" : ""}
                  </Label>
                  <textarea
                    id="adapter-creds"
                    value={form.credentialsJson}
                    onChange={(e) => setForm({ ...form, credentialsJson: e.target.value })}
                    rows={4}
                    className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm font-mono transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    placeholder='{"bot_token": "xoxb-...", "signing_secret": "..."}'
                  />
                </div>
              )}
              {credError && <p className="text-sm text-destructive">{credError}</p>}

              <div className="space-y-2">
                <Label htmlFor="adapter-status">Status</Label>
                <select
                  id="adapter-status"
                  value={form.status}
                  onChange={(e) => setForm({ ...form, status: e.target.value })}
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <option value="active">active</option>
                  <option value="inactive">inactive</option>
                </select>
              </div>
              {mutationError instanceof Error && (
                <div className="text-sm text-destructive">{mutationError.message}</div>
              )}
              <DialogFooter>
                <Button type="submit" disabled={isPending}>
                  {isPending ? "Saving..." : editingId ? "Update" : "Create"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <div className="border rounded-lg">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ID</TableHead>
              <TableHead>Platform</TableHead>
              <TableHead>Agent ID</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                  Loading...
                </TableCell>
              </TableRow>
            ) : error ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-8 text-destructive">
                  Failed to load adapters: {error instanceof Error ? error.message : "Unknown error"}
                </TableCell>
              </TableRow>
            ) : adapters?.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                  No adapters configured
                </TableCell>
              </TableRow>
            ) : (
              adapters?.map((a) => (
                <TableRow key={a.id}>
                  <TableCell className="font-mono text-sm">{a.id}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">{a.platform}</Badge>
                  </TableCell>
                  <TableCell className="font-mono text-sm">{a.agentId}</TableCell>
                  <TableCell>
                    <Badge variant={a.status === "active" ? "default" : "destructive"}>{a.status}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{formatDate(a.createdAt)}</TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Button variant="ghost" size="icon" onClick={() => openEdit(a)} title="Edit">
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleDelete(a.id)}
                        disabled={deleteMutation.isPending}
                        title="Delete"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
