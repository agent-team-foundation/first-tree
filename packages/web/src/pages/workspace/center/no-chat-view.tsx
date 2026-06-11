import { Plus } from "lucide-react";
import { FirstTreeLogo } from "../../../components/first-tree-logo.js";
import { Button } from "../../../components/ui/button.js";

/**
 * Center-panel placeholder shown when no chat is selected. Sibling of
 * NewChatDraft and ChatByIdView; CenterPanel picks one based on URL params.
 * The primary action is starting a new chat — the left rail is a conversation
 * list, not an agent roster, so the old "pick an agent from the roster"
 * guidance no longer holds.
 *
 * Button variant note: this used to be the workspace surface's `cta` (brand-
 * green) hero. The persistent CTA now lives on the conversation rail's
 * "New chat" button (see `conversations/index.tsx`), so the empty-state
 * action here demotes to neutral `default` to avoid two simultaneous green
 * heroes on the same screen — DESIGN.md bans repeated green actions, and
 * "one hero per surface" is honoured by keeping the persistent rail CTA
 * as the canonical home and treating this as a discoverability echo.
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
          <Button type="button" variant="default" onClick={onNewChat}>
            <Plus className="h-3.5 w-3.5" />
            <span>New chat</span>
          </Button>
        </div>
      </div>
    </div>
  );
}
