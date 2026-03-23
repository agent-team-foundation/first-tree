import { AGENT_TYPES } from "@agent-hub/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useNavigate } from "react-router";
import { createAgent, listAgents } from "../api/agents.js";
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
import { cn, formatDate } from "../lib/utils.js";

const agentTypeValues = Object.values(AGENT_TYPES);

export function AgentsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [cursor, setCursor] = useState<string | undefined>();
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({ id: "", type: "autonomous_agent", displayName: "" });

  const { data, isLoading, error } = useQuery({
    queryKey: ["agents", cursor],
    queryFn: () => listAgents({ limit: 20, cursor }),
  });

  const createMutation = useMutation({
    mutationFn: () =>
      createAgent({
        id: form.id || undefined,
        type: form.type as "human" | "personal_assistant" | "autonomous_agent",
        displayName: form.displayName || undefined,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      setCreateOpen(false);
      setForm({ id: "", type: "autonomous_agent", displayName: "" });
    },
  });

  const handleCreate = (e: FormEvent) => {
    e.preventDefault();
    createMutation.mutate();
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold">Agents</h1>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="h-4 w-4 mr-2" />
              Create Agent
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create Agent</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleCreate} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="agent-id">ID (optional)</Label>
                <Input
                  id="agent-id"
                  value={form.id}
                  onChange={(e) => setForm({ ...form, id: e.target.value })}
                  placeholder="auto-generated if empty"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="agent-type">Type</Label>
                <select
                  id="agent-type"
                  value={form.type}
                  onChange={(e) => setForm({ ...form, type: e.target.value })}
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  {agentTypeValues.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="agent-name">Display Name</Label>
                <Input
                  id="agent-name"
                  value={form.displayName}
                  onChange={(e) => setForm({ ...form, displayName: e.target.value })}
                />
              </div>
              {createMutation.error instanceof Error && (
                <div className="text-sm text-destructive">{createMutation.error.message}</div>
              )}
              <DialogFooter>
                <Button type="submit" disabled={createMutation.isPending}>
                  {createMutation.isPending ? "Creating..." : "Create"}
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
              <TableHead>Display Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Online</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Created</TableHead>
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
                  Failed to load agents: {error instanceof Error ? error.message : "Unknown error"}
                </TableCell>
              </TableRow>
            ) : data?.items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                  No agents yet
                </TableCell>
              </TableRow>
            ) : (
              data?.items.map((agent) => (
                <TableRow key={agent.id} className="cursor-pointer" onClick={() => navigate(`/agents/${agent.id}`)}>
                  <TableCell className="font-mono text-sm">{agent.id}</TableCell>
                  <TableCell>{agent.displayName ?? "—"}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">{agent.type}</Badge>
                  </TableCell>
                  <TableCell>
                    <span
                      className={cn(
                        "inline-block h-2 w-2 rounded-full",
                        agent.presenceStatus === "online" ? "bg-green-500" : "bg-gray-300",
                      )}
                      title={agent.presenceStatus ?? "offline"}
                    />
                  </TableCell>
                  <TableCell>
                    <Badge variant={agent.status === "active" ? "default" : "destructive"}>{agent.status}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{formatDate(agent.createdAt)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {data?.nextCursor && (
        <div className="flex justify-end mt-4">
          <Button variant="outline" onClick={() => setCursor(data.nextCursor ?? undefined)}>
            Next Page
          </Button>
        </div>
      )}
    </div>
  );
}
