import { Link2 } from "lucide-react";
import { useNavigate } from "react-router";
import { Button } from "../../components/ui/button.js";
import { AppearanceSection } from "./appearance-section.js";
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
        <div className="flex justify-end">
          <Button
            variant="outline"
            size="xs"
            onClick={() => navigate(`/settings/integrations?agent=${ctx.agent.uuid}`)}
            title="Manage platform bindings in Integrations"
          >
            <Link2 className="h-3 w-3" />
            Manage platform bindings
          </Button>
        </div>
      )}
    </>
  );
}
