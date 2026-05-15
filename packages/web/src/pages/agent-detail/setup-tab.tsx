import { DangerZone } from "./danger-zone.js";
import { useAgentDetailContext } from "./layout-context.js";
import { ModelSection } from "./model-section.js";
import { SetupSection } from "./setup-section.js";

export function SetupTab() {
  const ctx = useAgentDetailContext();
  return (
    <>
      {ctx.canEditConfig && (
        <>
          {ctx.config?.version != null && (
            <div className="mono text-caption" style={{ color: "var(--fg-3)" }}>
              config v{ctx.config.version}
              {ctx.draft.summary.anyDirty && (
                <>
                  {" · "}
                  <span style={{ color: "var(--state-blocked)" }}>draft</span>
                </>
              )}
            </div>
          )}
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
            <SetupSection
              runtimeProvider={ctx.setupRuntimeProvider}
              computerLabel={ctx.boundClientLabel}
              computerStatusLoading={ctx.clientStatusLoading}
              computerStatusError={ctx.clientStatusError}
              canBindComputer={ctx.isUnclaimed && ctx.agent.status === "active"}
              bindComputerPending={ctx.bindClientPending}
              onBindComputer={ctx.onOpenBindDialog}
              onRebind={ctx.agent.clientId ? ctx.onOpenRebindDialog : undefined}
              modelSlot={
                <ModelSection
                  value={ctx.draft.draft.model}
                  baseline={ctx.config?.payload.model ?? ""}
                  onChange={ctx.draft.setModel}
                  onRevert={ctx.draft.revertModel}
                  disabled={ctx.agent.status !== "active"}
                  provider={ctx.setupRuntimeProvider}
                />
              }
            />
          )}
        </>
      )}

      {ctx.canManageAgent && (
        <DangerZone
          agent={ctx.agent}
          suspendPending={ctx.suspendPending}
          reactivatePending={ctx.reactivatePending}
          deletePending={ctx.deletePending}
          errorMessage={ctx.dangerError}
          onSuspend={ctx.onSuspend}
          onReactivate={ctx.onReactivate}
          onDelete={ctx.onDelete}
        />
      )}
    </>
  );
}
