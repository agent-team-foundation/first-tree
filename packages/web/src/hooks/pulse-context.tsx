import { type PulseBucket, pulseTickSchema } from "@agent-team-foundation/first-tree-hub-shared";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { aggregate, EMPTY_BUCKETS } from "./pulse-aggregate.js";
import { useAdminWs } from "./use-admin-ws.js";

export type { PulseBucket };

type PulseState = {
  aggregated: PulseBucket[];
  agents: Record<string, PulseBucket[]>;
  receivedAtMs: number | null;
  stale: boolean;
};

const PulseContext = createContext<PulseState>({
  aggregated: EMPTY_BUCKETS,
  agents: {},
  receivedAtMs: null,
  stale: true,
});

export function PulseProvider({ children }: { children: ReactNode }) {
  const [latest, setLatest] = useState<Omit<PulseState, "stale">>({
    aggregated: EMPTY_BUCKETS,
    agents: {},
    receivedAtMs: null,
  });
  const [now, setNow] = useState(() => Date.now());

  useAdminWs({
    onMessage: (msg) => {
      const parsed = pulseTickSchema.safeParse(msg);
      if (!parsed.success) return;
      setLatest({
        aggregated: aggregate(parsed.data.agents),
        agents: parsed.data.agents,
        receivedAtMs: Date.now(),
      });
    },
  });

  useEffect(() => {
    // 10s cadence is enough to flip `stale` (threshold = 30s); 2s burned re-renders for no gain.
    const id = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(id);
  }, []);

  const value = useMemo<PulseState>(
    () => ({
      ...latest,
      stale: latest.receivedAtMs === null || now - latest.receivedAtMs > 30_000,
    }),
    [latest, now],
  );

  return <PulseContext.Provider value={value}>{children}</PulseContext.Provider>;
}

export function usePulse(): PulseState {
  return useContext(PulseContext);
}
