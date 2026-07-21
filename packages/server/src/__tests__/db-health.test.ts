import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDbHealthChecker } from "../services/db-health.js";

/**
 * Pure unit tests for the shared cached DB probe — no app, no real DB.
 * Uses fake timers; the runner re-uses worker processes (vitest
 * `isolate: false`), so `afterEach` MUST restore real timers.
 */

const TTL_MS = 5_000;
const PROBE_TIMEOUT_MS = 2_000;

function makeDb(execute: ReturnType<typeof vi.fn>) {
  // The checker only ever calls `db.execute`; a one-method double stands in
  // for the full Drizzle instance.
  return { execute } as never;
}

describe("createDbHealthChecker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("serves cached result within TTL without re-querying", async () => {
    const execute = vi.fn(async () => [{ one: 1 }]);
    const checker = createDbHealthChecker(makeDb(execute));

    const first = await checker.check();
    expect(first).toEqual({ ok: true, checkedAt: expect.any(String), latencyMs: expect.any(Number) });

    const second = await checker.check();
    expect(second).toBe(first);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("re-probes after TTL expiry", async () => {
    const execute = vi.fn(async () => [{ one: 1 }]);
    const checker = createDbHealthChecker(makeDb(execute));

    await checker.check();
    await vi.advanceTimersByTimeAsync(TTL_MS + 1);
    const result = await checker.check();

    expect(result.ok).toBe(true);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent checks into a single in-flight probe", async () => {
    let release: ((rows: unknown) => void) | undefined;
    const execute = vi.fn(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const checker = createDbHealthChecker(makeDb(execute));

    const firstCall = checker.check();
    const secondCall = checker.check();
    release?.([{ one: 1 }]);
    const [first, second] = await Promise.all([firstCall, secondCall]);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
    expect(first.ok).toBe(true);
  });

  it("caches failure and fails fast within TTL", async () => {
    const execute = vi.fn(async () => {
      throw new Error("db unavailable");
    });
    const checker = createDbHealthChecker(makeDb(execute));

    const first = await checker.check();
    expect(first.ok).toBe(false);

    const second = await checker.check();
    expect(second.ok).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("times out a hanging probe after timeoutMs and reports not ok", async () => {
    const execute = vi.fn(() => new Promise(() => {}));
    const checker = createDbHealthChecker(makeDb(execute));

    const pending = checker.check();
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);
    const result = await pending;

    expect(result.ok).toBe(false);
    expect(result.latencyMs).toBeUndefined();
  });

  it("does not spawn a second probe while one is in flight across TTL windows", async () => {
    const execute = vi.fn(() => new Promise(() => {}));
    const checker = createDbHealthChecker(makeDb(execute));

    // Three callers spread across three TTL windows, all while the first
    // probe hangs (postgres-js connect_timeout can hold it for ~30s). Each
    // times out against the SAME probe; none may spawn a second one.
    for (let window = 0; window < 3; window++) {
      const pending = checker.check();
      await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);
      expect((await pending).ok).toBe(false);
      await vi.advanceTimersByTimeAsync(TTL_MS + 1);
    }

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("writes the settled result to cache after a timed-out probe eventually resolves", async () => {
    let release: ((rows: { one: number }[]) => void) | undefined;
    const execute = vi.fn(async () => [{ one: 1 }]);
    execute.mockImplementationOnce(
      () =>
        new Promise<{ one: number }[]>((resolve) => {
          release = resolve;
        }),
    );
    const checker = createDbHealthChecker(makeDb(execute));

    // Caller times out; the failure is cached but the probe keeps flying.
    const pending = checker.check();
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);
    expect((await pending).ok).toBe(false);

    // The probe settles late: its real result overwrites the cached failure
    // (last-write-wins) without any new probe being spawned.
    release?.([{ one: 1 }]);
    await vi.advanceTimersByTimeAsync(0);
    const settled = await checker.check();
    expect(settled.ok).toBe(true);
    expect(settled.latencyMs).toBe(PROBE_TIMEOUT_MS);
    expect(execute).toHaveBeenCalledTimes(1);

    // The slot was released on settle: after TTL expiry the next caller can
    // start a fresh probe again.
    await vi.advanceTimersByTimeAsync(TTL_MS + 1);
    const reprobed = await checker.check();
    expect(reprobed.ok).toBe(true);
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
