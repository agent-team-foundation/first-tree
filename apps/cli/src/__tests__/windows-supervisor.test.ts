import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  runWindowsSupervisorLoop,
  windowsSupervisorLogPath,
  windowsSupervisorStopIntentPath,
  writeWindowsSupervisorStopIntent,
} from "../core/supervisor/windows-supervisor.js";

const originalHome = process.env.FIRST_TREE_HOME;

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ft-windows-supervisor-"));
  process.env.FIRST_TREE_HOME = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.FIRST_TREE_HOME;
  else process.env.FIRST_TREE_HOME = originalHome;
});

function fakeSpawnFor(exits: number[]): ReturnType<typeof vi.fn> {
  return vi.fn((_program: string, _args: string[], _options: unknown) => {
    const code = exits.shift() ?? 0;
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, {
      pid: 9000 + exits.length,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    queueMicrotask(() => child.emit("exit", code, null));
    return child;
  });
}

function fakeSpawnError(error: Error): ReturnType<typeof vi.fn> {
  return vi.fn((_program: string, _args: string[], _options: unknown) => {
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, {
      pid: undefined,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    queueMicrotask(() => child.emit("error", error));
    return child;
  });
}

describe("Windows supervisor loop", () => {
  it("returns exit 75 so the wrapper reloads the supervisor after self-update", async () => {
    const spawnProcess = fakeSpawnFor([75]);

    const code = await runWindowsSupervisorLoop({
      platform: "win32",
      invocation: { kind: "bin", program: "first-tree-dev" },
      spawnProcess,
      maxCycles: 3,
    });

    expect(code).toBe(75);
    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(spawnProcess).toHaveBeenNthCalledWith(
      1,
      process.env.ComSpec || "cmd.exe",
      ["/d", "/s", "/c", '""first-tree-dev" "daemon" "start" "--no-interactive""'],
      expect.objectContaining({
        detached: false,
        windowsVerbatimArguments: true,
        env: expect.objectContaining({
          FIRST_TREE_HOME: home,
          FIRST_TREE_SERVICE_MODE: "1",
        }),
      }),
    );
    expect(readFileSync(windowsSupervisorLogPath(), "utf-8")).toContain("wrapper will reload supervisor");
  });

  it("routes extensionless npm bin shims through cmd.exe on Windows", async () => {
    const spawnProcess = fakeSpawnFor([0]);

    const code = await runWindowsSupervisorLoop({
      platform: "win32",
      invocation: { kind: "bin", program: "C:\\Users\\baixi\\AppData\\Roaming\\npm\\first-tree-staging" },
      spawnProcess,
      maxCycles: 1,
    });

    expect(code).toBe(0);
    expect(spawnProcess).toHaveBeenCalledWith(
      process.env.ComSpec || "cmd.exe",
      [
        "/d",
        "/s",
        "/c",
        '""C:\\Users\\baixi\\AppData\\Roaming\\npm\\first-tree-staging" "daemon" "start" "--no-interactive""',
      ],
      expect.objectContaining({ detached: false, windowsHide: true, windowsVerbatimArguments: true }),
    );
  });

  it("does not keep old supervisor code in memory after exit 75", async () => {
    const spawnProcess = fakeSpawnFor([75]);
    const resolveInvocation = vi
      .fn()
      .mockReturnValue({ kind: "bin", program: "C:\\First Tree\\old\\first-tree-dev.cmd" });

    const code = await runWindowsSupervisorLoop({
      platform: "win32",
      resolveInvocation,
      spawnProcess,
      maxCycles: 3,
    });

    expect(code).toBe(75);
    expect(resolveInvocation).toHaveBeenCalledTimes(1);
    expect(spawnProcess).toHaveBeenNthCalledWith(
      1,
      process.env.ComSpec || "cmd.exe",
      ["/d", "/s", "/c", '""C:\\First Tree\\old\\first-tree-dev.cmd" "daemon" "start" "--no-interactive""'],
      expect.objectContaining({ windowsVerbatimArguments: true }),
    );
  });

  it("backs off after a non-zero crash before restarting", async () => {
    const spawnProcess = fakeSpawnFor([1, 0]);
    const sleep = vi.fn(async () => undefined);

    const code = await runWindowsSupervisorLoop({
      platform: "win32",
      invocation: { kind: "node", program: "node.exe", args: ["C:\\First Tree\\index.mjs"] },
      spawnProcess,
      sleep,
      maxCycles: 3,
    });

    expect(code).toBe(0);
    expect(spawnProcess).toHaveBeenCalledTimes(2);
    expect(spawnProcess).toHaveBeenNthCalledWith(
      1,
      "node.exe",
      ["C:\\First Tree\\index.mjs", "daemon", "start", "--no-interactive"],
      expect.any(Object),
    );
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it("backs off and exits cleanly from the wait loop when spawn emits only error", async () => {
    const spawnProcess = fakeSpawnError(Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
    const sleep = vi.fn(async () => undefined);

    const code = await runWindowsSupervisorLoop({
      platform: "win32",
      invocation: { kind: "bin", program: "C:\\First Tree\\missing\\first-tree-dev.cmd" },
      spawnProcess,
      sleep,
      maxCycles: 2,
    });

    expect(code).toBe(1);
    expect(spawnProcess).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1000);
    expect(readFileSync(windowsSupervisorLogPath(), "utf-8")).toContain("daemon child spawn error: spawn ENOENT");
  });

  it("consumes stop intent before launching a child", async () => {
    const spawnProcess = fakeSpawnFor([0]);
    writeWindowsSupervisorStopIntent();

    const code = await runWindowsSupervisorLoop({
      platform: "win32",
      invocation: { kind: "bin", program: "first-tree-dev" },
      spawnProcess,
      maxCycles: 1,
    });

    expect(code).toBe(0);
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(existsSync(windowsSupervisorStopIntentPath())).toBe(false);
  });

  it("fails closed on non-Windows platforms", async () => {
    await expect(
      runWindowsSupervisorLoop({
        platform: "linux",
        invocation: { kind: "bin", program: "first-tree-dev" },
        spawnProcess: fakeSpawnFor([0]),
      }),
    ).rejects.toThrow("only supported on win32");
  });
});
