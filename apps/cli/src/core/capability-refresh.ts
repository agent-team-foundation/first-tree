import {
  hasNonOkProvider,
  nextCapabilityRefreshDelayMs,
  reprobeOnReconnect,
  revalidateCapabilities,
} from "@first-tree/client";
import type { ClientCapabilities } from "@first-tree/shared";

/**
 * Stable JSON stringify — sorts object keys so two capability snapshots that
 * differ only in key order serialize identically. Used to dedupe uploads: a
 * re-probe that produced the same snapshot must not re-PATCH the server.
 */
export function stableCapabilitiesJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => stableCapabilitiesJson(item)).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableCapabilitiesJson(item)}`)
    .join(",")}}`;
}

export type CapabilityRefresherDeps = {
  /** PATCH the snapshot to the server. The caller owns access-token + clientId
   * wiring; the refresher only decides *when* and *whether changed*. */
  upload: (capabilities: ClientCapabilities) => Promise<void>;
  /** Status logger (symbol + message), e.g. `print.status`. */
  log: (symbol: string, message: string) => void;
  /** Initial snapshot from the daemon's startup probe (null if it failed). */
  initial?: ClientCapabilities | null;
  /** Override the backoff base (test seam). */
  baseMs?: number;
  /** Override the backoff ceiling (test seam). */
  maxMs?: number;
  /** Timer seam — defaults to global setTimeout/clearTimeout. */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
  /** Injected probe helpers (test seam). */
  reprobe?: typeof reprobeOnReconnect;
  revalidate?: typeof revalidateCapabilities;
};

/**
 * Owns the daemon's post-registration runtime-capability refresh as a SINGLE
 * probing model, so the two refresh triggers never overlap or fight:
 *
 *   1. WS reconnect (`onReconnect`) — TTL-aware full-or-revalidate via
 *      {@link reprobeOnReconnect}, preserving the existing reconnect behavior.
 *   2. A bounded, backoff-scheduled background poll (`start`) that fires *while
 *      the daemon stays connected* — the gap this fixes. A capability snapshot
 *      goes stale the moment the operator installs / logs into a provider; with
 *      no reconnect there was previously no refresh until a restart or a manual
 *      `daemon probe`. The poll re-probes with {@link revalidateCapabilities}
 *      (a real smoke for each non-`ok` provider so a freshly-installed one can
 *      flip to `ok`; already-`ok` providers stay on the free cached path), and
 *      stops itself once every built-in provider is `ok`.
 *
 * Both triggers share one in-flight guard, so a reconnect re-probe and a poll
 * can never launch providers concurrently, and uploads are deduped against the
 * last snapshot actually sent.
 */
export class CapabilityRefresher {
  private readonly deps: CapabilityRefresherDeps;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;
  private readonly reprobe: typeof reprobeOnReconnect;
  private readonly revalidate: typeof revalidateCapabilities;

  private snapshot: ClientCapabilities | null;
  private lastUploadedJson: string | null = null;
  private inFlight = false;
  /** A reconnect that landed while a refresh was in flight, to be drained (in
   * reconnect mode) once the current refresh finishes — never dropped, so the
   * reconnect TTL/full re-probe path is always honored. */
  private pendingReconnect = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Consecutive polls with no observed state change — drives the backoff. */
  private idleAttempts = 0;
  private stopped = false;

