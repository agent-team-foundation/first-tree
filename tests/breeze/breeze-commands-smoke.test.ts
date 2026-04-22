/**
 * Light smoke tests for the ported `doctor` / `status` / `cleanup`
 * commands. We run them against a temporary `$BREEZE_HOME` and assert
 * the one-screen summary renders without throwing. Full behaviour is
 * covered by the thread-store + scheduler tests.
 */

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

import { runCleanup } from "../../src/products/breeze/engine/commands/cleanup.js";
import { runDoctor } from "../../src/products/breeze/engine/commands/doctor.js";
import {
  resolveSelfStartCommand,
  runInstall,
} from "../../src/products/breeze/engine/commands/install.js";
import { runStatus } from "../../src/products/breeze/engine/commands/status.js";
import { ThreadStore } from "../../src/products/breeze/engine/daemon/thread-store.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length) {
    const dir = tempRoots.pop();
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

function makeHome(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `breeze-cmd-${prefix}-`));
  tempRoots.push(dir);
  return dir;
}

describe("runDoctor", () => {
  it("prints the one-screen diagnostic regardless of identity", async () => {
    const home = makeHome("doctor");
    const lines: string[] = [];
    const code = await runDoctor([], {
      runnerHome: home,
      write: (line) => lines.push(line),
    });
    expect(code).toBe(0);
    const out = lines.join("\n");
    expect(out).toContain("breeze-runner doctor");
    expect(out).toContain(`home: ${home}`);
    expect(out).toContain("agents:");
    expect(out).toMatch(/lock: (absent|stale|present)/);
  });
});

describe("runStatus", () => {
  it("reports runtime/status.env keys when present", async () => {
    const home = makeHome("status");
    const store = new ThreadStore({ runnerHome: home });
    store.writeRuntimeStatus({
      last_poll_epoch: "1700000000",
      active_tasks: "2",
      queued_tasks: "1",
      last_note: "busy",
      allowed_repos: "o/*",
    });
    const lines: string[] = [];
    const code = await runStatus([], {
      runnerHome: home,
      write: (line) => lines.push(line),
    });
    expect(code).toBe(0);
    const out = lines.join("\n");
    expect(out).toContain("breeze-runner status");
    expect(out).toContain("last_poll_epoch: 1700000000");
    expect(out).toContain("active_tasks: 2");
    expect(out).toContain("allowed repos: o/*");
  });

  it("falls back to 'no status recorded yet' when runtime is empty", async () => {
    const home = makeHome("empty-status");
    const lines: string[] = [];
    await runStatus([], {
      runnerHome: home,
      write: (line) => lines.push(line),
    });
    expect(lines.join("\n")).toContain("runtime: no status recorded yet");
  });
});

describe("runCleanup", () => {
  it("removes stale workspaces and reports the counts", async () => {
    const home = makeHome("cleanup");
    const store = new ThreadStore({ runnerHome: home });
    const ws = join(home, "workspaces", "task-stale");
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, "marker"), "x");
    store.writeTaskMetadata("task-stale", {
      status: "handled",
      workspace_path: ws,
      finished_at: "1",
    });
    const lines: string[] = [];
    const code = await runCleanup(["--workspace-ttl-secs=10"], {
      runnerHome: home,
      write: (line) => lines.push(line),
    });
    expect(code).toBe(0);
    const out = lines.join("\n");
    expect(out).toMatch(/removed 1 stale workspaces/);
    expect(out).toContain(ws);
    expect(existsSync(ws)).toBe(false);
  });
});

describe("runInstall", () => {
  it("refuses to install-start without an explicit repo scope", () => {
    const lines: string[] = [];
    const spawn = vi.fn(() => ({ status: 0 })) as unknown as typeof import("node:child_process").spawnSync;
    const code = runInstall([], {
      breezeDir: makeHome("install-missing-scope"),
      write: (line) => lines.push(line),
      checkCommand: () => true,
      checkGhAuth: () => true,
      spawn,
    });
    expect(code).toBe(1);
    expect(spawn).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain("missing required --allow-repo");
  });

  it("re-invokes the current CLI for `breeze start` instead of shelling to PATH", () => {
    const lines: string[] = [];
    const spawn = vi.fn(() => ({ status: 0 })) as unknown as typeof import("node:child_process").spawnSync;
    const code = runInstall(["--allow-repo", "owner/repo"], {
      breezeDir: makeHome("install"),
      write: (line) => lines.push(line),
      checkCommand: () => true,
      checkGhAuth: () => true,
      spawn,
      startCommand: {
        cmd: process.execPath,
        args: ["/tmp/first-tree/dist/cli.js", "breeze", "start"],
      },
    });
    expect(code).toBe(0);
    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      [
        "/tmp/first-tree/dist/cli.js",
        "breeze",
        "start",
        "--allow-repo",
        "owner/repo",
      ],
      { stdio: "inherit" },
    );
    expect(lines.join("\n")).toContain("Daemon started");
  });

  it("resolves the current CLI entrypoint for nested self-starts", () => {
    expect(resolveSelfStartCommand("/tmp/first-tree/dist/cli.js")).toEqual({
      cmd: process.execPath,
      args: ["/tmp/first-tree/dist/cli.js", "breeze", "start"],
    });
  });
});

describe("cli routing", () => {
  it("maps doctor/status/cleanup/start/stop/poll-inbox to TS specifiers", async () => {
    // Importing the cli module shouldn't throw and all the new dispatch
    // entries should be present. The actual execution path is covered by
    // the unit tests above.
    const cli = await import("../../src/products/breeze/cli.js");
    expect(cli.BREEZE_USAGE).toContain("doctor");
    expect(cli.BREEZE_USAGE).toContain("poll-inbox");
    // extractBackendFlag is exported for tests; verify it still works.
    expect(cli.extractBackendFlag(["--backend=ts"])).toEqual({
      backend: "ts",
      rest: [],
    });
  });
});
