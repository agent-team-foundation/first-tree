import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createBus } from "../../src/github-scan/engine/daemon/bus.js";
import { runCandidateCycle, runCandidateLoop } from "../../src/github-scan/engine/daemon/candidate-loop.js";
import { type TaskCandidate as DispatchCandidate, Dispatcher } from "../../src/github-scan/engine/daemon/dispatcher.js";
import { type CandidatePoll, GhClient } from "../../src/github-scan/engine/daemon/gh-client.js";
import { GhExecutor } from "../../src/github-scan/engine/daemon/gh-executor.js";
import { type GitRunner, WorkspaceManager } from "../../src/github-scan/engine/daemon/workspace.js";
import { RepoFilter } from "../../src/github-scan/engine/runtime/repo-filter.js";
import { buildReviewRequestCandidate } from "../../src/github-scan/engine/runtime/task.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length) {
    const dir = tempRoots.pop();
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `github-scan-candidate-${prefix}-`));
  tempRoots.push(dir);
  return dir;
}

function makeClientStub(poll: CandidatePoll): GhClient {
  const executor = new GhExecutor({
    realGh: "/usr/bin/gh",
    writeCooldownMs: 0,
    spawnGh: async () => ({ stdout: "", stderr: "", statusCode: 0 }),
    now: () => 1_000_000,
    sleep: async () => undefined,
  });
  const client = new GhClient({
    host: "github.com",
    repoFilter: RepoFilter.empty(),
    executor,
  });
  // Override collectCandidates for the test.
  (client as unknown as { collectCandidates: unknown }).collectCandidates = async () => poll;
  return client;
}