  constructor(deps: CapabilityRefresherDeps) {
    this.deps = deps;
    this.snapshot = deps.initial ?? null;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle));
    this.reprobe = deps.reprobe ?? reprobeOnReconnect;
    this.revalidate = deps.revalidate ?? revalidateCapabilities;
  }

  /**
   * Push the startup snapshot to the server (deduped) and arm the background
   * poll if a refresh is still warranted (a non-`ok` provider, or a snapshot
   * the server has not confirmed). Best-effort: an upload failure is logged and
   * the poll is still armed (a later poll re-tries the upload).
   */
  async start(): Promise<void> {
    if (this.snapshot) {
      try {
        await this.uploadIfChanged(this.snapshot);
      } catch (err) {
        this.deps.log("⚠️", `capabilities upload skipped: ${message(err)}`);
      }
    }
    this.idleAttempts = 0;
    this.scheduleNext();
  }

  /**
   * Re-probe after a WS reconnect (full or revalidate per the TTL policy), then
   * re-arm or stop the poll based on the fresh snapshot. Fire-and-forget; never
   * throws into the connection.
   *
   * If a refresh is already in flight (e.g. a degraded-state poll), the
   * reconnect is recorded as pending and drained in reconnect mode once that
   * refresh finishes — it is never dropped, so the reconnect's TTL/full
   * re-probe always runs even when it coincides with a poll.
   */
  onReconnect(): void {
    this.pendingReconnect = true;
    void this.runRefresh("reconnect");
  }

  /** Tear down the poll timer. Call on daemon shutdown. */
  stop(): void {
    this.stopped = true;
    this.clearPending();
  }

  private clearPending(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }

  private async uploadIfChanged(capabilities: ClientCapabilities): Promise<boolean> {
    const nextJson = stableCapabilitiesJson(capabilities);
    if (this.lastUploadedJson === nextJson) return false;
    await this.deps.upload(capabilities);
    this.lastUploadedJson = nextJson;
    return true;
  }

  private async runRefresh(trigger: "reconnect" | "poll"): Promise<void> {
    if (this.stopped) return;
    if (this.inFlight) return; // a coincident reconnect is held in pendingReconnect

    this.inFlight = true;
    try {
      // A reconnect that arrived (now, or while a prior refresh ran) wins over a
      // poll: it carries the stricter TTL/full re-probe semantics. Drain the
      // intent into this run so it is honored rather than dropped.
      const effective: "reconnect" | "poll" = this.pendingReconnect ? "reconnect" : trigger;
      this.pendingReconnect = false;

      const previous = this.snapshot ?? {};
      let probed = false;
      try {
        let next: ClientCapabilities;
        let modeLabel: string;
        if (effective === "reconnect") {
          const { capabilities, mode } = await this.reprobe(previous);
          next = capabilities;
          modeLabel = `reconnect, ${mode}`;
        } else {
          next = await this.revalidate(previous);
          modeLabel = "poll";
        }
        probed = true;
        const changed = stableCapabilitiesJson(next) !== stableCapabilitiesJson(previous);
        this.snapshot = next;
        // Upload is tracked separately from the probe: a probe that recovered a
        // provider to `ok` but whose PATCH failed must NOT let the poll stop —
        // the server would otherwise stay on the stale degraded snapshot. The
        // upload failure resets the backoff so the retry is prompt.
        let uploadFailed = false;
        try {
          const uploaded = await this.uploadIfChanged(next);
          this.deps.log(
            "•",
            `runtime capabilities re-probed (${modeLabel})${uploaded ? " and uploaded" : "; unchanged, upload skipped"}`,
          );
        } catch (uploadErr) {
          uploadFailed = true;
          this.deps.log("⚠️", `capabilities upload skipped: ${message(uploadErr)}`);
        }
        // A reconnect, an observed state change, or a failed upload all warrant
        // a prompt next attempt; only an unchanged, fully-synced poll backs off.
        this.idleAttempts = effective === "reconnect" || changed || uploadFailed ? 0 : this.idleAttempts + 1;
      } catch (probeErr) {
        this.deps.log("⚠️", `${effective} capability re-probe skipped: ${message(probeErr)}`);
        // Keep polling on a transient probe failure so the daemon still converges.
      }
      if (!probed) this.idleAttempts += 1;
      this.scheduleNext();
    } finally {
      this.inFlight = false;
    }

    // A reconnect that landed while this refresh ran is drained now (in
    // reconnect mode), so its TTL/full re-probe is never skipped.
    if (this.pendingReconnect && !this.stopped) {
      void this.runRefresh("reconnect");
    }
  }

  /**
   * Arm the next poll while a refresh is still warranted, else cancel it. A
   * refresh is warranted when the snapshot is missing (startup probe failed),
   * still has a non-`ok` provider, OR is healthy but not yet confirmed uploaded
   * to the server (a prior PATCH failed) — the poll must keep going until the
   * server actually reflects readiness. The interval is read from
   * `idleAttempts`, which the callers advance.
   */
  private scheduleNext(): void {
    this.clearPending();
    if (this.stopped) return;
    if (!this.needsRefresh()) {
      this.idleAttempts = 0;
      return;
    }
    const delay = nextCapabilityRefreshDelayMs(this.idleAttempts, {
      baseMs: this.deps.baseMs,
      maxMs: this.deps.maxMs,
    });
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.runRefresh("poll");
    }, delay);
  }

  /** True while the daemon should keep re-probing: no snapshot yet, a provider
   * is still non-`ok`, or the current healthy snapshot has not been confirmed
   * uploaded (so the server may still show stale "no runtime ready"). */
  private needsRefresh(): boolean {
    const snap = this.snapshot;
    if (!snap) return true;
    if (hasNonOkProvider(snap)) return true;
    return stableCapabilitiesJson(snap) !== this.lastUploadedJson;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
