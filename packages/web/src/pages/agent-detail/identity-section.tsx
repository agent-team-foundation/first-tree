import { AGENT_VISIBILITY, type Agent, type UpdateAgent } from "@agent-team-foundation/first-tree-hub-shared";
import { useQuery } from "@tanstack/react-query";
import { Pencil } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { listAgents } from "../../api/agents.js";
import { useAuth } from "../../auth/auth-context.js";
import { Button } from "../../components/ui/button.js";
import { DenseBadge } from "../../components/ui/dense-badge.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { Input } from "../../components/ui/input.js";
import { Label } from "../../components/ui/label.js";
import { useAgentNameMap } from "../../lib/use-agent-name-map.js";
import { useMemberNameMap } from "../../lib/use-member-name-map.js";

/**
 * Redesign §5.3 Identity — a compact two-line summary plus a dedicated
 * Edit dialog whose Save goes **straight to the identity API**, bypassing the
 * page-level Save Bar (PRD §6 "config and identity are separate APIs").
 */

export type IdentitySectionProps = {
  agent: Agent;
  onSave: (patch: UpdateAgent) => Promise<void>;
};

export function IdentitySection({ agent, onSave }: IdentitySectionProps) {
  const [open, setOpen] = useState(false);
  const { memberId, role: authRole } = useAuth();
  const resolveAgent = useAgentNameMap();
  const resolveMember = useMemberNameMap();

  // Mirror the backend PATCH /admin/agents/:uuid guard (assertCanManage).
  // Without this the Edit button surfaces to non-managers and Save would
  // 404 from the server — a confusing "Agent not found" in the dialog.
  // null-is-permissive so a transient /me failure doesn't lock a real
  // manager out of their own agent (see agent-detail.tsx for details).
  const canManage = memberId == null || authRole === "admin" || agent.managerId === memberId;

  const metadata = agent.metadata as Record<string, unknown> | undefined;
  const treeMeta = metadata?.tree as Record<string, unknown> | undefined;
  const role = typeof treeMeta?.role === "string" ? treeMeta.role : null;
  const domains = Array.isArray(treeMeta?.domains)
    ? (treeMeta?.domains as unknown[]).filter((d): d is string => typeof d === "string")
    : [];
  const ownerName = agent.managerId ? resolveMember(agent.managerId) : null;
  const delegateLabel = agent.delegateMention ? resolveAgent(agent.delegateMention) : null;

  return (
    <section
      style={{
        background: "var(--bg-raised)",
        border: "1px solid var(--border)",
        borderRadius: 6,
      }}
    >
      <header
        className="flex items-center justify-between"
        style={{
          padding: "10px 14px",
          borderBottom: "1px solid var(--border-faint)",
        }}
      >
        <h2 style={{ fontSize: 12, fontWeight: 600, color: "var(--fg)" }}>Profile</h2>
        {agent.status === "active" && canManage && (
          <Button size="xs" variant="outline" onClick={() => setOpen(true)}>
            <Pencil className="h-3 w-3" /> Edit
          </Button>
        )}
      </header>
      <div className="px-4 py-3 text-sm space-y-1">
        <div>
          <span className="font-mono">{agent.name ?? agent.uuid}</span>
          <span className="mx-2 text-muted-foreground">·</span>
          <span>{agent.displayName ?? <span className="text-muted-foreground italic">no display name</span>}</span>
          {delegateLabel && (
            <>
              <span className="mx-2 text-muted-foreground">·</span>
              <span className="text-muted-foreground">
                delegate <span className="font-mono">{delegateLabel}</span>
              </span>
            </>
          )}
        </div>
        <div className="text-xs text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>
            owner <span className="text-gray-900">{ownerName ?? "—"}</span>
          </span>
          {role && (
            <span>
              role <span className="text-gray-900">{role}</span>
            </span>
          )}
          <span>
            type <DenseBadge tone={agent.type === "autonomous_agent" ? "accent" : "neutral"}>{agent.type}</DenseBadge>
          </span>
          <span>
            visibility{" "}
            <DenseBadge tone={agent.visibility === "organization" ? "accent" : "outline"}>
              {agent.visibility}
            </DenseBadge>
          </span>
          {domains.length > 0 && (
            <span>
              domains{" "}
              <span className="inline-flex flex-wrap gap-1 align-middle">
                {domains.map((d) => (
                  <DenseBadge key={d} tone="outline">
                    {d}
                  </DenseBadge>
                ))}
              </span>
            </span>
          )}
        </div>
      </div>

      <IdentityEditDialog agent={agent} open={open} onOpenChange={setOpen} onSave={onSave} />
    </section>
  );
}

type IdentityDialogProps = {
  agent: Agent;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (patch: UpdateAgent) => Promise<void>;
};

function IdentityEditDialog({ agent, open, onOpenChange, onSave }: IdentityDialogProps) {
  const { memberId, role } = useAuth();
  const [displayName, setDisplayName] = useState(agent.displayName ?? "");
  const [delegateMention, setDelegateMention] = useState(agent.delegateMention ?? "");
  const [visibility, setVisibility] = useState(agent.visibility);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setDisplayName(agent.displayName ?? "");
      setDelegateMention(agent.delegateMention ?? "");
      setVisibility(agent.visibility);
      setError(null);
    }
  }, [open, agent]);

  const isHuman = agent.type === "human";
  // Only the agent's manager or an admin can change visibility. The backend
  // enforces this via assertCanManage; this mirrors that on the UI so the
  // field is disabled when the caller can't persist the change anyway.
  const canChangeVisibility = role === "admin" || agent.managerId === memberId;
  const assistantsQuery = useQuery({
    queryKey: ["agents-for-delegate"],
    queryFn: async () => {
      const res = await listAgents({ limit: 100 });
      return res.items.filter((a) => a.type === "personal_assistant" && a.status === "active");
    },
    enabled: open && isHuman,
  });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const patch: UpdateAgent = {
        displayName: displayName || null,
        delegateMention: delegateMention || null,
      };
      if (visibility !== agent.visibility) {
        patch.visibility = visibility;
      }
      await onSave(patch);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit Identity</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label>Name (mention)</Label>
            <Input value={agent.name ?? ""} disabled className="font-mono" />
            <p className="text-xs text-muted-foreground">Name is permanent after creation.</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="id-display">Display Name</Label>
            <Input
              id="id-display"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="How teammates see this agent"
              maxLength={200}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="id-visibility">Visibility</Label>
            <select
              id="id-visibility"
              value={visibility}
              onChange={(e) => setVisibility(e.target.value as typeof visibility)}
              disabled={!canChangeVisibility}
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option value={AGENT_VISIBILITY.PRIVATE}>Private — only the manager</option>
              <option value={AGENT_VISIBILITY.ORGANIZATION}>Organization — all members</option>
            </select>
            <p className="text-xs text-muted-foreground">
              {canChangeVisibility
                ? "Private agents are only visible to their manager; organization agents appear in every member's list."
                : "Only the manager or an admin can change this agent's visibility."}
            </p>
          </div>
          {isHuman && (
            <div className="space-y-2">
              <Label htmlFor="id-delegate">Delegate Mention</Label>
              <select
                id="id-delegate"
                value={delegateMention}
                onChange={(e) => setDelegateMention(e.target.value)}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="">None</option>
                {assistantsQuery.data?.map((a) => (
                  <option key={a.uuid} value={a.uuid}>
                    {a.displayName ? `${a.displayName} (${a.name ?? a.uuid})` : (a.name ?? a.uuid)}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">Assistant that acts on behalf of this agent.</p>
            </div>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
