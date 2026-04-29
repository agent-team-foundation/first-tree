import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTO_USAGE, runAuto } from "../src/cli.js";

function captureOutput(): {
  lines: string[];
  write: (text: string) => void;
} {
  const lines: string[] = [];
  return {
    lines,
    write: (text: string) => {
      lines.push(text);
    },
  };
}

describe("auto cli USAGE", () => {
  it("advertises every dispatched subcommand", () => {
    const subcommands = [
      "install",
      "run",
      "run-once",
      "start",
      "stop",
      "status",
      "poll",
      "doctor",
      "cleanup",
      "watch",
      "status-manager",
      "statusline",
    ];
    for (const sub of subcommands) {
      expect(AUTO_USAGE).toContain(sub);
    }
    expect(AUTO_USAGE).toContain("AUTO_DIR");
    expect(AUTO_USAGE).toContain("AUTO_HOME");
  });
});

describe("runAuto dispatcher", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("prints USAGE with no args", async () => {
    const output = captureOutput();
    const code = await runAuto([], output.write);
    expect(code).toBe(0);
    expect(output.lines).toEqual([AUTO_USAGE]);
  });

  it("prints USAGE for --help, -h, help", async () => {
    for (const flag of ["--help", "-h", "help"]) {
      const output = captureOutput();
      const code = await runAuto([flag], output.write);
      expect(code).toBe(0);
      expect(output.lines[0]).toBe(AUTO_USAGE);
    }
  });

  it("errors with hint on unknown subcommand", async () => {
    const output = captureOutput();
    const code = await runAuto(["no-such-thing"], output.write);
    expect(code).toBe(1);
    expect(output.lines[0]).toBe("Unknown auto command: no-such-thing");
    expect(output.lines[1]).toBe(AUTO_USAGE);
  });

  it("routes run / run-once / daemon through the TS daemon", async () => {
    const runDaemonSpy = vi.fn(async () => 0);
    vi.doMock("../src/daemon/runner-skeleton.js", () => ({
      runDaemon: runDaemonSpy,
    }));
    const { runAuto: freshRun } = await import("../src/cli.js");

    const cases: Array<{
      args: string[];
      expectedArgs: string[];
      once: boolean;
    }> = [
      { args: ["run"], expectedArgs: [], once: false },
      {
        args: ["run-once", "--verbose"],
        expectedArgs: ["--verbose"],
        once: true,
      },
      {
        args: ["daemon", "--poll-interval-secs", "30"],
        expectedArgs: ["--poll-interval-secs", "30"],
        once: false,
      },
    ];
    for (const { args, expectedArgs, once } of cases) {
      runDaemonSpy.mockClear();
      const code = await freshRun(args, () => {});
      expect(code).toBe(0);
      expect(runDaemonSpy).toHaveBeenCalledWith(expectedArgs, { once });
    }
  });

  it("prints inline help for daemon-like subcommands without executing them", async () => {
    const runDaemonSpy = vi.fn(async () => 0);
    const runStartSpy = vi.fn(async () => 0);
    vi.doMock("../src/daemon/runner-skeleton.js", () => ({
      runDaemon: runDaemonSpy,
    }));
    vi.doMock("../src/commands/start.js", () => ({
      runStart: runStartSpy,
    }));

    const { runAuto: freshRun } = await import("../src/cli.js");

    const runOutput = captureOutput();
    const runCode = await freshRun(["run", "--help"], runOutput.write);
    expect(runCode).toBe(0);
    expect(runOutput.lines.join("\n")).toContain("usage: first-tree auto run");
    expect(runOutput.lines.join("\n")).toContain(
      "Required: restrict work to owner/repo or owner/* patterns",
    );
    expect(runDaemonSpy).not.toHaveBeenCalled();

    const startOutput = captureOutput();
    const startCode = await freshRun(["start", "--help"], startOutput.write);
    expect(startCode).toBe(0);
    expect(startOutput.lines.join("\n")).toContain("usage: first-tree auto start");
    expect(startOutput.lines.join("\n")).toContain(
      "Required: restrict work to owner/repo or owner/* patterns",
    );
    expect(runStartSpy).not.toHaveBeenCalled();
  });

  it("routes statusline through node + the separate dist bundle", async () => {
    const spawnSpy = vi.fn().mockReturnValue(0);
    const resolveBundleSpy = vi.fn(() => "/pkg/dist/auto-statusline.js");

    vi.doMock("../src/bridge.js", () => ({
      resolveStatuslineBundlePath: resolveBundleSpy,
      spawnInherit: spawnSpy,
    }));

    const { runAuto: freshRun } = await import("../src/cli.js");

    const code = await freshRun(["statusline"], () => {});
    expect(code).toBe(0);
    expect(resolveBundleSpy).toHaveBeenCalled();
    expect(spawnSpy).toHaveBeenCalledWith(process.execPath, [
      "/pkg/dist/auto-statusline.js",
    ]);
  });

  it("routes install through the TS install command", async () => {
    const runInstallSpy = vi.fn().mockReturnValue(0);
    vi.doMock("../src/commands/install.js", () => ({
      runInstall: runInstallSpy,
    }));

    const { runAuto: freshRun } = await import("../src/cli.js");

    const code = await freshRun(["install"], () => {});
    expect(code).toBe(0);
    expect(runInstallSpy).toHaveBeenCalledWith([]);
  });

  it("routes poll through the TS port (not the runner)", async () => {
    vi.doMock("../src/bridge.js", () => ({
      resolveAutoPackageRoot: vi.fn(() => "/pkg"),
      spawnInherit: vi.fn(() => {
        throw new Error("poll must not route through the runner bridge");
      }),
    }));

    const runPoll = vi.fn(async () => 0);
    vi.doMock("../src/commands/poll.js", () => ({
      runPoll,
    }));

    const { runAuto: freshRun } = await import("../src/cli.js");
    const code = await freshRun(["poll", "--foo"], () => {});
    expect(code).toBe(0);
    expect(runPoll).toHaveBeenCalledWith(["--foo"]);
  });

  it("routes watch through the TS port (not the bridge)", async () => {
    vi.doMock("../src/bridge.js", () => ({
      resolveAutoPackageRoot: vi.fn(() => "/pkg"),
      spawnInherit: vi.fn(() => {
        throw new Error("watch must not route through the bundled script bridge");
      }),
    }));

    const runWatch = vi.fn(async () => 0);
    vi.doMock("../src/commands/watch.js", () => ({
      runWatch,
    }));

    const { runAuto: freshRun } = await import("../src/cli.js");
    const code = await freshRun(["watch"], () => {});
    expect(code).toBe(0);
    expect(runWatch).toHaveBeenCalledWith([]);
  });

  it("propagates the runDaemon exit code for `run`", async () => {
    const runDaemonSpy = vi.fn(async () => 13);
    vi.doMock("../src/daemon/runner-skeleton.js", () => ({
      runDaemon: runDaemonSpy,
    }));
    const { runAuto: freshRun } = await import("../src/cli.js");
    const code = await freshRun(["run"], () => {});
    expect(code).toBe(13);
  });

  it("routes status-manager through the TS port (not the bash bridge)", async () => {
    // If the dispatcher still spawned the bash script, the bridge helpers
    // would be called. Stub them to throw so any bridge call fails loudly.
    vi.doMock("../src/bridge.js", () => ({
      resolveAutoPackageRoot: vi.fn(() => "/pkg"),
      spawnInherit: vi.fn(() => {
        throw new Error("should not be called for status-manager");
      }),
    }));

    const runStatusManager = vi.fn(async () => 0);
    vi.doMock("../src/commands/status-manager.js", () => ({
      runStatusManager,
    }));

    const { runAuto: freshRun } = await import("../src/cli.js");
    const code = await freshRun(["status-manager", "list"], () => {});
    expect(code).toBe(0);
    expect(runStatusManager).toHaveBeenCalledWith(["list"]);
  });

  it("surfaces runDaemon errors to stderr and returns 1", async () => {
    vi.doMock("../src/daemon/runner-skeleton.js", () => ({
      runDaemon: async () => {
        throw new Error("daemon init failed");
      },
    }));

    const writes: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      const { runAuto: freshRun } = await import("../src/cli.js");
      const code = await freshRun(["run"], () => {});
      expect(code).toBe(1);
      expect(writes.join("")).toContain("daemon init failed");
    } finally {
      process.stderr.write = origWrite;
    }
  });
});
