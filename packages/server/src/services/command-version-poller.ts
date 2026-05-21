import type { FastifyBaseLogger } from "fastify";

/**
 * npm name of the consumer-facing CLI tarball. Kept here (rather than
 * imported from `apps/cli`) because the server Docker image
 * deliberately does NOT copy the Command package — see the May 2026
 * "decouple Docker entry from CLI" refactor — so a runtime import would
 * fail. The string is part of npm's public API; renaming it would break
 * every installed client anyway.
 */
export const COMMAND_PACKAGE_NAME = "@agent-team-foundation/first-tree-hub";

/**
 * Tracks the Command-package version the server should advertise to every
 * connected Client via `server:welcome.serverCommandVersion`.
 *
 * Why this exists: hard-coding the broadcasted version to the server's own
 * `package.json` (or to the Command package.json baked into the image at
 * build time) couples auto-update to the server's deploy cadence — clients
 * never see a fresh CLI release until the server image is also rebuilt and
 * rolled. The poller instead asks the npm registry for the configured
 * channel's current `dist-tag` value, so:
 *
 *   - Staging deployments running `channel=alpha` follow CI's preview
 *     publishes within `pollIntervalMinutes` of upload.
 *   - Prod deployments running `channel=latest` follow stable releases the
 *     same way.
 *   - Server build cadence and Command publish cadence decouple cleanly.
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
  packageName: string;
  channel: string;
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

  async function fetchOnce(): Promise<string | null> {
    // npm registry packument URL. We append the package name *unencoded*
    // because the npm registry expects literal `@` and `/` for scoped
    // packages (`@scope/name`) — both are reserved chars URL-wise but
    // sub-delims that registries treat as path segments. The package name
    // never comes from user input on this code path (it's hard-coded by
    // the server build), so there's no injection vector to encode away.
    const url = `${opts.registryUrl.replace(/\/$/, "")}/${opts.packageName}`;
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
        opts.logger.warn(
          { status: res.status, url, channel: opts.channel },
          "command-version-poller: npm registry returned non-OK",
        );
        return null;
      }
      const body = (await res.json()) as Packument;
      const tag = body["dist-tags"]?.[opts.channel];
      if (typeof tag !== "string" || tag.length === 0) {
        opts.logger.warn(
          { channel: opts.channel, tags: Object.keys(body["dist-tags"] ?? {}) },
          "command-version-poller: dist-tag missing from packument",
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
      opts.logger.info(
        { from: current, to: next, channel: opts.channel },
        "command-version-poller: advertised version changed",
      );
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
