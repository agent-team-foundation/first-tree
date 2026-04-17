import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  Scheduler,
  failureRetryDelaySec,
  operatorRepoFor,
  readRoutingSnapshotText,
  retryDelaySec,
  routeWorkspaceCandidate,
  shouldRouteToOperatorRepo,
} from "../../src/products/breeze/engine/daemon/scheduler.js";
import { ThreadStore } from "../../src/products/breeze/engine/daemon/thread-store.js";
import {
  buildReviewRequestCandidate,
  toDispatcherCandidate,
} from "../../src/products/breeze/engine/runtime/task.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length) {
    const dir = tempRoots.pop();
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

function makeHome(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `breeze-sched-${prefix}-`));
  tempRoots.push(dir);
  return dir;
}

describe("retryDelaySec / failureRetryDelaySec", () => {
  it("doubles per failure, saturates at 2^6 shift", () => {
    expect(retryDelaySec(0)).toBe(60);
    expect(retryDelaySec(1)).toBe(120);
    expect(retryDelaySec(4)).toBe(60 * 16);
    expect(retryDelaySec(6)).toBe(60 * 64);
    expect(retryDelaySec(99)).toBe(60 * 64);
  });

  it("bounds by poll interval in failureRetryDelaySec", () => {
    expect(failureRetryDelaySec(6, 300)).toBe(300);
    expect(failureRetryDelaySec(1, 300)).toBe(120);
  });
});

describe("Scheduler.shouldSchedule", () => {
  it("returns true for a fresh thread and persists last_seen", async () => {
    const store = new ThreadStore({ runnerHome: makeHome("fresh") });
    const sched = new Scheduler({
      store,
      identity: { host: "github.com", login: "alice" },
      pollIntervalSec: 60,
      nowSec: () => 1_000,
    });
    const candidate = buildReviewRequestCandidate({
      repo: "o/r",
      number: 1,
      title: "t",
      webUrl: "u",
      updatedAt: "2026-04-15T12:00:00Z",
    });
    expect(await sched.shouldSchedule(candidate)).toBe(true);
    const record = store.loadThreadRecord(candidate.threadKey);
    expect(record.lastSeenUpdatedAt).toBe("2026-04-15T12:00:00Z");
  });

  it("returns false while inside the backoff window", async () => {
    const store = new ThreadStore({ runnerHome: makeHome("backoff") });
    const sched = new Scheduler({
      store,
      identity: { host: "github.com", login: "alice" },
      pollIntervalSec: 60,
      nowSec: () => 1_000,
    });
    const candidate = buildReviewRequestCandidate({
      repo: "o/r",
      number: 2,
      title: "t",
      webUrl: "u",
      updatedAt: "2026-04-15T12:00:00Z",
    });
    store.saveThreadRecord({
      threadKey: candidate.threadKey,
      repo: candidate.repo,
      lastSeenUpdatedAt: candidate.updatedAt,
      lastHandledUpdatedAt: "",
      lastResult: "failed",
      failureCount: 2,
      nextRetryEpoch: 2_000,
      lastTaskId: "t1",
    });
    expect(await sched.shouldSchedule(candidate)).toBe(false);
  });

  it("returns false when updated_at is not newer than last_handled", async () => {
    const store = new ThreadStore({ runnerHome: makeHome("handled") });
    const sched = new Scheduler({
      store,
      identity: { host: "github.com", login: "alice" },
      pollIntervalSec: 60,
      nowSec: () => 1_000_000,
    });
    const candidate = buildReviewRequestCandidate({
      repo: "o/r",
      number: 3,
      title: "t",
      webUrl: "u",
      updatedAt: "2026-04-15T12:00:00Z",
    });
    store.saveThreadRecord({
      threadKey: candidate.threadKey,
      repo: candidate.repo,
      lastSeenUpdatedAt: "",
      lastHandledUpdatedAt: "2026-04-15T12:00:00Z",
      lastResult: "handled",
      failureCount: 0,
      nextRetryEpoch: 0,
      lastTaskId: "",
    });
    expect(await sched.shouldSchedule(candidate)).toBe(false);
  });

  it("short-circuits when latestVisibleActivity says we already replied", async () => {
    const store = new ThreadStore({ runnerHome: makeHome("selfact") });
    const ghClient = {
      async latestVisibleActivity() {
        return {
          login: "alice",
          userType: "User",
          updatedAt: "2026-04-15T12:00:00Z",
        };
      },
    } as never;
    const sched = new Scheduler({
      store,
      ghClient,
      identity: { host: "github.com", login: "alice" },
      pollIntervalSec: 60,
      nowSec: () => 1_000,
    });
    const candidate = buildReviewRequestCandidate({
      repo: "o/r",
      number: 4,
      title: "t",
      webUrl: "u",
      updatedAt: "2026-04-15T12:00:00Z",
    });
    expect(await sched.shouldSchedule(candidate)).toBe(false);
    const record = store.loadThreadRecord(candidate.threadKey);
    expect(record.lastResult).toBe("skipped");
    expect(record.lastHandledUpdatedAt).toBe(candidate.updatedAt);
  });
});

