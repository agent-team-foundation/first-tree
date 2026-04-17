/**
 * Phase 3c: task dispatcher.
 *
 * Port of the dispatch loop in
 * `service.rs::run_loop` +
 * `dispatch_pending` + `handle_completion`.
 *
 * Role:
 *   - Accept `TaskCandidate`s from an injected source (`submit`).
 *   - Gate on the per-notification claim (see `claim.ts`) to dedupe
 *     across restarts and across this host + laptop.
 *   - Respect `maxParallel` concurrency ceiling.
 *   - Prepare a workspace (`workspace.ts`) and run the agent
 *     (`runner.ts::executeRunner`) with the pool's execution order as
 *     fallback chain.
 *   - Publish task-phase events to the bus (`bus.ts`) so SSE
 *     subscribers see `dispatched` / `completed` / `failed` / `timed_out`.
 *   - Enforce a per-task timeout (spec doc 4 §8, §11 — Rust had no
 *     timeout and agent hangs blocked dispatcher threads indefinitely).
 *
 * Out of scope (Phase 4):
 *   - Polling GitHub to produce candidates (`collect_candidates`).
 *   - Snapshot hydration into `<task-dir>/snapshot/` (`write_task_snapshot`).
 *   - ThreadRecord retry/backoff bookkeeping. We surface the hook via
 *     `onCompletion` so a future layer can persist it without this
 *     module needing to know about the store.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { Bus } from "./bus.js";
import {
  CLAIM_STALE_AFTER_SEC,
  peekClaim,
  releaseClaim,
  tryClaim,
} from "./claim.js";
import {
  RunnerPool,
  executeRunner,
  runWithTimeout,
  type AgentIdentity,
  type RunnerOutcome,
  type RunnerRequest,
  type RunnerSpec,
  type RunnerSpawner,
  type RunnerTask,
} from "./runner.js";
import {
  WorkspaceManager,
  type WorkspaceCandidate,
} from "./workspace.js";

export interface TaskCandidate {
  /** Stable key to dedupe across this thread_key. */
  threadKey: string;
  /** The underlying GitHub thread id used for claim naming. */
  notificationId: string;
  /** Source repository (`owner/repo`). */
  repo: string;
  /** Optional operator-routing override; defaults to `repo`. */
  workspaceRepo?: string;
  /** Issue/PR kind (issue | pr | review | mention | ...). */
  kind: string;
  /** Derived id used for workspace directory naming + task id. */
  stableId: string;
  /** Optional PR number (for `refs/pull/<n>/head` fetch). */
  prNumber?: number;
  title: string;
  taskUrl: string;
  /** Dispatcher priority (higher first). */
  priority: number;
  /** ISO timestamp used for tie-breaking older-first. */
  updatedAt: string;
}

export interface DispatcherOptions {
  runnerHome: string;
  identity: AgentIdentity;
  runners: readonly RunnerSpec[];
  workspaceManager: WorkspaceManager;
  bus: Bus;
  ghShimDir: string;
  ghBrokerDir: string;
  claimsDir: string;
  disclosureText: string;
  maxParallel: number;
  taskTimeoutMs: number;
  /** Inject a runner spawner; tests pass a stub. Production uses default. */
  spawner?: RunnerSpawner;
  /** Inject a clock (seconds). */
  nowSec?: () => number;
  /** Hook called once per completion (ok or error). */
  onCompletion?: (result: CompletionRecord) => void;
  /** Logger for diagnostic lines. */
  logger?: DispatcherLogger;
  /** Dry-run: skip agent execution, publish simulated success. */
  dryRun?: boolean;
  /**
   * Claim TTL in seconds. Defaults to `CLAIM_STALE_AFTER_SEC` (5min)
   * from `claim.ts` for parity with the skill; the dispatcher may
   * tune it for long-running tasks.
   */
  claimTtlSec?: number;
}

export interface DispatcherLogger {
  info: (line: string) => void;
  warn: (line: string) => void;
  error: (line: string) => void;
}

export interface CompletionRecord {
  taskId: string;
  threadKey: string;
  candidate: TaskCandidate;
  phase: "completed" | "failed" | "timed_out" | "skipped-claim";
  status?: string;
  summary?: string;
  error?: string;
  runnerName?: string;
  runnerOutputPath?: string;
}

interface ActiveTask {
  taskId: string;
  threadKey: string;
  title: string;
  claimed: boolean;
  /** Settles when the task's run-and-handle loop finishes. */
  done: Promise<void>;
}

const DEFAULT_LOGGER: DispatcherLogger = {
  info: (line) => process.stdout.write(`${line}\n`),
  warn: (line) => process.stderr.write(`WARN: ${line}\n`),
  error: (line) => process.stderr.write(`ERROR: ${line}\n`),
};

