import type { FastifyBaseLogger } from "fastify";

/**
 * Tracks the Command-package version the server should advertise to every
 * connected Client via `server:welcome.serverCommandVersion`.
 *
 * Why this exists: hard-coding the broadcasted version to the server's own
 * `package.json` (or to the Command package.json baked into the image at
 * build time) couples auto-update to the server's deploy cadence — clients
 * never see a fresh CLI release until the server image is also rebuilt and
 * rolled. The poller instead asks the npm registry for the configured
 * package's `latest` dist-tag value, so server build cadence and Command
 * publish cadence decouple cleanly.
 *
 * Multi-env: each channel (prod / staging) is its own npm package with
 * its own `latest` dist-tag — the per-channel selection happens at the
 * server config level (`channel` field), which decides which package
 * name to pass here. `packageName === null` (dev channel) puts the
 * poller into no-op mode: it never hits the registry and always returns
 * `initialVersion`. That's correct for local dev where the CLI binary
 * is symlinked from source.
 *
 * Fault tolerance: a failing fetch never tears down the in-memory value —
 * the previously-seen version (or the bootstrap fallback if no poll has
 * ever succeeded) stays advertised. This keeps welcome frames well-formed
 * during a registry outage; clients simply continue running their current
 * version until the next successful poll.
 */
export type CommandVersionPoller = {
  /** Current cached version. Cheap; safe to call on the hot WS path. */
  get(): string;
  /** Begin periodic refreshes. Fires an immediate refresh in the background. */
  start(): void;
  /** Stop the timer and ignore in-flight responses. Idempotent. */
  stop(): void;
  /** Force a refresh now. Exposed for tests; production code calls `start()`. */
  refresh(): Promise<void>;
};

export type CommandVersionPollerOptions = {
  logger: FastifyBaseLogger;
  registryUrl: string;
  /**
   * npm package name to poll. `null` puts the poller into no-op mode —
   * used for dev-channel servers where the CLI binary is symlinked from
   * source and there's no published package to follow.
   */
  packageName: string | null;
  intervalMs: number;
  /** Bootstrap value used until the first successful poll lands. */
  initialVersion: string;
  /**
   * Override for tests. Production uses global `fetch`. Returning `null`
   * (rather than throwing) lets tests model "registry unreachable" without
   * tripping the catch-all.
   */
  fetchImpl?: typeof fetch;
};

/** Shape of the trimmed packument response we read. */
type Packument = { "dist-tags"?: Record<string, string> };

export function createCommandVersionPoller(opts: CommandVersionPollerOptions): CommandVersionPoller {
  const fetchFn = opts.fetchImpl ?? fetch;
  let current = opts.initialVersion;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  // Multi-env: dev channel has no published package — the CLI binary
  // is symlinked from source. Returning a no-op poller keeps the rest
  // of the server bootstrap path uniform.
  if (opts.packageName === null) {
    opts.logger.info("command-version-poller: dev channel — no published package; advertising initialVersion only");
    return {
      get: () => current,
      start: () => {
        /* no-op */
      },
      stop: () => {
        /* no-op */
      },
      refresh: async () => {
        /* no-op */
      },
    };
  }

  // Capture packageName as a non-null local so closures don't have to
  // re-narrow per call.
  const packageName: string = opts.packageName;

  async function fetchOnce(): Promise<string | null> {
    // npm registry packument URL. We append the package name *unencoded*
    // because the npm registry expects literal `@` and `/` for scoped
    // packages (`@scope/name`) — both are reserved chars URL-wise but
    // sub-delims that registries treat as path segments. The package name
    // never comes from user input on this code path (it's hard-coded by
    // the server build), so there's no injection vector to encode away.
    const url = `${opts.registryUrl.replace(/\/$/, "")}/${packageName}`;
    try {
      const res = await fetchFn(url, {
        headers: {
          // Asking for the abbreviated packument cuts the payload from
          // megabytes (full per-version metadata) to ~tens of kilobytes —
          // dist-tags is all we need.
          Accept: "application/vnd.npm.install-v1+json",
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        opts.logger.warn({ status: res.status, url }, "command-version-poller: npm registry returned non-OK");
        return null;
      }
      const body = (await res.json()) as Packument;
      // Multi-env: every package has exactly one dist-tag (`latest`).
      // Pre-multi-env had `alpha` here too; the per-channel split
      // collapsed that into separate packages.
      const tag = body["dist-tags"]?.latest;
      if (typeof tag !== "string" || tag.length === 0) {
        opts.logger.warn(
          { tags: Object.keys(body["dist-tags"] ?? {}) },
          "command-version-poller: 'latest' dist-tag missing from packument",
        );
        return null;
      }
      return tag;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      opts.logger.warn({ err: message, url }, "command-version-poller: fetch failed");
      return null;
    }
  }

  async function refresh(): Promise<void> {
    const next = await fetchOnce();
    if (stopped || next === null) return;
    if (next !== current) {
      opts.logger.info({ from: current, to: next }, "command-version-poller: advertised version changed");
      current = next;
    }
  }

  return {
    get: () => current,
    start: () => {
      if (timer) return;
      // Kick the first refresh in the background — we do NOT await it here
      // so server boot stays unblocked when the registry is slow.
      void refresh();
      timer = setInterval(() => {
        void refresh();
      }, opts.intervalMs);
      // `unref` so the timer alone doesn't keep the process alive across
      // graceful shutdown. The `onClose` hook clears it explicitly anyway,
      // but this is a safety net for crash paths.
      if (typeof timer.unref === "function") timer.unref();
    },
    stop: () => {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    refresh,
  };
}
