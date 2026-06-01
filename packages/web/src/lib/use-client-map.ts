import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { type HubClient, listClients } from "../api/activity.js";

/**
 * Shared hook that builds a clientId → client lookup map.
 * Used by Workspace (Agent Roster, Context Panel) and Agents page
 * to display client hostname, OS, SDK version, etc.
 */
export function useClientMap(): {
  resolve: (clientId: string | null | undefined) => HubClient | null;
  clients: HubClient[];
  connectedClients: HubClient[];
} {
  const { data } = useQuery({
    queryKey: ["clients"],
    queryFn: listClients,
    staleTime: 10_000,
    refetchInterval: 10_000,
  });

  return useMemo(() => {
    const list = data ?? [];
    const map = new Map<string, HubClient>();
    for (const c of list) {
      map.set(c.id, c);
    }
    return {
      resolve: (clientId: string | null | undefined) => {
        if (!clientId) return null;
        return map.get(clientId) ?? null;
      },
      clients: list,
      connectedClients: list.filter((c) => c.status === "connected"),
    };
  }, [data]);
}
