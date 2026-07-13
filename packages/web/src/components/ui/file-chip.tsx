import { cva, type VariantProps } from "class-variance-authority";
import { File, FileCode, FileImage, FileSpreadsheet, FileText, LoaderCircle, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils.js";

// Extension → lucide icon. Since the composer chip drops the type label, the
// icon (plus the extension in the name) is the type cue — so it maps to a
// recognisable family rather than a single generic file glyph.
const SPREADSHEET_EXTS = new Set([".xlsx", ".csv", ".tsv"]);
const CODE_EXTS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".c",
  ".h",
  ".cpp",
  ".rb",
  ".php",
  ".sh",
  ".sql",
  ".css",
  ".json",
  ".jsonl",
  ".yaml",
  ".yml",
  ".xml",
  ".html",
  ".htm",
  ".toml",
  ".ini",
]);
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const DOC_EXTS = new Set([".pdf", ".doc", ".docx", ".ppt", ".pptx", ".md", ".markdown", ".txt", ".log"]);

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot).toLowerCase() : "";
}

export function fileIconForName(filename: string): LucideIcon {
  const ext = extensionOf(filename);
  if (SPREADSHEET_EXTS.has(ext)) return FileSpreadsheet;
  if (IMAGE_EXTS.has(ext)) return FileImage;
  if (CODE_EXTS.has(ext)) return FileCode;
  if (DOC_EXTS.has(ext)) return FileText;
  return File;
}

const fileChipVariants = cva(
  "relative inline-flex h-8 min-w-[var(--sp-20)] max-w-[var(--sp-45)] items-center gap-1.5 rounded-[var(--radius-chip)] border bg-card pl-2 text-label",
  {
    variants: {
      state: {
        idle: "border-border",
        uploading: "border-border",
        error: "border-destructive bg-destructive/10",
      },
      trailing: { true: "pr-6", false: "pr-2" },
    },
    defaultVariants: { state: "idle", trailing: false },
  },
);

type FileChipProps = Omit<VariantProps<typeof fileChipVariants>, "trailing"> & {
  filename: string;
  /**
   * Trailing action pinned to the right edge, vertically centred (remove × in
   * the composer, download ↓ on a received message). When present the chip
   * reserves right padding so the name never underlaps it.
   */
  trailing?: ReactNode;
  className?: string;
};

/**
 * A single-line attachment pill: type icon + filename (middle-truncated,
 * preserving the extension) + an optional trailing action. Presentational —
 * callers own the action button and any whole-chip click. Dimensions and
 * tokens follow packages/web/DESIGN.md (chip radius, size-4 lucide icon,
 * text-label, --sp-20/--sp-45 min/max width).
 */
export function FileChip({ filename, state, trailing, className }: FileChipProps) {
  const Icon = fileIconForName(filename);
  const dot = filename.lastIndexOf(".");
  const head = dot > 0 ? filename.slice(0, dot) : filename;
  const tail = dot > 0 ? filename.slice(dot) : "";
  return (
    <div className={cn(fileChipVariants({ state, trailing: trailing != null }), className)} title={filename}>
      {state === "uploading" ? (
        <LoaderCircle className="size-4 shrink-0 text-muted-foreground motion-safe:animate-spin" aria-hidden />
      ) : (
        <Icon
          className={cn("size-4 shrink-0", state === "error" ? "text-destructive" : "text-muted-foreground")}
          aria-hidden
        />
      )}
      <span className="flex min-w-0 items-center text-foreground">
        <span className="truncate">{head}</span>
        <span className="shrink-0">{tail}</span>
      </span>
      {trailing != null ? (
        <span className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center">{trailing}</span>
      ) : null}
    </div>
  );
}
