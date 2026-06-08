import { useMemo } from "react";
import { Navigate } from "react-router";
import { Section } from "../../components/ui/section.js";
import { ResourceTypeSection, useAgentResources } from "./capability-section.js";
import { EnvSection } from "./env-section.js";
import { useAgentDetailContext } from "./layout-context.js";
import { ModelSection } from "./model-section.js";
import { ReasoningEffortSection } from "./reasoning-effort-section.js";
import { RuntimeSection } from "./runtime-section.js";
import { sectionAnchorId } from "./save-bar.js";
import { titleWithSemantics } from "./save-semantics.js";

export function RuntimeTab() {
  const ctx = useAgentDetailContext();
  const envOtherKeys = useMemo(() => {
    const active = ctx.draft.draft.env.filter((i) => i.status !== "deleted");
    return (exceptKey: string | null): ReadonlySet<string> =>
      new Set(active.filter((i) => i.key !== exceptKey).map((i) => i.value.key));
  }, [ctx.draft.draft.env]);
  // Code repositories are part of the workspace this agent runs in, so they live
  // on Environment now (not Tools & skills). Unlike model/effort/env, repo
  // changes save IMMEDIATELY through the agent-resources API — they're NOT part
  // of the SaveBar draft. The shared `["agent-resources", uuid]` cache keeps this
  // in sync with the Tools & skills tab (skills + MCP).
  // Gate on canEditConfig (not just !isHuman): non-editors hit the redirect
  // below, so there's no point firing an agent-resources GET for them.
  const repos = useAgentResources(ctx.uuid, { enabled: !!ctx.uuid && ctx.canEditConfig });
  const canEditResources = ctx.canManageAgent && ctx.agent.status === "active";
  // Human agents (and any role without canEditConfig) have no runtime to
  // configure. The tab is hidden from buildTabs, but a stale deep link to
  // /agents/:uuid/runtime would otherwise render a blank page; redirect to
  // Profile, which now hosts agent lifecycle controls (suspend / delete).
  if (!ctx.canEditConfig) return <Navigate to="../profile" replace />;
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
      {/* Immediate zone — Execution + Repositories. Both save the moment you act
          (bind/re-bind, repo add/remove); no SaveBar involvement. */}
      {ctx.config && (
        <RuntimeSection
          runtimeProvider={ctx.setupRuntimeProvider}
          computerLabel={ctx.boundClientLabel}
          computerStatusLoading={ctx.clientStatusLoading}
          computerStatusError={ctx.clientStatusError}
          canBindComputer={ctx.isUnclaimed && ctx.agent.status === "active"}
          bindComputerPending={ctx.bindClientPending}
          onBindComputer={ctx.onOpenBindDialog}
          onRebind={ctx.agent.clientId ? ctx.onOpenRebindDialog : undefined}
        />
      )}
      <div id={sectionAnchorId("git")} style={{ marginTop: "var(--sp-8)" }}>
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
            onNavigateAway={ctx.guardedNavigate}
          />
        )}
        {repos.saveError ? (
          <p className="text-body" style={{ color: "var(--state-error)", margin: "var(--sp-2) 0 0" }}>
            {repos.saveError instanceof Error ? repos.saveError.message : "Failed to save repositories"}
          </p>
        ) : null}
      </div>

      {/* Draft zone — Model settings + Environment variables. These stage into the
          SaveBar and commit together; their dirty-dots drive the bar. */}
      {ctx.config && (
        <div style={{ marginTop: "var(--sp-8)" }}>
          <Section
            title={titleWithSemantics("Model settings", "draft")}
            description="Model and reasoning settings remain drafts until saved from the Save bar."
          >
            <div id={sectionAnchorId("model")}>
              <ModelSection
                value={ctx.draft.draft.model}
                baseline={ctx.config?.payload.model ?? ""}
                onChange={ctx.draft.setModel}
                onRevert={ctx.draft.revertModel}
                disabled={ctx.agent.status !== "active"}
                provider={ctx.setupRuntimeProvider}
              />
            </div>
            <div id={sectionAnchorId("effort")}>
              <ReasoningEffortSection
                value={ctx.draft.draft.reasoningEffort}
                baseline={ctx.config?.payload.reasoningEffort ?? ""}
                onChange={ctx.draft.setReasoningEffort}
                onRevert={ctx.draft.revertReasoningEffort}
                disabled={ctx.agent.status !== "active"}
                provider={ctx.setupRuntimeProvider}
              />
            </div>
          </Section>
        </div>
      )}
      {ctx.config && (
        <div id={sectionAnchorId("env")} style={{ marginTop: "var(--sp-8)" }}>
          <EnvSection
            items={ctx.draft.draft.env}
            otherKeys={envOtherKeys}
            onAdd={ctx.draft.addEnv}
            onUpdate={ctx.draft.updateEnv}
            onDelete={ctx.draft.deleteEnv}
            onUndoDelete={ctx.draft.undoDeleteEnv}
            disabled={ctx.agent.status !== "active"}
          />
        </div>
      )}
    </>
  );
}
