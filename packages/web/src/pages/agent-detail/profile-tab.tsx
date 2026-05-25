import { Link2 } from "lucide-react";
import { useNavigate } from "react-router";
import { Button } from "../../components/ui/button.js";
import { Section } from "../../components/ui/section.js";
import { AppearanceSection } from "./appearance-section.js";
import { DangerZone } from "./danger-zone.js";
import { ConfigRow } from "./flat-section.js";
import { IdentitySection } from "./identity-section.js";
import { useAgentDetailContext } from "./layout-context.js";

export function ProfileTab() {
  const ctx = useAgentDetailContext();
  const navigate = useNavigate();
  return (
    <>
      <IdentitySection agent={ctx.agent} canEdit={ctx.canManageAgent} onSave={ctx.saveIdentity} />
      <AppearanceSection
        agent={ctx.agent}
        canEdit={ctx.canManageAgent}
        onSave={ctx.saveIdentity}
        onRefresh={ctx.refreshAgent}
      />
      {ctx.canManageAgent && (
        <Section
          title="Platform bindings"
          action={
            <Button
              variant="outline"
              size="xs"
              onClick={() => navigate(`/settings/integrations?agent=${ctx.agent.uuid}`)}
              title="Manage platform bindings in Integrations"
            >
              <Link2 className="h-3 w-3" />
              Manage
            </Button>
          }
        >
          <ConfigRow label="Integrations" value="Manage external platform bindings for this agent." />
        </Section>
      )}
      {/* Danger zone lives at the bottom of Profile — agent lifecycle
          (suspend / delete) is identity-level, not runtime-level. Industry
          pattern: GitHub / Linear / Stripe all put danger zone at the end
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
