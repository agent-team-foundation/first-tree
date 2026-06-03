import type { CreateTeamResource, ResourceRow, ResourceType } from "@first-tree/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { type FormEvent, type ReactNode, useMemo, useState } from "react";
import {
  createTeamResource,
  listTeamResources,
  previewOrgResourceImpact,
  retireResource,
} from "../../api/resources.js";
import { useAuth } from "../../auth/auth-context.js";
import { Badge } from "../../components/ui/badge.js";
import { Button } from "../../components/ui/button.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { Input } from "../../components/ui/input.js";
import { Label } from "../../components/ui/label.js";
import { PageHeader } from "../../components/ui/page-header.js";
import { Section } from "../../components/ui/section.js";
import { Select, type SelectOption } from "../../components/ui/select.js";
import { Textarea } from "../../components/ui/textarea.js";

const RESOURCE_TYPES: ResourceType[] = ["repo", "prompt", "skill", "mcp"];
const DEFAULT_MODES = ["available", "recommended"] as const;
const TRANSPORTS = ["stdio", "http", "sse"] as const;
type DefaultMode = (typeof DEFAULT_MODES)[number];
type Transport = (typeof TRANSPORTS)[number];

// Narrow a raw Select value back to its union without an `as` assertion: the
// control can only emit one of the provided option values, so the fallback is
// never hit at runtime — it just keeps the return type honest.
const asResourceType = (v: string): ResourceType => RESOURCE_TYPES.find((t) => t === v) ?? "repo";
const asDefaultMode = (v: string): DefaultMode => DEFAULT_MODES.find((d) => d === v) ?? "available";
const asTransport = (v: string): Transport => TRANSPORTS.find((t) => t === v) ?? "stdio";

const TYPE_OPTIONS: SelectOption[] = RESOURCE_TYPES.map((t) => ({ value: t, label: typeLabelSingular(t) }));
const DEFAULT_OPTIONS: SelectOption[] = [
  { value: "available", label: "Available", hint: "Agents opt in" },
  { value: "recommended", label: "Recommended", hint: "On by default" },
];
const TRANSPORT_OPTIONS: SelectOption[] = TRANSPORTS.map((t) => ({ value: t, label: t }));

/**
 * Settings → Resources. Org-scoped runtime resources (repo / prompt / skill /
 * mcp) the team's agents consume. Lives under Settings (an org-admin config
 * surface), not on the Team roster — see the Settings IA in settings.tsx.
 *
 * Visible to all members (read-only); only admins see create / retire
 * affordances. The chrome (PageHeader + padded wrapper) matches the sibling
 * Settings pages so it slots cleanly into the master-detail layout.
 */
export function SettingsResourcesPage() {
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
    <>
      <PageHeader
        title="Resources"
        subtitle="Team defaults and available resources used by agents at runtime."
        right={
          isAdmin ? (
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" /> Resource
            </Button>
          ) : null
        }
      />
      <div className="flex flex-col" style={{ gap: "var(--sp-5)", padding: "var(--sp-2) var(--sp-5) var(--sp-7)" }}>
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
      </div>
      <CreateResourceDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => {
          setCreateOpen(false);
          queryClient.invalidateQueries({ queryKey: ["team-resources"] });
        }}
      />
    </>
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
          <Badge variant={props.resource.defaultEnabled === "recommended" ? "secondary" : "outline"}>
            {props.resource.defaultEnabled}
          </Badge>
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
            <SelectField id="resource-type" label="Type">
              <Select
                id="resource-type"
                aria-label="Resource type"
                value={type}
                onChange={(v) => setType(asResourceType(v))}
                options={TYPE_OPTIONS}
              />
            </SelectField>
            <SelectField id="resource-default" label="Default">
              <Select
                id="resource-default"
                aria-label="Default mode"
                value={defaultEnabled}
                onChange={(v) => setDefaultEnabled(asDefaultMode(v))}
                options={DEFAULT_OPTIONS}
              />
            </SelectField>
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
              <SelectField id="mcp-transport" label="Transport">
                <Select
                  id="mcp-transport"
                  aria-label="MCP transport"
                  value={transport}
                  onChange={(v) => setTransport(asTransport(v))}
                  options={TRANSPORT_OPTIONS}
                  mono
                />
              </SelectField>
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
                <Textarea
                  id="resource-body"
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  className="min-h-32 resize-y"
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

/** Label + control wrapper for the design-system `Select` (mirrors `Field`). */
function SelectField(props: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <Label htmlFor={props.id}>{props.label}</Label>
      {props.children}
    </div>
  );
}

/** Plural for the list section headers (a group of resources). */
function typeLabel(type: ResourceType): string {
  if (type === "repo") return "Repos";
  if (type === "prompt") return "Prompts";
  if (type === "skill") return "Skills";
  return "MCP";
}

/** Singular for the create-dialog type picker (choosing one resource). */
function typeLabelSingular(type: ResourceType): string {
  if (type === "repo") return "Repo";
  if (type === "prompt") return "Prompt";
  if (type === "skill") return "Skill";
  return "MCP";
}
