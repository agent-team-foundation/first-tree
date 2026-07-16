import {
  type AgentResourceBindingInput,
  type AgentResourcesOutput,
  deriveRepoLocalPath,
  type EffectiveResourceRow,
  formatRepoCoordinate,
  noSecretMcpServerSchema,
  type ResourceRow,
  type ResourceType,
  skillResourcePayloadSchema,
} from "@first-tree/shared";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, FolderGit2, Plug, Plus, Sparkles } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import { useNavigate } from "react-router";
import { getAgentResources, updateAgentResources } from "../../api/agent-resources.js";
import { ApiError } from "../../api/client.js";
import { Button } from "../../components/ui/button.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { Input } from "../../components/ui/input.js";
import { Label } from "../../components/ui/label.js";
import { Popover } from "../../components/ui/popover.js";
import { Section } from "../../components/ui/section.js";
import { normalizeRepoUrl } from "../../lib/normalize-repo-url.js";
import { typeLabelSingular } from "../settings/resource-editors.js";
import { ResourceRowView, type RowMenu, type RowStatusMarker, type RowToggle } from "./resource-row.js";
import { sourceLabel } from "./resource-source.js";
import { titleWithSemantics, useJustSaved } from "./save-semantics.js";

/**
 * Shared agent-resource (repo / skill / mcp) section, used by two tabs:
 *   - Tools & skills tab (`resources-tab.tsx`) renders the `skill` + `mcp` sections.
 *   - Environment tab (`runtime-tab.tsx`) renders the `repo` section.
 *
 * Both consume the SAME `["agent-resources", uuid]` React Query cache via
 * `useAgentResources`, so a mutation on one tab is reflected on the other with
 * no shell-level state lift. All resource bindings save IMMEDIATELY (optimistic,
 * version-checked) — they are NOT part of the SaveBar draft.
 */

export type AgentResourcesController = {
  data: AgentResourcesOutput | undefined;
  isLoading: boolean;
  error: unknown;
  /** Submit the full bindings array; saves immediately. */
  mutateBindings: (bindings: AgentResourceBindingInput[]) => void;
  pending: boolean;
  saveError: unknown;
  /** True for ~2.5s after a successful immediate save (drives the "Saved" tag). */
  justSaved: boolean;
};

/**
 * Shared success/error handlers for any mutation that writes the versioned
 * `["agent-resources", uuid]` cache (the shared resource hook AND the Instructions
 * tab's prompt-binding mutations). Centralized so every writer of this cache gets
 * the same two protections, now that the page shell, Environment, Tools & skills,
 * and Instructions all observe and write it:
 *  - onSuccess cancels any in-flight GET before writing, so a stale response can't
 *    resolve afterwards and clobber the version just written (which would desync
 *    rows/badges and 409 the next mutation);
 *  - onError refetches on a 409 so a retry uses the latest version instead of
 *    dead-ending on the same stale expectedVersion.
 */
export function agentResourcesMutationHandlers(
  queryClient: QueryClient,
  uuid: string,
  opts?: { onSuccessAfter?: () => void },
): { onSuccess: (next: AgentResourcesOutput) => Promise<void>; onError: (err: unknown) => void } {
  return {
    onSuccess: async (next) => {
      await queryClient.cancelQueries({ queryKey: ["agent-resources", uuid] });
      queryClient.setQueryData(["agent-resources", uuid], next);
      queryClient.invalidateQueries({ queryKey: ["agent-config", uuid] });
      opts?.onSuccessAfter?.();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409) {
        queryClient.invalidateQueries({ queryKey: ["agent-resources", uuid] });
      }
    },
  };
}

export function useAgentResources(uuid: string, opts: { enabled: boolean }): AgentResourcesController {
  const queryClient = useQueryClient();
  const { justSaved, markSaved } = useJustSaved();
  const resourcesQuery = useQuery({
    queryKey: ["agent-resources", uuid],
    queryFn: () => getAgentResources(uuid),
    enabled: opts.enabled,
  });
  const updateMut = useMutation({
    mutationFn: (bindings: AgentResourceBindingInput[]) => {
      if (!resourcesQuery.data) throw new Error("resources not loaded");
      return updateAgentResources(uuid, { expectedVersion: resourcesQuery.data.version, bindings });
    },
    ...agentResourcesMutationHandlers(queryClient, uuid, { onSuccessAfter: markSaved }),
  });
  return {
    data: resourcesQuery.data,
    isLoading: resourcesQuery.isLoading,
    error: resourcesQuery.error,
    mutateBindings: updateMut.mutate,
    pending: updateMut.isPending,
    saveError: updateMut.error,
    justSaved,
  };
}

