import type { ResourceRow, ResourceType } from "@first-tree/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, Pencil, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { listTeamResources, previewResourceImpact, retireResource } from "../../api/resources.js";
import { useAuth } from "../../auth/auth-context.js";
import { Badge } from "../../components/ui/badge.js";
import { Button } from "../../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog.js";
import { PageHeader } from "../../components/ui/page-header.js";
import { Section } from "../../components/ui/section.js";
import { useToast } from "../../components/ui/toast.js";
import { stripInlineMarkdown } from "../../lib/strip-inline-markdown.js";
import {
  AddResourceMenu,
  type EditorState,
  RESOURCE_TYPES,
  ResourceEditor,
  typeLabelPlural,
} from "./resource-editors.js";
import { ResourcePreviewDialog } from "./resource-preview-dialog.js";

/**
 * Settings → Resources. Org-scoped runtime resources (repo / prompt / skill /
 * mcp) the team's agents consume. Lives under Settings (an org-admin config
 * surface), not on the Team roster — see the Settings IA in settings.tsx.
 *
 * Visible to all members. Everyone can open the read-only preview (the eye
 * icon); only admins see add / edit / retire affordances. Adding is type-first:
 * one "Add resource" menu picks the type, then a per-type editor opens (all
 * four render in a modal — see resource-editors.tsx). The same editors handle
 * edit, prefilled.
 */
export function SettingsResourcesPage() {
  const { role } = useAuth();
  const isAdmin = role === "admin";
  const queryClient = useQueryClient();
  const { addToast } = useToast();
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [preview, setPreview] = useState<ResourceRow | null>(null);
  const [retireTarget, setRetireTarget] = useState<ResourceRow | null>(null);
  const resourcesQuery = useQuery({ queryKey: ["team-resources"], queryFn: listTeamResources });
  const retireMut = useMutation({
    mutationFn: retireResource,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["team-resources"] });
      addToast({ title: `Retired "${retireTarget?.name ?? "resource"}"` });
      setRetireTarget(null);
    },
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
        right={isAdmin ? <AddResourceMenu onPick={(type) => setEditor({ mode: "create", type })} /> : undefined}
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
            <Section key={type} title={typeLabelPlural(type)} count={grouped.get(type)?.length ?? 0}>
              <div>
                {(grouped.get(type) ?? []).length === 0 ? (
                  <p className="text-body" style={{ color: "var(--fg-4)", padding: "var(--sp-3) 0", margin: 0 }}>
                    No {typeLabelPlural(type).toLowerCase()} configured.
                  </p>
                ) : (
                  (grouped.get(type) ?? []).map((resource) => (
                    <ResourceListRow
                      key={resource.id}
                      resource={resource}
                      canEdit={isAdmin}
                      onPreview={() => setPreview(resource)}
                      onEdit={() => setEditor({ mode: "edit", type: resource.type, resource })}
                      onRetire={() => setRetireTarget(resource)}
                    />
                  ))
                )}
              </div>
            </Section>
          ))
        )}
      </div>
      {editor ? (
        // Key by target so switching create-type / edit-target remounts the
        // editor with fresh field state (useState initializers run on mount).
        <ResourceEditor
          key={editor.mode === "edit" ? `edit-${editor.resource.id}` : `create-${editor.type}`}
          state={editor}
          onClose={() => setEditor(null)}
        />
      ) : null}
      {preview ? <ResourcePreviewDialog resource={preview} onClose={() => setPreview(null)} /> : null}
      {retireTarget ? (
        <RetireConfirmDialog
          resource={retireTarget}
          retiring={retireMut.isPending}
          onCancel={() => setRetireTarget(null)}
          onConfirm={() => retireMut.mutate(retireTarget.id)}
        />
      ) : null}
    </>
  );
}

/** One-line list summary. Prompt/skill prefer description, then a stripped body
 *  snippet — never the meaningless raw character count. */
