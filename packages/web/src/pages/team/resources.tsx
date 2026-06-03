import type { CreateTeamResource, ResourceRow, ResourceType } from "@first-tree/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";
import {
  createTeamResource,
  listTeamResources,
  previewOrgResourceImpact,
  retireResource,
} from "../../api/resources.js";
import { useAuth } from "../../auth/auth-context.js";
import { Button } from "../../components/ui/button.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { Input } from "../../components/ui/input.js";
import { Label } from "../../components/ui/label.js";
import { PageHeader } from "../../components/ui/page-header.js";
import { Section } from "../../components/ui/section.js";

const RESOURCE_TYPES: ResourceType[] = ["repo", "prompt", "skill", "mcp"];

export function TeamResourcesPage() {
  const { role } = useAuth();
  const isAdmin = role === "admin";
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const resourcesQuery = useQuery({ queryKey: ["team-resources"], queryFn: listTeamResources });
  const retireMut = useMutation({
    mutationFn: retireResource,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["team-resources"] }),
  });

  const grouped = useMemo(() => {
    const map = new Map<ResourceType, ResourceRow[]>();
    for (const type of RESOURCE_TYPES) map.set(type, []);
    for (const resource of resourcesQuery.data ?? []) {
      map.get(resource.type)?.push(resource);
    }
    return map;
  }, [resourcesQuery.data]);

  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-5)" }}>
      <PageHeader
        title="Team Resources"
        subtitle="Team defaults and available resources used by agents at runtime."
        right={
          isAdmin ? (
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" /> Resource
            </Button>
          ) : null
        }
      />
      {resourcesQuery.isLoading ? (
        <p className="text-body" style={{ color: "var(--fg-3)" }}>
          Loading...
        </p>
      ) : resourcesQuery.error ? (
        <p className="text-body" style={{ color: "var(--state-error)" }}>
          {resourcesQuery.error instanceof Error ? resourcesQuery.error.message : "Failed to load resources"}
        </p>
      ) : (
        RESOURCE_TYPES.map((type) => (
          <Section key={type} title={typeLabel(type)} count={grouped.get(type)?.length ?? 0}>
            <div>
              {(grouped.get(type) ?? []).length === 0 ? (
                <p className="text-body" style={{ color: "var(--fg-4)", padding: "var(--sp-3) 0", margin: 0 }}>
                  No {typeLabel(type).toLowerCase()} configured.
                </p>
              ) : (
                (grouped.get(type) ?? []).map((resource) => (
                  <ResourceListRow
                    key={resource.id}
                    resource={resource}
                    canEdit={isAdmin}
                    retiring={retireMut.isPending}
                    onRetire={() => retireMut.mutate(resource.id)}
                  />
                ))
              )}
            </div>
          </Section>
        ))
      )}
      <CreateResourceDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => {
          setCreateOpen(false);
          queryClient.invalidateQueries({ queryKey: ["team-resources"] });
        }}
      />
    </div>
  );
}

function ResourceListRow(props: { resource: ResourceRow; canEdit: boolean; retiring: boolean; onRetire: () => void }) {
  const payload = props.resource.payload as Record<string, unknown>;
  const detail =
    typeof payload.url === "string"
      ? payload.url
      : typeof payload.description === "string"
        ? payload.description
        : typeof payload.body === "string"
          ? `${payload.body.length} chars`
          : "";
  return (
    <div
      className="flex items-center gap-3"
      style={{ padding: "var(--sp-3) 0", borderBottom: "var(--hairline) solid var(--border-faint)" }}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="m-0 text-body font-medium truncate" style={{ color: "var(--fg)" }}>
            {props.resource.name}
          </p>
          <span className="text-caption" style={{ color: "var(--fg-4)" }}>
            {props.resource.defaultEnabled}
          </span>
        </div>
        {detail ? (
          <p className="m-0 text-caption truncate mono" style={{ color: "var(--fg-3)", marginTop: "var(--sp-0_5)" }}>
            {detail}
          </p>
        ) : null}
      </div>
      {props.canEdit ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-label={`Retire ${props.resource.name}`}
          disabled={props.retiring}
          onClick={props.onRetire}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      ) : null}
    </div>
  );
}

