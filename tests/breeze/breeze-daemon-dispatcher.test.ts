import { afterEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBus, type BusEvent } from "../../src/products/breeze/engine/daemon/bus.js";
import {
  Dispatcher,
  type CompletionRecord,
  type TaskCandidate,
} from "../../src/products/breeze/engine/daemon/dispatcher.js";
import {
  WorkspaceManager,
  type GitRunner,
} from "../../src/products/breeze/engine/daemon/workspace.js";
import type { RunnerSpawner } from "../../src/products/breeze/engine/daemon/runner.js";
import { tryClaim } from "../../src/products/breeze/engine/daemon/claim.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length) {
    const dir = tempRoots.pop();
    if (dir && existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `breeze-dispatch-${prefix}-`));
  tempRoots.push(dir);
  return dir;
}

function fakeCandidate(overrides: Partial<TaskCandidate> = {}): TaskCandidate {
  return {
    threadKey: "owner/repo#42",
    notificationId: "nid-42",
    repo: "owner/repo",
    kind: "issue",
    stableId: "42",
    title: "Fix thing",
    taskUrl: "https://github.com/owner/repo/issues/42",
    priority: 1,
    updatedAt: "2026-04-16T00:00:00Z",
    ...overrides,
  };
}

function fakeGitRunner(): GitRunner {
  return async ({ args }) => {
    if (args.includes("rev-parse") && args.includes("HEAD")) {
      return { stdout: "deadbeef\n", stderr: "", statusCode: 0 };
    }
    return { stdout: "", stderr: "", statusCode: 0 };
  };
}

function makeWorkspaceManager(root: string): WorkspaceManager {
  const reposDir = join(root, "repos");
  const workspacesDir = join(root, "workspaces");
  mkdirSync(reposDir, { recursive: true });
  mkdirSync(join(reposDir, "owner__repo.git"), { recursive: true });
  return new WorkspaceManager({
    reposDir,
    workspacesDir,
    identity: { host: "github.com", login: "alice" },
    runGit: fakeGitRunner(),
  });
}

interface DispatcherEnv {
  dispatcher: Dispatcher;
  runnerHome: string;
  claimsDir: string;
  events: BusEvent[];
  completions: CompletionRecord[];
}

function setupDispatcher(opts: {
  spawner?: RunnerSpawner;
  runners?: Array<{ kind: "codex" | "claude" }>;
  maxParallel?: number;
  taskTimeoutMs?: number;
  dryRun?: boolean;
} = {}): DispatcherEnv {
  const root = makeTempDir("env");
  const runnerHome = join(root, "runner-home");
  const claimsDir = join(root, "claims");
  mkdirSync(runnerHome, { recursive: true });
  mkdirSync(claimsDir, { recursive: true });

  const bus = createBus();
  const events: BusEvent[] = [];
  bus.subscribe((ev) => events.push(ev));
  const completions: CompletionRecord[] = [];

  const dispatcher = new Dispatcher({
    runnerHome,
    identity: { host: "github.com", login: "alice" },
    runners: opts.runners ?? [{ kind: "codex" }],
    workspaceManager: makeWorkspaceManager(root),
    bus,
    ghShimDir: join(root, "shim", "bin"),
    ghBrokerDir: join(root, "shim"),
    claimsDir,
    disclosureText: "Agent note.",
    maxParallel: opts.maxParallel ?? 2,
    taskTimeoutMs: opts.taskTimeoutMs ?? 2_000,
    spawner: opts.spawner,
    dryRun: opts.dryRun,
    onCompletion: (rec) => completions.push(rec),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });

  return { dispatcher, runnerHome, claimsDir, events, completions };
}

