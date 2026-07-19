import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Notifier, RuntimeStateChangeHandler } from "../services/notifier.js";
import { createPulseAggregator } from "../services/pulse-aggregator.js";

/**
 * Batch B / S8 — pulse-aggregator unit coverage.
 *
 * These fixtures exercise the aggregator directly via its `ingest` method,
 * avoiding the PG NOTIFY round-trip. They lock down:
 *   1. bucket counting (working++ / errorMask)
 *   2. ring rotation and head-bucket reset
 *   3. cross-org isolation at the broadcast boundary
 *   4. start/stop lifecycle (ingest is a no-op when stopped)
 */

type BroadcastFn = ReturnType<typeof vi.fn>;

function makeMockNotifier(): {
  notifier: Notifier;
  triggerRuntimeState: RuntimeStateChangeHandler;
} {
  const handlers: RuntimeStateChangeHandler[] = [];
  const notifier = {
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    notify: vi.fn(async () => {}),
    notifyConfigChange: vi.fn(async () => {}),
    notifySessionStateChange: vi.fn(async () => {}),
    notifyRuntimeStateChange: vi.fn(async () => {}),
    notifySessionRuntime: vi.fn(async () => {}),
    notifyChatMessage: vi.fn(async () => {}),
    notifyChatAudience: vi.fn(async () => {}),
    notifyChatUpdated: vi.fn(async () => {}),
    notifyMeChatsChanged: vi.fn(async () => {}),
    notifyAgentRouteChange: vi.fn(async () => {}),
    notifyDaemonClientCommand: vi.fn(async () => {}),
    notifyDaemonClientCommandResult: vi.fn(async () => {}),
    notifySessionEvent: vi.fn(async () => {}),
    pushFrameToInbox: vi.fn(async () => 0),
    onConfigChange: vi.fn(),
    onSessionStateChange: vi.fn(),
    onSessionEvent: vi.fn(),
    onRuntimeStateChange: vi.fn((handler: RuntimeStateChangeHandler) => {
      handlers.push(handler);
    }),
    onSessionRuntime: vi.fn(),
    onChatMessage: vi.fn(),
    onChatAudience: vi.fn(),
    onChatUpdated: vi.fn(),
    onMeChatsChanged: vi.fn(),
    onAgentRouteChange: vi.fn(),
    onDaemonClientCommand: vi.fn(),
    onDaemonClientCommandResult: vi.fn(),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  } satisfies Notifier;
  const triggerRuntimeState: RuntimeStateChangeHandler = (payload) => {
    for (const handler of handlers) handler(payload);
  };
  return { notifier, triggerRuntimeState };
}

