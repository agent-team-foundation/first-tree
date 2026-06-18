import { deriveRepoLocalPath, formatRepoCoordinate } from "@first-tree/shared";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Navigate } from "react-router";
import { getContextTreeSetting } from "../../api/org-settings.js";
import { useAuth } from "../../auth/auth-context.js";
import { Section } from "../../components/ui/section.js";
import { ResourceTypeSection, useAgentResources } from "./capability-section.js";
import { EnvSection } from "./env-section.js";
import { useAgentDetailContext } from "./layout-context.js";
import { ModelSection } from "./model-section.js";
import { ReasoningEffortSection } from "./reasoning-effort-section.js";
import { ResourceRowView } from "./resource-row.js";
import { RuntimeSection } from "./runtime-section.js";
import { titleWithSemantics } from "./save-semantics.js";

export function RuntimeTab() {
  const ctx = useAgentDetailContext();
  // Code repositories are part of the workspace this agent runs in, so they live
  // on Environment now (not Tools & skills). The shared `["agent-resources", uuid]`
  // cache keeps this in sync with the Tools & skills tab (skills + MCP).
  // Gate on canEditConfig (not just !isHuman): non-editors hit the redirect
  // below, so there's no point firing an agent-resources GET for them.
  const repos = useAgentResources(ctx.uuid, { enabled: !!ctx.uuid && ctx.canEditConfig });
  const canEditResources = ctx.canManageAgent && ctx.agent.status === "active";
  // Human agents (and any role without canEditConfig) have no runtime to
  // configure. The tab is hidden from buildTabs, but a stale deep link to
  // /agents/:uuid/runtime would otherwise render a blank page; redirect to
  // Profile, which now hosts agent lifecycle controls (suspend / delete).
  if (!ctx.canEditConfig) return <Navigate to="../profile" replace />;

  const { config, configSave } = ctx;
  // Edits disable while a save is in flight, so the next PATCH always sees the
  // version the previous one wrote back — no self-conflicting 409 on rapid edits.
  const editsDisabled = ctx.agent.status !== "active" || configSave.pending;
  const modelSettingsSaved =
    configSave.justSaved && (configSave.savedField === "model" || configSave.savedField === "effort");
  const envSaved = configSave.justSaved && configSave.savedField === "env";

  return (
    <>
      {ctx.configLoading && (
        <div className="text-body" style={{ color: "var(--fg-3)" }}>
          Loading configuration…
        </div>
      )}
      {ctx.configError != null && (
        <div className="text-body" style={{ color: "var(--state-error)" }}>
          Failed to load configuration: {String(ctx.configError)}
        </div>
      )}
      {/* Section order follows the conceptual grouping (runtime → workspace):
          Execution → Model settings → Repositories → Context tree → Env vars.
          Every section saves immediately. */}
      {config && (
        <RuntimeSection
          runtimeProvider={ctx.setupRuntimeProvider}
          computerLabel={ctx.boundClientLabel}
          computerStatusLoading={ctx.clientStatusLoading}
          computerStatusError={ctx.clientStatusError}
          canBindComputer={ctx.isUnclaimed && ctx.agent.status === "active"}
          bindComputerPending={ctx.bindClientPending}
          onBindComputer={ctx.onOpenBindDialog}
        />
      )}

      {config && (
        <div style={{ marginTop: "var(--sp-8)" }}>
          <Section title={titleWithSemantics("Model settings", modelSettingsSaved)}>
            <ModelSection
              value={config.payload.model}
              onChange={(v) => configSave.save({ model: v }, { field: "model" })}
              disabled={editsDisabled}
              provider={ctx.setupRuntimeProvider}
            />
            <ReasoningEffortSection
              value={config.payload.reasoningEffort}
              onChange={(v) => configSave.save({ reasoningEffort: v }, { field: "effort" })}
              disabled={editsDisabled}
              provider={ctx.setupRuntimeProvider}
            />
          </Section>
          {configSave.conflict ? (
            <p className="text-body" style={{ color: "var(--state-blocked)", margin: "var(--sp-2) 0 0" }}>
              This agent's configuration was updated elsewhere; reloaded the latest values.
            </p>
          ) : configSave.saveError ? (
            <p className="text-body" style={{ color: "var(--state-error)", margin: "var(--sp-2) 0 0" }}>
              Failed to save: {configSave.saveError}
            </p>
          ) : null}
        </div>
      )}

      {/* Repositories — saves immediately on add/remove via the agent-resources API. */}
      <div style={{ marginTop: "var(--sp-8)" }}>
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

      {/* Environment variables — saves immediately on add / edit / delete. */}
      {config && (
        <div style={{ marginTop: "var(--sp-8)" }}>
          <EnvSection
            items={config.payload.env}
            onSave={(next, opts) => configSave.save({ env: next }, { field: "env", onSuccess: opts?.onSuccess })}
            disabled={editsDisabled}
            saved={envSaved}
          />
        </div>
      )}
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
