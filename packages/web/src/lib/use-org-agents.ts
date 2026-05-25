import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { listAgents } from "../api/agents.js";

type PaginatedAgents = Awaited<ReturnType<typeof listAgents>>;

/**
 * Shared cache for `GET /orgs/:orgId/agents?limit=100` — the org-wide agent
 * roster used by the participant picker, the `[+]` add-member dropdown, the
 * identity-map hooks (UUID → name / slug / chip), and the bindings page.
 *
 * Centralising on a single `queryKey` (`["agents", "org-list"]`) is the
 * point: prior to this hook the picker used `["org-agents"]` while the
 * identity-map hooks used `["agents", "name-map"]`, so React Query held two
 * independent caches for the same HTTP request — two GETs on mount and two
 * 30-second poll cycles. See issue 495.
 *
 * The `["agents", …]` prefix is intentional: agent mutation flows (create
 * in `new-agent-dialog.tsx`, rebind in `re-bind-dialog.tsx`, role/visibility
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
 * above that threshold need pagination at the consumer level.
 */
export function useOrgAgents(): UseQueryResult<PaginatedAgents> {
  return useQuery({
    queryKey: ["agents", "org-list"],
    queryFn: () => listAgents({ limit: 100 }),
    refetchInterval: 30_000,
    staleTime: 30_000,
  });
}