function waitForCompletions(
  env: DispatcherEnv,
  count: number,
  timeoutMs = 2_000,
): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (env.completions.length >= count) return resolve();
      if (Date.now() - start > timeoutMs) {
        return reject(
          new Error(
            `only ${env.completions.length}/${count} completions after ${timeoutMs}ms`,
          ),
        );
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe("Dispatcher.submit", () => {
  it("dedupes repeated candidates with the same threadKey", () => {
    const spawner: RunnerSpawner = async ({ outputPath }) => {
      writeFileSync(
        outputPath,
        "BREEZE_RESULT: status=handled summary=ok",
      );
      return { statusCode: 0 };
    };
    const env = setupDispatcher({ spawner });
    env.dispatcher.submit(fakeCandidate());
    env.dispatcher.submit(fakeCandidate()); // same threadKey
    // First one launched immediately, so pending may be 0; but a 2nd of
    // same key must not enter.
    expect(env.dispatcher.activeCount() + env.dispatcher.pendingCount()).toBe(1);
  });

  it("sorts pending queue by priority (desc) then by updatedAt (asc)", async () => {
    // Serial spawner: resolves one task at a time, waits for the next
    // spawn before releasing. This exercises pump() ordering as slots free.
    let resolver: ((v: { statusCode: number }) => void) | undefined;
    const spawnedThreadKeys: string[] = [];
    const spawner: RunnerSpawner = async ({ outputPath, request }) => {
      spawnedThreadKeys.push(request.task.title);
      return new Promise((resolve) => {
        resolver = (v) => {
          writeFileSync(
            outputPath,
            "BREEZE_RESULT: status=handled summary=ok",
          );
          resolve(v);
        };
      });
    };
    const env = setupDispatcher({ spawner, maxParallel: 1 });
    env.dispatcher.submit(
      fakeCandidate({
        threadKey: "t-A",
        notificationId: "n-A",
        stableId: "A",
        title: "A",
        priority: 1,
      }),
    );
    env.dispatcher.submit(
      fakeCandidate({
        threadKey: "t-low",
        notificationId: "n-low",
        stableId: "low",
        title: "low",
        priority: 0,
        updatedAt: "2026-04-01T00:00:00Z",
      }),
    );
    env.dispatcher.submit(
      fakeCandidate({
        threadKey: "t-hi",
        notificationId: "n-hi",
        stableId: "hi",
        title: "hi",
        priority: 5,
        updatedAt: "2026-04-10T00:00:00Z",
      }),
    );
    env.dispatcher.submit(
      fakeCandidate({
        threadKey: "t-mid",
        notificationId: "n-mid",
        stableId: "mid",
        title: "mid",
        priority: 2,
        updatedAt: "2026-04-05T00:00:00Z",
      }),
    );

    // Drain 4 tasks serially, waiting for each spawn before releasing.
    for (let i = 0; i < 4; i++) {
      const deadline = Date.now() + 1_000;
      while (!resolver && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }
      const r = resolver;
      resolver = undefined;
      r?.({ statusCode: 0 });
    }

    await waitForCompletions(env, 4);
    expect(spawnedThreadKeys).toEqual(["A", "hi", "mid", "low"]);
  });
});

describe("Dispatcher claim handling", () => {
  it("skips dispatch when the claim is already held by someone else", async () => {
    const spawner = vi.fn<RunnerSpawner>();
    const env = setupDispatcher({ spawner });
    // Pre-claim the notification as a different owner.
    tryClaim({
      claimsDir: env.claimsDir,
      id: "nid-42",
      sessionId: "laptop:someone-else",
    });
    env.dispatcher.submit(fakeCandidate());
    // skipped-claim is synchronous in launch(); no wait needed.
    expect(env.completions).toHaveLength(1);
    expect(env.completions[0].phase).toBe("skipped-claim");
    expect(spawner).not.toHaveBeenCalled();
    // And no task event was published (skipped-claim is filtered out).
    const taskEvents = env.events.filter((e) => e.kind === "task");
    expect(taskEvents).toHaveLength(0);
  });

  it("releases the claim after task completes", async () => {
    const spawner: RunnerSpawner = async ({ outputPath }) => {
      writeFileSync(outputPath, "BREEZE_RESULT: status=handled summary=ok");
      return { statusCode: 0 };
    };
    const env = setupDispatcher({ spawner });
    env.dispatcher.submit(fakeCandidate());
    await waitForCompletions(env, 1);
    // Claim dir for this notification should be gone.
    expect(existsSync(join(env.claimsDir, "nid-42"))).toBe(false);
  });
});

describe("Dispatcher execution", () => {
  it("respects maxParallel (holds extras in pending)", async () => {
    const resolvers: Array<(v: { statusCode: number }) => void> = [];
    const spawner: RunnerSpawner = async ({ outputPath }) =>
      new Promise((resolve) => {
        resolvers.push((v) => {
          writeFileSync(
            outputPath,
            "BREEZE_RESULT: status=handled summary=ok",
          );
          resolve(v);
        });
      });
    const env = setupDispatcher({ spawner, maxParallel: 2 });
    env.dispatcher.submit(
      fakeCandidate({ threadKey: "a", notificationId: "na", stableId: "a" }),
    );
    env.dispatcher.submit(
      fakeCandidate({ threadKey: "b", notificationId: "nb", stableId: "b" }),
    );
    env.dispatcher.submit(
      fakeCandidate({ threadKey: "c", notificationId: "nc", stableId: "c" }),
    );
    expect(env.dispatcher.activeCount()).toBe(2);
    expect(env.dispatcher.pendingCount()).toBe(1);
    // Drain resolvers as they appear until all three complete.
    const deadline = Date.now() + 4_000;
    while (env.completions.length < 3 && Date.now() < deadline) {
      const r = resolvers.shift();
      if (r) r({ statusCode: 0 });
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(env.completions.length).toBe(3);
  });

  it("marks completed and publishes task event", async () => {
    const spawner: RunnerSpawner = async ({ outputPath }) => {
      writeFileSync(
        outputPath,
        "BREEZE_RESULT: status=handled summary=all done",
      );
      return { statusCode: 0 };
    };
    const env = setupDispatcher({ spawner });
    env.dispatcher.submit(fakeCandidate());
    await waitForCompletions(env, 1);
    const record = env.completions[0];
    expect(record.phase).toBe("completed");
    expect(record.status).toBe("handled");
    expect(record.summary).toBe("all done");
    expect(record.runnerName).toBe("codex");

    const phases = env.events
      .filter((e) => e.kind === "task")
      .map((e) => (e as Extract<BusEvent, { kind: "task" }>).phase);
    expect(phases).toEqual(["dispatched", "completed"]);
  });

  it("falls through to the next runner on non-timeout failure", async () => {
    const calls: string[] = [];
    const spawner: RunnerSpawner = async ({ spec, outputPath, stdoutPath }) => {
      calls.push(spec.kind);
      if (spec.kind === "codex") {
        return { statusCode: 1 };
      }
      writeFileSync(
        stdoutPath,
        "BREEZE_RESULT: status=handled summary=secondary",
      );
      writeFileSync(outputPath, "");
      return { statusCode: 0 };
    };
    const env = setupDispatcher({
      spawner,
      runners: [{ kind: "codex" }, { kind: "claude" }],
    });
    env.dispatcher.submit(fakeCandidate());
    await waitForCompletions(env, 1);
    expect(calls).toEqual(["codex", "claude"]);
    expect(env.completions[0].phase).toBe("completed");
    expect(env.completions[0].runnerName).toBe("claude");
  });

  it("publishes failed when every runner errors", async () => {
    const spawner: RunnerSpawner = async () => ({ statusCode: 7 });
    const env = setupDispatcher({
      spawner,
      runners: [{ kind: "codex" }, { kind: "claude" }],
    });
    env.dispatcher.submit(fakeCandidate());
    await waitForCompletions(env, 1);
    expect(env.completions[0].phase).toBe("failed");
    expect(env.completions[0].error).toMatch(/codex:/);
    expect(env.completions[0].error).toMatch(/claude:/);
    const taskEvents = env.events.filter((e) => e.kind === "task");
    expect(
      taskEvents.map(
        (e) => (e as Extract<BusEvent, { kind: "task" }>).phase,
      ),
    ).toEqual(["dispatched", "failed"]);
  });

  it("publishes timed_out and stops trying further runners when timeout fires", async () => {
    const spawner: RunnerSpawner = () =>
      new Promise(() => {
        /* never resolves */
      });
    const env = setupDispatcher({
      spawner,
      runners: [{ kind: "codex" }, { kind: "claude" }],
      taskTimeoutMs: 40,
    });
    env.dispatcher.submit(fakeCandidate());
    await waitForCompletions(env, 1, 1_000);
    expect(env.completions[0].phase).toBe("timed_out");
    const taskEvents = env.events.filter((e) => e.kind === "task");
    expect(
      taskEvents.map(
        (e) => (e as Extract<BusEvent, { kind: "task" }>).phase,
      ),
    ).toEqual(["dispatched", "timed_out"]);
  });

  it("dryRun short-circuits agent execution", async () => {
    const spawner = vi.fn<RunnerSpawner>();
    const env = setupDispatcher({ spawner, dryRun: true });
    env.dispatcher.submit(fakeCandidate());
    await waitForCompletions(env, 1);
    expect(spawner).not.toHaveBeenCalled();
    expect(env.completions[0].phase).toBe("completed");
    expect(env.completions[0].status).toBe("simulated");
  });
});

describe("Dispatcher.stop", () => {
  it("aborts in-flight tasks and drains pending", async () => {
    const spawner: RunnerSpawner = () =>
      new Promise(() => {
        /* never resolves */
      });
    const env = setupDispatcher({
      spawner,
      maxParallel: 1,
      taskTimeoutMs: 10_000,
    });
    env.dispatcher.submit(
      fakeCandidate({ threadKey: "a", notificationId: "na", stableId: "a" }),
    );
    env.dispatcher.submit(
      fakeCandidate({ threadKey: "b", notificationId: "nb", stableId: "b" }),
    );
    expect(env.dispatcher.activeCount()).toBe(1);
    expect(env.dispatcher.pendingCount()).toBe(1);
    await env.dispatcher.stop();
    expect(env.dispatcher.activeCount()).toBe(0);
    expect(env.dispatcher.pendingCount()).toBe(0);
    // Submissions after stop are ignored.
    env.dispatcher.submit(
      fakeCandidate({ threadKey: "c", notificationId: "nc", stableId: "c" }),
    );
    expect(env.dispatcher.activeCount()).toBe(0);
    expect(env.dispatcher.pendingCount()).toBe(0);
  });
});

describe("Dispatcher workspace failure", () => {
  it("publishes failed phase when workspace preparation throws", async () => {
    const badRunner: GitRunner = async ({ args }) => {
      if (args.includes("rev-parse")) {
        return { stdout: "", stderr: "boom", statusCode: 128 };
      }
      return { stdout: "", stderr: "", statusCode: 0 };
    };
    const root = makeTempDir("wsfail");
    const reposDir = join(root, "repos");
    mkdirSync(join(reposDir, "owner__repo.git"), { recursive: true });
    const runnerHome = join(root, "runner-home");
    const claimsDir = join(root, "claims");
    mkdirSync(runnerHome, { recursive: true });
    mkdirSync(claimsDir, { recursive: true });
    const bus = createBus();
    const events: BusEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const completions: CompletionRecord[] = [];
    const dispatcher = new Dispatcher({
      runnerHome,
      identity: { host: "github.com", login: "alice" },
      runners: [{ kind: "codex" }],
      workspaceManager: new WorkspaceManager({
        reposDir,
        workspacesDir: join(root, "workspaces"),
        identity: { host: "github.com", login: "alice" },
        runGit: badRunner,
      }),
      bus,
      ghShimDir: join(root, "shim", "bin"),
      ghBrokerDir: join(root, "shim"),
      claimsDir,
      disclosureText: "n",
      maxParallel: 1,
      taskTimeoutMs: 1_000,
      spawner: vi.fn<RunnerSpawner>(),
      onCompletion: (rec) => completions.push(rec),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    dispatcher.submit(fakeCandidate());
    const start = Date.now();
    while (completions.length < 1 && Date.now() - start < 2_000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(completions[0].phase).toBe("failed");
    expect(completions[0].error).toMatch(/workspace prepare failed/);
  });
});
