import type { ClientConfig } from "@first-tree/shared/config";
import * as semver from "semver";
import type { ServerWelcome } from "../client-connection.js";

/**
 * Narrow subset of `ClientConnection` the manager uses. Declared structurally
 * so tests can hand in a plain `EventEmitter` without dragging the full
 * connection surface into unit tests.
 */
export type UpdateManagerConnection = {
  on(event: "server:welcome", listener: (welcome: ServerWelcome) => void): unknown;
  off(event: "server:welcome", listener: (welcome: ServerWelcome) => void): unknown;
};

export type QuietGateSnapshot = {
  /** Number of sessions actively handling a message. */
  activeCount: number;
  /** Most-recent per-session `lastActivity` timestamp (0 when no sessions). */
  lastActivityMs: number;
};

export type UpdateLogLevel = "debug" | "info" | "warn";

export type UpdateLogger = (level: UpdateLogLevel, msg: string) => void;

/**
 * Command-layer TTY prompt. Returns `true` when the operator explicitly
 * consents to the update (pressing `y`); returns `false` on `N`, timeout, or
 * non-TTY decline. The UpdateManager uses the result as an explicit-consent
 * waiver of the quiet gate — a `true` here means "restart now" even if
 * sessions are active.
 */
export type UpdatePromptFn = (opts: {
  currentVersion: string;
  targetVersion: string;
  timeoutSeconds: number;
}) => Promise<boolean>;

export type ExecuteUpdateResult = {
  /**
   * Whether the new version was successfully installed. `true` means the host
   * should stop retrying on subsequent welcome frames (the bits are on disk;
   * a restart is required to pick them up). `false` means install did not
   * complete and a retry on the next welcome is appropriate.
   */
  installed: boolean;
};

/**
 * Command-layer install + (optional) restart. A managed run (service-unit,
 * Docker, etc.) is expected to `process.exit(SELF_RESTART_EXIT_CODE)` on
 * success so the supervisor relaunches on the new binary — in that case this
 * function never resolves. A standalone run has no supervisor, so it must
 * leave the process alive and return `{ installed: true }`; the UpdateManager
 * then stops attempting further updates until the operator restarts the
 * process.
 */
export type ExecuteUpdateFn = (opts: { currentVersion: string; targetVersion: string }) => Promise<ExecuteUpdateResult>;

export type UpdateManagerOptions = {
  currentVersion: string;
  updateConfig: ClientConfig["update"];
  /** Whether stdin/stdout is attached to a TTY. Drives prompt vs log-only. */
  isTTY: boolean;
  log: UpdateLogger;
  getQuietGateSnapshot: () => QuietGateSnapshot;
  prompt: UpdatePromptFn;
  executeUpdate: ExecuteUpdateFn;
};

/**
 * Grouped update dependencies the host runtime forwards to the UpdateManager.
 * All-or-nothing — runtimes only attach the manager when every field is
 * present, so there's no "3 of 4" ambiguity at the construction site.
 */
export type UpdateHooks = {
  updateConfig: ClientConfig["update"];
  prompt: UpdatePromptFn;
  executeUpdate: ExecuteUpdateFn;
};

/**
 * Version-drift decision flow. Install, prompt, and exit are delegated to
 * command-layer callbacks so the Client package stays free of CLI /
 * filesystem knowledge.
 */
export class UpdateManager {
  private readonly options: UpdateManagerOptions;
  private readonly connection: UpdateManagerConnection;
  private readonly welcomeListener: (welcome: ServerWelcome) => void;
  private updateInFlight = false;
  private quietGateTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  /**
   * Set when a standalone (unmanaged) executeUpdate reports `installed: true`
   * without exiting. The new bits are on disk; subsequent welcome frames must
   * not re-invoke npm since a restart is the only way to pick them up.
   */
  private pendingRestart = false;

