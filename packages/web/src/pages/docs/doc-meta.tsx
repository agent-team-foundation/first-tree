import type { DocAuthor, DocStatus } from "@first-tree/shared";
import { Bot, User } from "lucide-react";

/** Sentence-case labels for the four document statuses. */
export const DOC_STATUS_LABELS: Record<DocStatus, string> = {
  draft: "Draft",
  in_review: "In review",
  approved: "Approved",
  archived: "Archived",
};

const DOC_STATUS_COLORS: Record<DocStatus, { fg: string; bg: string }> = {
  draft: { fg: "var(--fg-3)", bg: "var(--bg-active)" },
  in_review: { fg: "var(--fg-warn-strong)", bg: "var(--bg-warn-soft)" },
  approved: { fg: "var(--fg-success-strong)", bg: "var(--bg-success-soft)" },
  archived: { fg: "var(--fg-3)", bg: "transparent" },
};

export function DocStatusChip({ status }: { status: DocStatus }) {
  const colors = DOC_STATUS_COLORS[status];
  return (
    <span
      className="inline-flex items-center rounded-[var(--radius-chip)] px-2 py-0.5 text-caption font-semibold"
      style={{
        color: colors.fg,
        background: colors.bg,
        border: status === "archived" ? "var(--hairline) solid var(--border)" : "none",
      }}
    >
      {DOC_STATUS_LABELS[status]}
    </span>
  );
}

/** Author byline: agents and humans are both first-class, visually tagged. */
export function DocAuthorLabel({ author }: { author: DocAuthor }) {
  const Icon = author.kind === "agent" ? Bot : User;
  return (
    <span className="inline-flex items-center gap-1 text-label" style={{ color: "var(--fg-2)" }}>
      <Icon size={12} aria-label={author.kind} />
      {author.name}
    </span>
  );
}
