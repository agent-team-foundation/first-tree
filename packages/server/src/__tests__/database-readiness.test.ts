import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDatabaseReadinessProbe,
  DATABASE_READINESS_CACHE_TTL_MS,
  DATABASE_READINESS_TIMEOUT_MS,
} from "../services/database-readiness.js";

type Deferred<T> = {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T | PromiseLike<T>) => void;
};

function deferred<T>(): Deferred<T> {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("createDatabaseReadinessProbe", () => {
  let nowMs: number;

  beforeEach(() => {
    vi.useFakeTimers();
    nowMs = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shares one underlying call and one timeout across 100 concurrent callers", async () => {
    const query = deferred<unknown>();
    const executeProbe = vi.fn(() => query.promise);
    const probe = createDatabaseReadinessProbe(executeProbe, { now: () => nowMs });

    const checks = Array.from({ length: 100 }, () => probe.check());

    expect(new Set(checks)).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);
    await Promise.resolve();
    expect(executeProbe).toHaveBeenCalledTimes(1);

    query.resolve(undefined);
    await expect(Promise.all(checks)).resolves.toEqual(Array(100).fill("connected"));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out exactly at 2000 ms and never replaces a still-pending generation", async () => {
    const query = deferred<unknown>();
    const executeProbe = vi.fn(() => query.promise);
    const probe = createDatabaseReadinessProbe(executeProbe, { now: () => nowMs });
    const firstCheck = probe.check();
    const observedResult = vi.fn();
    void firstCheck.then(observedResult);

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(DATABASE_READINESS_TIMEOUT_MS - 1);
    expect(observedResult).not.toHaveBeenCalled();
    expect(executeProbe).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    await expect(firstCheck).resolves.toBe("disconnected");
    expect(observedResult).toHaveBeenCalledWith("disconnected");
    expect(vi.getTimerCount()).toBe(0);

    for (const elapsed of [5_000, 10_000, 15_000, 25_000]) {
      nowMs = elapsed;
      const repeatedChecks = Array.from({ length: 100 }, () => probe.check());
      expect(new Set(repeatedChecks)).toHaveLength(1);
      await expect(Promise.all(repeatedChecks)).resolves.toEqual(Array(100).fill("disconnected"));
      expect(executeProbe).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it("caches a late success for a full TTL measured from actual settlement", async () => {
    const query = deferred<unknown>();
    const executeProbe = vi.fn(() => query.promise);
    const probe = createDatabaseReadinessProbe(executeProbe, { now: () => nowMs });
    const timedOutCheck = probe.check();

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(DATABASE_READINESS_TIMEOUT_MS);
    await expect(timedOutCheck).resolves.toBe("disconnected");

    nowMs = 12_000;
    query.resolve(undefined);
    await vi.advanceTimersByTimeAsync(0);

    await expect(probe.check()).resolves.toBe("connected");
    expect(executeProbe).toHaveBeenCalledTimes(1);

    nowMs = 12_000 + DATABASE_READINESS_CACHE_TTL_MS - 1;
    await expect(probe.check()).resolves.toBe("connected");
    expect(executeProbe).toHaveBeenCalledTimes(1);

    nowMs += 1;
    const boundaryChecks = Array.from({ length: 100 }, () => probe.check());
    expect(new Set(boundaryChecks)).toHaveLength(1);
    await expect(Promise.all(boundaryChecks)).resolves.toEqual(Array(100).fill("connected"));
    expect(executeProbe).toHaveBeenCalledTimes(2);
  });

  it("consumes a late rejection and caches it for a full TTL from settlement", async () => {
    const query = deferred<unknown>();
    const executeProbe = vi
      .fn<() => Promise<unknown>>()
      .mockImplementationOnce(() => query.promise)
      .mockResolvedValueOnce(undefined);
    const probe = createDatabaseReadinessProbe(executeProbe, { now: () => nowMs });
    const unhandledRejection = vi.fn();
    process.on("unhandledRejection", unhandledRejection);

    try {
      const timedOutCheck = probe.check();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(DATABASE_READINESS_TIMEOUT_MS);
      await expect(timedOutCheck).resolves.toBe("disconnected");

      nowMs = 9_000;
      query.reject(new Error("database unavailable"));
      await vi.advanceTimersByTimeAsync(0);

      await expect(probe.check()).resolves.toBe("disconnected");
      expect(executeProbe).toHaveBeenCalledTimes(1);
      expect(unhandledRejection).not.toHaveBeenCalled();

      nowMs = 9_000 + DATABASE_READINESS_CACHE_TTL_MS - 1;
      await expect(probe.check()).resolves.toBe("disconnected");
      expect(executeProbe).toHaveBeenCalledTimes(1);

      nowMs += 1;
      const boundaryChecks = Array.from({ length: 100 }, () => probe.check());
      await expect(Promise.all(boundaryChecks)).resolves.toEqual(Array(100).fill("connected"));
      expect(executeProbe).toHaveBeenCalledTimes(2);
      expect(unhandledRejection).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandledRejection);
    }
  });

  it("starts the full cache TTL when a slow query settles", async () => {
    const firstQuery = deferred<unknown>();
    const executeProbe = vi
      .fn<() => Promise<unknown>>()
      .mockImplementationOnce(() => firstQuery.promise)
      .mockResolvedValueOnce(undefined);
    const probe = createDatabaseReadinessProbe(executeProbe, { now: () => nowMs });
    const firstCheck = probe.check();

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_500);
    nowMs = 1_500;
    firstQuery.resolve(undefined);
    await expect(firstCheck).resolves.toBe("connected");

    nowMs = 1_500 + DATABASE_READINESS_CACHE_TTL_MS - 1;
    await expect(probe.check()).resolves.toBe("connected");
    expect(executeProbe).toHaveBeenCalledTimes(1);

    nowMs += 1;
    const boundaryChecks = Array.from({ length: 100 }, () => probe.check());
    expect(new Set(boundaryChecks)).toHaveLength(1);
    await expect(Promise.all(boundaryChecks)).resolves.toEqual(Array(100).fill("connected"));
    expect(executeProbe).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("normalizes and caches synchronous throws and quick rejections", async () => {
    const syncThrow = vi.fn((): Promise<unknown> => {
      throw new Error("sync failure");
    });
    const syncThrowProbe = createDatabaseReadinessProbe(syncThrow, { now: () => nowMs });

    await expect(syncThrowProbe.check()).resolves.toBe("disconnected");
    nowMs = DATABASE_READINESS_CACHE_TTL_MS - 1;
    await expect(syncThrowProbe.check()).resolves.toBe("disconnected");
    expect(syncThrow).toHaveBeenCalledTimes(1);

    nowMs = 0;
    const quickRejection = vi.fn(() => Promise.reject(new Error("async failure")));
    const quickRejectionProbe = createDatabaseReadinessProbe(quickRejection, { now: () => nowMs });

    await expect(quickRejectionProbe.check()).resolves.toBe("disconnected");
    nowMs = DATABASE_READINESS_CACHE_TTL_MS - 1;
    await expect(quickRejectionProbe.check()).resolves.toBe("disconnected");
    expect(quickRejection).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps state isolated between independent probe instances", async () => {
    const firstExecute = vi.fn(async () => undefined);
    const secondExecute = vi.fn(async () => undefined);
    const firstProbe = createDatabaseReadinessProbe(firstExecute, { now: () => nowMs });
    const secondProbe = createDatabaseReadinessProbe(secondExecute, { now: () => nowMs });

    const firstCheck = firstProbe.check();
    const secondCheck = secondProbe.check();
    expect(vi.getTimerCount()).toBe(2);

    await expect(Promise.all([firstCheck, secondCheck])).resolves.toEqual(["connected", "connected"]);
    expect(firstExecute).toHaveBeenCalledTimes(1);
    expect(secondExecute).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
