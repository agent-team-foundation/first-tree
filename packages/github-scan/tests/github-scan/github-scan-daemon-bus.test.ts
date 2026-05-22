/**
 * Phase 3c contract tests for the in-process event bus.
 *
 * The bus is the Node equivalent of `bus.rs`.
 * It fans out broker/poller events to any number of read-only subscribers
 * (HTTP SSE stream, in-process task monitors) without allowing them to
 * mutate `inbox.json`. The single-writer rule (see `daemon/bus.ts` header)
 * is covered by the fact that the module exports no store writers.
 */

import { describe, expect, it, vi } from "vitest";

import { createBus, toSseBus, type BusEvent } from "../../src/github-scan/engine/daemon/bus.js";

describe("createBus", () => {
  it("delivers events to every live subscriber in subscription order", () => {
    const bus = createBus();
    const a: BusEvent[] = [];
    const b: BusEvent[] = [];
    bus.subscribe((ev) => a.push(ev));
    bus.subscribe((ev) => b.push(ev));

    bus.publish({ kind: "activity", line: "one" });
    bus.publish({ kind: "activity", line: "two" });

    expect(a).toEqual([
      { kind: "activity", line: "one" },
      { kind: "activity", line: "two" },
    ]);
    expect(b).toEqual([
      { kind: "activity", line: "one" },
      { kind: "activity", line: "two" },
    ]);
  });

  it("returns a working unsubscribe that stops further delivery", () => {
    const bus = createBus();
    const a: BusEvent[] = [];
    const unsub = bus.subscribe((ev) => a.push(ev));

    bus.publish({ kind: "activity", line: "before" });
    unsub();
    bus.publish({ kind: "activity", line: "after" });

    expect(a).toEqual([{ kind: "activity", line: "before" }]);
    expect(bus.subscriberCount()).toBe(0);
  });

  it("snapshots subscribers before iteration so unsubscribe-during-publish still delivers", () => {
    const bus = createBus();
    const received: string[] = [];
    let unsubB: (() => void) | null = null;
    bus.subscribe((ev) => {
      if (ev.kind === "activity") received.push(`a:${ev.line}`);
      // Unsubscribe b mid-publish — Rust `retain`-style semantics keep b
      // scheduled for this delivery because we snapshotted first.
      if (unsubB) unsubB();
    });
    unsubB = bus.subscribe((ev) => {
      if (ev.kind === "activity") received.push(`b:${ev.line}`);
    });

    bus.publish({ kind: "activity", line: "snap" });
    expect(received).toEqual(["a:snap", "b:snap"]);

    bus.publish({ kind: "activity", line: "gone" });
    expect(received).toEqual(["a:snap", "b:snap", "a:gone"]);
  });

  it("isolates subscriber errors so fan-out continues (matches Rust retain-on-send)", () => {
    const errs: unknown[] = [];
    const bus = createBus({
      onListenerError: (err) => errs.push(err),
    });
    const good: BusEvent[] = [];
    bus.subscribe(() => {
      throw new Error("boom");
    });
    bus.subscribe((ev) => good.push(ev));

    bus.publish({ kind: "inbox", last_poll: "t", total: 0, new_count: 0 });

    expect(good).toHaveLength(1);
    expect(errs).toHaveLength(1);
    expect((errs[0] as Error).message).toBe("boom");
  });

  it("drops publishes after close (backpressure: subscribers must consume or be gone)", () => {
    const bus = createBus();
    const received: BusEvent[] = [];
    bus.subscribe((ev) => received.push(ev));

    bus.publish({ kind: "activity", line: "live" });
    bus.close();
    bus.publish({ kind: "activity", line: "after-close" });

    expect(received).toEqual([{ kind: "activity", line: "live" }]);
    expect(bus.isClosed()).toBe(true);
    expect(bus.subscriberCount()).toBe(0);
  });

  it("subscribe after close returns a no-op unsubscribe", () => {
    const bus = createBus();
    bus.close();
    const fn = vi.fn();
    const unsub = bus.subscribe(fn);
    bus.publish({ kind: "activity", line: "none" });
    unsub();
    expect(fn).not.toHaveBeenCalled();
  });

  it("carries broker task events with full shape", () => {
    const bus = createBus();
    const received: BusEvent[] = [];
    bus.subscribe((ev) => received.push(ev));

    bus.publish({
      kind: "task",
      phase: "dispatched",
      task_id: "task-1",
      thread_key: "repo/123",
    });
    bus.publish({
      kind: "task",
      phase: "failed",
      task_id: "task-1",
      thread_key: "repo/123",
      status: "failed",
      summary: "boom",
    });

    expect(received).toHaveLength(2);
    expect(received[0]).toMatchObject({ kind: "task", phase: "dispatched" });
    expect(received[1]).toMatchObject({
      kind: "task",
      phase: "failed",
      summary: "boom",
    });
  });
});

describe("toSseBus", () => {
  it("forwards inbox events unchanged", () => {
    const bus = createBus();
    const sse = toSseBus(bus);
    const seen: unknown[] = [];
    sse.subscribe((ev) => seen.push(ev));

    bus.publish({
      kind: "inbox",
      last_poll: "2024-01-01T00:00:00Z",
      total: 3,
      new_count: 1,
    });

    expect(seen).toEqual([
      {
        kind: "inbox",
        last_poll: "2024-01-01T00:00:00Z",
        total: 3,
        new_count: 1,
      },
    ]);
  });

  it("forwards activity events unchanged", () => {
    const bus = createBus();
    const sse = toSseBus(bus);
    const seen: unknown[] = [];
    sse.subscribe((ev) => seen.push(ev));

    bus.publish({ kind: "activity", line: '{"event":"new","id":"abc"}' });
    expect(seen).toEqual([
      { kind: "activity", line: '{"event":"new","id":"abc"}' },
    ]);
  });

  it("renders task events as compact-JSON activity lines", () => {
    const bus = createBus();
    const sse = toSseBus(bus);
    const seen: { kind: string; line?: string }[] = [];
    sse.subscribe((ev) => seen.push(ev as { kind: string; line?: string }));

    bus.publish({
      kind: "task",
      phase: "completed",
      task_id: "task-42",
      thread_key: "owner/repo/7",
      status: "handled",
      summary: "done",
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].kind).toBe("activity");
    const parsed = JSON.parse(seen[0].line!) as Record<string, unknown>;
    expect(parsed).toEqual({
      event: "task_completed",
      task_id: "task-42",
      thread_key: "owner/repo/7",
      status: "handled",
      summary: "done",
    });
  });

  it("omits optional status/summary from task activity lines when absent", () => {
    const bus = createBus();
    const sse = toSseBus(bus);
    const seen: { kind: string; line?: string }[] = [];
    sse.subscribe((ev) => seen.push(ev as { kind: string; line?: string }));

    bus.publish({
      kind: "task",
      phase: "dispatched",
      task_id: "task-7",
      thread_key: "owner/repo/5",
    });

    expect(seen).toHaveLength(1);
    const parsed = JSON.parse(seen[0].line!) as Record<string, unknown>;
    expect(parsed).toEqual({
      event: "task_dispatched",
      task_id: "task-7",
      thread_key: "owner/repo/5",
    });
  });
});
