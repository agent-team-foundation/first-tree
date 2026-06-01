import { AGENT_VISIBILITY, type Agent, type UpdateAgent } from "@first-tree/shared";
import { useQuery } from "@tanstack/react-query";
import { Pencil } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { listAgents } from "../../api/agents.js";
import { useAuth } from "../../auth/auth-context.js";
import { AgentChip } from "../../components/agent-chip.js";
import { Button } from "../../components/ui/button.js";
import { DenseBadge } from "../../components/ui/dense-badge.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { Input } from "../../components/ui/input.js";
import { Label } from "../../components/ui/label.js";
import { Section } from "../../components/ui/section.js";
import { Select, type SelectOption } from "../../components/ui/select.js";
import { humanizeAgentType, humanizeVisibility } from "../../lib/agent-labels.js";
import { useAgentIdentityMap } from "../../lib/use-agent-name-map.js";
import { useMemberNameMap } from "../../lib/use-member-name-map.js";
import { ConfigRow } from "./flat-section.js";

/**
 * Redesign §5.3 Identity — a compact two-line summary plus a dedicated
 * Edit dialog whose Save goes **straight to the identity API**, bypassing the
 * page-level Save Bar (PRD §6 "config and identity are separate APIs").
 */

export type IdentitySectionProps = {
  agent: Agent;
  canEdit?: boolean;
  onSave: (patch: UpdateAgent) => Promise<void>;
};

export function IdentitySection({ agent, canEdit = true, onSave }: IdentitySectionProps) {
  const [open, setOpen] = useState(false);
  const resolveAgent = useAgentIdentityMap();
  const resolveMember = useMemberNameMap();

  const metadata = agent.metadata as Record<string, unknown> | undefined;
  const treeMeta = metadata?.tree as Record<string, unknown> | undefined;
  const role = typeof treeMeta?.role === "string" ? treeMeta.role : null;
  const domains = Array.isArray(treeMeta?.domains)
    ? (treeMeta?.domains as unknown[]).filter((d): d is string => typeof d === "string")
    : [];
  const managerName = agent.managerId ? resolveMember(agent.managerId) : null;
  const delegateIdentity = agent.delegateMention ? resolveAgent(agent.delegateMention) : null;

  const action =
    canEdit && agent.status === "active" ? (
      <Button size="xs" variant="outline" onClick={() => setOpen(true)}>
        <Pencil className="h-3 w-3" /> Edit
      </Button>
    ) : null;

  return (
    <Section title="Identity" action={action}>
      <ConfigRow label="Display name" value={<span className="font-semibold">{agent.displayName}</span>} />
      <ConfigRow label="Agent name" value={agent.name ? <span className="font-mono">@{agent.name}</span> : "—"} />
      {delegateIdentity && (
        <ConfigRow
          label="Delegate"
          value={<AgentChip name={delegateIdentity.name} displayName={delegateIdentity.displayName} />}
        />
      )}
      <ConfigRow label="Manager" value={managerName ?? "—"} />
      {role && <ConfigRow label="Role" value={role} />}
      <ConfigRow label="Type" value={humanizeAgentType(agent.type)} />
      <ConfigRow label="Visibility" value={humanizeVisibility(agent.visibility)} />
      {domains.length > 0 && (
        <ConfigRow
          label="Domains"
          value={
            <span className="inline-flex flex-wrap gap-1 align-middle">
              {domains.map((d) => (
                <DenseBadge key={d} tone="outline">
                  {humanizeDomain(d)}
                </DenseBadge>
              ))}
            </span>
          }
        />
      )}

      {canEdit && <IdentityEditDialog agent={agent} open={open} onOpenChange={setOpen} onSave={onSave} />}
    </Section>
  );
}

type IdentityDialogProps = {
  agent: Agent;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (patch: UpdateAgent) => Promise<void>;
};

