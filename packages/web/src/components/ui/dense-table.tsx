import { forwardRef, type HTMLAttributes, type TdHTMLAttributes, type ThHTMLAttributes } from "react";
import { cn } from "../../lib/utils.js";

// Dense table variant aligned with the workspace page redesigns:
// - 9.5px uppercase mono column headers with letter-spacing
// - 12px cell body text, 9px vertical padding
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
      className={cn("mono text-left uppercase font-medium whitespace-nowrap", className)}
      style={{
        padding: "8px 12px",
        fontSize: 9.5,
        letterSpacing: "0.09em",
        color: "var(--fg-4)",
        background: "var(--bg-sunken)",
        borderBottom: "1px solid var(--border)",
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
      className={cn("align-middle", className)}
      style={{
        padding: "9px 12px",
        borderBottom: "1px solid var(--border-faint)",
        fontSize: 12,
        ...style,
      }}
      {...props}
    />
  ),
);
DenseTableCell.displayName = "DenseTableCell";

export { DenseTable, DenseTableBody, DenseTableCell, DenseTableHead, DenseTableHeader, DenseTableRow };
