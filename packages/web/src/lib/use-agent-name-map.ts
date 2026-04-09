import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { listAgents } from "../api/agents.js";

/**
 * Shared hook that builds a UUID → name lookup map from the agents list.
 * Used by pages that display agent UUIDs (delegate mentions, participants, senders, bindings).
 *
 * Note: limited to 100 agents (API max). For deployments with more agents,
 * this should be replaced with a paginated fetch or a dedicated lookup endpoint.
 */
export function useAgentNameMap(): (uuid: string | null | undefined) => string {
  const { data } = useQuery({
    queryKey: ["agents", "name-map"],
    queryFn: () => listAgents({ limit: 100 }),
    staleTime: 30_000,
  });

  return useMemo(() => {
    const map = new Map<string, string>();
    if (data?.items) {
      for (const a of data.items) {
        map.set(a.uuid, a.name ?? a.displayName ?? a.uuid);
      }
    }
    return (uuid: string | null | undefined) => {
      if (!uuid) return "\u2014";
      return map.get(uuid) ?? uuid;
    };
  }, [data]);
}
