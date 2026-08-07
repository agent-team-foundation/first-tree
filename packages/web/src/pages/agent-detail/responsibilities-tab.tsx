import { useQuery } from "@tanstack/react-query";
import { Navigate } from "react-router";
import { listAgentTemplates } from "../../api/agent-templates.js";
import { useAgentResources } from "./capability-section.js";
import { useAgentDetailContext } from "./layout-context.js";
import { ResponsibilitiesSection } from "./responsibilities-section.js";
import { responsibilitiesSideFromQuery, shouldShowResponsibilitiesTab } from "./tabs.js";

export function ResponsibilitiesTab() {
  const ctx = useAgentDetailContext();
  const resources = useAgentResources(ctx.uuid, { enabled: !!ctx.uuid && !ctx.isHuman, refetchOnMount: false });
  // Same catalog key as the Agent Detail shell / edit dialog — hide this route
  // when the public catalog and this agent's adopted templateIds are both empty.
  const catalogQuery = useQuery({
    queryKey: ["agent-templates-catalog"],
    queryFn: listAgentTemplates,
    enabled: !!ctx.uuid && !ctx.isHuman,
    retry: 1,
    refetchOnMount: false,
  });

  const showResponsibilities = shouldShowResponsibilitiesTab(ctx.isHuman, {
    catalog: responsibilitiesSideFromQuery({
      count: catalogQuery.data ? catalogQuery.data.templates.length : null,
      isFetching: catalogQuery.isFetching,
      isError: catalogQuery.isError,
    }),
    agentResources: responsibilitiesSideFromQuery({
      count: resources.data ? resources.data.templateIds.length : null,
      isFetching: resources.isFetching,
      isError: resources.isError,
    }),
  });

  if (ctx.isHuman || !showResponsibilities) return <Navigate to="../profile" replace />;
  if (resources.isLoading) {
    return (
      <p className="text-body" style={{ color: "var(--fg-3)" }}>
        Loading responsibilities…
      </p>
    );
  }
  if (resources.error || !resources.data) {
    return (
      <p className="text-body" style={{ color: "var(--state-error)" }}>
        {resources.error instanceof Error ? resources.error.message : "Failed to load responsibilities"}
      </p>
    );
  }

  return (
    <ResponsibilitiesSection
      agentUuid={ctx.agent.uuid}
      agentStatus={ctx.agent.status}
      canManage={ctx.canEditConfig}
      templateIds={resources.data.templateIds}
      adoptedTemplates={resources.data.adoptedTemplates}
      version={resources.data.version}
    />
  );
}
