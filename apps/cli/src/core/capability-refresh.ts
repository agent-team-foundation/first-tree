import {
  hasNonOkProvider,
  nextCapabilityRefreshDelayMs,
  reprobeOnReconnect,
  revalidateCapabilities,
} from "@first-tree/client";
import type { CapabilityEntry, ClientCapabilities } from "@first-tree/shared";

const EMPTY_OMITTED_KEYS = new Set<string>();
const VOLATILE_CAPABILITY_FIELDS = new Set(["detectedAt", "latencyMs"]);

/**
 * Stable JSON stringify — sorts object keys so two capability snapshots that
 * differ only in key order serialize identically.
 */
export function stableCapabilitiesJson(value: unknown): string {
  return stableCapabilitiesJsonWithOmittedKeys(value, EMPTY_OMITTED_KEYS);
}

/**
 * Stable semantic snapshot for upload / backoff decisions. Probe timestamps and
 * durations change on every run, but they do not mean the server-visible runtime
 * readiness changed.
 */
export function stableCapabilitySyncJson(value: unknown): string {
  return stableCapabilitiesJsonWithOmittedKeys(value, VOLATILE_CAPABILITY_FIELDS);
}

function stableCapabilitiesJsonWithOmittedKeys(value: unknown, omittedKeys: ReadonlySet<string>): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableCapabilitiesJsonWithOmittedKeys(item, omittedKeys)).join(",")}]`;
  }
  return `{${Object.entries(value)
    .filter(([key]) => !omittedKeys.has(key))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableCapabilitiesJsonWithOmittedKeys(item, omittedKeys)}`)
    .join(",")}}`;
}

