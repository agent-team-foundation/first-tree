import type { CapabilityEntry, RuntimeProvider } from "@first-tree/shared";
import type { ReactNode } from "react";
import { PROVIDER_LABEL } from "./providers.js";

/**
 * Hairline-separated group with dimmed text. Used by AuthExpired and
 * Offline to render "stale context" sections (runtimes / agents that
 * were observed before the machine went silent). Visually quieter
 * than the Ready card's Group so the primary action stays the focus.
 */
export function DimmedGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      className="flex flex-col"
      style={{
        gap: "var(--sp-1_5)",
        padding: "var(--sp-2_5) 0 0",
        borderTop: "var(--hairline) solid var(--border-faint)",
        opacity: 0.7,
      }}
    >
      <div className="text-caption" style={{ color: "var(--fg-3)" }}>
        {label}
      </div>
      {children}
    </div>
  );
}

/**
 * "(last reported)" runtime line. No action affordance — the machine
 * isn't checking in, so the operator can't directly act on the runtime
 * state. Pure status snapshot from the last successful probe.
 *
 * Used by AuthExpired and Offline card bodies. Distinct from the Ready
 * card's RuntimeStateLine which renders action hints inline; here we
 * never tell the user what to do because they can't reach the machine
 * to do it.
 */
export function StaleRuntimeLine({ provider, entry }: { provider: RuntimeProvider; entry: CapabilityEntry }) {
  const label = PROVIDER_LABEL[provider];
  const glyph =
    entry.state === "ok" ? "✓" : entry.state === "unauthenticated" ? "⚠" : entry.state === "missing" ? "✗" : "!";
  const segments: string[] = [label];
  if (entry.sdkVersion) segments.push(`v${entry.sdkVersion}`);
  if (entry.state === "ok" && entry.authMethod) segments.push(entry.authMethod);
  else if (entry.state === "unauthenticated") segments.push("unauthenticated");
  else if (entry.state === "missing") segments.push("not installed");
  else if (entry.state === "error") segments.push(entry.error ?? "probe failed");
  return (
    <div className="text-body" style={{ color: "var(--fg-2)" }}>
      <span style={{ color: "var(--fg-4)" }}>{glyph}</span> {segments.join(" · ")}
    </div>
  );
}
