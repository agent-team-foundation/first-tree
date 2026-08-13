import { AGENT_TEMPLATE_LIFECYCLE_ERROR_CODES, type AgentTemplateAdoptionSummary } from "@first-tree/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Fragment, useMemo, useState } from "react";
import { Link } from "react-router";
import { trackEvent } from "../../analytics.js";
import { updateAgentTemplates } from "../../api/agent-templates.js";
import { ApiError } from "../../api/client.js";
import { Button } from "../../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog.js";
import { RowActionsMenu } from "../../components/ui/row-actions-menu.js";
import { agentResourcesMutationHandlers } from "./capability-section.js";

/**
 * One-line Template provenance inside Profile identity. The source names link
 * to their public Template pages; the compact overflow preserves the existing
 * remove-binding action without restoring a dedicated management section.
 */
export type TemplateProvenanceProps = {
  agentUuid: string;
  agentStatus: string;
  canManage: boolean;
  templateIds: string[];
  adoptedTemplates: AgentTemplateAdoptionSummary[];
  version: number;
};

const VERSION_CAS_FEEDBACK =
  "This agent changed elsewhere. Its template sources were refreshed — review and remove again.";

export function TemplateProvenance({
  agentUuid,
  agentStatus,
  canManage,
  templateIds,
  adoptedTemplates,
  version,
}: TemplateProvenanceProps) {
  const queryClient = useQueryClient();
  const [removeTarget, setRemoveTarget] = useState<AgentTemplateAdoptionSummary | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const canEdit = canManage && agentStatus === "active";
  const closeRemoveDialog = () => {
    setRemoveTarget(null);
    setFeedback(null);
  };

  const ordered = useMemo(() => {
    const byId = new Map(adoptedTemplates.map((summary) => [summary.id, summary]));
    return templateIds.map((id) => byId.get(id) ?? missingSummary(id)).sort(compareResponsibilitySummaries);
  }, [adoptedTemplates, templateIds]);

  const mutationHandlers = agentResourcesMutationHandlers(queryClient, agentUuid);
  const removeMutation = useMutation({
    mutationFn: (target: AgentTemplateAdoptionSummary) =>
      updateAgentTemplates(agentUuid, {
        expectedVersion: version,
        templateIds: templateIds.filter((id) => id !== target.id),
      }),
    onSuccess: async (next) => {
      await mutationHandlers.onSuccess(next);
      trackEvent("agent_template_replace_set", { result: "success" });
      closeRemoveDialog();
    },
    onError: (error) => {
      mutationHandlers.onError(error);
      trackEvent("agent_template_replace_set", { result: "failure" });
      if (
        error instanceof ApiError &&
        error.status === 409 &&
        error.code === AGENT_TEMPLATE_LIFECYCLE_ERROR_CODES.VERSION_CONFLICT
      ) {
        setFeedback(VERSION_CAS_FEEDBACK);
        return;
      }
      setFeedback(error instanceof Error ? error.message : "Failed to remove template source");
    },
  });

  if (ordered.length === 0) return null;

  const targetName = removeTarget ? sourceLabel(removeTarget) : "this template source";

  return (
    <>
      <span className="inline-flex min-w-0 max-w-full items-center gap-1" data-slot="template-provenance">
        <span className="min-w-0 truncate">
          {ordered.map((summary, index) => (
            <Fragment key={summary.id}>
              {sourceSeparator(index, ordered.length)}
              {summary.slug ? (
                <Link to={`/templates/${summary.slug}`} className="text-primary underline underline-offset-2">
                  {sourceLabel(summary)}
                </Link>
              ) : (
                <span style={{ color: "var(--fg-3)" }}>{sourceLabel(summary)}</span>
              )}
            </Fragment>
          ))}
        </span>
        {canEdit ? (
          <RowActionsMenu
            ariaLabel="Manage template sources"
            touchTarget
            actions={ordered.map((summary) => ({
              key: summary.id,
              label: summary.name ? `Remove ${sourceLabel(summary)}` : `Remove unavailable template ${summary.id}`,
              destructive: true,
              onSelect: () => {
                setFeedback(null);
                setRemoveTarget(summary);
              },
            }))}
          />
        ) : null}
      </span>

      <Dialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open && !removeMutation.isPending) {
            closeRemoveDialog();
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove template source?</DialogTitle>
            <DialogDescription>
              Only this agent’s bindings imported from {targetName} will be removed. Team Resources will remain
              available.
            </DialogDescription>
          </DialogHeader>
          {feedback ? (
            <p className="text-body text-destructive" role="alert">
              {feedback}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={removeMutation.isPending} onClick={closeRemoveDialog}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={!removeTarget || removeMutation.isPending}
              onClick={() => {
                if (removeTarget) removeMutation.mutate(removeTarget);
              }}
            >
              {removeMutation.isPending ? "Removing…" : "Remove source"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function sourceLabel(summary: AgentTemplateAdoptionSummary): string {
  return summary.name ? `${summary.name} template` : "an unavailable template";
}

function sourceSeparator(index: number, total: number): string {
  if (index === 0) return "";
  if (index === total - 1) return total === 2 ? " and " : ", and ";
  return ", ";
}

function compareResponsibilitySummaries(
  left: AgentTemplateAdoptionSummary,
  right: AgentTemplateAdoptionSummary,
): number {
  if (left.name === null && right.name !== null) return 1;
  if (left.name !== null && right.name === null) return -1;
  if (left.name !== null && right.name !== null) {
    const leftName = left.name.toLocaleLowerCase();
    const rightName = right.name.toLocaleLowerCase();
    if (leftName < rightName) return -1;
    if (leftName > rightName) return 1;
  }
  return left.id.localeCompare(right.id);
}

function missingSummary(id: string): AgentTemplateAdoptionSummary {
  return { id, status: "missing", slug: null, name: null, public: null, replacement: null };
}
