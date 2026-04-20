import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { useAdminWs } from "./use-admin-ws.js";

export type PulseBucket = { workingCount: number; errorMask: boolean };

const EMPTY_BUCKETS: PulseBucket[] = Array.from({ length: 32 }, () => ({ workingCount: 0, errorMask: false }));

type PulseTick = {
  type: "pulse:tick";
  organizationId: string;
  agents: Record<string, PulseBucket[]>;
};

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

function aggregate(agents: Record<string, PulseBucket[]>): PulseBucket[] {
  const out: PulseBucket[] = Array.from({ length: 32 }, () => ({ workingCount: 0, errorMask: false }));
  for (const perAgent of Object.values(agents)) {
    for (let i = 0; i < 32 && i < perAgent.length; i++) {
      const src = perAgent[i];
      const dst = out[i];
      if (!src || !dst) continue;
      dst.workingCount += src.workingCount;
      dst.errorMask = dst.errorMask || src.errorMask;
    }
  }
  return out;
}

function isPulseTick(msg: { type: string; [k: string]: unknown }): msg is PulseTick {
  return msg.type === "pulse:tick" && typeof msg.agents === "object" && msg.agents !== null;
}

export function PulseProvider({ children }: { children: ReactNode }) {
  const [latest, setLatest] = useState<Omit<PulseState, "stale">>({
    aggregated: EMPTY_BUCKETS,
    agents: {},
    receivedAtMs: null,
  });
  const [now, setNow] = useState(() => Date.now());

  useAdminWs({
    onMessage: (msg) => {
      if (!isPulseTick(msg)) return;
      setLatest({
        aggregated: aggregate(msg.agents),
        agents: msg.agents,
        receivedAtMs: Date.now(),
      });
    },
  });

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 2_000);
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
