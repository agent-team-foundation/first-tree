import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { listAgents } from "../api/agents.js";

type PaginatedAgents = Awaited<ReturnType<typeof listAgents>>;

/**
 * Shared cache for `GET /orgs/:orgId/agents?limit=100` — the org-wide agent
 * roster used by identity-map hooks (UUID → name / slug / chip), navigation,
 * and picker surfaces that do not request the active-only addressable view.
 *
 * Centralising under the `["agents", "org-list"]` prefix is the
 * point: prior to this hook the picker used `["org-agents"]` while the
 * identity-map hooks used `["agents", "name-map"]`, so React Query held two
 * independent caches for the same HTTP request — two GETs on mount and two
 * 30-second poll cycles. See issue 495.
 *
 * The `["agents", …]` prefix is intentional: agent mutation flows (create
 * in `new-agent-dialog.tsx`, role/visibility
 * changes in `team/index.tsx`, etc.) call `invalidateQueries({ queryKey:
 * ["agents"] })` to force a roster refetch instead of waiting on the poll.
 * Sharing that prefix keeps pickers and name-maps in step with those
 * mutations (and incidentally fixes the picker's pre-existing miss — its
 * old `["org-agents"]` key wasn't matched by `["agents"]` either).
 *
 * Polling cadence (`refetchInterval: 30_000`) is inherited from the picker:
 * the participants header needs the freshest roster so newly-added agents
 * appear without a manual refresh. `staleTime: 30_000` keeps mount/focus
 * refetches in step with the poll tick — without it, a freshly-mounted
 * consumer would kick off an extra fetch right after a recent poll.
 *
 * `limit: 100` is the server's enforced cap in `paginationQuerySchema`; orgs
 * above that threshold reach agents past the first page via
 * {@link useOrgAgentsSearch} (issue 494).
 */
export function useOrgAgents(options?: {
  enabled?: boolean;
  addressableOnly?: boolean;
}): UseQueryResult<PaginatedAgents> {
  const addressableOnly = options?.addressableOnly ?? false;
  return useQuery({
    queryKey: ["agents", "org-list", { addressableOnly }],
    queryFn: () => listAgents({ limit: 100, addressableOnly }),
    refetchInterval: 30_000,
    staleTime: 30_000,
    enabled: options?.enabled ?? true,
  });
}

/**
 * Server-side substring search over the org's visible agents. Backs the
 * participant pickers (chat-header `[+]`, right-sidebar `[+]`,
 * new-chat-draft chip picker, new-chat-draft textarea `@` autocomplete) so
 * orgs above the 100-row first-page cap can still surface every addable
 * agent (issue 494).
 *
 * Distinct from {@link useOrgAgents}: this hook keys on the query string so
 * each typed term has its own cache entry, and it does NOT poll — picker
 * results are pulled on demand, not on a background tick. Empty query
 * (after trimming) is short-circuited to the cached first page so picker
 * open never round-trips for the small-org default case.
 *
 * Caller is responsible for debouncing the input — wiring this directly to
 * an onChange handler would issue one fetch per keystroke.
 */
export function useOrgAgentsSearch(
  query: string,
  options?: { addressableOnly?: boolean },
): UseQueryResult<PaginatedAgents> {
  const trimmed = query.trim();
  const addressableOnly = options?.addressableOnly ?? false;
  const unfiltered = useOrgAgents({ addressableOnly });
  const search = useQuery({
    queryKey: ["agents", "org-list", { addressableOnly }, "search", trimmed],
    queryFn: () => listAgents({ limit: 100, query: trimmed, addressableOnly }),
    // Search results stay fresh briefly so re-opening the picker with the
    // same term doesn't re-hit the server; expire fast enough that a newly
    // added agent shows up under search within a reasonable window.
    staleTime: 10_000,
    enabled: trimmed.length > 0,
  });
  return trimmed.length > 0 ? search : unfiltered;
}
