import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ThreadStore } from "../src/products/breeze/engine/daemon/thread-store.js";
import {
  defaultThreadRecord,
  type ThreadRecord,
} from "../src/products/breeze/engine/runtime/task.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length) {
    const dir = tempRoots.pop();
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

function makeHome(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `breeze-store-${prefix}-`));
  tempRoots.push(dir);
  return dir;
}

describe("ThreadStore.{load,save}ThreadRecord", () => {
  it("returns a default record with the requested thread key when absent", () => {
    const store = new ThreadStore({ runnerHome: makeHome("default") });
    const record = store.loadThreadRecord("/repos/o/r/issues/1");
    expect(record.threadKey).toBe("/repos/o/r/issues/1");
    expect(record.failureCount).toBe(0);
  });

  it("round-trips a ThreadRecord to disk", () => {
    const store = new ThreadStore({ runnerHome: makeHome("rt") });
    const record: ThreadRecord = {
      ...defaultThreadRecord(),
      threadKey: "/repos/o/r/issues/9",
      repo: "o/r",
      lastSeenUpdatedAt: "2026-04-15T12:00:00Z",
      lastHandledUpdatedAt: "2026-04-15T12:00:00Z",
      lastResult: "handled",
      failureCount: 2,
      nextRetryEpoch: 1_234,
      lastTaskId: "task-42",
    };
    store.saveThreadRecord(record);
    const restored = store.loadThreadRecord(record.threadKey);
    expect(restored).toEqual(record);
  });
});

describe("ThreadStore.{write,read}TaskMetadata", () => {
  it("persists and reads key/value entries under tasks/<id>/task.env", () => {
    const store = new ThreadStore({ runnerHome: makeHome("task") });
    store.writeTaskMetadata("task-7", {
      task_id: "task-7",
      status: "running",
      repo: "o/r",
    });
    const metadata = store.readTaskMetadata("task-7");
    expect(metadata.get("status")).toBe("running");
    expect(metadata.get("repo")).toBe("o/r");
    // File exists at the expected location.
    expect(
      existsSync(join(store.tasksDir, "task-7", "task.env")),
    ).toBe(true);
  });

  it("listTaskMetadata returns each task dir sorted", () => {
    const store = new ThreadStore({ runnerHome: makeHome("list") });
    store.writeTaskMetadata("task-b", { status: "running" });
    store.writeTaskMetadata("task-a", { status: "handled" });
    const list = store.listTaskMetadata();
    expect(list.map(([id]) => id)).toEqual(["task-a", "task-b"]);
    expect(list[1][1].get("status")).toBe("running");
  });
});

describe("ThreadStore.cleanupOldWorkspaces", () => {
  it("removes workspace dirs belonging to finished tasks older than ttl", () => {
    const home = makeHome("cleanup");
    const store = new ThreadStore({ runnerHome: home });
    const workspacePath = join(home, "workspaces", "task-old");
    mkdirSync(workspacePath, { recursive: true });
    writeFileSync(join(workspacePath, "marker"), "x");
    store.writeTaskMetadata("task-old", {
      status: "handled",
      workspace_path: workspacePath,
      finished_at: "1000",
    });
    const removed = store.cleanupOldWorkspaces(
      60,
      [],
      10_000 /* nowSec */,
    );
    expect(removed).toEqual([workspacePath]);
    expect(existsSync(workspacePath)).toBe(false);
  });

  it("keeps workspaces that are still active", () => {
    const home = makeHome("active");
    const store = new ThreadStore({ runnerHome: home });
    const workspacePath = join(home, "workspaces", "task-live");
    mkdirSync(workspacePath, { recursive: true });
    store.writeTaskMetadata("task-live", {
      status: "running",
      workspace_path: workspacePath,
      finished_at: "1000",
    });
    const removed = store.cleanupOldWorkspaces(
      60,
      [workspacePath],
      10_000,
    );
    expect(removed).toEqual([]);
    expect(existsSync(workspacePath)).toBe(true);
  });

  it("keeps workspaces whose finished_at is within ttl", () => {
    const home = makeHome("fresh");
    const store = new ThreadStore({ runnerHome: home });
    const workspacePath = join(home, "workspaces", "task-fresh");
    mkdirSync(workspacePath, { recursive: true });
    store.writeTaskMetadata("task-fresh", {
      status: "handled",
      workspace_path: workspacePath,
      finished_at: "9950",
    });
    const removed = store.cleanupOldWorkspaces(100, [], 10_000);
    expect(removed).toEqual([]);
    expect(existsSync(workspacePath)).toBe(true);
  });
});

describe("ThreadStore.{write,read}RuntimeStatus", () => {
  it("round-trips runtime/status.env", () => {
    const store = new ThreadStore({ runnerHome: makeHome("rt-status") });
    store.writeRuntimeStatus({ active: "2", queued: "1", note: "hi" });
    const status = store.readRuntimeStatus();
    expect(status.get("active")).toBe("2");
    expect(status.get("note")).toBe("hi");
    expect(readFileSync(store.runtimePath, "utf8")).toContain("note=hi");
  });
});
