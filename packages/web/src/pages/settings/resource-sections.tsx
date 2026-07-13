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
import { Section } from "../../components/ui/section.js";
import { useToast } from "../../components/ui/toast.js";
import { stripInlineMarkdown } from "../../lib/strip-inline-markdown.js";
import {
  AddResourceButton,
  defaultEnabledLabel,
  type EditorState,
  ResourceEditor,
  typeLabelPlural,
} from "./resource-editors.js";
import { ResourcePreviewDialog } from "./resource-preview-dialog.js";

/**
 * Section list for a subset of the team's runtime resource types, extracted
 * from the Settings → Resources page so a type can live on a different
 * Settings page without duplicating the list/editor/retire machinery — the
 * `repo` type renders on Settings → GitHub as "Source Repos", next to the
 * GitHub App connection those repos flow through.
 *
 * Behaviour matches the Resources page: everyone can open the read-only
 * preview (the eye icon); only admins see add / edit / retire affordances.
 * Each section owns its own add control — a "+ <Type>" button that opens
 * that type's editor directly. All editors render in a modal
 * (resource-editors.tsx) and double as the edit form, prefilled.
 *
 * The team-resources query is shared by key across instances, so pages
 * rendering different subsets don't duplicate fetches.
 */
export function ResourceTypeSections({
  types,
  titleFor,
}: {
  types: readonly ResourceType[];
  /** Override a section's heading; defaults to the type's plural label. */
  titleFor?: (type: ResourceType) => string;
}) {
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
    onError: (e) => {
      // Surface the failure instead of silently re-enabling the dialog; the
      // dialog stays open so the user can retry or cancel.
      addToast({ title: "Couldn't retire resource", description: e instanceof Error ? e.message : String(e) });
    },
  });

  const grouped = useMemo(() => {
    const map = new Map<ResourceType, ResourceRow[]>();
    for (const type of types) map.set(type, []);
    for (const resource of resourcesQuery.data ?? []) {
      map.get(resource.type)?.push(resource);
    }
    return map;
  }, [resourcesQuery.data, types]);

  return (
    <>
      {resourcesQuery.isLoading ? (
        <p className="text-body" style={{ color: "var(--fg-3)" }}>
          Loading…
        </p>
      ) : resourcesQuery.error ? (
        <p className="text-body" style={{ color: "var(--state-error)" }}>
          {resourcesQuery.error instanceof Error ? resourcesQuery.error.message : "Failed to load resources"}
        </p>
      ) : (
        types.map((type) => {
          // When the host overrides a section's title (e.g. GitHub renders the
          // `repo` type as "Source repos"), derive the empty-state and add-button
          // nouns from that title so they read as one surface — instead of the
          // per-type default ("repos" / "Repo") leaking through. Plural comes
          // straight from the (already-plural) title; the add label strips a
          // trailing "s" for a singular.
          const overrideTitle = titleFor?.(type);
          const pluralNoun = overrideTitle ? overrideTitle.toLowerCase() : typeLabelPlural(type).toLowerCase();
          const addLabel = overrideTitle ? `Add ${overrideTitle.toLowerCase().replace(/s$/, "")}` : undefined;
          return (
            <Section
              key={type}
              title={overrideTitle ?? typeLabelPlural(type)}
              count={grouped.get(type)?.length ?? 0}
              action={
                isAdmin ? (
                  <AddResourceButton type={type} label={addLabel} onClick={() => setEditor({ mode: "create", type })} />
                ) : undefined
              }
            >
              <div>
                {(grouped.get(type) ?? []).length === 0 ? (
                  <p className="text-body" style={{ color: "var(--fg-4)", padding: "var(--sp-3) 0", margin: 0 }}>
                    No {pluralNoun} configured yet.
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
          );
        })
      )}
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
            {defaultEnabledLabel(props.resource.defaultEnabled)}
          </Badge>
        </div>
        {detail ? (
          <p
            className="m-0 text-caption truncate"
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
  // Destructive action: never confirm against a stale count. `gcTime: 0` drops
  // the cache when the dialog closes, so each open re-fetches fresh rather than
  // reusing a prior result; the confirm button + copy then gate on `isFetching`
  // (not just `isPending`) so an in-flight (re)fetch keeps it blocked.
  const impactQuery = useQuery({
    queryKey: ["resource-impact", props.resource.id],
    queryFn: () => previewResourceImpact(props.resource.id),
    gcTime: 0,
    staleTime: 0,
  });
  const checking = impactQuery.isFetching;
  const count = impactQuery.data?.affectedAgentCount;
  const impactLine = checking
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
              can't retire before seeing how many agents it affects. `isFetching`
              (not just `isPending`) also blocks a background refetch on reopen,
              so a cached stale count is never confirmable; it clears on both
              success and error, so a failed check never locks the button. */}
          <Button type="button" variant="destructive" onClick={props.onConfirm} disabled={props.retiring || checking}>
            {props.retiring ? "Retiring…" : "Retire"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
