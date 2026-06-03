import { cva } from "class-variance-authority";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils.js";

/**
 * One chip for every "this differs from the saved baseline" signal across the
 * agent config draft: list rows (MCP / Env / Git) and section headers (model,
 * effort, prompt). Replaces the per-call `ChangedChip` / inline status badges
 * that had drifted into three different shapes and two oranges.
 *
 * Color follows state semantics: `added` = success green, `deleted` = error red,
 * `modified` = neutral pending change. It deliberately avoids blocked/error
 * warm hues because draft edits are not operational incidents.
 * `unchanged` renders nothing so callers can pass status unconditionally.
 */
export type DraftStatusChipStatus = "unchanged" | "added" | "modified" | "deleted";

const LABELS: Record<Exclude<DraftStatusChipStatus, "unchanged">, string> = {
  added: "new",
  modified: "changed",
  deleted: "will be removed on save",
};

const chipVariants = cva(
  "inline-flex items-center rounded-[var(--radius-chip)] px-1.5 py-0.5 text-caption font-medium whitespace-nowrap",
  {
    variants: {
      status: {
        added: "bg-success-soft text-success",
        modified: "bg-muted text-muted-foreground",
        deleted: "bg-error-soft text-error",
      },
    },
  },
);

export function DraftStatusChip({
  status,
  className,
}: {
  status: DraftStatusChipStatus;
  className?: string;
}): ReactNode {
  if (status === "unchanged") return null;
  return <span className={cn(chipVariants({ status }), className)}>{LABELS[status]}</span>;
}
