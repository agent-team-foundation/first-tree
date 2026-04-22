import { MoreHorizontal, Undo2 } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../../components/ui/button.js";
import { cn } from "../../lib/utils.js";
import type { DraftListStatus } from "./use-config-draft.js";

/**
 * Shared presentation for a single item in an MCP/Env/Git list.
 * Marks the row with a status badge and either a `⋯ Edit/Delete` menu
 * (non-deleted) or a `Undo` action (deleted).
 */

export type ListRowProps = {
  status: DraftListStatus;
  onEdit: () => void;
  onDelete: () => void;
  onUndo: () => void;
  children: ReactNode;
  disabled?: boolean;
};

const STATUS_BADGES: Record<DraftListStatus, { label: string; tone: string }> = {
  unchanged: { label: "", tone: "" },
  added: { label: "new", tone: "bg-success-soft text-success" },
  modified: { label: "changed", tone: "bg-warn-soft text-warn" },
  deleted: { label: "will be removed on save", tone: "bg-error-soft text-error" },
};

export function ListRow({ status, onEdit, onDelete, onUndo, children, disabled }: ListRowProps) {
  const badge = STATUS_BADGES[status];
  const isDeleted = status === "deleted";

  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded border px-3 py-2 text-body",
        isDeleted ? "bg-error-soft border-error text-error line-through decoration-error" : "bg-card",
      )}
    >
      <div className="flex-1 min-w-0 flex items-center gap-2">{children}</div>
      {badge.label && (
        <span className={cn("text-caption rounded px-1.5 py-0.5 whitespace-nowrap", badge.tone)}>{badge.label}</span>
      )}
      {!disabled &&
        (isDeleted ? (
          <Button size="sm" variant="ghost" onClick={onUndo}>
            <Undo2 className="h-3.5 w-3.5 mr-1" />
            Undo
          </Button>
        ) : (
          <RowMenu onEdit={onEdit} onDelete={onDelete} />
        ))}
    </div>
  );
}

function RowMenu({ onEdit, onDelete }: { onEdit: () => void; onDelete: () => void }) {
  return (
    <div className="flex gap-1">
      <Button size="sm" variant="ghost" onClick={onEdit} title="Edit">
        Edit
      </Button>
      <Button size="sm" variant="ghost" onClick={onDelete} title="Delete">
        <MoreHorizontal className="sr-only h-3.5 w-3.5" aria-hidden />
        Delete
      </Button>
    </div>
  );
}
