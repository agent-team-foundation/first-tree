import { Plus } from "lucide-react";
import { FirstTreeLogo } from "../../../components/first-tree-logo.js";
import { Button } from "../../../components/ui/button.js";

/**
 * Center-panel placeholder shown when onboarding is complete/dismissed but no
 * chat is selected. Sibling of ChatView and OnboardingView; CenterPanel picks
 * one of the three based on URL params + onboardingStep. The primary action is
 * starting a new chat — the left rail is a conversation list, not an agent
 * roster, so the old "pick an agent from the roster" guidance no longer holds.
 */
export function NoChatView({ onNewChat }: { onNewChat: () => void }) {
  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="text-center max-w-sm">
        <FirstTreeLogo width={36} height={40} className="mx-auto mb-3 text-primary opacity-60" />
        <div className="text-subtitle mb-1">No chat selected</div>
        <div className="text-body text-muted-foreground mb-4">
          Start a new chat to put your agent to work, or open an existing one from the list.
        </div>
        <div className="flex justify-center">
          <Button type="button" onClick={onNewChat}>
            <Plus className="h-4 w-4" />
            <span>New chat</span>
          </Button>
        </div>
      </div>
    </div>
  );
}