function IdentityEditDialog({ agent, open, onOpenChange, onSave }: IdentityDialogProps) {
  const { memberId, role, agentId } = useAuth();
  const resolveAgent = useAgentIdentityMap();
  const [displayName, setDisplayName] = useState(agent.displayName);
  const [delegateMention, setDelegateMention] = useState(agent.delegateMention ?? "");
  const [visibility, setVisibility] = useState(agent.visibility);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setDisplayName(agent.displayName);
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
  // A delegate is a personal choice — only the member themselves may set it,
  // NOT an admin acting on their behalf. The backend enforces this (403);
  // mirror it here so the control is disabled when the caller can't persist.
  // Use the SAME truth source the server uses (scope.humanAgentId === target
  // uuid): useAuth().agentId is the caller's own human-agent uuid. A
  // managerId-based check could drift from this if the manager is reassigned.
  const canEditDelegate = isHuman && agent.uuid === agentId;
  // For non-owners the selector is read-only, so resolve the assigned delegate
  // to show the truth as text instead of a disabled <select>.
  const delegateIdentity = agent.delegateMention ? resolveAgent(agent.delegateMention) : null;
  const assistantsQuery = useQuery({
    queryKey: ["agents-for-delegate", memberId],
    queryFn: async () => {
      const res = await listAgents({ limit: 100 });
      // Candidates mirror the Team page selector: the member's own team-visible
      // (organization), active agents. Private agents are excluded because a
      // delegate acts on the member's behalf in team chats and must be
      // team-mentionable.
      return res.items.filter(
        (a) =>
          a.type === "agent" && a.visibility === "organization" && a.status === "active" && a.managerId === memberId,
      );
    },
    enabled: open && canEditDelegate,
  });
  const delegateOptions: SelectOption[] = useMemo(
    () => [
      { value: "", label: "Remove delegate" },
      ...(assistantsQuery.data?.map((a) => ({
        value: a.uuid,
        label: a.displayName ? `${a.displayName} (@${a.name ?? a.uuid})` : a.name ? `@${a.name}` : a.uuid,
      })) ?? []),
    ],
    [assistantsQuery.data],
  );

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    // Display name is required after Phase 2 — reject empty locally so the
    // server 400 doesn't bubble up as a mystery "validation failed".
    const trimmed = displayName.trim();
    if (!trimmed) {
      setError("Display name is required.");
      return;
    }
    setSaving(true);
    try {
      const patch: UpdateAgent = {
        displayName: trimmed,
      };
      // Only send delegateMention when the caller owns this agent. Otherwise an
      // admin editing someone else's display name would carry the field and trip
      // the server-side self-only guard (403).
      if (canEditDelegate) {
        patch.delegateMention = delegateMention || null;
      }
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
            <Label>Agent name</Label>
            <Input value={agent.name ? `@${agent.name}` : ""} disabled className="font-mono" />
            <p className="text-caption text-muted-foreground">
              Agent name is permanent after creation — used in @mentions and CLI commands.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="id-display">Display name</Label>
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
            <Select
              id="id-visibility"
              aria-label="Visibility"
              value={visibility}
              onChange={(v) => setVisibility(v as typeof visibility)}
              disabled={!canChangeVisibility}
              options={[
                { value: AGENT_VISIBILITY.PRIVATE, label: "Private — only the manager" },
                { value: AGENT_VISIBILITY.ORGANIZATION, label: "Organization — all members" },
              ]}
            />
            <p className="text-caption text-muted-foreground">
              {canChangeVisibility
                ? "Private agents are only visible to their manager; organization agents appear in every member's list."
                : "Only the manager or an admin can change this agent's visibility."}
            </p>
          </div>
          {isHuman && (
            <div className="space-y-2">
              <Label htmlFor="id-delegate">Delegate Mention</Label>
              {canEditDelegate ? (
                <Select
                  id="id-delegate"
                  aria-label="Delegate Mention"
                  value={delegateMention}
                  onChange={setDelegateMention}
                  options={delegateOptions}
                  searchable
                />
              ) : (
                // Read-only for non-owners: show the assigned delegate as text.
                // A disabled <select> would have no matching option (the query
                // is gated to owners) and misrender the value as "Remove delegate".
                <div className="flex h-9 w-full items-center rounded-[var(--radius-input)] border border-input bg-transparent px-3 text-body opacity-70">
                  {delegateIdentity ? (
                    <AgentChip name={delegateIdentity.name} displayName={delegateIdentity.displayName} />
                  ) : (
                    <span className="text-muted-foreground">No delegate</span>
                  )}
                </div>
              )}
              <p className="text-caption text-muted-foreground">
                {canEditDelegate
                  ? "Assistant that acts on behalf of this agent."
                  : "Only the member themselves can set their own delegate."}
              </p>
            </div>
          )}
          {error && <p className="text-body text-destructive">{error}</p>}
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

/**
 * Domain tags come from `metadata.tree.domains` and mirror the Context
 * Tree's top-level directory names (`kael`, `agent-hub`, `first-tree-skill-cli`,
 * …). They're free-form strings, not a closed enum, so we lean on a
 * lightweight transform instead of a hard-coded map: kebab/snake → spaces,
 * then capitalize the first letter so the chip reads as sentence-case
 * ("Agent hub", "First tree skill cli") rather than as a code token.
 */
function humanizeDomain(domain: string): string {
  if (!domain) return domain;
  const spaced = domain.replace(/[-_]+/g, " ").trim();
  if (!spaced) return domain;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
