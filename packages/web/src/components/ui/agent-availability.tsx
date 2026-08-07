import { CircleMinus } from "lucide-react";
import type { ReactNode } from "react";
import type { AgentAvailabilityView } from "../../lib/agent-availability.js";
import { cn } from "../../lib/utils.js";
import { StatusGlyph } from "./status-glyph.js";

function availabilityGlyph(view: AgentAvailabilityView): ReactNode {
  if (view.kind === "online") {
    return <StatusGlyph colorVar="var(--state-idle)" shape="dot" size={7} />;
  }
  if (view.kind === "offline") {
    return <StatusGlyph colorVar="var(--state-offline)" shape="hollow" size={7} />;
  }
  if (view.kind === "suspended") {
    return <StatusGlyph colorVar="var(--fg-4)" shape="pause" size={7} />;
  }
  if (view.kind === "needs-setup") {
    return <CircleMinus className="h-3.5 w-3.5" aria-hidden />;
  }
  return <CircleMinus className="h-3.5 w-3.5" aria-hidden />;
}

function availabilityColor(kind: AgentAvailabilityView["kind"]): string {
  if (kind === "online") return "var(--fg-2)";
  if (kind === "needs-setup") return "var(--fg-needs-you-strong)";
  return "var(--fg-3)";
}

/** One compact status label; explanatory detail stays beside it in the host. */
export function AgentAvailability({ view, className }: { view: AgentAvailabilityView; className?: string }) {
  return (
    <span
      data-agent-availability={view.kind}
      aria-live="polite"
      aria-atomic="true"
      className={cn("inline-flex items-center gap-1.5 text-caption font-medium", className)}
      style={{ color: availabilityColor(view.kind) }}
    >
      {availabilityGlyph(view)}
      {view.label}
    </span>
  );
}