/**
 * Priority-sorted queue + concurrency gate. Candidates enter via
 * `submit`; completions are surfaced via the bus and the optional
 * `onCompletion` hook. The dispatcher never blocks `submit` — it
 * queues and lets the internal pump drain as slots free up.
 */
export class Dispatcher {
  private readonly options: DispatcherOptions;
  private readonly runnerPool: RunnerPool;
  private readonly logger: DispatcherLogger;
  private readonly pending: TaskCandidate[] = [];
  private readonly queuedThreads = new Set<string>();
  private readonly active = new Map<string, ActiveTask>();
  private readonly nowSec: () => number;
  private readonly claimTtlSec: number;
  private stopped = false;
  /**
   * AbortController cascaded to every running task. Tripped on `stop()`.
   */
  private readonly shutdown = new AbortController();

  constructor(options: DispatcherOptions) {
    this.options = options;
    this.runnerPool = new RunnerPool(options.runners);
    this.logger = options.logger ?? DEFAULT_LOGGER;
    this.nowSec = options.nowSec ?? (() => Math.floor(Date.now() / 1_000));
    this.claimTtlSec = options.claimTtlSec ?? CLAIM_STALE_AFTER_SEC;
  }

  /** Enqueue a candidate. No-op if already pending/active. */
  submit(candidate: TaskCandidate): void {
    if (this.stopped) return;
    if (this.queuedThreads.has(candidate.threadKey)) return;
    if ([...this.active.values()].some((t) => t.threadKey === candidate.threadKey)) {
      return;
    }
    this.pending.push(candidate);
    this.queuedThreads.add(candidate.threadKey);
    this.pending.sort(orderByPriority);
    this.pump();
  }

  /** Number of candidates waiting for a slot. */
  pendingCount(): number {
    return this.pending.length;
  }

  /** Number of tasks currently running. */
  activeCount(): number {
    return this.active.size;
  }