function makeDispatcher(): {
  dispatcher: Dispatcher;
  submitted: DispatchCandidate[];
} {
  const submitted: DispatchCandidate[] = [];
  const root = makeTempDir("disp");
  const reposDir = join(root, "repos");
  const claimsDir = join(root, "claims");
  mkdirSync(reposDir, { recursive: true });
  mkdirSync(claimsDir, { recursive: true });
  mkdirSync(join(reposDir, "owner__repo.git"), { recursive: true });
  const git: GitRunner = async ({ args }) =>
    args.includes("rev-parse")
      ? { stdout: "deadbeef\n", stderr: "", statusCode: 0 }
      : { stdout: "", stderr: "", statusCode: 0 };
  const dispatcher = new Dispatcher({
    runnerHome: join(root, "runner"),
    identity: { host: "github.com", login: "alice" },
    agents: [{ kind: "codex" }],
    workspaceManager: new WorkspaceManager({
      reposDir,
      workspacesDir: join(root, "workspaces"),
      identity: { host: "github.com", login: "alice" },
      runGit: git,
    }),
    bus: createBus(),
    ghShimDir: join(root, "shim", "bin"),
    ghBrokerDir: join(root, "shim"),
    claimsDir,
    disclosureText: "n",
    maxParallel: 1,
    taskTimeoutMs: 1_000,
    dryRun: true,
    onCompletion: () => undefined,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  mkdirSync(join(root, "runner"), { recursive: true });
  const submitOriginal = dispatcher.submit.bind(dispatcher);
  dispatcher.submit = (c: DispatchCandidate): void => {
    submitted.push(c);
    submitOriginal(c);
  };
  return { dispatcher, submitted };
}

describe("runCandidateCycle", () => {
  it("submits each candidate to the dispatcher and reports counts", async () => {
    const candidate = buildReviewRequestCandidate({
      repo: "owner/repo",
      number: 42,
      title: "Review",
      webUrl: "https://github.com/owner/repo/pull/42",
      updatedAt: "2026-04-15T12:00:00Z",
    });
    const poll: CandidatePoll = {
      tasks: [candidate],
      warnings: [],
      searchAttempted: true,
      searchRateLimited: false,
    };
    const client = makeClientStub(poll);
    const { dispatcher, submitted } = makeDispatcher();
    const outcome = await runCandidateCycle(
      {
        client,
        dispatcher,
        searchLimit: 10,
        includeSearch: true,
        lookbackSecs: 3600,
      },
      () => 1_700_000_000,
    );
    expect(outcome.submitted).toBe(1);
    expect(submitted).toHaveLength(1);
    expect(submitted[0].threadKey).toBe("/repos/owner/repo/pulls/42");
  });

  it("bubbles rate-limited + warning signals from the poll", async () => {
    const client = makeClientStub({
      tasks: [],
      warnings: ["review search: rate limit"],
      searchAttempted: true,
      searchRateLimited: true,
    });
    const { dispatcher } = makeDispatcher();
    const outcome = await runCandidateCycle(
      {
        client,
        dispatcher,
        searchLimit: 10,
        includeSearch: true,
        lookbackSecs: 3600,
      },
      () => 1_700_000_000,
    );
    expect(outcome.submitted).toBe(0);
    expect(outcome.rateLimited).toBe(true);
    expect(outcome.warnings).toEqual(["review search: rate limit"]);
  });

  it("honors scheduler skips and still reports the raw cycle outcome", async () => {
    const candidate = buildReviewRequestCandidate({
      repo: "owner/repo",
      number: 77,
      title: "Skip for now",
      webUrl: "https://github.com/owner/repo/pull/77",
      updatedAt: "2026-04-15T12:00:00Z",
    });
    const client = makeClientStub({
      tasks: [candidate],
      warnings: ["soft warning"],
      searchAttempted: true,
      searchRateLimited: false,
    });
    const { dispatcher, submitted } = makeDispatcher();
    const outcomes: unknown[] = [];
    const outcome = await runCandidateCycle(
      {
        client,
        dispatcher,
        searchLimit: 10,
        includeSearch: true,
        lookbackSecs: 3600,
        scheduler: { shouldSchedule: async () => false } as never,
        onCycle: (next) => outcomes.push(next),
      },
      () => 1_700_000_000,
    );
    expect(outcome.submitted).toBe(0);
    expect(submitted).toEqual([]);
    expect(outcomes).toEqual([outcome]);
  });
});

describe("runCandidateLoop", () => {
  it("exits cleanly when the signal aborts", async () => {
    const client = makeClientStub({
      tasks: [],
      warnings: [],
      searchAttempted: false,
      searchRateLimited: false,
    });
    const { dispatcher } = makeDispatcher();
    const controller = new AbortController();
    const sleep = vi.fn(async (_ms: number) => {
      // Abort mid-loop so we don't wait the real interval.
      controller.abort();
    });
    const done = runCandidateLoop({
      client,
      dispatcher,
      pollIntervalSec: 1,
      searchLimit: 10,
      includeSearch: false,
      lookbackSecs: 3600,
      signal: controller.signal,
      sleep,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    await done;
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("recovers orphaned candidates before polling and applies the scheduler gate", async () => {
    const first = buildReviewRequestCandidate({
      repo: "owner/repo",
      number: 1,
      title: "Skip recovery",
      webUrl: "https://github.com/owner/repo/pull/1",
      updatedAt: "2026-04-15T12:00:00Z",
    });
    const second = buildReviewRequestCandidate({
      repo: "owner/repo",
      number: 2,
      title: "Recover",
      webUrl: "https://github.com/owner/repo/pull/2",
      updatedAt: "2026-04-15T12:01:00Z",
    });
    const client = makeClientStub({
      tasks: [],
      warnings: [],
      searchAttempted: false,
      searchRateLimited: false,
    });
    const { dispatcher, submitted } = makeDispatcher();
    const controller = new AbortController();
    const decisions = [false, true];
    const sleep = vi.fn(async () => {
      controller.abort();
    });

    await runCandidateLoop({
      client,
      dispatcher,
      pollIntervalSec: 1,
      searchLimit: 10,
      includeSearch: false,
      lookbackSecs: 3600,
      signal: controller.signal,
      sleep,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      scheduler: { shouldSchedule: async () => decisions.shift() ?? true } as never,
      recoverableCandidates: () => [first, second],
    });

    expect(submitted.map((candidate) => candidate.threadKey)).toEqual(["/repos/owner/repo/pulls/2"]);
  });

  it("publishes warnings and backs off when the candidate search is rate-limited", async () => {
    const client = makeClientStub({
      tasks: [],
      warnings: ["review search: secondary rate limit"],
      searchAttempted: true,
      searchRateLimited: true,
    });
    const { dispatcher } = makeDispatcher();
    const controller = new AbortController();
    const events: unknown[] = [];
    const logs: string[] = [];
    const sleepCalls: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      sleepCalls.push(ms);
      controller.abort();
    });

    await runCandidateLoop({
      client,
      dispatcher,
      bus: { publish: (event: unknown) => events.push(event) } as never,
      pollIntervalSec: 1,
      searchLimit: 10,
      includeSearch: true,
      lookbackSecs: 3600,
      signal: controller.signal,
      sleep,
      logger: {
        info: (line) => logs.push(`INFO ${line}`),
        warn: (line) => logs.push(`WARN ${line}`),
        error: (line) => logs.push(`ERROR ${line}`),
      },
    });

    expect(events).toEqual([{ kind: "activity", line: "review search: secondary rate limit" }]);
    expect(logs).toEqual(expect.arrayContaining([expect.stringContaining("candidate search rate-limited")]));
    expect(sleepCalls[0]).toBe(120_000);
  });

  it("logs crashed cycles and sleeps the regular poll interval", async () => {
    const executor = new GhExecutor({
      realGh: "/usr/bin/gh",
      writeCooldownMs: 0,
      spawnGh: async () => ({ stdout: "", stderr: "", statusCode: 0 }),
      now: () => 1_000_000,
      sleep: async () => undefined,
    });
    const client = new GhClient({
      host: "github.com",
      repoFilter: RepoFilter.empty(),
      executor,
    });
    (client as unknown as { collectCandidates: unknown }).collectCandidates = async () => {
      throw new Error("candidate boom");
    };
    const { dispatcher } = makeDispatcher();
    const controller = new AbortController();
    const errors: string[] = [];
    const sleepCalls: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      sleepCalls.push(ms);
      controller.abort();
    });

    await runCandidateLoop({
      client,
      dispatcher,
      pollIntervalSec: 3,
      searchLimit: 10,
      includeSearch: false,
      lookbackSecs: 3600,
      signal: controller.signal,
      sleep,
      logger: { info: () => {}, warn: () => {}, error: (line) => errors.push(line) },
    });

    expect(errors).toEqual(["candidate cycle crashed: candidate boom"]);
    expect(sleepCalls).toEqual([3000]);
  });
});
