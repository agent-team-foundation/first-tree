import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Copy, Key, Plus, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { deleteAgent, getAgent, updateAgent } from "../api/agents.js";
import { createToken, listTokens, revokeToken } from "../api/tokens.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog.js";
import { Input } from "../components/ui/input.js";
import { Label } from "../components/ui/label.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.js";
import { formatDate } from "../lib/utils.js";

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

  // Tokens data
  const tokensQuery = useQuery({
    queryKey: ["tokens", agentId],
    queryFn: () => listTokens(agentId),
    enabled: !!agentId,
  });

  // Edit state
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editStatus, setEditStatus] = useState("");

  // Token dialog
  const [tokenDialogOpen, setTokenDialogOpen] = useState(false);
  const [tokenName, setTokenName] = useState("");
  const [createdToken, setCreatedToken] = useState<string | null>(null);

  // Mutations
  const updateMutation = useMutation({
    mutationFn: (data: { displayName?: string | null; status?: "active" | "suspended" }) => updateAgent(agentId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agent", agentId] });
      setEditing(false);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteAgent(agentId),
    onSuccess: () => navigate("/agents"),
  });

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

  const agent = agentQuery.data;

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

  const startEdit = () => {
    setEditName(agent.displayName ?? "");
    setEditStatus(agent.status);
    setEditing(true);
  };

  const handleUpdate = (e: FormEvent) => {
    e.preventDefault();
    updateMutation.mutate({
      displayName: editName || null,
      status: editStatus as "active" | "suspended",
    });
  };

  const handleDelete = () => {
    if (window.confirm("Are you sure you want to delete this agent?")) {
      deleteMutation.mutate();
    }
  };

  const handleCreateToken = (e: FormEvent) => {
    e.preventDefault();
    createTokenMutation.mutate(tokenName);
  };

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
        <Button variant="destructive" size="sm" onClick={handleDelete}>
          <Trash2 className="h-4 w-4 mr-2" />
          Delete
        </Button>
      </div>

      {/* Agent Info */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Agent Info</CardTitle>
          {!editing && (
            <Button variant="outline" size="sm" onClick={startEdit}>
              Edit
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {editing ? (
            <form onSubmit={handleUpdate} className="space-y-4">
              <div className="space-y-2">
                <Label>Display Name</Label>
                <Input value={editName} onChange={(e) => setEditName(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Status</Label>
                <select
                  value={editStatus}
                  onChange={(e) => setEditStatus(e.target.value)}
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <option value="active">active</option>
                  <option value="suspended">suspended</option>
                </select>
              </div>
              {updateMutation.error instanceof Error && (
                <div className="text-sm text-destructive">{updateMutation.error.message}</div>
              )}
              <div className="flex gap-2">
                <Button type="submit" size="sm" disabled={updateMutation.isPending}>
                  Save
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <dl className="grid grid-cols-2 gap-4 text-sm">
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
              <div>
                <dt className="text-muted-foreground mb-1">Organization</dt>
                <dd className="font-mono">{agent.organizationId}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground mb-1">Created</dt>
                <dd>{formatDate(agent.createdAt)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground mb-1">Updated</dt>
                <dd>{formatDate(agent.updatedAt)}</dd>
              </div>
            </dl>
          )}
        </CardContent>
      </Card>

      {/* Token Management */}
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

      {/* Create Token Dialog */}
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
                <Input value={tokenName} onChange={(e) => setTokenName(e.target.value)} placeholder="e.g. production" />
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
    </div>
  );
}