describe("Scheduler.handleCompletion", () => {
  function makeCandidate() {
    const rich = buildReviewRequestCandidate({
      repo: "o/r",
      number: 5,
      title: "t",
      webUrl: "u",
      updatedAt: "2026-04-15T12:00:00Z",
    });
    return toDispatcherCandidate(rich);
  }

  it("handled → resets failure_count and next_retry", () => {
    const store = new ThreadStore({ runnerHome: makeHome("handled-ok") });
    store.saveThreadRecord({
      threadKey: "/repos/o/r/pulls/5",
      repo: "o/r",
      lastSeenUpdatedAt: "",
      lastHandledUpdatedAt: "",
      lastResult: "failed",
      failureCount: 3,
      nextRetryEpoch: 1_000,
      lastTaskId: "",
    });
    const sched = new Scheduler({
      store,
      identity: { host: "github.com", login: "alice" },
      pollIntervalSec: 60,
      nowSec: () => 2_000,
    });
    sched.handleCompletion({
      taskId: "task-1",
      threadKey: "/repos/o/r/pulls/5",
      candidate: makeCandidate(),
      phase: "completed",
      status: "handled",
      summary: "ok",
    });
    const record = store.loadThreadRecord("/repos/o/r/pulls/5");
    expect(record.failureCount).toBe(0);
    expect(record.nextRetryEpoch).toBe(0);
    expect(record.lastResult).toBe("handled");
    expect(record.lastHandledUpdatedAt).toBe("2026-04-15T12:00:00Z");
  });

  it("failed status bumps failure_count and schedules retry", () => {
    const store = new ThreadStore({ runnerHome: makeHome("failed-ok") });
    const sched = new Scheduler({
      store,
      identity: { host: "github.com", login: "alice" },
      pollIntervalSec: 3600,
      nowSec: () => 5_000,
    });
    sched.handleCompletion({
      taskId: "task-2",
      threadKey: "/repos/o/r/pulls/5",
      candidate: makeCandidate(),
      phase: "completed",
      status: "failed",
      summary: "boom",
    });
    const record = store.loadThreadRecord("/repos/o/r/pulls/5");
    expect(record.failureCount).toBe(1);
    // failureRetryDelaySec(1, 3600) === 120
    expect(record.nextRetryEpoch).toBe(5_120);
  });

  it("timed_out phase bumps failure_count and sets metadata status", () => {
    const store = new ThreadStore({ runnerHome: makeHome("timed") });
    const sched = new Scheduler({
      store,
      identity: { host: "github.com", login: "alice" },
      pollIntervalSec: 60,
      nowSec: () => 7_000,
    });
    sched.handleCompletion({
      taskId: "task-3",
      threadKey: "/repos/o/r/pulls/5",
      candidate: makeCandidate(),
      phase: "timed_out",
      error: "timed out after 120000ms",
    });
    const meta = store.readTaskMetadata("task-3");
    expect(meta.get("status")).toBe("timed_out");
    const record = store.loadThreadRecord("/repos/o/r/pulls/5");
    expect(record.failureCount).toBe(1);
    expect(record.lastResult).toBe("timed_out");
  });

  it("skipped-claim is a no-op on ThreadRecord", () => {
    const store = new ThreadStore({ runnerHome: makeHome("skipped") });
    store.saveThreadRecord({
      threadKey: "/repos/o/r/pulls/5",
      repo: "o/r",
      lastSeenUpdatedAt: "",
      lastHandledUpdatedAt: "",
      lastResult: "",
      failureCount: 2,
      nextRetryEpoch: 5_000,
      lastTaskId: "",
    });
    const sched = new Scheduler({
      store,
      identity: { host: "github.com", login: "alice" },
      pollIntervalSec: 60,
      nowSec: () => 1_000,
    });
    sched.handleCompletion({
      taskId: "task-4",
      threadKey: "/repos/o/r/pulls/5",
      candidate: makeCandidate(),
      phase: "skipped-claim",
    });
    const record = store.loadThreadRecord("/repos/o/r/pulls/5");
    expect(record.failureCount).toBe(2);
    expect(record.nextRetryEpoch).toBe(5_000);
  });
});