/**
 * One resource type's section (Section header + rows + add menu). Self-contained
 * and presentational: it takes the loaded `data` and an `onMutate` callback, so
 * it renders identically in the live tabs and in the DEV preview gallery.
 */
export function ResourceTypeSection(props: {
  type: ResourceType;
  data: AgentResourcesOutput;
  canEdit: boolean;
  pending: boolean;
  onMutate: (bindings: AgentResourceBindingInput[]) => void;
  /** Flash a "Saved" tag after a successful immediate write (from useAgentResources). */
  saved?: boolean;
  /** Leave-guarded navigate for the "Manage in Settings" exit (omit in previews). */
  onNavigateAway?: (to: string) => void;
}) {
  const [repoOpen, setRepoOpen] = useState(false);
  const { type, data, canEdit, pending, onMutate, saved, onNavigateAway } = props;
  const currentBindings = data.bindings;
  const activeBindingIds = new Set(currentBindings.map((b) => b.resourceId).filter((id): id is string => !!id));
  // Opt-in team resources an agent can enable for itself. Repos are excluded:
  // team repos are always On by default now (no per-repo Opt-in), so they never
  // appear in the "Enable from team" list. skill / mcp still support opt-in.
  const enableable = data.availableTeamResources.filter(
    (resource) =>
      resource.type === type &&
      resource.defaultEnabled === "available" &&
      resource.type !== "repo" &&
      !activeBindingIds.has(resource.id),
  );
  const rows = data.effective[resourceBucket(type)];
  return (
    <Section
      title={titleWithSemantics(typeLabel(type), saved)}
      count={rows.length}
      action={
        canEdit ? (
          <AddCapabilityMenu
            type={type}
            enableable={enableable}
            pending={pending}
            onNavigateAway={onNavigateAway}
            onAddAgentRepo={() => setRepoOpen(true)}
            onEnable={(resource) =>
              onMutate([
                ...currentBindings,
                { type: resource.type, mode: "include", resourceId: resource.id, order: currentBindings.length + 1 },
              ])
            }
          />
        ) : null
      }
    >
      <div className="ad-tail-trim">
        {rows.length === 0 ? (
          <p className="text-body" style={{ color: "var(--fg-4)", padding: "var(--sp-3) 0", margin: 0 }}>
            No {emptyNoun(type)} yet.
          </p>
        ) : (
          rows.map((row) => (
            <EffectiveRow
              key={row.id}
              row={row}
              canEdit={canEdit}
              bindings={currentBindings}
              pending={pending}
              onRemoveBinding={(bindingId) => onMutate(currentBindings.filter((b) => b.id !== bindingId))}
              onDisable={(resourceId) =>
                onMutate([
                  // Drop any existing include/replace binding for this resource first —
                  // otherwise the resolver sees include + disable and it stays enabled.
                  ...currentBindings.filter((b) => b.resourceId !== resourceId && b.replacesResourceId !== resourceId),
                  { type: row.type, mode: "disable", resourceId, order: currentBindings.length + 1 },
                ])
              }
            />
          ))
        )}
      </div>
      {type === "repo" ? (
        <AgentRepoDialog
          open={repoOpen}
          onOpenChange={setRepoOpen}
          onSubmit={(repo) => {
            onMutate([
              ...currentBindings,
              { type: "repo", mode: "include", agentExtraRepo: repo, order: currentBindings.length + 1 },
            ]);
            setRepoOpen(false);
          }}
        />
      ) : null}
    </Section>
  );
}

