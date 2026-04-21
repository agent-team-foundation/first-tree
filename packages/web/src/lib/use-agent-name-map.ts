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

  // Prefer `displayName` over `name` so chat/roster render friendly
  // strings (e.g. "Alice Wang") instead of slug-form hub IDs
  // (e.g. "alice"). The slug stays available as a fallback for agents
  // with no display name set, and uuid as the last resort for soft-
  // deleted rows (`name` is cleared on delete) or agents that never had
  // either field populated.
  return useMemo(() => {
    const map = new Map<string, string>();
    if (data?.items) {
      for (const a of data.items) {
        map.set(a.uuid, a.displayName ?? a.name ?? a.uuid);
      }
    }
    return (uuid: string | null | undefined) => {
      if (!uuid) return "\u2014";
      return map.get(uuid) ?? uuid;
    };
  }, [data]);
}
