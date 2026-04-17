import { AGENT_TYPES, type Agent, type AgentType } from "@agent-team-foundation/first-tree-hub-shared";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { listClients } from "../api/activity.js";
import { listAgents } from "../api/agents.js";
import { listMembers } from "../api/members.js";
import { useAuth } from "../auth/auth-context.js";
import { Button } from "./ui/button.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog.js";
import { Input } from "./ui/input.js";
import { Label } from "./ui/label.js";

const agentTypeValues = Object.values(AGENT_TYPES);

type AgentFormProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (data: AgentFormData) => void;
  isPending: boolean;
  error?: Error | null;
} & ({ mode: "create"; agent?: undefined } | { mode: "edit"; agent: Agent });

export type AgentFormData = {
  name?: string;
  type: AgentType;
  displayName: string | null;
  delegateMention: string | null;
  managerId: string | null;
  clientId: string | null;
};

export function AgentFormDialog(props: AgentFormProps) {
  const { open, onOpenChange, onSubmit, isPending, error, mode } = props;
  const agent = mode === "edit" ? props.agent : undefined;
  const { memberId: selfMemberId, role } = useAuth();
  const isAdmin = role === "admin";

  const [formName, setFormName] = useState("");
  const [formType, setFormType] = useState<AgentType>("personal_assistant");
  const [formDisplayName, setFormDisplayName] = useState("");
  const [formDelegateMention, setFormDelegateMention] = useState("");
  const [formManagerId, setFormManagerId] = useState("");
  const [formClientId, setFormClientId] = useState("");

  const showClient = mode === "create" && formType !== "human";
  const clientsQuery = useQuery({
    queryKey: ["clients-for-pin"],
    queryFn: listClients,
    enabled: open && showClient,
  });

  const showDelegate = formType === "human";

  const assistantsQuery = useQuery({
    queryKey: ["agents-for-delegate"],
    queryFn: async () => {
      const result = await listAgents({ limit: 100 });
      return result.items.filter((a) => a.type === "personal_assistant" && a.status === "active");
    },
    enabled: open && showDelegate,
  });

  const membersQuery = useQuery({
    queryKey: ["members-for-manager"],
    queryFn: listMembers,
    enabled: open && mode === "create" && isAdmin,
  });

  // Filter clients by the selected manager's user_id. The manager dropdown
  // is admin-only; members auto-pin under their own user, so their options
  // are already filtered server-side by clients the user owns.
  const visibleClients = useMemo(() => {
    const all = clientsQuery.data ?? [];
    if (!showClient) return all;
    if (!isAdmin) {
      // Server should only return clients owned by the caller for non-admins.
      return all;
    }
    if (!formManagerId) return [];
    const manager = membersQuery.data?.find((m) => m.id === formManagerId);
    if (!manager) return [];
    return all.filter((c) => (c.userId ?? null) === manager.userId);
  }, [clientsQuery.data, isAdmin, formManagerId, membersQuery.data, showClient]);

  useEffect(() => {
    if (open) {
      if (agent) {
        setFormName(agent.name ?? "");
        setFormType(agent.type);
        setFormDisplayName(agent.displayName ?? "");
        setFormDelegateMention(agent.delegateMention ?? "");
        setFormManagerId(agent.managerId ?? "");
      } else {
        setFormName("");
        setFormType("personal_assistant");
        setFormDisplayName("");
        setFormDelegateMention("");
        setFormManagerId(isAdmin ? "" : (selfMemberId ?? ""));
        setFormClientId("");
      }
    }
  }, [open, agent, isAdmin, selfMemberId]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit({
      name: mode === "create" && formName ? formName : undefined,
      type: formType,
      displayName: formDisplayName || null,
      delegateMention: formDelegateMention || null,
      managerId: formManagerId || null,
      clientId: formClientId || null,
    });
  };

  const isEdit = mode === "edit";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Agent" : "New Agent"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="agent-name">Name</Label>
            {isEdit ? (
              <Input id="agent-name" value={formName} disabled className="font-mono" />
            ) : (
              <Input
                id="agent-name"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="Leave empty to auto-generate"
                pattern="^[a-z0-9_-]*$"
                title="Only lowercase alphanumeric, hyphens, and underscores"
                className="font-mono"
              />
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="agent-type">Type</Label>
            <select
              id="agent-type"
              value={formType}
              onChange={(e) => {
                const newType = e.target.value as AgentType;
                setFormType(newType);
                if (newType !== "human") setFormDelegateMention("");
                setFormClientId("");
              }}
              disabled={isEdit}
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
            >
              {agentTypeValues.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="agent-display-name">Display Name</Label>
            <Input
              id="agent-display-name"
              value={formDisplayName}
              onChange={(e) => setFormDisplayName(e.target.value)}
              placeholder="Optional"
              maxLength={200}
            />
          </div>

          {/* Manager — admin-only; members auto-assign to themselves */}
          {mode === "create" && isAdmin && (
            <div className="space-y-2">
              <Label htmlFor="agent-manager">Manager</Label>
              <select
                id="agent-manager"
                value={formManagerId}
                onChange={(e) => {
                  setFormManagerId(e.target.value);
                  setFormClientId("");
                }}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="">Select a member…</option>
                {membersQuery.data?.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName} ({m.role})
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                Non-human agents must pin a client belonging to this user.
              </p>
            </div>
          )}

          {showDelegate && (
            <div className="space-y-2">
              <Label htmlFor="agent-delegate">Delegate Mention</Label>
              <select
                id="agent-delegate"
                value={formDelegateMention}
                onChange={(e) => setFormDelegateMention(e.target.value)}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="">None</option>
                {assistantsQuery.data?.map((a) => (
                  <option key={a.uuid} value={a.uuid}>
                    {a.displayName ? `${a.displayName} (${a.name ?? a.uuid})` : (a.name ?? a.uuid)}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">The personal assistant that acts on behalf of this agent</p>
            </div>
          )}

          {showClient && (
            <div className="space-y-2">
              <Label htmlFor="agent-client">Client</Label>
              {visibleClients.length > 0 ? (
                <select
                  id="agent-client"
                  value={formClientId}
                  onChange={(e) => setFormClientId(e.target.value)}
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <option value="">Select a client…</option>
                  {visibleClients.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.hostname ?? c.id.slice(0, 12)}
                    </option>
                  ))}
                </select>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {isAdmin && !formManagerId
                    ? "Pick a manager first to see their clients."
                    : "No eligible clients. Run `first-tree-hub connect` on the target machine to register one."}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                Pinned at creation — clientId is immutable in this milestone. Move = delete + recreate.
              </p>
            </div>
          )}

          {error && <div className="text-sm text-destructive">{error.message}</div>}

          <DialogFooter>
            <Button type="submit" disabled={isPending}>
              {isPending ? "Saving..." : isEdit ? "Save" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
