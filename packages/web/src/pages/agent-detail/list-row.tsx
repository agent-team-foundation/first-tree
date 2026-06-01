import { Pencil, Trash2, Undo2 } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../../components/ui/button.js";
import { DraftStatusChip } from "../../components/ui/draft-status-chip.js";
import { cn } from "../../lib/utils.js";
import type { DraftListStatus } from "./use-config-draft.js";

/**
 * Shared presentation for a single item in an MCP/Env/Git list.
 * Marks the row with a status badge and either Edit/Delete actions
 * (non-deleted) or an Undo action (deleted, soft-removed pending save).
 *
 * The Edit/Delete pair uses icon-only ghost buttons consistent with the
 * Integrations → Bindings table; titles surface the action label on hover and
 * to assistive tech.
 */

export type ListRowProps = {
  status: DraftListStatus;
  onEdit: () => void;
  onDelete: () => void;
  onUndo: () => void;
  children: ReactNode;
  disabled?: boolean;
};

export function ListRow({ status, onEdit, onDelete, onUndo, children, disabled }: ListRowProps) {
  const isDeleted = status === "deleted";

  return (
    <div
      className={cn(
        "flex items-center gap-2 text-body transition-colors",
        isDeleted ? "text-error line-through decoration-error" : "hover:bg-accent",
      )}
      style={{
        padding: "var(--sp-2_5) 0",
        borderBottom: "var(--hairline) solid var(--border-faint)",
      }}
    >
      <div className="flex-1 min-w-0 flex items-center gap-2">{children}</div>
      <DraftStatusChip status={status} />
      {!disabled &&
        (isDeleted ? (
          <Button size="sm" variant="ghost" onClick={onUndo}>
            <Undo2 className="h-3.5 w-3.5 mr-1" />
            Undo
          </Button>
        ) : (
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
        ))}
    </div>
  );
}
