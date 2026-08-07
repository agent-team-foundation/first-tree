import type { EffectiveResourceRow } from "@first-tree/shared";

/**
 * Stable effective-rule labels for Agent Detail rows. They describe why the
 * item applies to this agent, not who happens to be viewing the page. Historical
 * Template provenance remains available separately in `templateSourceLabel`.
 */
export function sourceLabel(source: EffectiveResourceRow["source"]): string {
  if (source === "inline_prompt") return "Custom for this agent";
  if (source === "agent_extra") return "Added to this agent";
  if (source === "team_available") return "Enabled for this agent";
  return "Team default";
}

/**
 * Historical-origin label for a Resource that was imported from an official
 * Agent Template. The Template is only the one-time starting point — the Team
 * copy is the maintained authority afterwards. `templateName` may be unknown
 * (Template deleted or summary unavailable); fall back to non-leaking copy.
 */
export function templateSourceLabel(templateName: string | null): string {
  return `Imported from ${templateName ?? "a template"} · maintained by your team`;
}
