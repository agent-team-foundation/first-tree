import type { PresenceStatus } from "@first-tree/shared";
import { cn } from "../../lib/utils.js";
import { StatusGlyph } from "./status-glyph.js";

type PresenceChipProps = {
  status: PresenceStatus | null | undefined;
  className?: string;
};

const LABELS: Record<PresenceStatus, string> = {
  online: "Online",
  offline: "Offline",
};

/**
 * Resolve incoming `status` to a concrete `{ label, color }` view. Exported
 * so unit tests (and any future consumer that wants the same vocabulary
 * without the chip's DOM) can drive the same normalization. `null` /
 * `undefined` collapse to "offline" defensively; the server already returns
 * an `"offline"` fallback, but the Agent DTO marks the field optional.
 */
export function presenceChipView(status: PresenceStatus | null | undefined): {
  status: PresenceStatus;
  label: string;
  color: string;
} {
  const normalized: PresenceStatus = status ?? "offline";
  const color = normalized === "online" ? "var(--state-idle)" : "var(--fg-3)";
  return { status: normalized, label: LABELS[normalized], color };
}

/**
 * Two-state reachability chip for management surfaces (Team, Settings,
 * Computers). Counterpart to `StateChip`, which owns the runtime-A business
 * vocabulary (idle / working / blocked / error / offline) used in chat
 * workspace views. Field-agnostic: the *visual* element for any binary
 * reachable/not-reachable status — the data source (agent presence,
 * adapter-bot connectivity, …) is up to the caller.
 */
export function PresenceChip({ status, className }: PresenceChipProps) {
  const view = presenceChipView(status);
  return (
    <span className={cn("mono inline-flex items-center gap-1.5 text-caption", className)} style={{ color: view.color }}>
      <StatusGlyph shape="dot" colorVar={view.color} size={7} />
      {view.label}
    </span>
  );
}
