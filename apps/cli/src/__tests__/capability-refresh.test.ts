import type { CapabilityEntry, ClientCapabilities } from "@first-tree/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CapabilityRefresher, type CapabilityRefresherDeps } from "../core/capability-refresh.js";

/**
 * The refresher unifies the daemon's two capability-refresh triggers — the WS
 * reconnect re-probe and a bounded, backoff-scheduled background poll that runs
 * while the daemon stays connected (the gap fixed for the "no runtime ready
 * after install" issue). These tests cover the poll lifecycle, the upload
 * dedupe, the backoff, the shared in-flight guard, and the reconnect path with
 * the probe helpers injected (no real provider launches).
 */

const ok = (over: Partial<CapabilityEntry> = {}): CapabilityEntry => ({
  state: "ok",
  available: true,
  authenticated: true,
  authMethod: "oauth",
  sdkVersion: "1.0.0",
  detectedAt: "2026-06-17T00:00:00.000Z",
  ...over,
});

const missing = (over: Partial<CapabilityEntry> = {}): CapabilityEntry => ({
  state: "missing",
  available: false,
  authenticated: false,
  authMethod: "none",
  detectedAt: "2026-06-17T00:00:00.000Z",
  ...over,
});

const allOk = (): ClientCapabilities => ({
  "claude-code": ok(),
  "claude-code-tui": ok(),
  codex: ok(),
});

const codexMissing = (): ClientCapabilities => ({
  "claude-code": ok(),
  "claude-code-tui": ok(),
  codex: missing(),
});

const BASE = 100;
const MAX = 400;

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function makeRefresher(overrides: Partial<CapabilityRefresherDeps> = {}): {
  refresher: CapabilityRefresher;
  upload: ReturnType<typeof vi.fn>;
  log: ReturnType<typeof vi.fn>;
  reprobe: ReturnType<typeof vi.fn>;
  revalidate: ReturnType<typeof vi.fn>;
} {
  const upload = vi.fn(async () => undefined);
  const log = vi.fn();
  const reprobe = vi.fn(async () => ({ capabilities: allOk(), mode: "full" as const }));
  const revalidate = vi.fn(async () => allOk());
  const refresher = new CapabilityRefresher({
    upload,
    log,
    reprobe,
    revalidate,
    baseMs: BASE,
    maxMs: MAX,
    ...overrides,
  });
  return { refresher, upload, log, reprobe, revalidate };
}

