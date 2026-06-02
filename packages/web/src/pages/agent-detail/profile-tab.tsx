import { AppearanceSection } from "./appearance-section.js";
import { DangerZone } from "./danger-zone.js";
import { IdentitySection } from "./identity-section.js";
import { useAgentDetailContext } from "./layout-context.js";

export function ProfileTab() {
  const ctx = useAgentDetailContext();
  return (
    <>
      <IdentitySection
        agent={ctx.agent}
        canEdit={ctx.canManageAgent}
        onSave={ctx.saveIdentity}
        title="Identity"
        description={null}
        aside={
          <AppearanceSection
            agent={ctx.agent}
            canEdit={ctx.canManageAgent}
            onSave={ctx.saveIdentity}
            onRefresh={ctx.refreshAgent}
            variant="inline"
          />
        }
      />
      {/* Agent lifecycle lives at the bottom of Profile — availability/delete
          (suspend / delete) is identity-level, not runtime-level. Industry
          pattern: GitHub / Linear / Stripe all put lifecycle/destructive controls at the end
          of the identity/settings page, not mixed with config. */}
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
