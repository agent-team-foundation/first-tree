/**
 * Phase 5: daemon-private persistence for thread records + task metadata.
 *
 * Port of the relevant parts of
 * `store.rs`:
 *   - `thread_path`, `load_thread_record`, `save_thread_record`
 *   - `task_dir`, `write_task_metadata`, `read_task_metadata`,
 *     `list_task_metadata`
 *   - `cleanup_old_workspaces`
 *
 * Directory layout under `<runnerHome>/`:
 *   threads/<stableFileId(thread_key)>.env   — ThreadRecord
 *   tasks/<task_id>/task.env                 — TaskMetadata
 *   tasks/<task_id>/runner-output.txt        — agent final message (runner.ts)
 *   repos/                                   — bare mirrors (workspace.ts)
 *   workspaces/                              — live worktrees (workspace.ts)
 *   broker/                                  — broker request + history (broker.ts)
 *   locks/                                   — service lock (claim.ts)
 *   runtime/status.env                       — operator-visible status
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  parseKvLines,
  stableFileId,
} from "../runtime/task-util.js";
import {
  defaultThreadRecord,
  threadRecordFromKv,
  threadRecordToLines,
  type ThreadRecord,
} from "../runtime/task.js";

export interface ThreadStoreOptions {
  runnerHome: string;
}

export class ThreadStore {
  readonly runnerHome: string;
  readonly threadsDir: string;
  readonly tasksDir: string;
  readonly runtimePath: string;

  constructor(options: ThreadStoreOptions) {
    this.runnerHome = options.runnerHome;
    this.threadsDir = join(this.runnerHome, "threads");
    this.tasksDir = join(this.runnerHome, "tasks");
    this.runtimePath = join(this.runnerHome, "runtime", "status.env");
    mkdirSync(this.threadsDir, { recursive: true });
    mkdirSync(this.tasksDir, { recursive: true });
    mkdirSync(dirname(this.runtimePath), { recursive: true });
  }

  threadPath(threadKey: string): string {
    return join(this.threadsDir, `${stableFileId(threadKey)}.env`);
  }

  loadThreadRecord(threadKey: string): ThreadRecord {
    const path = this.threadPath(threadKey);
    if (!existsSync(path)) {
      return { ...defaultThreadRecord(), threadKey };
    }
    const contents = readFileSync(path, "utf8");
    const record = threadRecordFromKv(parseKvLines(contents));
    if (record.threadKey.length === 0) record.threadKey = threadKey;
    return record;
  }

  saveThreadRecord(record: ThreadRecord): void {
    const path = this.threadPath(record.threadKey);
    writeFileSync(path, threadRecordToLines(record).join("\n"));
  }

  taskDir(taskId: string): string {
    return join(this.tasksDir, taskId);
  }

  writeTaskMetadata(taskId: string, values: Record<string, string>): string {
    const dir = this.taskDir(taskId);
    mkdirSync(dir, { recursive: true });
    const lines = Object.entries(values).map(([k, v]) => `${k}=${v}`);
    const path = join(dir, "task.env");
    writeFileSync(path, lines.join("\n"));
    return path;
  }

  readTaskMetadata(taskId: string): Map<string, string> {
    const path = join(this.taskDir(taskId), "task.env");
    if (!existsSync(path)) return new Map();
    return new Map(parseKvLines(readFileSync(path, "utf8")));
  }

  listTaskMetadata(): Array<[string, Map<string, string>]> {
    if (!existsSync(this.tasksDir)) return [];
    const out: Array<[string, Map<string, string>]> = [];
    for (const name of readdirSync(this.tasksDir).sort()) {
      const entryPath = join(this.tasksDir, name);
      try {
        if (!statSync(entryPath).isDirectory()) continue;
      } catch {
        continue;
      }
      out.push([name, this.readTaskMetadata(name)]);
    }
    return out;
  }

  writeRuntimeStatus(values: Record<string, string>): void {
    const lines = Object.entries(values).map(([k, v]) => `${k}=${v}`);
    writeFileSync(this.runtimePath, lines.join("\n"));
  }

  readRuntimeStatus(): Map<string, string> {
    if (!existsSync(this.runtimePath)) return new Map();
    return new Map(parseKvLines(readFileSync(this.runtimePath, "utf8")));
  }

  /**
   * Remove workspace directories for finished tasks older than `ttlSecs`,
   * skipping any workspace currently in `activeWorkspaces`. Returns the
   * list of removed paths.
   */
  cleanupOldWorkspaces(
    ttlSecs: number,
    activeWorkspaces: readonly string[],
    nowSec: number = Math.floor(Date.now() / 1_000),
  ): string[] {
    const removed: string[] = [];
    const active = new Set(activeWorkspaces);
    for (const [taskId, metadata] of this.listTaskMetadata()) {
      void taskId;
      const workspacePath = metadata.get("workspace_path");
      if (!workspacePath) continue;
      if (active.has(workspacePath)) continue;
      const finishedAt = Number.parseInt(metadata.get("finished_at") ?? "", 10);
      const mtimeSec =
        Number.isFinite(finishedAt) && finishedAt > 0
          ? finishedAt
          : fileMtimeEpoch(workspacePath);
      if (mtimeSec === undefined) continue;
      if (nowSec - mtimeSec < ttlSecs) continue;
      if (existsSync(workspacePath)) {
        try {
          rmSync(workspacePath, { recursive: true, force: true });
        } catch {
          /* ignore — next sweep retries */
        }
      }
      removed.push(workspacePath);
    }
    return removed;
  }
}

function fileMtimeEpoch(path: string): number | undefined {
  try {
    const st = statSync(path);
    return Math.floor(st.mtimeMs / 1_000);
  } catch {
    return undefined;
  }
}
