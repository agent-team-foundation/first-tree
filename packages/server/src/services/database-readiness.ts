import { performance } from "node:perf_hooks";

export const DATABASE_READINESS_CACHE_TTL_MS = 5_000;
export const DATABASE_READINESS_TIMEOUT_MS = 2_000;

export type DatabaseReadinessStatus = "connected" | "disconnected";

export type DatabaseReadinessProbe = {
  check: () => Promise<DatabaseReadinessStatus>;
};

export type DatabaseReadinessProbeOptions = {
  cacheTtlMs?: number;
  timeoutMs?: number;
  now?: () => number;
};

type TerminalCache = {
  expiresAt: number;
  status: DatabaseReadinessStatus;
};

type ProbeGeneration = {
  actualPromise: Promise<DatabaseReadinessStatus>;
  visiblePromise: Promise<DatabaseReadinessStatus>;
};

/**
 * Creates a process-local, bounded database readiness probe.
 *
 * Each generation owns one underlying query, one caller-visible timeout race,
 * and one timer. A timeout fails closed for callers but deliberately leaves
 * the generation occupied until the real query settles, so a stalled database
 * can never accumulate replacement probes.
 */
export function createDatabaseReadinessProbe(
  executeProbe: () => Promise<unknown>,
  options: DatabaseReadinessProbeOptions = {},
): DatabaseReadinessProbe {
  const cacheTtlMs = options.cacheTtlMs ?? DATABASE_READINESS_CACHE_TTL_MS;
  const timeoutMs = options.timeoutMs ?? DATABASE_READINESS_TIMEOUT_MS;
  const now = options.now ?? (() => performance.now());

  let terminalCache: TerminalCache | undefined;
  let activeGeneration: ProbeGeneration | undefined;

  function startGeneration(): ProbeGeneration {
    // Defer execution into a promise so synchronous throws and asynchronous
    // rejections share the same consumed terminal result.
    const actualPromise: Promise<DatabaseReadinessStatus> = Promise.resolve()
      .then(executeProbe)
      .then(
        () => "connected",
        () => "disconnected",
      );

    let resolveVisible: (status: DatabaseReadinessStatus) => void = () => undefined;
    const visiblePromise = new Promise<DatabaseReadinessStatus>((resolve) => {
      resolveVisible = resolve;
    });

    const generation: ProbeGeneration = { actualPromise, visiblePromise };

    // Publish the generation before the deferred executeProbe can run. Every
    // concurrent caller now observes the same visible promise and timer.
    activeGeneration = generation;

    let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
      timer = undefined;
      resolveVisible("disconnected");
    }, timeoutMs);

    void actualPromise.then((status) => {
      // Only the real query outcome becomes a 5-second terminal cache. A
      // timeout fallback never releases or replaces an unsettled generation.
      terminalCache = { status, expiresAt: now() + cacheTtlMs };
      if (activeGeneration === generation) activeGeneration = undefined;

      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      resolveVisible(status);
    });

    return generation;
  }

  return {
    check(): Promise<DatabaseReadinessStatus> {
      if (terminalCache !== undefined && now() < terminalCache.expiresAt) {
        return Promise.resolve(terminalCache.status);
      }
      if (activeGeneration !== undefined) return activeGeneration.visiblePromise;
      return startGeneration().visiblePromise;
    },
  };
}
