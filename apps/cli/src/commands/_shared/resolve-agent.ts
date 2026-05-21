import { fail } from "../../cli/output.js";
import { cliFetch } from "../../core/cli-fetch.js";

export type ResolvedAgent = { uuid: string; name: string | null; displayName: string | null };

/**
 * Look up an agent the caller manages by name (or UUID) via
 * `GET /me/managed-agents`. Cross-org by design — multi-org users do not
 * need a per-command `--org` flag to dispatch agent-scoped operations.
 */
export async function resolveAgent(serverUrl: string, adminToken: string, agentName: string): Promise<ResolvedAgent> {
  const res = await cliFetch(`${serverUrl}/api/v1/me/managed-agents`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    fail("FETCH_ERROR", `Failed to list agents: ${res.status}`, 1);
  }
  const items = (await res.json()) as ResolvedAgent[];
  const found = items.find((a) => a.name === agentName || a.uuid === agentName);
  if (!found) {
    fail("NOT_FOUND", `Agent "${agentName}" not found`, 1);
  }
  return found;
}
