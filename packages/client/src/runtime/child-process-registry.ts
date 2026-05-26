/**
 * Child Process Registry — central bookkeeping for every subprocess the client
 * spawns (git, npm install, claude SDK helpers, playwright).
 *
 * Why a registry: systemd's cgroup-based `KillMode=mixed` cleanup repeatedly
 * leaves orphan `claude` / `npm exec @playw` processes after a shutdown
 * because the main process forgot to track them. Owning the PIDs ourselves
 * lets shutdown send SIGTERM, wait, and escalate to SIGKILL deterministically
 * — independent of cgroup behaviour.
 *
 * Scope:
 *  - `spawn` returns the live ChildProcess so callers stream stdout/stderr
 *    exactly as before; we just register a removal hook on `exit`.
 *  - `adopt` lets a caller register an externally-spawned process (e.g. an
 *    SDK that spawned its own child and only handed us a reference).
 *  - `killAll` runs SIGTERM → grace window → SIGKILL on every still-alive
 *    child. Resolves after every child fires `exit`, capped by an overall
 *    deadline so a stuck child can't hang shutdown forever.
 *  - `timeoutMs` per child arms an automatic SIGTERM/SIGKILL escalation.
 */

import type { ChildProcess, SpawnOptions as NodeSpawnOptions } from "node:child_process";
import { spawn as nodeSpawn } from "node:child_process";

export const CHILD_CATEGORIES = ["git", "npm-install", "claude", "playwright", "other"] as const;
export type ChildCategory = (typeof CHILD_CATEGORIES)[number];

export type CleanupPolicy = {
  firstSignal: NodeJS.Signals;
  /** Time between firstSignal and finalSignal. */
  gracePeriodMs: number;
  finalSignal: NodeJS.Signals;
};

const DEFAULT_CLEANUP: CleanupPolicy = {
  firstSignal: "SIGTERM",
  gracePeriodMs: 5_000,
  finalSignal: "SIGKILL",
};

const KILL_ALL_DEADLINE_MS = 30_000;

export type RegisteredChild = {
  /** PID assigned by Node — may be 0 in synthetic test fixtures. */
  readonly pid: number;
  readonly category: ChildCategory;
  readonly label: string;
  readonly startedAt: number;
  /** Send a signal to the child (no-op if already exited). */
  kill(signal?: NodeJS.Signals): void;
  /** Resolves once the child has exited. Multiple awaiters share the same promise. */
  readonly exited: Promise<void>;
};

export type RegistrySpawnOptions = NodeSpawnOptions & {
  category: ChildCategory;
  /** Human-readable label for logs (e.g. "git fetch origin"). */
  label: string;
  /** When >0, auto-kill the child after this many ms via the cleanup escalation. */
  timeoutMs?: number;
  cleanup?: CleanupPolicy;
};

export type AdoptOptions = {
  category: ChildCategory;
  label: string;
  timeoutMs?: number;
  cleanup?: CleanupPolicy;
};

type Entry = {
  child: ChildProcess;
  record: RegisteredChild;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
};

export interface ChildProcessRegistry {
  spawn(
    command: string,
    args: readonly string[],
    opts: RegistrySpawnOptions,
  ): { child: ChildProcess; record: RegisteredChild };
  adopt(child: ChildProcess, opts: AdoptOptions): RegisteredChild;
  list(filter?: { category?: ChildCategory }): readonly RegisteredChild[];
  /** Drop a record without killing the child. Used by tests / re-entry recovery. */
  unregister(pid: number): void;
  killAll(reason: string): Promise<void>;
}

class ChildProcessRegistryImpl implements ChildProcessRegistry {
  private readonly entries = new Map<number, Entry>();
  /** Distinct synthetic key when pid is undefined (rare — failed spawn). */
  private syntheticKey = -1;

  spawn(command: string, args: readonly string[], opts: RegistrySpawnOptions) {
    const { category, label, timeoutMs, cleanup, ...nodeOpts } = opts;
    const child = nodeSpawn(command, [...args], nodeOpts);
    const record = this.registerInternal(child, { category, label, timeoutMs, cleanup });
    return { child, record };
  }

