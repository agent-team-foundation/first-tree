import { type QueryClient, useQuery } from "@tanstack/react-query";

/**
 * A cache of participant `uuid -> displayName` learned from
 * `useOrgAgentsSearch` result rows, held INSIDE react-query so it shares the
 * org/auth lifecycle: a `queryClient.clear()` on organization switch or logout
 * wipes it like every other cached query, and it is never a second,
 * un-invalidated source of truth living at module scope.
 *
 * Its only job is a FALLBACK label for an identity the authoritative
 * `useAgentNameMap` cannot resolve — one that sorts past the org-list 100-row
 * first page, exactly who the at-scale participant search reaches. Chip
 * consumers always PREFER the authoritative map (so a rename, which invalidates
 * `["agents"]` and refreshes the map, immediately wins) and read this cache
 * only for ids the map still returns unresolved.
 */
const PARTICIPANT_NAME_CACHE_KEY = ["participant-name-cache"] as const;
type NameMap = Readonly<Record<string, string>>;

/** Record the display names seen in a participant search result set. */
export function rememberParticipantNames(
  queryClient: QueryClient,
  agents: ReadonlyArray<{ uuid: string; displayName: string }>,
): void {
  queryClient.setQueryData<NameMap>(PARTICIPANT_NAME_CACHE_KEY, (prev) => {
    const base = prev ?? {};
    let next: Record<string, string> | null = null;
    for (const agent of agents) {
      if (agent.displayName && base[agent.uuid] !== agent.displayName) {
        next = next ?? { ...base };
        next[agent.uuid] = agent.displayName;
      }
    }
    return next ?? base;
  });
}

/** Subscribe to the fallback cache; returns a resolver `uuid -> name | undefined`. */
export function useParticipantNames(): (uuid: string) => string | undefined {
  const { data } = useQuery<NameMap>({
    queryKey: PARTICIPANT_NAME_CACHE_KEY,
    queryFn: () => ({}),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  });
  return (uuid: string) => data?.[uuid];
}
