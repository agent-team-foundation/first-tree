import type { ResourceType } from "@first-tree/shared";
import { useState } from "react";
import { Button } from "../../components/ui/button.js";
import { ResourceTypeSection, useAgentResources } from "./capability-section.js";
import { useAgentDetailContext } from "./layout-context.js";

// The "Tools & skills" section. Code repositories live in Repositories
// (they're part of the workspace the agent runs in); prompts are managed in the
// Instructions tab. So this tab lists only skills and MCP integrations.
const RESOURCE_TYPES: ResourceType[] = ["skill", "mcp"];

export function ResourcesTab() {
  const ctx = useAgentDetailContext();
  const resources = useAgentResources(ctx.uuid, { enabled: !!ctx.uuid && !ctx.isHuman, refetchOnMount: false });
  // Skill and MCP share one resource mutation/justSaved flag, so flash "Saved"
  // only on the section that was actually edited (tracked at click time).
  const [lastSavedType, setLastSavedType] = useState<ResourceType | null>(null);

  if (ctx.isHuman) return null;
  if (resources.isLoading) {
    return (
      <p className="text-body" style={{ color: "var(--fg-3)" }} role="status">
        Loading tools and skills…
      </p>
    );
  }
  if (resources.error || !resources.data) {
    return (
      <div className="flex flex-wrap items-center gap-2" role="alert">
        <p className="m-0 text-body" style={{ color: "var(--state-error)" }}>
          Couldn’t load tools and skills.
          {resources.error instanceof Error ? ` ${resources.error.message}` : ""}
        </p>
        <Button className="min-h-11" size="xs" variant="outline" onClick={resources.reload}>
          Retry
        </Button>
      </div>
    );
  }

  const data = resources.data;
  const canEdit = ctx.canManageAgent && ctx.agent.status === "active";
  const readOnlyReason =
    ctx.canManageAgent && ctx.agent.status === "suspended"
      ? ctx.agent.clientId
        ? "suspended"
        : "suspended-unbound"
      : "viewer";

  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-5)" }}>
      {RESOURCE_TYPES.map((type) => (
        <ResourceTypeSection
          key={type}
          type={type}
          data={data}
          canEdit={canEdit}
          readOnlyReason={readOnlyReason}
          pending={resources.pending || resources.reloading}
          saving={resources.pending && lastSavedType === type}
          onMutate={(bindings) => {
            setLastSavedType(type);
            resources.mutateBindings(bindings);
          }}
          saved={resources.justSaved && lastSavedType === type}
          onNavigateAway={ctx.navigateAway}
        />
      ))}
      {resources.saveError ? (
        <div className="flex flex-wrap items-center gap-2" role="alert">
          <p className="m-0 text-body" style={{ color: "var(--state-error)" }}>
            Couldn’t save changes. Reload the latest settings, then repeat your change.
            {resources.saveError instanceof Error ? ` ${resources.saveError.message}` : ""}
          </p>
          <Button
            className="min-h-11"
            size="xs"
            variant="outline"
            onClick={resources.reload}
            disabled={resources.pending || resources.reloading}
          >
            {resources.reloading ? "Reloading…" : "Reload latest"}
          </Button>
        </div>
      ) : null}
      {resources.reloadComplete ? (
        <p className="m-0 text-caption" style={{ color: "var(--fg-3)" }} role="status" aria-live="polite">
          Latest settings loaded. Repeat your change.
        </p>
      ) : null}
    </div>
  );
}
