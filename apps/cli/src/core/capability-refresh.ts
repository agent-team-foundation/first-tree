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
   * Push the startup snapshot to the server (deduped) and, if any provider is
   * not yet `ok`, arm the background poll. Best-effort: an upload failure is
   * logged and the poll is still armed (a later poll re-tries the upload).
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
   * throws into the connection. No-op if a refresh is already in flight.
   */
  onReconnect(): void {
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
    if (this.inFlight || this.stopped) return;
    this.inFlight = true;
    try {
      const previous = this.snapshot ?? {};
      let next: ClientCapabilities;
      let modeLabel: string;
      if (trigger === "reconnect") {
        const { capabilities, mode } = await this.reprobe(previous);
        next = capabilities;
        modeLabel = `reconnect, ${mode}`;
      } else {
        next = await this.revalidate(previous);
        modeLabel = "poll";
      }
      const changed = stableCapabilitiesJson(next) !== stableCapabilitiesJson(previous);
      this.snapshot = next;
      const uploaded = await this.uploadIfChanged(next);
      this.deps.log(
        "•",
        `runtime capabilities re-probed (${modeLabel})${uploaded ? " and uploaded" : "; unchanged, upload skipped"}`,
      );
      // A reconnect is a fresh external trigger, so reset the backoff; for a
      // poll, a state change means the operator is actively setting up (poll
      // again quickly), while an unchanged poll lets the interval grow toward
      // the ceiling.
      this.idleAttempts = trigger === "reconnect" || changed ? 0 : this.idleAttempts + 1;
      this.scheduleNext();
    } catch (err) {
      this.deps.log("⚠️", `${trigger} capability re-probe skipped: ${message(err)}`);
      // Keep polling on a transient failure so the daemon still converges.
      this.scheduleNext();
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * Arm the next poll when the snapshot still has a non-`ok` provider (a null
   * snapshot — the startup probe failed — also counts as degraded), else cancel
   * it. The interval is read from `idleAttempts`, which the callers advance.
   */
  private scheduleNext(): void {
    this.clearPending();
    if (this.stopped) return;
    const degraded = !this.snapshot || hasNonOkProvider(this.snapshot);
    if (!degraded) {
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
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