  /**
   * Stop accepting new candidates, abort running tasks, and wait for
   * them to release. Idempotent.
   */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.shutdown.abort();
    // Drain pending queue without running.
    this.pending.length = 0;
    this.queuedThreads.clear();
    await Promise.all(
      [...this.active.values()].map((t) => t.done.catch(() => undefined)),
    );
  }

  /** Pump the queue up to `maxParallel`. */
  private pump(): void {
    if (this.stopped) return;
    while (
      this.active.size < this.options.maxParallel &&
      this.pending.length > 0
    ) {
      const candidate = this.pending.shift();
      if (!candidate) break;
      this.queuedThreads.delete(candidate.threadKey);
      this.launch(candidate);
    }
  }

  private launch(candidate: TaskCandidate): void {
    const taskId = `task-${this.nowSec()}-${candidate.stableId}`;
    const taskDir = join(this.options.runnerHome, "tasks", taskId);
    mkdirSync(taskDir, { recursive: true });
    const snapshotDir = join(taskDir, "snapshot");
    mkdirSync(snapshotDir, { recursive: true });

    const claim = tryClaim({
      claimsDir: this.options.claimsDir,
      id: candidate.notificationId,
      sessionId: `dispatcher:${taskId}`,
      action: "dispatch",
      claimStaleSec: this.claimTtlSec,
    });

    if (!claim.claimed) {
      this.logger.info(
        `dispatcher: skipping ${candidate.threadKey} — active claim held by ${claim.owner ?? "unknown"}`,
      );
      const record: CompletionRecord = {
        taskId,
        threadKey: candidate.threadKey,
        candidate,
        phase: "skipped-claim",
        summary: "claim already held",
      };
      this.options.onCompletion?.(record);
      this.publishTask(record);
      // No state to clean up — we never added to active.
      return;
    }

    const active: ActiveTask = {
      taskId,
      threadKey: candidate.threadKey,
      title: candidate.title,
      claimed: true,
      done: this.runTask(taskId, taskDir, snapshotDir, candidate).finally(
        () => {
          try {
            releaseClaim(this.options.claimsDir, candidate.notificationId);
          } catch (err) {
            this.logger.warn(
              `dispatcher: failed to release claim: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          this.active.delete(taskId);
          this.pump();
        },
      ),
    };
    this.active.set(taskId, active);

    this.options.bus.publish({
      kind: "task",
      phase: "dispatched",
      task_id: taskId,
      thread_key: candidate.threadKey,
      summary: candidate.title,
    });
  }

  private async runTask(
    taskId: string,
    taskDir: string,
    snapshotDir: string,
    candidate: TaskCandidate,
  ): Promise<void> {
    if (this.options.dryRun) {
      const record: CompletionRecord = {
        taskId,
        threadKey: candidate.threadKey,
        candidate,
        phase: "completed",
        status: "simulated",
        summary: "dry-run scheduled task",
        runnerOutputPath: join(taskDir, "runner-output.txt"),
      };
      this.options.onCompletion?.(record);
      this.publishTask(record);
      return;
    }

    let workspaceDir: string;
    try {
      const lease = await this.options.workspaceManager.prepare(
        toWorkspaceCandidate(candidate),
      );
      workspaceDir = lease.workspaceDir;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const record: CompletionRecord = {
        taskId,
        threadKey: candidate.threadKey,
        candidate,
        phase: "failed",
        error: `workspace prepare failed: ${message}`,
      };
      this.options.onCompletion?.(record);
      this.publishTask(record);
      return;
    }

    const request = makeRunnerRequest({
      candidate,
      taskId,
      taskDir,
      snapshotDir,
      workspaceDir,
      identity: this.options.identity,
      ghShimDir: this.options.ghShimDir,
      ghBrokerDir: this.options.ghBrokerDir,
      disclosureText: this.options.disclosureText,
    });

    const runners = this.runnerPool.executionOrder();
    const errors: string[] = [];
    let outcome: RunnerOutcome | undefined;
    let selectedRunner: RunnerSpec | undefined;
    let timedOut = false;

    for (const spec of runners) {
      try {
        outcome = await runWithTimeout({
          run: () => executeRunner(spec, request, {
            timeoutMs: this.options.taskTimeoutMs,
            spawner: this.options.spawner,
          }),
          // `executeRunner`'s spawner handles its own kill hook; we use
          // runWithTimeout as an additional safety net and propagate
          // the shutdown signal.
          kill: () => undefined,
          timeoutMs: this.options.taskTimeoutMs,
          signal: this.shutdown.signal,
        });
        selectedRunner = spec;
        break;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`${spec.kind}: ${message}`);
        if (/^timed out/.test(message) || /^aborted/.test(message)) {
          timedOut = true;
          break;
        }
      }
    }

    if (!outcome) {
      const phase: CompletionRecord["phase"] = timedOut ? "timed_out" : "failed";
      const record: CompletionRecord = {
        taskId,
        threadKey: candidate.threadKey,
        candidate,
        phase,
        error: errors.join("; "),
      };
      this.options.onCompletion?.(record);
      this.publishTask(record);
      return;
    }

    const record: CompletionRecord = {
      taskId,
      threadKey: candidate.threadKey,
      candidate,
      phase: "completed",
      status: outcome.status,
      summary: outcome.summary,
      runnerName: selectedRunner?.kind,
      runnerOutputPath: outcome.outputPath,
    };
    this.options.onCompletion?.(record);
    this.publishTask(record);
  }

  private publishTask(record: CompletionRecord): void {
    if (record.phase === "skipped-claim") return;
    this.options.bus.publish({
      kind: "task",
      phase:
        record.phase === "timed_out"
          ? "timed_out"
          : record.phase === "failed"
            ? "failed"
            : "completed",
      task_id: record.taskId,
      thread_key: record.threadKey,
      status: record.status,
      summary: record.summary ?? record.error,
    });
  }
}

function toWorkspaceCandidate(candidate: TaskCandidate): WorkspaceCandidate {
  return {
    repo: candidate.repo,
    workspaceRepo: candidate.workspaceRepo ?? candidate.repo,
    kind: candidate.kind,
    stableId: candidate.stableId,
    prNumber: candidate.prNumber,
  };
}

function makeRunnerRequest(args: {
  candidate: TaskCandidate;
  taskId: string;
  taskDir: string;
  snapshotDir: string;
  workspaceDir: string;
  identity: AgentIdentity;
  ghShimDir: string;
  ghBrokerDir: string;
  disclosureText: string;
}): RunnerRequest {
  const task: RunnerTask = {
    repo: args.candidate.repo,
    workspaceRepo: args.candidate.workspaceRepo ?? args.candidate.repo,
    kind: args.candidate.kind,
    title: args.candidate.title,
    taskUrl: args.candidate.taskUrl,
  };
  return {
    task,
    taskId: args.taskId,
    taskDir: args.taskDir,
    workspaceDir: args.workspaceDir,
    snapshotDir: args.snapshotDir,
    ghShimDir: args.ghShimDir,
    ghBrokerDir: args.ghBrokerDir,
    identity: args.identity,
    disclosureText: args.disclosureText,
  };
}

function orderByPriority(a: TaskCandidate, b: TaskCandidate): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
  return a.threadKey.localeCompare(b.threadKey);
}

/** Re-export peekClaim for callers that want to inspect without acquiring. */
export { peekClaim };
