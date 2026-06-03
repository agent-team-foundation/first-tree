import { useMemo } from "react";
import { Navigate } from "react-router";
import { EnvSection } from "./env-section.js";
import { useAgentDetailContext } from "./layout-context.js";
import { ModelSection } from "./model-section.js";
import { ReasoningEffortSection } from "./reasoning-effort-section.js";
import { RuntimeSection } from "./runtime-section.js";
import { sectionAnchorId } from "./save-bar.js";

export function RuntimeTab() {
  const ctx = useAgentDetailContext();
  const envOtherKeys = useMemo(() => {
    const active = ctx.draft.draft.env.filter((i) => i.status !== "deleted");
    return (exceptKey: string | null): ReadonlySet<string> =>
      new Set(active.filter((i) => i.key !== exceptKey).map((i) => i.value.key));
  }, [ctx.draft.draft.env]);
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
          modelSlot={
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
          }
          effortSlot={
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
          }
        />
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
