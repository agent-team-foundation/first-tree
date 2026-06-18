import { Pencil, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../../components/ui/button.js";
import { cn } from "../../lib/utils.js";

/**
 * Shared presentation for a single item in the Env list. Renders Edit/Delete
 * icon actions. Edits save immediately (no draft status / undo here — a deleted
 * row is gone, with an Undo offered transiently via toast by the section).
 *
 * The Edit/Delete pair uses icon-only ghost buttons consistent with the
 * Integrations → Bindings table; titles surface the action label on hover and
 * to assistive tech.
 */

export type ListRowProps = {
  onEdit: () => void;
  onDelete: () => void;
  children: ReactNode;
  disabled?: boolean;
};

export function ListRow({ onEdit, onDelete, children, disabled }: ListRowProps) {
  return (
    <div
      className={cn("flex items-center gap-2 text-body transition-colors hover:bg-accent")}
      style={{
        padding: "var(--sp-2_5) 0",
        borderBottom: "var(--hairline) solid var(--border-faint)",
      }}
    >
      <div className="flex-1 min-w-0 flex items-center gap-2">{children}</div>
      {!disabled && (
        <div className="flex gap-1 shrink-0">
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onEdit} title="Edit">
            <Pencil className="h-3.5 w-3.5" />
            <span className="sr-only">Edit</span>
          </Button>
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onDelete} title="Delete">
            <Trash2 className="h-3.5 w-3.5" />
            <span className="sr-only">Delete</span>
          </Button>
        </div>
      )}
    </div>
  );
}
