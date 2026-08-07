import {
  AGENT_TEMPLATE_LIFECYCLE_ERROR_CODES,
  type AgentTemplateAdoptionSummary,
  type AgentTemplatePublicTemplate,
  MAX_AGENT_TEMPLATE_IDS,
} from "@first-tree/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { trackEvent } from "../../analytics.js";
import { listAgentTemplates, updateAgentTemplates } from "../../api/agent-templates.js";
import { ApiError } from "../../api/client.js";
import { TemplateResponsibilityLabel } from "../../components/template-responsibility-label.js";
import { Button } from "../../components/ui/button.js";
import { DenseBadge } from "../../components/ui/dense-badge.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog.js";
import { agentResourcesMutationHandlers } from "./capability-section.js";

/**
 * Responsibilities — the content of the dedicated Agent Detail tab. Shows
 * the agent's adopted official Templates (0-3) with public-safe
 * summaries only. Managers of an ACTIVE agent edit via the full replace-set
 * PATCH; everyone else sees the same card read-only. Saved changes apply
 * before the agent's next action — there is no current/next version display
 * by design.
 */
export type ResponsibilitiesSectionProps = {
  agentUuid: string;
  agentStatus: string;
  canManage: boolean;
  templateIds: string[];
  adoptedTemplates: AgentTemplateAdoptionSummary[];
  version: number;
};

export function ResponsibilitiesSection({
  agentUuid,
  agentStatus,
  canManage,
  templateIds,
  adoptedTemplates,
  version,
}: ResponsibilitiesSectionProps) {
  const [editorOpen, setEditorOpen] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  // A suspended agent keeps its history visible but is not editable.
  const canEdit = canManage && agentStatus === "active";

  const byId = useMemo(() => new Map(adoptedTemplates.map((summary) => [summary.id, summary])), [adoptedTemplates]);
  const ordered = templateIds.map((id) => byId.get(id) ?? missingSummary(id));

  return (
    <div className="space-y-3">
      {(savedFlash || canEdit) && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {savedFlash && (
            <span role="status" aria-live="polite">
              <DenseBadge>Saved. It will apply before this agent&apos;s next action.</DenseBadge>
            </span>
          )}
          {canEdit && (
            <Button type="button" variant="outline" size="sm" onClick={() => setEditorOpen(true)}>
              {ordered.length === 0 ? "Add responsibility" : "Edit responsibilities"}
            </Button>
          )}
        </div>
      )}

      <div style={{ borderTop: "var(--hairline) solid var(--border)" }}>
        {ordered.length === 0 ? (
          <p className="text-caption text-muted-foreground py-4">No starting responsibilities yet.</p>
        ) : (
          <ul className="m-0 list-none p-0">
            {ordered.map((summary) => (
              <li
                key={summary.id}
                className="py-3"
                style={{ borderBottom: "var(--hairline) solid var(--border-faint)" }}
              >
                <TemplateResponsibilityLabel template={summary} variant="assigned" />
              </li>
            ))}
          </ul>
        )}
      </div>

      {canEdit && (
        <ResponsibilitiesEditor
          open={editorOpen}
          onOpenChange={setEditorOpen}
          agentUuid={agentUuid}
          templateIds={templateIds}
          adoptedTemplates={adoptedTemplates}
          version={version}
          onSaved={() => {
            setSavedFlash(true);
            window.setTimeout(() => setSavedFlash(false), 4_000);
          }}
        />
      )}
    </div>
  );
}

function missingSummary(id: string): AgentTemplateAdoptionSummary {
  return { id, status: "missing", slug: null, name: null, public: null, replacement: null };
}

function TemplateStatusBadge({ status }: { status: AgentTemplateAdoptionSummary["status"] }) {
  if (status === "active") return <DenseBadge>Active</DenseBadge>;
  if (status === "retired") return <DenseBadge>Retired</DenseBadge>;
  return <DenseBadge>Unavailable</DenseBadge>;
}

const VERSION_CAS_FEEDBACK =
  "This agent changed elsewhere. Its responsibilities were refreshed — review and save again.";

