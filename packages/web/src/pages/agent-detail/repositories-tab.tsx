import { deriveRepoLocalPath, formatRepoCoordinate } from "@first-tree/shared";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Navigate } from "react-router";
import { getContextTreeSetting } from "../../api/org-settings.js";
import { useAuth } from "../../auth/auth-context.js";
import { Section } from "../../components/ui/section.js";
import { ResourceTypeSection, useAgentResources } from "./capability-section.js";
import { useAgentDetailContext } from "./layout-context.js";
import { ResourceRowView } from "./resource-row.js";

/**
 * Repositories tab — the agent's code + the team's shared knowledge: editable
 * code repositories (cloned into the workspace) and the read-only org context
 * tree. Both are "workspace content" the agent reads, which is why they sit
 * together. Repos save immediately via the agent-resources API.
 *
 * Editor-only, like the old Environment tab that previously hosted these: repos
 * and the context tree were never visible to non-editors, and still aren't.
 */
export function RepositoriesTab() {
  const ctx = useAgentDetailContext();
  // Gate on canEditConfig (not just !isHuman): non-editors hit the redirect
  // below, so there's no point firing an agent-resources GET for them.
  const repos = useAgentResources(ctx.uuid, { enabled: !!ctx.uuid && ctx.canEditConfig });
  const canEditResources = ctx.canManageAgent && ctx.agent.status === "active";
  if (!ctx.canEditConfig) return <Navigate to="../profile" replace />;

  return (
    <>
      {/* Code repositories — cloned into the session workspace; saved immediately
          on add/remove via the agent-resources API. The shared
          `["agent-resources", uuid]` cache keeps this in sync with Tools & skills. */}
      <div>
        {repos.isLoading ? (
          <div className="text-body" style={{ color: "var(--fg-3)" }}>
            Loading repositories…
          </div>
        ) : repos.error || !repos.data ? (
          <div className="text-body" style={{ color: "var(--state-error)" }}>
            {repos.error instanceof Error ? repos.error.message : "Failed to load repositories"}
          </div>
        ) : (
          <ResourceTypeSection
            type="repo"
            data={repos.data}
            canEdit={canEditResources}
            pending={repos.pending}
            onMutate={repos.mutateBindings}
            saved={repos.justSaved}
            onNavigateAway={ctx.navigateAway}
          />
        )}
        {repos.saveError ? (
          <p className="text-body" style={{ color: "var(--state-error)", margin: "var(--sp-2) 0 0" }}>
            {repos.saveError instanceof Error ? repos.saveError.message : "Failed to save repositories"}
          </p>
        ) : null}
      </div>

      {/* Context tree — read-only, org-level. Injected into the workspace at
          startup, so it's shown here for visibility, but it's configured by an
          admin in Settings (never per-agent), so the row has no actions. */}
      <div style={{ marginTop: "var(--sp-8)" }}>
        <ContextTreeRow />
      </div>
    </>
  );
}

/**
 * Read-only view of the org-level Context tree binding, rendered on the shared
 * `ResourceRow` so it reads identically to the repo/skill/MCP rows. The tree is
 * injected into every agent's workspace at startup (hence its presence here),
 * but it's an org-wide setting an admin configures in Settings — never
 * per-agent — so the row carries no actions and links nowhere.
 */
function ContextTreeRow(): ReactNode {
  const { organizationId } = useAuth();
  const query = useQuery({
    queryKey: ["org-context-tree", organizationId],
    queryFn: () => getContextTreeSetting(organizationId ?? ""),
    enabled: !!organizationId,
  });

  let row: ReactNode;
  if (!organizationId || query.isLoading) {
    row = <ResourceRowView name={null} source="" emptyPeek="Loading…" />;
  } else if (query.error) {
    // Quiet failure — never crash the tab over an optional, read-only row.
    row = <ResourceRowView name={null} source="" emptyPeek="Couldn't load context tree." />;
  } else if (!query.data?.repo) {
    row = <ResourceRowView name={null} source="" emptyPeek="Not configured" />;
  } else {
    const repo = query.data.repo;
    row = (
      <ResourceRowView
        name={deriveRepoLocalPath(repo)}
        source=""
        peek={formatRepoCoordinate({ url: repo, ref: query.data.branch })}
        monoPeek
      />
    );
  }

  return <Section title="Context tree">{row}</Section>;
}