  adopt(child: ChildProcess, opts: AdoptOptions): RegisteredChild {
    return this.registerInternal(child, opts);
  }

  list(filter?: { category?: ChildCategory }): readonly RegisteredChild[] {
    const out: RegisteredChild[] = [];
    for (const entry of this.entries.values()) {
      if (filter?.category && entry.record.category !== filter.category) continue;
      out.push(entry.record);
    }
    return out;
  }

  unregister(pid: number): void {
    const entry = this.entries.get(pid);
    if (!entry) return;
    if (entry.timeoutTimer) clearTimeout(entry.timeoutTimer);
    this.entries.delete(pid);
  }

  async killAll(reason: string): Promise<void> {
    const entries = [...this.entries.values()];
    if (entries.length === 0) return;
    const policy = DEFAULT_CLEANUP;

    // Send firstSignal to all entries; collect exit promises.
    const deadlines: Array<Promise<void>> = [];
    for (const entry of entries) {
      try {
        entry.child.kill(policy.firstSignal);
      } catch {
        // ignore — already dead or kernel said no such pid
      }
      deadlines.push(this.escalateAndAwait(entry, policy, reason));
    }

    await Promise.race([
      Promise.allSettled(deadlines),
      new Promise<void>((resolve) => setTimeout(resolve, KILL_ALL_DEADLINE_MS)),
    ]);
  }

  // ----- internal --------------------------------------------------------

  private registerInternal(
    child: ChildProcess,
    opts: { category: ChildCategory; label: string; timeoutMs?: number; cleanup?: CleanupPolicy },
  ): RegisteredChild {
    const pid = typeof child.pid === "number" ? child.pid : this.syntheticKey--;

    let exitResolve: () => void = () => {};
    const exited = new Promise<void>((resolve) => {
      exitResolve = resolve;
    });

    const record: RegisteredChild = {
      pid,
      category: opts.category,
      label: opts.label,
      startedAt: Date.now(),
      kill: (signal?: NodeJS.Signals) => {
        try {
          child.kill(signal ?? "SIGTERM");
        } catch {
          // already dead
        }
      },
      exited,
    };

    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      const cleanup = opts.cleanup ?? DEFAULT_CLEANUP;
      timeoutTimer = setTimeout(() => {
        try {
          child.kill(cleanup.firstSignal);
        } catch {
          // already dead
        }
        setTimeout(() => {
          // If the child is still alive after the grace window, escalate.
          if (this.entries.has(pid)) {
            try {
              child.kill(cleanup.finalSignal);
            } catch {
              // already dead
            }
          }
        }, cleanup.gracePeriodMs);
      }, opts.timeoutMs);
    }

    const entry: Entry = { child, record, timeoutTimer };
    this.entries.set(pid, entry);

    const onExit = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      this.entries.delete(pid);
      exitResolve();
    };
    child.once("exit", onExit);
    // A child that fails to spawn never emits "exit" but does emit "error".
    // Treat that as the same terminal signal so callers awaiting `exited`
    // don't hang forever.
    child.once("error", onExit);

    return record;
  }

  private async escalateAndAwait(entry: Entry, policy: CleanupPolicy, _reason: string): Promise<void> {
    // First wait the grace window.
    await Promise.race([
      entry.record.exited,
      new Promise<void>((resolve) => setTimeout(resolve, policy.gracePeriodMs)),
    ]);
    // If still alive, send finalSignal and wait for exit.
    if (this.entries.has(entry.record.pid)) {
      try {
        entry.child.kill(policy.finalSignal);
      } catch {
        // already dead
      }
      await entry.record.exited;
    }
  }
}

let singleton: ChildProcessRegistry | null = null;

export function getChildProcessRegistry(): ChildProcessRegistry {
  if (!singleton) singleton = new ChildProcessRegistryImpl();
  return singleton;
}

/** Test helper: replace the singleton with a fresh instance. */
export function _resetChildProcessRegistryForTests(): void {
  singleton = new ChildProcessRegistryImpl();
}