function ResponsibilitiesEditor({
  open,
  onOpenChange,
  agentUuid,
  templateIds,
  adoptedTemplates,
  version,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentUuid: string;
  templateIds: string[];
  adoptedTemplates: AgentTemplateAdoptionSummary[];
  version: number;
  onSaved: () => void;
}) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string[]>(templateIds);
  const [feedback, setFeedback] = useState<string | null>(null);

  // Seed discipline in one effect: a fresh open reseeds the draft AND clears
  // feedback; a server-set change while open (e.g. the 409 refetch) reseeds
  // the draft but keeps the "review and save again" feedback visible.
  const prevOpenRef = useRef(false);
  useEffect(() => {
    const openedNow = open && !prevOpenRef.current;
    prevOpenRef.current = open;
    if (!open) return;
    setSelected(templateIds);
    if (openedNow) setFeedback(null);
  }, [open, templateIds]);

  const catalogQuery = useQuery({
    queryKey: ["agent-templates-catalog"],
    queryFn: listAgentTemplates,
    enabled: open,
    retry: 1,
  });

  const summaryById = useMemo(
    () => new Map(adoptedTemplates.map((summary) => [summary.id, summary])),
    [adoptedTemplates],
  );
  const addable = useMemo(() => {
    const catalog = catalogQuery.data?.templates ?? [];
    return catalog.filter((template) => template.status === "active" && !selected.includes(template.id));
  }, [catalogQuery.data, selected]);

  const saveMut = useMutation({
    mutationFn: (nextIds: string[]) =>
      updateAgentTemplates(agentUuid, { expectedVersion: version, templateIds: nextIds }),
    ...agentResourcesMutationHandlers(queryClient, agentUuid, {
      onSuccessAfter: () => {
        trackEvent("agent_template_replace_set", { result: "success" });
        setFeedback(null);
        onOpenChange(false);
        onSaved();
      },
    }),
    onError: (error) => {
      trackEvent("agent_template_replace_set", { result: "failure" });
      // Only a real version-CAS conflict refreshes the draft. Adoption /
      // inactive 409s keep the user's selection and surface the server message.
      if (
        error instanceof ApiError &&
        error.status === 409 &&
        error.code === AGENT_TEMPLATE_LIFECYCLE_ERROR_CODES.VERSION_CONFLICT
      ) {
        queryClient.invalidateQueries({ queryKey: ["agent-resources", agentUuid] });
        setFeedback(VERSION_CAS_FEEDBACK);
        return;
      }
      setFeedback(error instanceof Error ? error.message : "Failed to save responsibilities");
    },
  });

  function toggleId(template: { id: string; slug?: string | null }): void {
    // Changing the draft clears a prior non-CAS conflict so the user can
    // correct the set and retry without a stale actionable message.
    if (feedback && feedback !== VERSION_CAS_FEEDBACK) {
      setFeedback(null);
    }
    if (selected.includes(template.id)) {
      setSelected((prev) => prev.filter((id) => id !== template.id));
      trackEvent("agent_template_select", {
        surface: "agent_detail",
        action: "remove",
        slug: template.slug ?? undefined,
      });
      return;
    }
    if (selected.length >= MAX_AGENT_TEMPLATE_IDS) return;
    setSelected((prev) => [...prev, template.id]);
    trackEvent("agent_template_select", { surface: "agent_detail", action: "add", slug: template.slug ?? undefined });
  }

  const unchanged = selected.length === templateIds.length && selected.every((id, index) => id === templateIds[index]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[calc(100vh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit responsibilities</DialogTitle>
          <DialogDescription>
            Choose up to 3 Agent Templates. Changes update the template-created instructions and capabilities for this
            agent.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            {selected.length === 0 && (
              <p className="text-caption text-muted-foreground">No responsibilities selected.</p>
            )}
            {selected.map((id) => {
              const summary = summaryById.get(id) ?? missingSummary(id);
              return (
                <div key={id} className="flex items-center justify-between gap-2">
                  <div className="flex items-baseline gap-2 min-w-0">
                    <span className="text-body truncate">{summary.name ?? "Unavailable template"}</span>
                    <TemplateStatusBadge status={summary.status} />
                  </div>
                  <Button type="button" variant="ghost" size="sm" onClick={() => toggleId(summary)}>
                    Remove
                  </Button>
                </div>
              );
            })}
          </div>
          {selected.length < MAX_AGENT_TEMPLATE_IDS && addable.length > 0 && (
            <div className="space-y-2">
              <p className="text-caption text-muted-foreground">Add a responsibility</p>
              {addable.map((template: AgentTemplatePublicTemplate) => (
                <div key={template.id} className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-body truncate">{template.name}</div>
                    <div className="text-caption text-muted-foreground truncate">{template.public.tagline}</div>
                  </div>
                  <Button type="button" variant="outline" size="sm" onClick={() => toggleId(template)}>
                    Add
                  </Button>
                </div>
              ))}
            </div>
          )}
          {catalogQuery.isError && (
            <div className="flex items-center justify-between gap-2">
              <p className="text-caption text-destructive">
                Couldn&apos;t load the template catalog. Removals still work.
              </p>
              <Button type="button" variant="outline" size="sm" onClick={() => void catalogQuery.refetch()}>
                Retry
              </Button>
            </div>
          )}
          {feedback && (
            <p className="text-caption text-destructive" role="alert">
              {feedback}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="cta"
            disabled={unchanged || saveMut.isPending}
            onClick={() => saveMut.mutate(selected)}
          >
            {saveMut.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
