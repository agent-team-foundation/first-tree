import type { PulseBucket } from "@agent-team-foundation/first-tree-hub-shared";
import type { AdminBroadcastPayload } from "./admin-broadcast.js";
import type { Notifier, RuntimeStateChangeHandler } from "./notifier.js";

/**
 * NC1 pulse aggregator.
 *
 * Holds an in-memory ring of `bucketCount` PulseBuckets per (org, agent).
 * Every `intervalMs` tick:
 *   1. broadcast the current snapshot to each org's admin sockets
 *   2. advance the ring index and reset the new head bucket
 *
 * Consumers (pulse-bar.tsx in S9) render the 32 buckets as a rolling
 * 5-minute heartbeat. Lazy-init keeps the aggregator decoupled from the
 * DB: the first runtime-state change for an (org, agent) conjures its
 * 32-slot ring.
 */

export type PulseAggregatorIngest = {
  agentId: string;
  state: string;
  organizationId: string;
};

export type PulseAggregatorOptions = {
  notifier: Notifier;
  broadcast: (payload: AdminBroadcastPayload) => void;
  intervalMs?: number;
  bucketCount?: number;
};

export type PulseAggregator = {
  start(): void;
  stop(): void;
  ingest(payload: PulseAggregatorIngest): void;
};

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_BUCKET_COUNT = 32;

export function createPulseAggregator(options: PulseAggregatorOptions): PulseAggregator {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const bucketCount = options.bucketCount ?? DEFAULT_BUCKET_COUNT;
  const state = new Map<string, Map<string, PulseBucket[]>>();
  let currentIdx = 0;
  let running = false;
  let intervalHandle: ReturnType<typeof setInterval> | null = null;

  function emptyBucket(): PulseBucket {
    return { workingCount: 0, errorMask: false };
  }
  function initBuckets(): PulseBucket[] {
    return Array.from({ length: bucketCount }, emptyBucket);
  }
  function ensureAgent(organizationId: string, agentId: string): PulseBucket[] {
    let orgMap = state.get(organizationId);
    if (!orgMap) {
      orgMap = new Map();
      state.set(organizationId, orgMap);
    }
    let buckets = orgMap.get(agentId);
    if (!buckets) {
      buckets = initBuckets();
      orgMap.set(agentId, buckets);
    }
    return buckets;
  }

  const ingest: RuntimeStateChangeHandler = (payload) => {
    if (!running) return;
    if (!payload.organizationId || !payload.agentId) return;
    const buckets = ensureAgent(payload.organizationId, payload.agentId);
    const bucket = buckets[currentIdx];
    if (!bucket) return;
    if (payload.state === "working") {
      bucket.workingCount += 1;
    } else if (payload.state === "error") {
      bucket.errorMask = true;
    }
  };

  function snapshotBuckets(buckets: PulseBucket[]): PulseBucket[] {
    // Re-order ring buffer → time-ordered [oldest … newest] so clients can
    // render left-to-right without knowing currentIdx. The just-finished
    // bucket sits at currentIdx (newest, placed last); the next-to-be-cleared
    // bucket at (currentIdx + 1) is oldest, placed first.
    const out: PulseBucket[] = [];
    for (let i = 0; i < bucketCount; i++) {
      const idx = (currentIdx + 1 + i) % bucketCount;
      const src = buckets[idx] ?? emptyBucket();
      out.push({ workingCount: src.workingCount, errorMask: src.errorMask });
    }
    return out;
  }

  function broadcastTick() {
    for (const [organizationId, orgMap] of state) {
      const agents: Record<string, PulseBucket[]> = {};
      for (const [agentId, buckets] of orgMap) {
        agents[agentId] = snapshotBuckets(buckets);
      }
      options.broadcast({ type: "pulse:tick", organizationId, agents });
    }
  }

  function advance() {
    broadcastTick();
    currentIdx = (currentIdx + 1) % bucketCount;
    for (const orgMap of state.values()) {
      for (const buckets of orgMap.values()) {
        buckets[currentIdx] = emptyBucket();
      }
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      options.notifier.onRuntimeStateChange(ingest);
      intervalHandle = setInterval(advance, intervalMs);
    },
    stop() {
      if (!running) return;
      running = false;
      if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = null;
      }
    },
    ingest,
  };
}
