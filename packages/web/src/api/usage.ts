import type { UsageAgentSummary, UsageByAgentResponse, UsageTurnsResponse } from "@first-tree/shared";
import { api, withOrg } from "./client.js";

/**
 * Token-usage aggregation API. Backed by the endpoints introduced in the
 * backend PR (`packages/server/src/services/usage.ts`). All windows are
 * computed server-side; the client passes `from/to` as ISO strings.
 */

export type UsageWindow = "7d" | "30d";

export function windowToDays(w: UsageWindow): number {
  return w === "7d" ? 7 : 30;
}

function windowQuery(w: UsageWindow): string {
  const to = new Date();
  const from = new Date(to.getTime() - windowToDays(w) * 24 * 60 * 60 * 1000);
  return `?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`;
}

/** Per-agent aggregate, used by the Team page Usage column. */
export function getOrgUsageByAgent(window: UsageWindow): Promise<UsageByAgentResponse> {
  return api.get<UsageByAgentResponse>(withOrg(`/usage/by-agent${windowQuery(window)}`));
}

/** Single-agent summary: window totals + trailing-90d activity grid. */
export function getAgentUsageSummary(agentId: string, window: UsageWindow): Promise<UsageAgentSummary> {
  return api.get<UsageAgentSummary>(`/agents/${encodeURIComponent(agentId)}/usage/summary${windowQuery(window)}`);
}

/** Paginated per-turn list. `cursor` is opaque (base64url ISO timestamp). */
export function getAgentUsageTurns(
  agentId: string,
  args: { window: UsageWindow; cursor?: string | null; limit?: number },
): Promise<UsageTurnsResponse> {
  const wq = windowQuery(args.window).slice(1); // strip leading "?"
  const parts = [wq];
  if (args.cursor) parts.push(`cursor=${encodeURIComponent(args.cursor)}`);
  if (args.limit) parts.push(`limit=${args.limit}`);
  return api.get<UsageTurnsResponse>(`/agents/${encodeURIComponent(agentId)}/usage/turns?${parts.join("&")}`);
}