/**
 * Per-section add control. One "+ <Type>" trigger opens a context menu:
 *   - repo: "Add agent repo" (a private, agent-scoped repo). Team repos are
 *     always On by default (no per-repo Opt-in), so there's no "enable from
 *     team" list for repos.
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
  /** Leave-guarded navigate for "Manage in Settings"; falls back to plain navigate. */
  onNavigateAway?: (to: string) => void;
}) {
  const navigate = useNavigate();
  // Team repos are managed in the provider-neutral code-access area on
  // Settings → Integrations; the other resource types stay on Settings →
  // Resources. The anchor makes this exit land on the shared section rather
  // than implying that Team code belongs to the active GitHub connection.
  const settingsPath = props.type === "repo" ? "/settings/integrations/github#code-access" : "/settings/resources";
  const settingsLabel = props.type === "repo" ? "Manage Team code access" : "Manage in Settings → Resources";
  const goToSettings = () => (props.onNavigateAway ?? navigate)(settingsPath);
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
              goToSettings();
              close();
            }}
          >
            {settingsLabel}
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
  const row = props.row;
  // Unavailable rows surface the failure reason as the subtitle; everything
  // else shows a type-appropriate detail. The subtitle never falls back to the
  // raw `source` enum (that used to duplicate the source under skills/MCP rows).
  const subtitle = row.mode === "unavailable" ? row.unavailableReason : rowSubtitle(row);
  const status = statusMarker(row.mode);
  const source = sourceLabel(row.source);
  const isTeamRecommended = row.source === "team_recommended";
  const canRemove = !!row.bindingId && props.bindings.some((b) => b.id === row.bindingId);
  // Mono only for technical detail (repo URL, MCP command). A skill description
  // and an "unavailable" failure reason are prose and stay in the sans body.
  const monoPeek = row.mode !== "unavailable" && (row.type === "repo" || row.type === "mcp");

  // Team-recommended resources get the on/off Switch (off = stays listed, greyed).
  // It reuses the existing disable-binding mutation: toggling off adds a disable
  // binding; toggling on removes it (the disabled row's bindingId IS that disable
  // binding). Unavailable team rows show the Switch disabled rather than hide it.
  const toggle: RowToggle | undefined =
    props.canEdit && isTeamRecommended && row.resourceId && row.mode !== "replaced"
      ? {
          checked: row.mode === "enabled",
          disabled: props.pending || row.mode === "unavailable",
          ariaLabel: `Enable ${row.name}`,
          onChange: (next) =>
            next ? props.onRemoveBinding(row.bindingId ?? "") : props.onDisable(row.resourceId ?? ""),
        }
      : undefined;

  // ⋯ Remove only for the present-or-removed sources (opt-in / agent-added). A
  // team-recommended resource is never "removed" — it belongs to the team set and
  // is toggled off instead — so it gets no ⋯ when there's nothing else to offer.
  const menu: RowMenu | undefined =
    props.canEdit && canRemove && !isTeamRecommended
      ? {
          ariaLabel: `More actions for ${row.name}`,
          actions: [
            {
              key: "remove",
              label: `Remove ${row.name}`,
              destructive: true,
              disabled: props.pending,
              onSelect: () => props.onRemoveBinding(row.bindingId ?? ""),
            },
          ],
        }
      : undefined;

  return (
    <ResourceRowView
      name={row.name}
      source={source}
      status={status}
      peek={subtitle}
      monoPeek={monoPeek}
      toggle={toggle}
      menu={menu}
      dimmed={row.mode === "disabled"}
      leadingIcon={resourceTypeIcon(row.type)}
    />
  );
}

/** Leading glyph per resource kind, so the four types read apart at a glance. */
export function resourceTypeIcon(type: ResourceType): ReactNode {
  if (type === "repo") return <FolderGit2 className="h-4 w-4" />;
  if (type === "skill") return <Sparkles className="h-4 w-4" />;
  if (type === "mcp") return <Plug className="h-4 w-4" />;
  return <FileText className="h-4 w-4" />;
}

function AgentRepoDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (repo: { url: string; name?: string; defaultBranch?: string }) => void;
}) {
  const [url, setUrl] = useState("");
  const [branch, setBranch] = useState("");
  const [error, setError] = useState<string | null>(null);
  function submit(e: FormEvent) {
    e.preventDefault();
    // Normalize common paste shapes, then derive the name — matching the Team
    // code-access editor. A repo has no user-meaningful name, so we don't ask
    // for one.
    const normalized = normalizeRepoUrl(url);
    if (!normalized) {
      setError("URL is required.");
      return;
    }
    props.onSubmit({
      url: normalized,
      name: deriveRepoLocalPath(normalized),
      ...(branch.trim() ? { defaultBranch: branch.trim() } : {}),
    });
    setUrl("");
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
            placeholder="https://git.example.com/org/repo.git"
            mono
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
  if (type === "repo") return "Repositories";
  if (type === "prompt") return "Prompts";
  if (type === "skill") return "Skills";
  return "Integrations (MCP)";
}

function emptyNoun(type: ResourceType): string {
  if (type === "repo") return "repositories";
  if (type === "prompt") return "prompts";
  if (type === "skill") return "skills";
  return "MCP integrations";
}

/** One-line, human subtitle per resource type. Never the raw `source` enum. */
function rowSubtitle(row: EffectiveResourceRow): string | null {
  if (row.type === "repo") {
    if (!row.repo?.url) return null;
    // Compact `owner/repo` coordinate; branch/mount path only when non-default.
    return formatRepoCoordinate(row.repo);
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
 * Status marker — a dense badge, rendered only for the two states a row can't
 * convey through its own controls: `Overridden` (a team resource replaced by a
 * custom one) and `Can't load` (a broken reference). The plain disabled state is
 * NOT a badge — it's the Switch in its off position plus a greyed (`dimmed`) row.
 */
export function statusMarker(mode: EffectiveResourceRow["mode"]): RowStatusMarker {
  if (mode === "replaced") return { label: "Overridden", tone: "neutral" };
  if (mode === "unavailable") return { label: "Can't load", tone: "error" };
  return null;
}
