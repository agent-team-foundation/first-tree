import { useQuery } from "@tanstack/react-query";
import { type HubClient, listClients } from "../api/activity.js";
import { useAuth } from "../auth/auth-context.js";

export type DisconnectedSummary = {
  rows: HubClient[];
  firstHostname: string | null;
};

/**
 * Pure filter rule. Exported so the unit test can pin the contract — drift
 * here changes when the topbar warning shows up. Scope is strictly the
 * caller's own clients (no admin widening); only computers that were
 * actively serving agents and are now offline qualify.
 */
export function selectDisconnectedComputers(clients: HubClient[], userId: string): HubClient[] {
  if (!userId) return [];
  return clients.filter((c) => c.userId === userId && c.status === "disconnected" && c.agentCount > 0);
}

/**
 * Topbar-side read of `["clients"]`. Shares the cache with `ClientsPage`
 * (same query key + queryFn + refetchInterval) so the 10s poll runs once
 * for the whole app — the chip on every page and the table on `/clients`
 * see the same snapshot.
 */
export function useDisconnectedComputers(): DisconnectedSummary {
  const { user } = useAuth();
  const { data } = useQuery({
    queryKey: ["clients"],
    queryFn: listClients,
    refetchInterval: 10_000,
    enabled: !!user,
  });
  if (!data || !user) return { rows: [], firstHostname: null };
  const rows = selectDisconnectedComputers(data, user.id);
  return { rows, firstHostname: rows[0]?.hostname ?? null };
}