describe("createPulseAggregator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts working++ and raises errorMask in the current bucket", () => {
    const broadcast: BroadcastFn = vi.fn();
    const { notifier } = makeMockNotifier();
    const agg = createPulseAggregator({ notifier, broadcast, intervalMs: 5000, bucketCount: 32 });
    agg.start();

    for (let i = 0; i < 3; i += 1) {
      agg.ingest({ agentId: "a1", state: "working", organizationId: "org-A" });
    }
    agg.ingest({ agentId: "a1", state: "error", organizationId: "org-A" });
    agg.ingest({ agentId: "a1", state: "error", organizationId: "org-A" });

    vi.advanceTimersByTime(5000); // fire one tick → broadcast snapshot then advance

    expect(broadcast).toHaveBeenCalledTimes(1);
    const frame = broadcast.mock.calls[0]?.[0] as {
      organizationId: string;
      agents: Record<string, Array<{ workingCount: number; errorMask: boolean }>>;
    };
    expect(frame.organizationId).toBe("org-A");
    const buckets = frame.agents.a1;
    expect(buckets).toBeDefined();
    // Time-ordered: the just-finished bucket sits at the last index.
    expect(buckets?.[31]).toEqual({ workingCount: 3, errorMask: true });

    agg.stop();
  });

  it("rotates the ring on each tick and resets the new head", () => {
    const broadcast: BroadcastFn = vi.fn();
    const { notifier } = makeMockNotifier();
    const agg = createPulseAggregator({ notifier, broadcast, intervalMs: 5000, bucketCount: 4 });
    agg.start();

    agg.ingest({ agentId: "a1", state: "working", organizationId: "org-A" });
    vi.advanceTimersByTime(5000); // tick 1: idx 0 → 1, reset idx 1
    agg.ingest({ agentId: "a1", state: "working", organizationId: "org-A" });
    vi.advanceTimersByTime(5000); // tick 2: idx 1 → 2, reset idx 2

    expect(broadcast).toHaveBeenCalledTimes(2);
    const second = broadcast.mock.calls[1]?.[0] as {
      agents: Record<string, Array<{ workingCount: number; errorMask: boolean }>>;
    };
    const buckets = second.agents.a1 ?? [];
    // Time-ordered output: [oldest … newest].
    // tick 2 (currentIdx=1): newest bucket (index 3) is the one just finished,
    // previous spike (tick 1 data) drifted one slot left to index 2.
    expect(buckets[0]?.workingCount).toBe(0);
    expect(buckets[1]?.workingCount).toBe(0);
    expect(buckets[2]?.workingCount).toBe(1);
    expect(buckets[3]?.workingCount).toBe(1);

    agg.stop();
  });

  it("broadcasts a separate frame per org with no cross-org bleed", () => {
    const broadcast: BroadcastFn = vi.fn();
    const { notifier } = makeMockNotifier();
    const agg = createPulseAggregator({ notifier, broadcast, intervalMs: 5000, bucketCount: 4 });
    agg.start();

    agg.ingest({ agentId: "a1", state: "working", organizationId: "org-A" });
    agg.ingest({ agentId: "b1", state: "error", organizationId: "org-B" });

    vi.advanceTimersByTime(5000);

    expect(broadcast).toHaveBeenCalledTimes(2);
    const frames = broadcast.mock.calls.map((c) => c[0] as { organizationId: string; agents: Record<string, unknown> });
    const a = frames.find((f) => f.organizationId === "org-A");
    const b = frames.find((f) => f.organizationId === "org-B");
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(Object.keys(a?.agents ?? {})).toEqual(["a1"]);
    expect(Object.keys(b?.agents ?? {})).toEqual(["b1"]);

    agg.stop();
  });

  it("drops ingest and stops ticking after stop()", () => {
    const broadcast: BroadcastFn = vi.fn();
    const { notifier } = makeMockNotifier();
    const agg = createPulseAggregator({ notifier, broadcast, intervalMs: 5000, bucketCount: 4 });
    agg.start();

    agg.ingest({ agentId: "a1", state: "working", organizationId: "org-A" });
    vi.advanceTimersByTime(5000);
    expect(broadcast).toHaveBeenCalledTimes(1);

    agg.stop();
    agg.ingest({ agentId: "a1", state: "working", organizationId: "org-A" });
    vi.advanceTimersByTime(10000);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it("forwards notifier runtime-state events through ingest", () => {
    const broadcast: BroadcastFn = vi.fn();
    const { notifier, triggerRuntimeState } = makeMockNotifier();
    const agg = createPulseAggregator({ notifier, broadcast, intervalMs: 5000, bucketCount: 4 });
    agg.start();

    triggerRuntimeState({ agentId: "a1", state: "working", organizationId: "org-A" });
    triggerRuntimeState({ agentId: "a1", state: "error", organizationId: "org-A" });

    vi.advanceTimersByTime(5000);

    expect(broadcast).toHaveBeenCalledTimes(1);
    const frame = broadcast.mock.calls[0]?.[0] as {
      agents: Record<string, Array<{ workingCount: number; errorMask: boolean }>>;
    };
    expect(frame.agents.a1?.[3]).toEqual({ workingCount: 1, errorMask: true });

    agg.stop();
  });
});
