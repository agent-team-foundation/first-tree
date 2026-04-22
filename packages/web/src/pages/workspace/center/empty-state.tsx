import { FirstTreeLogo } from "../../../components/first-tree-logo.js";

export function EmptyState() {
  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="text-center max-w-sm">
        <FirstTreeLogo width={36} height={40} className="mx-auto mb-3 text-primary opacity-60" />
        <div className="text-subtitle mb-1">Select a chat</div>
        <div className="text-body text-muted-foreground">
          Pick an agent from the roster to view its sessions, or open a chat to start collaborating.
        </div>
      </div>
    </div>
  );
}
