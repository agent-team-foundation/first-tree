import { forwardRef, type HTMLAttributes, type TdHTMLAttributes, type ThHTMLAttributes } from "react";
import { cn } from "../../lib/utils.js";

// Dense table variant aligned with the workspace page redesigns:
// - text-eyebrow uppercase mono column headers with letter-spacing
// - text-body cell body, tight vertical padding
// - Hairline row separators
// - No outer border (meant to live inside a Panel).

const DenseTable = forwardRef<HTMLTableElement, HTMLAttributes<HTMLTableElement>>(({ className, ...props }, ref) => (
  <table
    ref={ref}
    className={cn("w-full", className)}
    style={{ borderCollapse: "separate", borderSpacing: 0 }}
    {...props}
  />
));
DenseTable.displayName = "DenseTable";

const DenseTableHeader = forwardRef<HTMLTableSectionElement, HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => <thead ref={ref} className={className} {...props} />,
);
DenseTableHeader.displayName = "DenseTableHeader";

const DenseTableBody = forwardRef<HTMLTableSectionElement, HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => <tbody ref={ref} className={className} {...props} />,
);
DenseTableBody.displayName = "DenseTableBody";

type DenseRowProps = HTMLAttributes<HTMLTableRowElement> & {
  interactive?: boolean;
  selected?: boolean;
};

const DenseTableRow = forwardRef<HTMLTableRowElement, DenseRowProps>(
  ({ className, interactive, selected, style, ...props }, ref) => (
    <tr
      ref={ref}
      className={cn("transition-colors", className)}
      data-interactive={interactive ? "" : undefined}
      data-selected={selected ? "" : undefined}
      style={{
        background: selected ? "var(--bg-active)" : undefined,
        cursor: interactive ? "pointer" : undefined,
        ...style,
      }}
      {...props}
    />
  ),
);
DenseTableRow.displayName = "DenseTableRow";

const DenseTableHead = forwardRef<HTMLTableCellElement, ThHTMLAttributes<HTMLTableCellElement>>(
  ({ className, style, ...props }, ref) => (
    <th
      ref={ref}
      // `text-eyebrow` bundles 10 / 600 / 0.1em — size was bumped from 9.5
      // to 10 in the unified scale so Windows ClearType renders headers
      // cleanly. `font-medium` was removed because the token sets 600.
      className={cn("mono text-left uppercase text-eyebrow whitespace-nowrap", className)}
      style={{
        padding: "var(--sp-2) var(--sp-3)",
        color: "var(--fg-4)",
        background: "var(--bg-sunken)",
        borderBottom: "var(--hairline) solid var(--border)",
        ...style,
      }}
      {...props}
    />
  ),
);
DenseTableHead.displayName = "DenseTableHead";

const DenseTableCell = forwardRef<HTMLTableCellElement, TdHTMLAttributes<HTMLTableCellElement>>(
  ({ className, style, ...props }, ref) => (
    <td
      ref={ref}
      className={cn("align-middle text-body", className)}
      style={{
        padding: "var(--sp-2_25) var(--sp-3)",
        borderBottom: "var(--hairline) solid var(--border-faint)",
        ...style,
      }}
      {...props}
    />
  ),
);
DenseTableCell.displayName = "DenseTableCell";

export { DenseTable, DenseTableBody, DenseTableCell, DenseTableHead, DenseTableHeader, DenseTableRow };