describe("Scheduler.recordSetupFailure", () => {
  it("bumps failure_count and writes a failed task.env", () => {
    const store = new ThreadStore({ runnerHome: makeHome("setup") });
    const sched = new Scheduler({
      store,
      identity: { host: "github.com", login: "alice" },
      pollIntervalSec: 60,
      nowSec: () => 9_000,
    });
    const candidate = buildReviewRequestCandidate({
      repo: "o/r",
      number: 9,
      title: "t",
      webUrl: "u",
      updatedAt: "2026-04-15T12:00:00Z",
    });
    sched.recordSetupFailure({
      taskId: "task-setup",
      candidate,
      error: "workspace prepare failed: bad head",
    });
    const meta = store.readTaskMetadata("task-setup");
    expect(meta.get("status")).toBe("failed");
    expect(meta.get("summary")).toContain("workspace prepare failed");
    const record = store.loadThreadRecord(candidate.threadKey);
    expect(record.failureCount).toBe(1);
    expect(record.lastResult).toBe("failed");
    expect(record.nextRetryEpoch).toBe(9_060);
  });
});

describe("Scheduler.enqueueRecoverableTasks", () => {
  it("picks up status=running tasks with no finished_at and marks them orphaned", () => {
    const store = new ThreadStore({ runnerHome: makeHome("recovery") });
    store.writeTaskMetadata("running-1", {
      task_id: "running-1",
      status: "running",
      repo: "o/r",
      thread_key: "/repos/o/r/pulls/1",
      kind: "review_request",
      updated_at: "2026-04-15T12:00:00Z",
      source: "review-search",
      title: "Recover me",
    });
    store.writeTaskMetadata("done-1", {
      task_id: "done-1",
      status: "handled",
      repo: "o/r",
      thread_key: "/repos/o/r/pulls/2",
      kind: "review_request",
      updated_at: "2026-04-15T12:00:00Z",
      source: "review-search",
      finished_at: "42",
      title: "Already done",
    });
    const sched = new Scheduler({
      store,
      identity: { host: "github.com", login: "alice" },
      pollIntervalSec: 60,
      nowSec: () => 99,
    });
    const candidates = sched.enqueueRecoverableTasks("github.com");
    expect(candidates.map((c) => c.threadKey)).toEqual([
      "/repos/o/r/pulls/1",
    ]);
    const meta = store.readTaskMetadata("running-1");
    expect(meta.get("status")).toBe("orphaned");
    expect(meta.get("finished_at")).toBe("99");
  });
});

describe("operator-repo routing helpers", () => {
  it("operatorRepoFor returns login/login", () => {
    expect(operatorRepoFor("bingran-you")).toBe("bingran-you/bingran-you");
  });

  it("shouldRouteToOperatorRepo triggers only on self-maintenance", () => {
    const yes = [
      "@bingran-you please configure the breeze-runner to",
      "can you fix the breeze-runner service for me",
    ]
      .join("\n")
      .toLowerCase();
    expect(shouldRouteToOperatorRepo(yes, "bingran-you")).toBe(true);

    const no =
      "please review this pull request — breeze-runner already commented.".toLowerCase();
    expect(shouldRouteToOperatorRepo(no, "bingran-you")).toBe(false);
  });

  it("readRoutingSnapshotText concatenates known files lowercased", () => {
    const dir = makeHome("route");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "subject.json"), "PLEASE RESTART BREEZE-RUNNER");
    writeFileSync(join(dir, "latest-comment.json"), "Unrelated");
    const text = readRoutingSnapshotText(dir);
    expect(text).toContain("restart breeze-runner");
    expect(text).toContain("unrelated");
  });

  it("routeWorkspaceCandidate routes when a snapshot asks for reconfiguration", () => {
    const dir = makeHome("route2");
    writeFileSync(
      join(dir, "subject.json"),
      "@bingran-you please configure the breeze-runner service",
    );
    const candidate = buildReviewRequestCandidate({
      repo: "o/r",
      number: 10,
      title: "t",
      webUrl: "u",
      updatedAt: "2026-04-15T12:00:00Z",
    });
    const routed = routeWorkspaceCandidate({
      candidate,
      identityLogin: "bingran-you",
      snapshotDir: dir,
    });
    expect(routed.workspaceRepo).toBe("bingran-you/bingran-you");
  });
});
