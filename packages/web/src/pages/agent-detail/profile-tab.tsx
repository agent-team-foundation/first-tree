import { useState } from "react";
import { AppearanceSection } from "./appearance-section.js";
import { DangerZone } from "./danger-zone.js";
import { IdentitySection } from "./identity-section.js";
import { useAgentDetailContext } from "./layout-context.js";
import { ProfileEditDialog } from "./profile-edit-dialog.js";
import { useJustSaved } from "./save-semantics.js";

export function ProfileTab() {
  const ctx = useAgentDetailContext();
  const { justSaved, markSaved } = useJustSaved();
  const [editOpen, setEditOpen] = useState(false);
  // Identity + Appearance share one Edit entry (PR2 §Profile). Both the Identity
  // section's Edit button and the avatar open the same unified dialog.
  const onEdit = ctx.canManageAgent && ctx.agent.status === "active" ? () => setEditOpen(true) : undefined;

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
      />
      {/* Agent lifecycle is identity-level, so destructive controls stay at the
          end of Profile instead of mixing with runtime configuration. */}
      {ctx.canManageAgent && ctx.agent.type !== "human" && (
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