export type CapabilityRefresherDeps = {
  /** PATCH the snapshot to the server. The caller owns access-token + clientId
   * wiring; the refresher only decides *when* and *whether changed*. */
  upload: (capabilities: ClientCapabilities) => Promise<void>;
  /** Status logger (symbol + message), e.g. `print.status`. */
  log: (symbol: string, message: string) => void;
  /** Optional initial snapshot from a caller-owned probe. Daemon startup normally
   * omits this so full launch probes run only after WS registration. */
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
 * probing model, so the refresh triggers never overlap or fight:
 *
 *   1. Startup (`start`) — if no caller supplied an initial snapshot, immediately
 *      launch a full probe in the background after the Client has registered.
 *   2. WS reconnect (`onReconnect`) — TTL-aware full-or-revalidate via
 *      {@link reprobeOnReconnect}, preserving the existing reconnect behavior.
 *   3. A bounded, backoff-scheduled background poll (`start`) that fires *while
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
  private lastUploadedSyncJson: string | null = null;
  private inFlight = false;
  /**
   * Providers with an in-flight interactive login (runtime-auth device-code).
   * While a provider is in this set, a background re-probe must NOT overwrite
   * its entry — the orchestrator owns it and is publishing a pending
   * device-code that a fresh probe would clobber (the web panel would vanish
   * mid-login). The flag also serializes logins: the daemon ignores a second
   * `runtime-auth:start` for a provider already mid-login.
   */
  private readonly interactiveProviders = new Set<string>();
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
   * Start post-registration capability refresh. If an initial snapshot was
   * supplied, upload it (deduped) and arm the background poll. Otherwise kick off
   * an immediate full probe in the background. Best-effort: failures are logged
   * and later polls retry convergence.
   */
  async start(): Promise<void> {
    if (this.snapshot) {
      try {
        await this.uploadIfChanged(this.snapshot);
      } catch (err) {
        this.deps.log("⚠️", `capabilities upload skipped: ${message(err)}`);
      }
    } else {
      void this.runRefresh("startup");
      return;
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

  /**
   * Latest known capability entry for a provider, or undefined. The runtime-auth
   * login flow reads this to preserve a provider's existing fields (version,
   * runtimeSource) while it attaches/clears a pending device-code.
   */
  currentEntry(provider: string): CapabilityEntry | undefined {
    return this.snapshot?.[provider];
  }

  /**
   * Replace a single provider's entry in the snapshot and upload the merged
   * snapshot (deduped), then re-arm the poll so convergence continues. The
   * runtime-auth login flow uses this to surface a pending device-code
   * immediately and to clear it after the post-login re-probe — without waiting
   * for the next scheduled poll. Best-effort upload: a failure is logged and a
   * later poll retries.
   */
  async setProviderEntry(provider: string, entry: CapabilityEntry): Promise<void> {
    const next: ClientCapabilities = { ...(this.snapshot ?? {}), [provider]: entry };
    this.snapshot = next;
    try {
      await this.uploadIfChanged(next);
    } catch (err) {
      this.deps.log("⚠️", `capabilities upload skipped: ${message(err)}`);
    }
    this.scheduleNext();
  }

  /**
   * Mark a provider as having an in-flight interactive login. A background
   * re-probe will then preserve that provider's current entry (incl. a pending
   * device-code) instead of overwriting it, and {@link isInteractive} lets the
   * caller drop duplicate `runtime-auth:start` commands. Idempotent.
   */
  beginInteractive(provider: string): void {
    this.interactiveProviders.add(provider);
  }

  /** Clear the in-flight interactive flag once the login resolves. */
  endInteractive(provider: string): void {
    this.interactiveProviders.delete(provider);
  }

  /** True while a provider has an in-flight interactive login. */
  isInteractive(provider: string): boolean {
    return this.interactiveProviders.has(provider);
  }

  private clearPending(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }

  private async uploadIfChanged(capabilities: ClientCapabilities): Promise<boolean> {
    const nextJson = stableCapabilitySyncJson(capabilities);
    if (this.lastUploadedSyncJson === nextJson) return false;
    await this.deps.upload(capabilities);
    this.lastUploadedSyncJson = nextJson;
    return true;
  }

  private async runRefresh(trigger: "startup" | "reconnect" | "poll"): Promise<void> {
    if (this.stopped) return;
    if (this.inFlight) return; // a coincident reconnect is held in pendingReconnect

    this.inFlight = true;
    const refreshStartedAt = Date.now();
    try {
      // A reconnect that arrived (now, or while a prior refresh ran) wins over a
      // poll: it carries the stricter TTL/full re-probe semantics. Drain the
      // intent into this run so it is honored rather than dropped.
      const effective: "startup" | "reconnect" | "poll" = this.pendingReconnect ? "reconnect" : trigger;
      this.pendingReconnect = false;

      const previous = this.snapshot ?? {};
      let probed = false;
      try {
        let next: ClientCapabilities;
        let modeLabel: string;
        if (effective === "startup" || effective === "reconnect") {
          const { capabilities, mode } = await this.reprobe(previous);
          next = capabilities;
          modeLabel = `${effective}, ${mode}`;
        } else {
          next = await this.revalidate(previous);
          modeLabel = "poll";
        }
        probed = true;
        // Re-read at merge time: runtime-auth may have published a pendingAuth
        // entry while this provider probe was awaiting a slow smoke.
        const current = this.snapshot ?? previous;
        // Preserve any provider with an in-flight interactive login: the
        // orchestrator owns its entry (a pending device-code) and a fresh probe
        // would clobber it, making the web device-code panel vanish mid-login.
        if (this.interactiveProviders.size > 0) {
          const preserved: ClientCapabilities = { ...next };
          for (const provider of this.interactiveProviders) {
            const owned = current[provider] ?? previous[provider];
            if (owned) preserved[provider] = owned;
          }
          next = preserved;
        }
        const changed = stableCapabilitySyncJson(next) !== stableCapabilitySyncJson(current);
        this.snapshot = next;
        // Upload is tracked separately from the probe: a probe that recovered a
        // provider to `ok` but whose PATCH failed must NOT let the poll stop —
        // the server would otherwise stay on the stale degraded snapshot. The
        // upload failure resets the backoff so the retry is prompt.
        let uploadFailed = false;
        try {
          const uploaded = await this.uploadIfChanged(next);
          if (uploaded) {
            this.deps.log(
              "•",
              `runtime capabilities re-probed (${modeLabel}) and uploaded in ${Date.now() - refreshStartedAt}ms`,
            );
          }
        } catch (uploadErr) {
          uploadFailed = true;
          this.deps.log(
            "⚠️",
            `capabilities upload skipped after ${Date.now() - refreshStartedAt}ms: ${message(uploadErr)}`,
          );
        }
        // A reconnect, an observed state change, or a failed upload all warrant
        // a prompt next attempt; only an unchanged, fully-synced poll backs off.
        this.idleAttempts =
          effective === "startup" || effective === "reconnect" || changed || uploadFailed ? 0 : this.idleAttempts + 1;
      } catch (probeErr) {
        this.deps.log(
          "⚠️",
          `${effective} capability re-probe skipped after ${Date.now() - refreshStartedAt}ms: ${message(probeErr)}`,
        );
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
    return stableCapabilitySyncJson(snap) !== this.lastUploadedSyncJson;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