  private constructor(connection: UpdateManagerConnection, options: UpdateManagerOptions) {
    this.connection = connection;
    this.options = options;
    this.welcomeListener = (welcome) => {
      this.onWelcome(welcome).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.options.log("warn", `update decision failed: ${msg}`);
      });
    };
  }

  /** Attach a manager to a connection. Returns the instance so callers can dispose. */
  static attach(connection: UpdateManagerConnection, options: UpdateManagerOptions): UpdateManager {
    const mgr = new UpdateManager(connection, options);
    connection.on("server:welcome", mgr.welcomeListener);
    return mgr;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.connection.off("server:welcome", this.welcomeListener);
    if (this.quietGateTimer) {
      clearTimeout(this.quietGateTimer);
      this.quietGateTimer = null;
    }
  }

  private async onWelcome(welcome: ServerWelcome): Promise<void> {
    if (this.disposed || this.updateInFlight || this.pendingRestart) return;
    // Claim the slot for the entire decision flow (not just runUpdate): a
    // `policy=auto` TTY path awaits a 5s sleep + the quiet gate, and a
    // reconnect storm inside that window would otherwise fan out parallel
    // decisions.
    this.updateInFlight = true;
    try {
      await this.decide(welcome);
    } finally {
      this.updateInFlight = false;
    }
  }

  private async decide(welcome: ServerWelcome): Promise<void> {
    const { serverCommandVersion: target } = welcome.frame;
    const current = this.options.currentVersion;

    if (!semver.valid(target)) {
      this.options.log("warn", `Server advertised invalid version "${target}"; skipping drift check`);
      return;
    }
    if (!semver.valid(current)) {
      this.options.log("warn", `Own version "${current}" is not valid SemVer; skipping drift check`);
      return;
    }

    if (semver.eq(target, current)) {
      this.options.log("debug", `Server advertises ${target}, matching running version`);
      return;
    }
    if (semver.lt(target, current)) {
      this.options.log("info", `Server advertises ${target}, running ${current} (ahead)`);
      return;
    }

    const policy = this.options.updateConfig.policy;

    if (policy === "off") {
      this.options.log("info", `Server advertises ${target}, running ${current}; self-update disabled (policy=off)`);
      return;
    }

    if (policy === "prompt") {
      if (!this.options.isTTY) {
        this.options.log(
          "warn",
          `Update available (${current} → ${target}) but policy=prompt requires a terminal; operator action required`,
        );
        return;
      }
      const accepted = await this.options.prompt({
        currentVersion: current,
        targetVersion: target,
        timeoutSeconds: this.options.updateConfig.prompt_timeout_seconds,
      });
      if (!accepted) {
        this.options.log("info", `Update declined by operator (still running ${current})`);
        return;
      }
      // Explicit consent waives the quiet gate — restart immediately.
      await this.runUpdate(current, target);
      return;
    }

    // policy === "auto"
    this.options.log("info", `Server advertises ${target}, running ${current}; policy=auto`);

    if (this.options.isTTY) {
      // Brief notice delay so an attended operator can Ctrl+C. The
      // process-level SIGINT handler installed by the runtime kills us
      // cleanly without applying the update.
      this.options.log("info", "Auto-update starting in 5s");
      await sleep(5000);
      if (this.disposed) return;
    }

    // First welcome: no quiet gate (no sessions could possibly be busy).
    // Reconnect welcome: defer until the quiet gate passes.
    if (welcome.isReconnect) {
      await this.waitForQuietGate();
      if (this.disposed) return;
    }
    await this.runUpdate(current, target);
  }

  private async waitForQuietGate(): Promise<void> {
    const quietMs = this.options.updateConfig.restart_quiet_seconds * 1000;
    const intervalMs = this.options.updateConfig.restart_check_interval_seconds * 1000;
    while (!this.disposed) {
      const snapshot = this.options.getQuietGateSnapshot();
      const now = Date.now();
      const idleFor = snapshot.lastActivityMs === 0 ? Number.POSITIVE_INFINITY : now - snapshot.lastActivityMs;
      if (snapshot.activeCount === 0 && idleFor >= quietMs) return;
      this.options.log(
        "debug",
        `Quiet gate: activeCount=${snapshot.activeCount}, idleFor=${Math.round(idleFor)}ms; re-checking in ${intervalMs}ms`,
      );
      await new Promise<void>((resolve) => {
        this.quietGateTimer = setTimeout(() => {
          this.quietGateTimer = null;
          resolve();
        }, intervalMs);
      });
    }
  }

  private async runUpdate(current: string, target: string): Promise<void> {
    try {
      const result = await this.options.executeUpdate({ currentVersion: current, targetVersion: target });
      if (result.installed) {
        // Standalone mode: install succeeded but the host left the process
        // alive. Further welcome frames must not fire npm again — only a
        // restart can pick up the new bits.
        this.pendingRestart = true;
        this.options.log(
          "info",
          `Update ${target} installed; restart required to pick it up (no further self-update attempts until restart)`,
        );
        return;
      }
      this.options.log("warn", "Self-update did not complete; will retry on next welcome frame");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.options.log("warn", `Self-update threw: ${msg}`);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
