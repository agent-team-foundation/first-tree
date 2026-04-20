import { Leaf } from "lucide-react";

export function EmptyState() {
  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="text-center max-w-sm">
        <Leaf className="h-10 w-10 mx-auto mb-3 text-primary opacity-60" />
        <div className="text-sm font-medium mb-1">Select a chat</div>
        <div className="text-xs text-muted-foreground">
          Pick an agent from the roster to view its sessions, or open a chat to start collaborating.
        </div>
      </div>
    </div>
  );
}
