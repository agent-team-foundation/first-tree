import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "../../lib/utils.js";

const Panel = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("overflow-hidden", className)}
    style={{
      background: "var(--bg-raised)",
      border: "1px solid var(--border)",
      borderRadius: 6,
    }}
    {...props}
  />
));
Panel.displayName = "Panel";

const PanelHeader = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("flex items-center justify-between gap-3", className)}
    style={{
      padding: "10px 14px",
      borderBottom: "1px solid var(--border-faint)",
    }}
    {...props}
  />
));
PanelHeader.displayName = "PanelHeader";

const PanelTitle = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("inline-flex items-center gap-2 font-semibold text-[12px]", className)}
    style={{ color: "var(--fg)" }}
    {...props}
  />
));
PanelTitle.displayName = "PanelTitle";

const PanelBody = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn(className)} style={{ padding: "12px 14px" }} {...props} />
));
PanelBody.displayName = "PanelBody";

export { Panel, PanelBody, PanelHeader, PanelTitle };
