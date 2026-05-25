import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { listAgents } from "../api/agents.js";

type PaginatedAgents = Awaited<ReturnType<typeof listAgents>>;

/**
 * Shared cache for `GET /orgs/:orgId/agents?limit=100` — the org-wide agent
 * roster used by the participant picker, the `[+]` add-member dropdown, the
 * identity-map hooks (UUID → name / slug / chip), and the bindings page.
 *
 * Centralising on a single `queryKey` (`["org-agents"]`) is the point: prior
 * to this hook the picker used `["org-agents"]` while the identity-map hooks
 * used `["agents", "name-map"]`, so React Query held two independent caches
 * for the same HTTP request — two GETs on mount and two 30-second poll
 * cycles. See issue 495.
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
    queryKey: ["org-agents"],
    queryFn: () => listAgents({ limit: 100 }),
    refetchInterval: 30_000,
    staleTime: 30_000,
  });
}
