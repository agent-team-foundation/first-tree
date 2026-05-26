import { useEffect, useState } from "react";

/**
 * A wall-clock `Date.now()` that re-renders the caller every `intervalMs`.
 * Used by the per-(agent,chat) status surfaces to self-clear a "working" chip
 * exactly at its `activity.staleAt` (via `clearStaleWorking`) without waiting
 * for the next server refetch. Mount-once interval; no network.
 */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
