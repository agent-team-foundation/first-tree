import type {
  AgentTemplateAdoptionSummary,
  AgentTemplatePublicProfile,
  AgentTemplatePublicTemplate,
} from "@first-tree/shared";
import type { ReactElement } from "react";
import { DenseBadge } from "./ui/dense-badge.js";

export type TemplateResponsibilityLabelData = {
  name: string | null;
  status: AgentTemplateAdoptionSummary["status"];
  public: AgentTemplatePublicProfile | null;
  replacement: { name: string } | null;
};

/**
 * New Agent reads the active-only public catalog, while Agent Detail may also
 * receive retired or missing adoption summaries. Normalize the catalog shape
 * explicitly at this boundary so the presentational label stays shared without
 * weakening either surface's lifecycle contract.
 */
export function activeTemplateResponsibilityLabel(
  template: AgentTemplatePublicTemplate,
): TemplateResponsibilityLabelData {
  return {
    name: template.name,
    status: "active",
    public: template.public,
    replacement: null,
  };
}

/**
 * Compact, public-safe responsibility label shared by Agent Detail and agent
 * creation surfaces. It deliberately omits the catalog tagline and audience:
 * purpose, user value, and capability summary are the responsibility signal.
 */
export function TemplateResponsibilityLabel({
  template,
  variant = "catalog",
}: {
  template: TemplateResponsibilityLabelData;
  variant?: "catalog" | "assigned";
}): ReactElement {
  const isAssigned = variant === "assigned";
  return (
    <div className="flex-1 min-w-0 space-y-0.5" data-slot="template-responsibility-label">
      <div className="flex items-baseline gap-2 min-w-0">
        <span className="text-body font-medium truncate">{template.name ?? "Unavailable template"}</span>
        {(!isAssigned || template.status !== "active") && <TemplateStatusBadge status={template.status} />}
        {template.status === "retired" && template.replacement && (
          <span className="text-caption text-muted-foreground truncate">Try {template.replacement.name}</span>
        )}
      </div>
      {template.public && (
        <div className="text-caption text-muted-foreground">
          <div className="truncate">{template.public.purpose}</div>
          {!isAssigned && <div className="truncate">{template.public.userValue}</div>}
          {!isAssigned && <div className="truncate">{template.public.toolsAndSkillsSummary}</div>}
        </div>
      )}
    </div>
  );
}

function TemplateStatusBadge({ status }: { status: AgentTemplateAdoptionSummary["status"] }) {
  if (status === "active") return <DenseBadge>Active</DenseBadge>;
  if (status === "retired") return <DenseBadge>Retired</DenseBadge>;
  return <DenseBadge>Unavailable</DenseBadge>;
}