function summarize(resource: ResourceRow): string {
  const payload = resource.payload;
  const read = (key: string): string => {
    if (payload && typeof payload === "object" && key in payload) {
      const v = (payload as Record<string, unknown>)[key];
      if (typeof v === "string") return v;
    }
    return "";
  };
  if (resource.type === "repo") return read("url");
  if (resource.type === "mcp") return read("url") || read("command");
  // prompt / skill
  const description = read("description");
  if (description) return description;
  const body = read("body");
  if (!body) return "";
  const snippet = stripInlineMarkdown(body.replace(/\s+/g, " ")).trim();
  return snippet.length > 140 ? `${snippet.slice(0, 140)}…` : snippet;
}

function ResourceListRow(props: {
  resource: ResourceRow;
  canEdit: boolean;
  onPreview: () => void;
  onEdit: () => void;
  onRetire: () => void;
}) {
  const detail = summarize(props.resource);
  return (
    <div
      className="group flex items-center gap-3"
      style={{ padding: "var(--sp-3) 0", borderBottom: "var(--hairline) solid var(--border-faint)" }}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="m-0 text-body font-medium truncate" style={{ color: "var(--fg)" }} title={props.resource.name}>
            {props.resource.name}
          </p>
          <Badge variant={props.resource.defaultEnabled === "recommended" ? "secondary" : "outline"}>
            {props.resource.defaultEnabled}
          </Badge>
        </div>
        {detail ? (
          <p
            className="m-0 text-caption truncate mono"
            style={{ color: "var(--fg-3)", marginTop: "var(--sp-0_5)" }}
            title={detail}
          >
            {detail}
          </p>
        ) : null}
      </div>
      {/* Row actions reveal on hover (pointer devices) and stay visible on
          coarse/touch pointers that have no hover state. Preview (eye) is
          available to every member; edit / retire are admin-only. The eye
          follows the same reveal behaviour as edit/retire for consistency. */}
      <div className="flex items-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-label={`Preview ${props.resource.name}`}
          onClick={props.onPreview}
        >
          <Eye className="h-4 w-4" />
        </Button>
        {props.canEdit ? (
          <>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              aria-label={`Edit ${props.resource.name}`}
              onClick={props.onEdit}
            >
              <Pencil className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              aria-label={`Retire ${props.resource.name}`}
              onClick={props.onRetire}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Retire confirmation. Retiring bumps every consuming agent's config version,
 * so we fetch the impact (how many agents) and show it before the user
 * commits — and require an explicit confirm rather than retiring on one click.
 */
function RetireConfirmDialog(props: {
  resource: ResourceRow;
  retiring: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const impactQuery = useQuery({
    queryKey: ["resource-impact", props.resource.id],
    queryFn: () => previewResourceImpact(props.resource.id),
  });
  const count = impactQuery.data?.affectedAgentCount;
  const impactLine = impactQuery.isLoading
    ? "Checking impact…"
    : count === undefined
      ? "This removes the resource from the team's runtime defaults."
      : count === 0
        ? "No agents currently use this resource."
        : `This will update ${count} agent${count === 1 ? "" : "s"} that use this resource.`;

  return (
    <Dialog open onOpenChange={(o) => (!o ? props.onCancel() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Retire "{props.resource.name}"?</DialogTitle>
        </DialogHeader>
        <DialogDescription style={{ color: "var(--fg-2)" }}>{impactLine}</DialogDescription>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={props.onCancel} disabled={props.retiring}>
            Cancel
          </Button>
          {/* Block the confirm until the impact check resolves, so the user
              can't retire before seeing how many agents it affects. `isPending`
              clears on both success and error — a failed soft-check never locks
              the button. */}
          <Button
            type="button"
            variant="destructive"
            onClick={props.onConfirm}
            disabled={props.retiring || impactQuery.isPending}
          >
            {props.retiring ? "Retiring…" : "Retire"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
