import {
  type AgentResourceBindingInput,
  deriveRepoLocalPath,
  type EffectiveResourceRow,
  type ResourceType,
} from "@first-tree/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { getAgentResources, updateAgentResources } from "../../api/agent-resources.js";
import { Button } from "../../components/ui/button.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { Input } from "../../components/ui/input.js";
import { Label } from "../../components/ui/label.js";
import { Section } from "../../components/ui/section.js";
import { useAgentDetailContext } from "./layout-context.js";

const RESOURCE_TYPES: ResourceType[] = ["repo", "prompt", "skill", "mcp"];

export function ResourcesTab() {
  const ctx = useAgentDetailContext();
  const queryClient = useQueryClient();
  const [repoOpen, setRepoOpen] = useState(false);
  const [promptOpen, setPromptOpen] = useState<{ replacesResourceId: string | null } | null>(null);
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
          action={
            canEdit && type === "repo" ? (
              <Button size="xs" variant="outline" onClick={() => setRepoOpen(true)}>
                <Plus className="h-3 w-3" /> Agent repo
              </Button>
            ) : canEdit && type === "prompt" ? (
              <Button size="xs" variant="outline" onClick={() => setPromptOpen({ replacesResourceId: null })}>
                <Plus className="h-3 w-3" /> Inline prompt
              </Button>
            ) : null
          }
        >
          <div>
            {data.effective[resourceBucket(type)].length === 0 ? (
              <p className="text-body" style={{ color: "var(--fg-4)", padding: "var(--sp-3) 0", margin: 0 }}>
                No {typeLabel(type).toLowerCase()} enabled.
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
                      ...currentBindings,
                      { type: row.type, mode: "disable", resourceId, order: currentBindings.length + 1 },
                    ])
                  }
                  onReplacePrompt={(resourceId) => setPromptOpen({ replacesResourceId: resourceId })}
                />
              ))
            )}
          </div>
          {canEdit && available.some((resource) => resource.type === type) ? (
            <div style={{ paddingTop: "var(--sp-3)" }}>
              {available
                .filter((resource) => resource.type === type)
                .map((resource) => (
                  <Button
                    key={resource.id}
                    type="button"
                    size="xs"
                    variant="outline"
                    disabled={updateMut.isPending}
                    onClick={() =>
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
                    style={{ marginRight: "var(--sp-2)", marginBottom: "var(--sp-2)" }}
                  >
                    Enable {resource.name}
                  </Button>
                ))}
            </div>
          ) : null}
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
      <InlinePromptDialog
        open={!!promptOpen}
        replacesResourceId={promptOpen?.replacesResourceId ?? null}
        onOpenChange={(open) => !open && setPromptOpen(null)}
        onSubmit={(body, replacesResourceId) => {
          mutateBindings([
            ...currentBindings,
            {
              type: "prompt",
              mode: replacesResourceId ? "replace" : "include",
              resourceId: null,
              replacesResourceId,
              inlinePromptBody: body,
              order: currentBindings.length + 1,
            },
          ]);
          setPromptOpen(null);
        }}
      />
    </div>
  );
}

function EffectiveRow(props: {
  row: EffectiveResourceRow;
  canEdit: boolean;
  bindings: AgentResourceBindingInput[];
  pending: boolean;
  onRemoveBinding: (bindingId: string) => void;
  onDisable: (resourceId: string) => void;
  onReplacePrompt: (resourceId: string) => void;
}) {
  const detail =
    props.row.repo?.url ??
    (props.row.promptBody ? `${props.row.promptBody.length} chars` : (props.row.unavailableReason ?? props.row.source));
  const canRemove = props.row.bindingId && props.bindings.some((b) => b.id === props.row.bindingId);
  const canDisable = props.row.resourceId && props.row.source === "team_recommended" && props.row.mode === "enabled";
  const canReplacePrompt = props.row.type === "prompt" && props.row.resourceId && props.row.source.startsWith("team_");
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
          <span className="text-caption" style={{ color: statusColor(props.row.mode) }}>
            {props.row.mode}
          </span>
          <span className="text-caption" style={{ color: "var(--fg-4)" }}>
            {props.row.source}
          </span>
        </div>
        <p className="m-0 text-caption truncate mono" style={{ color: "var(--fg-3)", marginTop: "var(--sp-0_5)" }}>
          {props.row.repo?.localPath ? `${detail} -> ${props.row.repo.localPath}` : detail}
        </p>
      </div>
      {props.canEdit && canReplacePrompt ? (
        <Button
          size="xs"
          variant="outline"
          disabled={props.pending}
          onClick={() => props.onReplacePrompt(props.row.resourceId ?? "")}
        >
          Replace
        </Button>
      ) : null}
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

function InlinePromptDialog(props: {
  open: boolean;
  replacesResourceId: string | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (body: string, replacesResourceId: string | null) => void;
}) {
  const [body, setBody] = useState("");
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{props.replacesResourceId ? "Replace prompt" : "Add inline prompt"}</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!body.trim()) return;
            props.onSubmit(body, props.replacesResourceId);
            setBody("");
          }}
          className="space-y-4"
        >
          <div className="space-y-2">
            <Label htmlFor="inline-prompt-body">Body</Label>
            <textarea
              id="inline-prompt-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              className="min-h-40 w-full rounded border bg-background p-2 text-body"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => props.onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit">{props.replacesResourceId ? "Replace" : "Add"}</Button>
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
  if (type === "repo") return "Repos";
  if (type === "prompt") return "Prompts";
  if (type === "skill") return "Skills";
  return "MCP";
}

function statusColor(mode: EffectiveResourceRow["mode"]): string {
  if (mode === "unavailable") return "var(--state-error)";
  if (mode === "disabled" || mode === "replaced") return "var(--fg-4)";
  return "var(--state-working)";
}
