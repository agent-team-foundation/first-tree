import type { ResourceType } from "@first-tree/shared";
import { ResourceTypeSection, useAgentResources } from "./capability-section.js";
import { useAgentDetailContext } from "./layout-context.js";

// The "Tools & skills" tab. Code repositories moved to the Environment tab
// (they're part of the workspace the agent runs in); prompts are managed in the
// Instructions tab. So this tab lists only skills and MCP integrations.
const RESOURCE_TYPES: ResourceType[] = ["skill", "mcp"];

export function ResourcesTab() {
  const ctx = useAgentDetailContext();
  const resources = useAgentResources(ctx.uuid, { enabled: !!ctx.uuid && !ctx.isHuman });

  if (ctx.isHuman) return null;
  if (resources.isLoading) {
    return (
      <p className="text-body" style={{ color: "var(--fg-3)" }}>
        Loading...
      </p>
    );
  }
  if (resources.error || !resources.data) {
    return (
      <p className="text-body" style={{ color: "var(--state-error)" }}>
        {resources.error instanceof Error ? resources.error.message : "Failed to load resources"}
      </p>
    );
  }

  const data = resources.data;
  const canEdit = ctx.canManageAgent && ctx.agent.status === "active";

  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-5)" }}>
      {RESOURCE_TYPES.map((type) => (
        <ResourceTypeSection
          key={type}
          type={type}
          data={data}
          canEdit={canEdit}
          pending={resources.pending}
          onMutate={resources.mutateBindings}
        />
      ))}
      {resources.saveError ? (
        <p className="text-body" style={{ color: "var(--state-error)" }}>
          {resources.saveError instanceof Error ? resources.saveError.message : "Failed to save resources"}
        </p>
      ) : null}
    </div>
  );
}
