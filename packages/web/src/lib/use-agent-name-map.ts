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
  // strings (e.g. "Alice Wang") instead of slug-form agent names
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

/**
 * Minimal identity pair surfaced to components that want to render the
 * full `<AgentChip>` (display name + `@name`) instead of a single string.
 */
export type AgentIdentity = {
  name: string | null;
  displayName: string | null;
};

/**
 * Variant of `useAgentNameMap` that returns the full `{ name, displayName }`
 * pair for a UUID, so callers can feed `<AgentChip>` without re-querying
 * the agents list. Returns `null` when the UUID is missing from the cached
 * list (soft-deleted, filtered out, or org changed mid-session) \u2014 callers
 * render their own fallback.
 */
export function useAgentIdentityMap(): (uuid: string | null | undefined) => AgentIdentity | null {
  const { data } = useQuery({
    queryKey: ["agents", "name-map"],
    queryFn: () => listAgents({ limit: 100 }),
    staleTime: 30_000,
  });

  return useMemo(() => {
    const map = new Map<string, AgentIdentity>();
    if (data?.items) {
      for (const a of data.items) {
        map.set(a.uuid, { name: a.name, displayName: a.displayName });
      }
    }
    return (uuid: string | null | undefined) => {
      if (!uuid) return null;
      return map.get(uuid) ?? null;
    };
  }, [data]);
}
