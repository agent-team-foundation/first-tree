import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "../../lib/utils.js";

const Panel = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("overflow-hidden", className)}
    style={{
      background: "var(--bg-raised)",
      border: "var(--hairline) solid var(--border)",
      borderRadius: "var(--radius-panel)",
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
      padding: "var(--sp-2_5) var(--sp-3_5)",
      borderBottom: "var(--hairline) solid var(--border-faint)",
    }}
    {...props}
  />
));
PanelHeader.displayName = "PanelHeader";

const PanelTitle = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("inline-flex items-center gap-2 text-body font-semibold", className)}
    style={{ color: "var(--fg)" }}
    {...props}
  />
));
PanelTitle.displayName = "PanelTitle";

const PanelBody = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn(className)} style={{ padding: "var(--sp-3) var(--sp-3_5)" }} {...props} />
));
PanelBody.displayName = "PanelBody";

export { Panel, PanelBody, PanelHeader, PanelTitle };
