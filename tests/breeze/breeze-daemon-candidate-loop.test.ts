import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBus } from "../../src/products/breeze/engine/daemon/bus.js";
import {
  Dispatcher,
  type TaskCandidate as DispatchCandidate,
} from "../../src/products/breeze/engine/daemon/dispatcher.js";
import {
  GhClient,
  type CandidatePoll,
} from "../../src/products/breeze/engine/daemon/gh-client.js";
import {
  runCandidateCycle,
  runCandidateLoop,
} from "../../src/products/breeze/engine/daemon/candidate-loop.js";
import { buildReviewRequestCandidate } from "../../src/products/breeze/engine/runtime/task.js";
import {
  WorkspaceManager,
  type GitRunner,
} from "../../src/products/breeze/engine/daemon/workspace.js";
import type { AgentSpawner } from "../../src/products/breeze/engine/daemon/runner.js";
import { RepoFilter } from "../../src/products/breeze/engine/runtime/repo-filter.js";
import { GhExecutor } from "../../src/products/breeze/engine/daemon/gh-executor.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length) {
    const dir = tempRoots.pop();
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `breeze-candidate-${prefix}-`));
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
  (client as unknown as { collectCandidates: unknown }).collectCandidates =
    async () => poll;
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
    const sleep = vi.fn(async (ms: number) => {
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
});
