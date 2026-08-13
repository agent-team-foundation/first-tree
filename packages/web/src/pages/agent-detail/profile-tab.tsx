import { useState } from "react";
import { Button } from "../../components/ui/button.js";
import { AppearanceSection } from "./appearance-section.js";
import { useAgentResources } from "./capability-section.js";
import { DangerZone } from "./danger-zone.js";
import { FeishuSection } from "./feishu-section.js";
import { IdentitySection } from "./identity-section.js";
import { useAgentDetailContext } from "./layout-context.js";
import { ProfileEditDialog } from "./profile-edit-dialog.js";
import { TemplateProvenance } from "./responsibilities-section.js";
import { useJustSaved } from "./save-semantics.js";

export function ProfileTab() {
  const ctx = useAgentDetailContext();
  const { justSaved, markSaved } = useJustSaved();
  const [editOpen, setEditOpen] = useState(false);
  const resources = useAgentResources(ctx.uuid, {
    enabled: !!ctx.uuid && !ctx.isHuman,
  });
  // Identity + Appearance share one Edit entry (PR2 §Profile). Both the Identity
  // section's Edit button and the avatar open the same unified dialog.
  const onEdit =
    ctx.canManageAgent && ctx.agent.status === "active" && !ctx.runtimeSwitchClaim
      ? () => setEditOpen(true)
      : undefined;

  return (
    <>
      <IdentitySection
        agent={ctx.agent}
        canEdit={ctx.canManageAgent}
        onEdit={onEdit}
        saved={justSaved}
        title="Identity"
        description={null}
        aside={<AppearanceSection agent={ctx.agent} canEdit={ctx.canManageAgent} onEdit={onEdit} variant="inline" />}
        createdFrom={
          !ctx.isHuman && resources.data && resources.data.templateIds.length > 0 ? (
            <TemplateProvenance
              agentUuid={ctx.uuid}
              agentStatus={ctx.agent.status}
              canManage={ctx.canEditConfig}
              templateIds={resources.data.templateIds}
              adoptedTemplates={resources.data.adoptedTemplates}
              version={resources.data.version}
            />
          ) : undefined
        }
      />
      {!ctx.isHuman && !resources.data && resources.isError ? (
        <div className="flex flex-wrap items-center gap-2 py-3" role="alert">
          <p className="m-0 text-body text-destructive">Some profile details couldn’t be loaded.</p>
          <Button
            type="button"
            className="min-h-11"
            size="xs"
            variant="outline"
            disabled={resources.reloading}
            onClick={() => void resources.reload()}
          >
            {resources.reloading ? "Retrying…" : "Retry"}
          </Button>
        </div>
      ) : null}
      {!ctx.isHuman && <FeishuSection onOpenProfileEdit={onEdit} />}
      {/* Agent lifecycle is identity-level, so destructive controls stay at the
          end of Profile instead of mixing with runtime configuration. */}
      {ctx.canManageAgent && ctx.agent.type !== "human" && (
        <DangerZone
          agent={ctx.agent}
          suspendPending={ctx.suspendPending}
          deletePending={ctx.deletePending}
          runtimeSwitchClaim={ctx.runtimeSwitchClaim}
          runtimeSwitchRecoveryPending={ctx.runtimeSwitchRecoveryPending}
          runtimeSwitchRecoveryError={ctx.runtimeSwitchRecoveryError}
          errorMessage={ctx.dangerError}
          onSuspend={ctx.onSuspend}
          onDelete={ctx.onDelete}
          onRecoverRuntimeSwitch={ctx.onRecoverRuntimeSwitch}
        />
      )}
      {ctx.canManageAgent && (
        <ProfileEditDialog
          agent={ctx.agent}
          open={editOpen}
          onOpenChange={setEditOpen}
          onSave={ctx.saveIdentity}
          onRefresh={ctx.refreshAgent}
          onSaved={markSaved}
        />
      )}
    </>
  );
}
