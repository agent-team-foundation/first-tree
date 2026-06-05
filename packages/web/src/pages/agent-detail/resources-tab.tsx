import {
  type AgentResourceBindingInput,
  deriveRepoLocalPath,
  type EffectiveResourceRow,
  noSecretMcpServerSchema,
  type ResourceRow,
  type ResourceType,
  skillResourcePayloadSchema,
} from "@first-tree/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import { useNavigate } from "react-router";
import { getAgentResources, updateAgentResources } from "../../api/agent-resources.js";
import { Button } from "../../components/ui/button.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { Input } from "../../components/ui/input.js";
import { Label } from "../../components/ui/label.js";
import { Popover } from "../../components/ui/popover.js";
import { Section } from "../../components/ui/section.js";
import { StatusGlyph } from "../../components/ui/status-glyph.js";
import { typeLabelSingular } from "../settings/resource-editors.js";
import { useAgentDetailContext } from "./layout-context.js";
import { sourceLabel } from "./resource-source.js";

// Prompts are managed in the Prompt tab, not here — Capabilities lists only
// what the agent can use: code repos, skills, and MCP integrations.
const RESOURCE_TYPES: ResourceType[] = ["repo", "skill", "mcp"];

export function ResourcesTab() {
  const ctx = useAgentDetailContext();
  const queryClient = useQueryClient();
  const [repoOpen, setRepoOpen] = useState(false);
  const resourcesQuery = useQuery({
    queryKey: ["agent-resources", ctx.uuid],
    queryFn: () => getAgentResources(ctx.uuid),
    enabled: !!ctx.uuid && !ctx.isHuman,
  });
  const updateMut = useMutation({
    mutationFn: (bindings: AgentResourceBindingInput[]) => {
      if (!resourcesQuery.data) throw new Error("resources not loaded");
      return updateAgentResources(ctx.uuid, { expectedVersion: resourcesQuery.data.version, bindings });
    },
    onSuccess: (next) => {
      queryClient.setQueryData(["agent-resources", ctx.uuid], next);
      queryClient.invalidateQueries({ queryKey: ["agent-config", ctx.uuid] });
    },
  });

  if (ctx.isHuman) return null;
  if (resourcesQuery.isLoading) {
    return (
      <p className="text-body" style={{ color: "var(--fg-3)" }}>
        Loading...
      </p>
    );
  }
  if (resourcesQuery.error || !resourcesQuery.data) {
    return (
      <p className="text-body" style={{ color: "var(--state-error)" }}>
        {resourcesQuery.error instanceof Error ? resourcesQuery.error.message : "Failed to load resources"}
      </p>
    );
  }

  const data = resourcesQuery.data;
  const canEdit = ctx.canManageAgent && ctx.agent.status === "active";
  const currentBindings = data.bindings;
  const mutateBindings = (next: AgentResourceBindingInput[]) => updateMut.mutate(next);
  const activeBindingIds = new Set(currentBindings.map((b) => b.resourceId).filter((id): id is string => !!id));
  const available = data.availableTeamResources.filter(
    (resource) => resource.defaultEnabled === "available" && !activeBindingIds.has(resource.id),
  );

  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-5)" }}>
      {RESOURCE_TYPES.map((type) => (
        <Section
          key={type}
          title={typeLabel(type)}
          count={data.effective[resourceBucket(type)].length}
          description={type === "mcp" ? "Tools come from the MCP servers connected here." : undefined}
          action={
            canEdit ? (
              <AddCapabilityMenu
                type={type}
                enableable={available.filter((resource) => resource.type === type)}
                pending={updateMut.isPending}
                onAddAgentRepo={() => setRepoOpen(true)}
                onEnable={(resource) =>
                  mutateBindings([
                    ...currentBindings,
                    {
                      type: resource.type,
                      mode: "include",
                      resourceId: resource.id,
                      order: currentBindings.length + 1,
                    },
                  ])
                }
              />
            ) : null
          }
        >
          <div>
            {data.effective[resourceBucket(type)].length === 0 ? (
              <p className="text-body" style={{ color: "var(--fg-4)", padding: "var(--sp-3) 0", margin: 0 }}>
                No {emptyNoun(type)} enabled.
              </p>
            ) : (
              data.effective[resourceBucket(type)].map((row) => (
                <EffectiveRow
                  key={row.id}
                  row={row}
                  canEdit={canEdit}
                  bindings={currentBindings}
                  pending={updateMut.isPending}
                  onRemoveBinding={(bindingId) => mutateBindings(currentBindings.filter((b) => b.id !== bindingId))}
                  onDisable={(resourceId) =>
                    mutateBindings([
                      // Drop any existing include/replace binding for this resource first —
                      // otherwise the resolver sees include + disable and it stays enabled.
                      ...currentBindings.filter(
                        (b) => b.resourceId !== resourceId && b.replacesResourceId !== resourceId,
                      ),
                      { type: row.type, mode: "disable", resourceId, order: currentBindings.length + 1 },
                    ])
                  }
                />
              ))
            )}
          </div>
        </Section>
      ))}
      {updateMut.error ? (
        <p className="text-body" style={{ color: "var(--state-error)" }}>
          {updateMut.error instanceof Error ? updateMut.error.message : "Failed to save resources"}
        </p>
      ) : null}
      <AgentRepoDialog
        open={repoOpen}
        onOpenChange={setRepoOpen}
        onSubmit={(repo) => {
          mutateBindings([
            ...currentBindings,
            { type: "repo", mode: "include", agentExtraRepo: repo, order: currentBindings.length + 1 },
          ]);
          setRepoOpen(false);
        }}
      />
    </div>
  );
}

