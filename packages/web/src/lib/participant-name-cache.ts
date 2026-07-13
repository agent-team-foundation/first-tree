import { useSyncExternalStore } from "react";

/**
 * A tiny session-lifetime cache of participant `uuid -> displayName`, populated
 * from `useOrgAgentsSearch` result rows.
 *
 * The Participants filter is search-only, so a viewer can select an identity
 * that sorts past the org-list 100-row first page — exactly who the at-scale
 * search exists to reach. `useAgentNameMap` only knows that first page, so
 * without this cache such a selection renders as a raw UUID on its filter chips
 * the moment it leaves the visible result rows: in the rail's persistent chip
 * row, and in the popover chip after the panel closes and reopens (the picking
 * component unmounts each time). This cache lives at module scope so a name
 * learned from any search survives those remounts and is shared by both chip
 * surfaces; it falls back to the identity map for names it has never seen.
 */
const names = new Map<string, string>();
const listeners = new Set<() => void>();
// A fresh snapshot identity on every change so `useSyncExternalStore` re-renders;
// stable between changes so `getSnapshot` never loops.
let snapshot: ReadonlyMap<string, string> = new Map(names);

function emit(): void {
  snapshot = new Map(names);
  for (const listener of listeners) listener();
}

/** Record display names seen in a search result set. Idempotent + no-op if unchanged. */
export function rememberParticipantNames(agents: ReadonlyArray<{ uuid: string; displayName: string }>): void {
  let changed = false;
  for (const agent of agents) {
    if (agent.displayName && names.get(agent.uuid) !== agent.displayName) {
      names.set(agent.uuid, agent.displayName);
      changed = true;
    }
  }
  if (changed) emit();
}

/** Test-only: clear the module cache so cases don't leak names into each other. */
export function __resetParticipantNameCacheForTests(): void {
  names.clear();
  emit();
}

/** Subscribe to the cache; returns a resolver `uuid -> name | undefined`. */
export function useParticipantNames(): (uuid: string) => string | undefined {
  const map = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
    () => snapshot,
  );
  return (uuid: string) => map.get(uuid);
}
