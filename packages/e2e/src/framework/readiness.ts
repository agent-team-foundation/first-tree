export type ReadinessProbe = {
  name: string;
  /** Resolves once the component is ready; rejects if the timeout elapses. */
  wait: (timeoutMs: number) => Promise<void>;
};

export async function waitForHttp(
  url: string,
  opts: {
    timeoutMs: number;
    intervalMs?: number;
    expectedStatus?: number;
    consecutive?: number;
    signal?: AbortSignal;
  },
): Promise<void> {
  const interval = opts.intervalMs ?? 250;
  const expected = opts.expectedStatus ?? 200;
  const need = opts.consecutive ?? 1;
  const deadline = Date.now() + opts.timeoutMs;
  let consecutiveOk = 0;
  let lastError = "no attempts";
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) throw new DOMException("waitForHttp aborted", "AbortError");
    try {
      const fetchSignal = opts.signal
        ? AbortSignal.any([opts.signal, AbortSignal.timeout(2_000)])
        : AbortSignal.timeout(2_000);
      const res = await fetch(url, { signal: fetchSignal });
      if (res.status === expected) {
        consecutiveOk += 1;
        if (consecutiveOk >= need) return;
      } else {
        lastError = `HTTP ${res.status}`;
        consecutiveOk = 0;
      }
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      lastError = err instanceof Error ? err.message : String(err);
      consecutiveOk = 0;
    }
    await sleep(interval, opts.signal);
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError}`);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("sleep aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("sleep aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
