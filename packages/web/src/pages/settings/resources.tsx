import type { ResourceRow, ResourceType } from "@first-tree/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { listTeamResources, retireResource } from "../../api/resources.js";
import { useAuth } from "../../auth/auth-context.js";
import { Badge } from "../../components/ui/badge.js";
import { Button } from "../../components/ui/button.js";
import { PageHeader } from "../../components/ui/page-header.js";
import { Section } from "../../components/ui/section.js";
import {
  AddResourceMenu,
  type EditorState,
  RESOURCE_TYPES,
  ResourceEditor,
  typeLabelPlural,
} from "./resource-editors.js";

/**
 * Settings → Resources. Org-scoped runtime resources (repo / prompt / skill /
 * mcp) the team's agents consume. Lives under Settings (an org-admin config
 * surface), not on the Team roster — see the Settings IA in settings.tsx.
 *
 * Visible to all members (read-only); only admins see add / edit / retire
 * affordances. Adding is type-first: one "Add resource" menu picks the type,
 * then a per-type editor opens (repo/mcp in a modal, prompt/skill in a side
 * sheet — see resource-editors.tsx). The same editors handle edit, prefilled.
 */
export function SettingsResourcesPage() {
  const { role } = useAuth();
  const isAdmin = role === "admin";
  const queryClient = useQueryClient();
  const [editor, setEditor] = useState<EditorState | null>(null);
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
                      retiring={retireMut.isPending}
                      onEdit={() => setEditor({ mode: "edit", type: resource.type, resource })}
                      onRetire={() => retireMut.mutate(resource.id)}
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
    </>
  );
}

function ResourceListRow(props: {
  resource: ResourceRow;
  canEdit: boolean;
  retiring: boolean;
  onEdit: () => void;
  onRetire: () => void;
}) {
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
      className="group flex items-center gap-3"
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
        <div className="flex items-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
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
            disabled={props.retiring}
            onClick={props.onRetire}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ) : null}
    </div>
  );
}
