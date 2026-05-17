import { Link2 } from "lucide-react";
import { useNavigate } from "react-router";
import { Button } from "../../components/ui/button.js";
import { AppearanceSection } from "./appearance-section.js";
import { ConfigRow, ConfigSection } from "./flat-section.js";
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
        <ConfigSection
          eyebrow="profile"
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
        </ConfigSection>
      )}
    </>
  );
}
