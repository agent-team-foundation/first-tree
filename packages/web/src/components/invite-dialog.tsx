import { InviteLinkPanel } from "../pages/invite-link-panel.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog.js";

/**
 * Shared invite dialog. Used by both the avatar UserMenu and the Team page so
 * the invite entry is reachable from a global, role-agnostic surface rather
 * than only the Team admin corner (issue 836). The panel inside role-forks:
 * every member can copy the link; only admins see Rotate.
 */
export function InviteDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite teammates</DialogTitle>
        </DialogHeader>
        <InviteLinkPanel />
      </DialogContent>
    </Dialog>
  );
}