function CreateResourceDialog(props: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: () => void }) {
  const [type, setType] = useState<ResourceType>("repo");
  const [defaultEnabled, setDefaultEnabled] = useState<"recommended" | "available">("available");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [body, setBody] = useState("");
  const [description, setDescription] = useState("");
  const [transport, setTransport] = useState<"stdio" | "http" | "sse">("stdio");
  const [command, setCommand] = useState("");
  const [impact, setImpact] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const createMut = useMutation({
    mutationFn: createTeamResource,
    onSuccess: props.onCreated,
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });
  const previewMut = useMutation({
    mutationFn: previewOrgResourceImpact,
    onSuccess: (result) => {
      setImpact(`${result.affectedAgentCount} agents affected, ${result.promptOverflowAgentCount} prompt overflows`);
    },
  });

  function buildPayload(): CreateTeamResource {
    const fallbackName = name.trim() || (type === "repo" || type === "mcp" ? url.trim() : "Team resource");
    if (type === "repo") {
      return { type, name: fallbackName, defaultEnabled, payload: { url: url.trim() } };
    }
    if (type === "prompt") {
      return {
        type,
        name: fallbackName,
        defaultEnabled,
        payload: { body, ...(description.trim() ? { description: description.trim() } : {}) },
      };
    }
    if (type === "skill") {
      return {
        type,
        name: fallbackName,
        defaultEnabled,
        payload: {
          name: fallbackName,
          description: description.trim() || fallbackName,
          body,
          metadata: {},
        },
      };
    }
    return transport === "stdio"
      ? {
          type,
          name: fallbackName,
          defaultEnabled,
          payload: { name: fallbackName, transport, command: command.trim() },
        }
      : { type, name: fallbackName, defaultEnabled, payload: { name: fallbackName, transport, url: url.trim() } };
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    createMut.mutate(buildPayload());
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create resource</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="resource-type">Type</Label>
              <select
                id="resource-type"
                className="h-9 w-full rounded border bg-background px-2"
                value={type}
                onChange={(e) => setType(e.target.value as ResourceType)}
              >
                {RESOURCE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {typeLabel(t)}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="resource-default">Default</Label>
              <select
                id="resource-default"
                className="h-9 w-full rounded border bg-background px-2"
                value={defaultEnabled}
                onChange={(e) => setDefaultEnabled(e.target.value as "recommended" | "available")}
              >
                <option value="available">Available</option>
                <option value="recommended">Recommended</option>
              </select>
            </div>
          </div>
          <Field id="resource-name" label="Name" value={name} onChange={setName} placeholder="Resource name" />
          {type === "mcp" && transport !== "stdio" ? (
            <Field
              id="resource-url"
              label="URL"
              value={url}
              onChange={setUrl}
              placeholder="https://github.com/org/repo.git"
              mono
            />
          ) : null}
          {type === "repo" ? (
            <Field
              id="repo-url"
              label="Repository URL"
              value={url}
              onChange={setUrl}
              placeholder="git@github.com:org/repo.git"
              mono
            />
          ) : null}
          {type === "mcp" ? (
            <>
              <div className="space-y-2">
                <Label htmlFor="mcp-transport">Transport</Label>
                <select
                  id="mcp-transport"
                  className="h-9 w-full rounded border bg-background px-2"
                  value={transport}
                  onChange={(e) => setTransport(e.target.value as "stdio" | "http" | "sse")}
                >
                  <option value="stdio">stdio</option>
                  <option value="http">http</option>
                  <option value="sse">sse</option>
                </select>
              </div>
              {transport === "stdio" ? (
                <Field id="mcp-command" label="Command" value={command} onChange={setCommand} placeholder="npx" mono />
              ) : null}
            </>
          ) : null}
          {(type === "prompt" || type === "skill") && (
            <>
              <Field
                id="resource-description"
                label="Description"
                value={description}
                onChange={setDescription}
                placeholder="Short description"
              />
              <div className="space-y-2">
                <Label htmlFor="resource-body">Body</Label>
                <textarea
                  id="resource-body"
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  className="min-h-32 w-full rounded border bg-background p-2 text-body"
                />
              </div>
            </>
          )}
          {impact ? (
            <p className="text-caption" style={{ color: "var(--fg-3)" }}>
              {impact}
            </p>
          ) : null}
          {error ? (
            <p className="text-body" style={{ color: "var(--state-error)" }}>
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => props.onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => previewMut.mutate({ type, defaultEnabled, payload: buildPayload().payload })}
            >
              Preview
            </Button>
            <Button type="submit" disabled={createMut.isPending}>
              Create
            </Button>
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

function typeLabel(type: ResourceType): string {
  if (type === "repo") return "Repos";
  if (type === "prompt") return "Prompts";
  if (type === "skill") return "Skills";
  return "MCP";
}