describe("CapabilityRefresher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("uploads the startup snapshot once and does not poll when all providers are ok", async () => {
    const { refresher, upload, revalidate } = makeRefresher({ initial: allOk() });
    await refresher.start();

    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledWith(allOk());

    await vi.advanceTimersByTimeAsync(MAX * 4);
    expect(revalidate).not.toHaveBeenCalled();
    refresher.stop();
  });

  it("polls a degraded snapshot, uploads the recovery, then stops once everything is ok", async () => {
    const recovered = allOk();
    const { refresher, upload, revalidate } = makeRefresher({ initial: codexMissing() });
    revalidate.mockResolvedValueOnce(recovered);

    await refresher.start();
    expect(upload).toHaveBeenCalledTimes(1); // initial degraded snapshot

    await vi.advanceTimersByTimeAsync(BASE);
    expect(revalidate).toHaveBeenCalledTimes(1);
    expect(revalidate).toHaveBeenCalledWith(codexMissing());
    expect(upload).toHaveBeenCalledTimes(2); // recovery uploaded
    expect(upload).toHaveBeenLastCalledWith(recovered);

    // Now healthy → the poll is disarmed.
    await vi.advanceTimersByTimeAsync(MAX * 4);
    expect(revalidate).toHaveBeenCalledTimes(1);
    refresher.stop();
  });

  it("skips the upload when a poll produces an unchanged snapshot, and backs off", async () => {
    const { refresher, upload, revalidate } = makeRefresher({ initial: codexMissing() });
    revalidate.mockResolvedValue(codexMissing()); // never changes

    await refresher.start();
    expect(upload).toHaveBeenCalledTimes(1);

    // First poll at BASE: unchanged → no upload, backoff grows to 2×BASE.
    await vi.advanceTimersByTimeAsync(BASE);
    expect(revalidate).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledTimes(1);

    // Nothing fires before the backed-off interval elapses.
    await vi.advanceTimersByTimeAsync(BASE);
    expect(revalidate).toHaveBeenCalledTimes(1);

    // Second poll at 2×BASE.
    await vi.advanceTimersByTimeAsync(BASE);
    expect(revalidate).toHaveBeenCalledTimes(2);
    expect(upload).toHaveBeenCalledTimes(1);
    refresher.stop();
  });

  it("resets the backoff when a poll observes a state change", async () => {
    const { refresher, revalidate } = makeRefresher({ initial: codexMissing() });
    // Each poll yields a different (still-degraded) snapshot → always "changed".
    revalidate
      .mockResolvedValueOnce({ ...codexMissing(), codex: missing({ error: "v1" }) })
      .mockResolvedValueOnce({ ...codexMissing(), codex: missing({ error: "v2" }) });

    await refresher.start();

    await vi.advanceTimersByTimeAsync(BASE);
    expect(revalidate).toHaveBeenCalledTimes(1);

    // Changed → backoff stays at BASE (not 2×BASE), so the next poll fires after BASE again.
    await vi.advanceTimersByTimeAsync(BASE);
    expect(revalidate).toHaveBeenCalledTimes(2);
    refresher.stop();
  });

  it("does not run a reconnect re-probe while a poll is already in flight", async () => {
    const gate = deferred<ClientCapabilities>();
    const { refresher, reprobe, revalidate } = makeRefresher({ initial: codexMissing() });
    revalidate.mockReturnValueOnce(gate.promise);

    await refresher.start();
    // Kick the poll; revalidate is now pending (in-flight).
    await vi.advanceTimersByTimeAsync(BASE);
    expect(revalidate).toHaveBeenCalledTimes(1);

    // A reconnect arriving mid-poll must be dropped, not run concurrently.
    refresher.onReconnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(reprobe).not.toHaveBeenCalled();

    gate.resolve(allOk());
    await vi.advanceTimersByTimeAsync(0);
    refresher.stop();
  });

  it("re-probes via reprobeOnReconnect on a reconnect and re-arms based on the result", async () => {
    const { refresher, upload, reprobe } = makeRefresher({ initial: codexMissing() });
    reprobe.mockResolvedValueOnce({ capabilities: allOk(), mode: "revalidate" as const });

    refresher.onReconnect();
    await vi.advanceTimersByTimeAsync(0);

    expect(reprobe).toHaveBeenCalledTimes(1);
    expect(reprobe).toHaveBeenCalledWith(codexMissing());
    expect(upload).toHaveBeenCalledWith(allOk());
    refresher.stop();
  });

  it("arms the poll even when the startup upload fails (a later poll retries)", async () => {
    const { refresher, upload, log, revalidate } = makeRefresher({ initial: codexMissing() });
    upload.mockRejectedValueOnce(new Error("clients row not ready"));

    await refresher.start();
    expect(log).toHaveBeenCalledWith("⚠️", expect.stringContaining("capabilities upload skipped"));

    await vi.advanceTimersByTimeAsync(BASE);
    expect(revalidate).toHaveBeenCalledTimes(1);
    refresher.stop();
  });

  it("stop() cancels a pending poll", async () => {
    const { refresher, revalidate } = makeRefresher({ initial: codexMissing() });
    await refresher.start();
    refresher.stop();

    await vi.advanceTimersByTimeAsync(MAX * 4);
    expect(revalidate).not.toHaveBeenCalled();
  });

  it("treats a null startup snapshot as degraded and recovers via the poll", async () => {
    const { refresher, upload, revalidate } = makeRefresher({ initial: null });
    revalidate.mockResolvedValueOnce(allOk());

    await refresher.start();
    expect(upload).not.toHaveBeenCalled(); // nothing to upload yet

    await vi.advanceTimersByTimeAsync(BASE);
    expect(revalidate).toHaveBeenCalledTimes(1);
    expect(revalidate).toHaveBeenCalledWith({}); // empty previous
    expect(upload).toHaveBeenCalledWith(allOk());
    refresher.stop();
  });
});
