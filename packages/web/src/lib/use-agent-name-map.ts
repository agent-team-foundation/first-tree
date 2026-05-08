import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { listAgents, listManagedAgents } from "../api/agents.js";

/**
 * Shared hook that builds a UUID → name lookup map from the agents list.
 * Used by pages that display agent UUIDs (delegate mentions, participants, senders, bindings).
 *
 * Two sources merged:
 *   1. `/agents` — org-scoped (current selected org). Covers same-org
 *      teammates and any agent visible via the org roster.
 *   2. `/me/managed-agents` — user-scoped, cross-org. Covers agents the
 *      caller manages in non-default orgs, so a client that hosts agents
 *      from multiple orgs (e.g. the `BOUND AGENTS` panel on the Computers
 *      tab) can resolve every UUID to a real name instead of falling back
 *      to the raw UUID. The org-scoped source wins on collision since it
 *      is the more authoritative view for the currently-selected tenant.
 *
 * Note: limited to 100 agents (API max) for the org-scoped page. For
 * deployments with more agents, this should be replaced with a paginated
 * fetch or a dedicated lookup endpoint.
 */
export function useAgentNameMap(): (uuid: string | null | undefined) => string {
  const { data } = useQuery({
    queryKey: ["agents", "name-map"],
    queryFn: () => listAgents({ limit: 100 }),
    staleTime: 30_000,
  });
  const { data: managed } = useQuery({
    queryKey: ["managed-agents", "name-map"],
    queryFn: listManagedAgents,
    staleTime: 30_000,
  });

  // Post-Phase 2 of the agent-naming refactor, `displayName` is guaranteed
  // non-null by the DB (migration 0024) and the service-level default.
  // The old `a.displayName ?? a.name ?? a.uuid` fallback chain is gone —
  // any missing label now means the UUID isn't in the cached page (e.g.
  // soft-deleted, org changed mid-session), which we surface as the raw
  // uuid so the caller can at least render something stable.
  return useMemo(() => {
    const map = new Map<string, string>();
    // Cross-org managed agents first — the org-scoped source overwrites
    // them so the more authoritative roster view wins on collision.
    if (managed) {
      for (const a of managed) {
        map.set(a.uuid, a.displayName);
      }
    }
    if (data?.items) {
      for (const a of data.items) {
        map.set(a.uuid, a.displayName);
      }
    }
    return (uuid: string | null | undefined) => {
      if (!uuid) return "—";
      return map.get(uuid) ?? uuid;
    };
  }, [data, managed]);
}

/**
 * Minimal identity pair surfaced to components that want to render the
 * full `<AgentChip>` (display name + `@name`) instead of a single string.
 * `displayName` is non-null post-Phase 2 of the agent-naming refactor;
 * `name` stays nullable because soft-deleted rows have it cleared.
 */
export type AgentIdentity = {
  name: string | null;
  displayName: string;
};

/**
 * Variant of `useAgentNameMap` that returns the full `{ name, displayName }`
 * pair for a UUID, so callers can feed `<AgentChip>` without re-querying
 * the agents list. Returns `null` when the UUID is missing from both the
 * org-scoped and cross-org caches (soft-deleted, filtered out, or never
 * loaded) — callers render their own fallback.
 */
export function useAgentIdentityMap(): (uuid: string | null | undefined) => AgentIdentity | null {
  const { data } = useQuery({
    queryKey: ["agents", "name-map"],
    queryFn: () => listAgents({ limit: 100 }),
    staleTime: 30_000,
  });
  const { data: managed } = useQuery({
    queryKey: ["managed-agents", "name-map"],
    queryFn: listManagedAgents,
    staleTime: 30_000,
  });

  return useMemo(() => {
    const map = new Map<string, AgentIdentity>();
    if (managed) {
      for (const a of managed) {
        map.set(a.uuid, { name: a.name, displayName: a.displayName });
      }
    }
    if (data?.items) {
      for (const a of data.items) {
        map.set(a.uuid, { name: a.name, displayName: a.displayName });
      }
    }
    return (uuid: string | null | undefined) => {
      if (!uuid) return null;
      return map.get(uuid) ?? null;
    };
  }, [data, managed]);
}
