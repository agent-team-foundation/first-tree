import { AGENT_TYPES, type Agent, type AgentType } from "@first-tree-hub/shared";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { listAgents } from "../api/agents.js";
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
  id?: string;
  type: AgentType;
  displayName: string | null;
  delegateMention: string | null;
};

export function AgentFormDialog(props: AgentFormProps) {
  const { open, onOpenChange, onSubmit, isPending, error, mode } = props;
  const agent = mode === "edit" ? props.agent : undefined;

  const [formId, setFormId] = useState("");
  const [formType, setFormType] = useState<AgentType>("personal_assistant");
  const [formDisplayName, setFormDisplayName] = useState("");
  const [formDelegateMention, setFormDelegateMention] = useState("");

  // Fetch active personal_assistant agents for delegate mention dropdown (human agents only)
  const showDelegate = formType === "human";
  const assistantsQuery = useQuery({
    queryKey: ["agents-for-delegate"],
    queryFn: async () => {
      const result = await listAgents({ limit: 100 });
      return result.items.filter((a) => a.type === "personal_assistant" && a.status === "active");
    },
    enabled: open && showDelegate,
  });

  // Reset form when dialog opens or agent changes
  useEffect(() => {
    if (open) {
      if (agent) {
        setFormId(agent.id);
        setFormType(agent.type);
        setFormDisplayName(agent.displayName ?? "");
        setFormDelegateMention(agent.delegateMention ?? "");
      } else {
        setFormId("");
        setFormType("personal_assistant");
        setFormDisplayName("");
        setFormDelegateMention("");
      }
    }
  }, [open, agent]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit({
      id: mode === "create" && formId ? formId : undefined,
      type: formType,
      displayName: formDisplayName || null,
      delegateMention: formDelegateMention || null,
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
          {/* ID */}
          <div className="space-y-2">
            <Label htmlFor="agent-id">ID</Label>
            {isEdit ? (
              <Input id="agent-id" value={formId} disabled className="font-mono" />
            ) : (
              <Input
                id="agent-id"
                value={formId}
                onChange={(e) => setFormId(e.target.value)}
                placeholder="Leave empty to auto-generate"
                pattern="^[a-z0-9_-]*$"
                title="Only lowercase alphanumeric, hyphens, and underscores"
                className="font-mono"
              />
            )}
          </div>

          {/* Type */}
          <div className="space-y-2">
            <Label htmlFor="agent-type">Type</Label>
            <select
              id="agent-type"
              value={formType}
              onChange={(e) => {
                const newType = e.target.value as AgentType;
                setFormType(newType);
                if (newType !== "human") setFormDelegateMention("");
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

          {/* Display Name */}
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

          {/* Delegate Mention — only for human agents */}
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
                  <option key={a.id} value={a.id}>
                    {a.displayName ? `${a.displayName} (${a.id})` : a.id}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">The personal assistant that acts on behalf of this agent</p>
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