/**
 * Per-section add control on the agent Capabilities tab. One "+ <Type>" trigger
 * opens a context menu:
 *   - repo: "Add agent repo" (a private, agent-scoped repo) plus any opt-in team
 *     repos to enable.
 *   - skill / mcp: opt-in team resources to enable. These types have no
 *     agent-private form (the binding model supports private repos and inline
 *     prompts only), so when the team offers none the menu still routes the user
 *     to Settings → Resources rather than dead-ending — every section's "+" is
 *     always actionable.
 */
function AddCapabilityMenu(props: {
  type: ResourceType;
  enableable: ResourceRow[];
  pending: boolean;
  onAddAgentRepo: () => void;
  onEnable: (resource: ResourceRow) => void;
}) {
  const navigate = useNavigate();
  return (
    <Popover
      align="end"
      trigger={({ open, toggle }) => {
        const label = `Add ${typeLabelSingular(props.type)}`;
        return (
          <Button size="xs" variant="ghost" aria-expanded={open} aria-label={label} title={label} onClick={toggle}>
            <Plus className="h-4 w-4" />
          </Button>
        );
      }}
    >
      {({ close }) => (
        <div style={{ padding: "var(--sp-1)", minWidth: "var(--sp-45)" }}>
          {props.type === "repo" ? (
            <MenuButton
              onClick={() => {
                props.onAddAgentRepo();
                close();
              }}
            >
              Add agent repo…
            </MenuButton>
          ) : null}
          {props.enableable.length > 0 ? (
            <>
              <MenuLabel>Enable from team</MenuLabel>
              {props.enableable.map((resource) => (
                <MenuButton
                  key={resource.id}
                  disabled={props.pending}
                  onClick={() => {
                    props.onEnable(resource);
                    close();
                  }}
                >
                  {resource.name}
                </MenuButton>
              ))}
            </>
          ) : props.type !== "repo" ? (
            <MenuLabel>No team {emptyNoun(props.type)} to enable yet.</MenuLabel>
          ) : null}
          <div style={{ borderTop: "var(--hairline) solid var(--border-faint)", margin: "var(--sp-1) 0" }} />
          <MenuButton
            muted
            onClick={() => {
              navigate("/settings/resources");
              close();
            }}
          >
            Manage in Settings → Resources
          </MenuButton>
        </div>
      )}
    </Popover>
  );
}

function MenuLabel({ children }: { children: ReactNode }) {
  return (
    <p className="text-label" style={{ color: "var(--fg-4)", margin: 0, padding: "var(--sp-1) var(--sp-2)" }}>
      {children}
    </p>
  );
}

function MenuButton(props: { children: ReactNode; muted?: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={props.disabled}
      className="flex w-full items-center text-left text-body transition-colors hover:bg-[var(--bg-hover)] disabled:pointer-events-none disabled:opacity-50"
      style={{
        gap: "var(--sp-2)",
        padding: "var(--sp-1_5) var(--sp-2)",
        borderRadius: "var(--radius-chip)",
        border: 0,
        background: "transparent",
        color: props.muted ? "var(--fg-3)" : "var(--fg)",
        cursor: "pointer",
      }}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

function EffectiveRow(props: {
  row: EffectiveResourceRow;
  canEdit: boolean;
  bindings: AgentResourceBindingInput[];
  pending: boolean;
  onRemoveBinding: (bindingId: string) => void;
  onDisable: (resourceId: string) => void;
}) {
  // Unavailable rows surface the failure reason as the subtitle; everything
  // else shows a type-appropriate detail. The subtitle never falls back to the
  // raw `source` enum (that used to duplicate the source under skills/MCP rows).
  const subtitle = props.row.mode === "unavailable" ? props.row.unavailableReason : rowSubtitle(props.row);
  const status = statusMarker(props.row.mode);
  const source = sourceLabel(props.row.source);
  const canRemove = props.row.bindingId && props.bindings.some((b) => b.id === props.row.bindingId);
  const canDisable = props.row.resourceId && props.row.source === "team_recommended" && props.row.mode === "enabled";
  return (
    <div
      className="flex items-center gap-3"
      style={{ padding: "var(--sp-3) 0", borderBottom: "var(--hairline) solid var(--border-faint)" }}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="m-0 text-body font-medium truncate" style={{ color: "var(--fg)" }}>
            {props.row.name}
          </p>
          {status ? (
            <span className="mono inline-flex items-center gap-1.5 text-caption" style={{ color: status.color }}>
              <StatusGlyph colorVar={status.color} shape="dot" size={7} ariaLabel={status.label} />
              {status.label}
            </span>
          ) : null}
          <span className="text-caption" style={{ color: "var(--fg-4)" }}>
            {source}
          </span>
        </div>
        {subtitle ? (
          <p className="m-0 text-caption truncate mono" style={{ color: "var(--fg-3)", marginTop: "var(--sp-0_5)" }}>
            {subtitle}
          </p>
        ) : null}
      </div>
      {props.canEdit && canDisable ? (
        <Button
          size="xs"
          variant="outline"
          disabled={props.pending}
          onClick={() => props.onDisable(props.row.resourceId ?? "")}
        >
          Disable
        </Button>
      ) : null}
      {props.canEdit && canRemove ? (
        <Button
          size="xs"
          variant="ghost"
          disabled={props.pending}
          aria-label={`Remove ${props.row.name}`}
          onClick={() => props.onRemoveBinding(props.row.bindingId ?? "")}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      ) : null}
    </div>
  );
}

function AgentRepoDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (repo: { url: string; name?: string; defaultBranch?: string }) => void;
}) {
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [branch, setBranch] = useState("");
  const [error, setError] = useState<string | null>(null);
  function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = url.trim();
    if (!trimmed) {
      setError("URL is required.");
      return;
    }
    props.onSubmit({
      url: trimmed,
      ...(name.trim() ? { name: name.trim() } : { name: deriveRepoLocalPath(trimmed) }),
      ...(branch.trim() ? { defaultBranch: branch.trim() } : {}),
    });
    setUrl("");
    setName("");
    setBranch("");
  }
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add agent repository</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <Field
            id="agent-repo-url"
            label="URL"
            value={url}
            onChange={setUrl}
            placeholder="git@github.com:org/repo.git"
            mono
          />
          <Field
            id="agent-repo-name"
            label="Name"
            value={name}
            onChange={setName}
            placeholder={deriveRepoLocalPath(url) || "repo"}
          />
          <Field id="agent-repo-branch" label="Default branch" value={branch} onChange={setBranch} placeholder="main" />
          {error ? (
            <p className="text-body" style={{ color: "var(--state-error)" }}>
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => props.onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit">Add</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field(props: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={props.id}>{props.label}</Label>
      <Input
        id={props.id}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder={props.placeholder}
        className={props.mono ? "mono" : undefined}
      />
    </div>
  );
}

function resourceBucket(type: ResourceType): "repos" | "prompts" | "skills" | "mcp" {
  if (type === "repo") return "repos";
  if (type === "prompt") return "prompts";
  if (type === "skill") return "skills";
  return "mcp";
}

function typeLabel(type: ResourceType): string {
  if (type === "repo") return "Code repositories";
  if (type === "prompt") return "Prompts";
  if (type === "skill") return "Skills";
  return "Integrations (MCP)";
}

function emptyNoun(type: ResourceType): string {
  if (type === "repo") return "code repositories";
  if (type === "prompt") return "prompts";
  if (type === "skill") return "skills";
  return "MCP integrations";
}

/** One-line, human subtitle per resource type. Never the raw `source` enum. */
function rowSubtitle(row: EffectiveResourceRow): string | null {
  if (row.type === "repo") {
    const url = row.repo?.url;
    if (!url) return null;
    return row.repo?.localPath ? `${url} -> ${row.repo.localPath}` : url;
  }
  if (row.type === "prompt") {
    return row.promptBody ? `${row.promptBody.length} chars` : null;
  }
  if (row.type === "skill") {
    const parsed = skillResourcePayloadSchema.safeParse(row.payload);
    return parsed.success ? parsed.data.description : null;
  }
  const mcp = noSecretMcpServerSchema.safeParse(row.payload);
  if (!mcp.success) return null;
  return mcp.data.transport === "stdio" ? mcp.data.command : mcp.data.url;
}

/**
 * Status marker — only rendered when a row deviates from the normal "enabled"
 * state, so normal rows stay clean. `Off` (not `Disabled`) avoids colliding
 * with the row's own `Disable` action button.
 */
function statusMarker(mode: EffectiveResourceRow["mode"]): { label: string; color: string } | null {
  if (mode === "disabled") return { label: "Off", color: "var(--fg-4)" };
  if (mode === "replaced") return { label: "Overridden", color: "var(--fg-4)" };
  if (mode === "unavailable") return { label: "Can't load", color: "var(--state-error)" };
  return null;
}
