import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BREEZE_USAGE, runBreeze } from "../../src/products/breeze/cli.js";

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

describe("breeze cli USAGE", () => {
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
      expect(BREEZE_USAGE).toContain(sub);
    }
    expect(BREEZE_USAGE).toContain("BREEZE_DIR");
    expect(BREEZE_USAGE).toContain("BREEZE_HOME");
  });
});

describe("runBreeze dispatcher", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("prints USAGE with no args", async () => {
    const output = captureOutput();
    const code = await runBreeze([], output.write);
    expect(code).toBe(0);
    expect(output.lines).toEqual([BREEZE_USAGE]);
  });

  it("prints USAGE for --help, -h, help", async () => {
    for (const flag of ["--help", "-h", "help"]) {
      const output = captureOutput();
      const code = await runBreeze([flag], output.write);
      expect(code).toBe(0);
      expect(output.lines[0]).toBe(BREEZE_USAGE);
    }
  });

  it("errors with hint on unknown subcommand", async () => {
    const output = captureOutput();
    const code = await runBreeze(["no-such-thing"], output.write);
    expect(code).toBe(1);
    expect(output.lines[0]).toBe("Unknown breeze command: no-such-thing");
    expect(output.lines[1]).toBe(BREEZE_USAGE);
  });

  it("routes run / run-once / daemon through the TS daemon", async () => {
    const runDaemonSpy = vi.fn(async () => 0);
    vi.doMock("../../src/products/breeze/engine/daemon/runner-skeleton.js", () => ({
      runDaemon: runDaemonSpy,
    }));
    const { runBreeze: freshRun } = await import(
      "../../src/products/breeze/cli.js"
    );

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

  it("routes statusline through node + the separate dist bundle", async () => {
    const spawnSpy = vi.fn().mockReturnValue(0);
    const resolvePackageRootSpy = vi.fn(() => "/pkg");

    vi.doMock("../../src/products/breeze/engine/bridge.js", () => ({
      resolveBreezeRunner: vi.fn(),
      resolveBundledBreezeScript: vi.fn(() => {
        throw new Error("statusline must not route through bundled scripts");
      }),
      resolveFirstTreePackageRoot: resolvePackageRootSpy,
      spawnInherit: spawnSpy,
    }));

    const { runBreeze: freshRun } = await import(
      "../../src/products/breeze/cli.js"
    );

    const code = await freshRun(["statusline"], () => {});
    expect(code).toBe(0);
    expect(resolvePackageRootSpy).toHaveBeenCalled();
    expect(spawnSpy).toHaveBeenCalledWith(process.execPath, [
      "/pkg/dist/breeze-statusline.js",
    ]);
  });

  it("routes install through the TS install command", async () => {
    const runInstallSpy = vi.fn().mockReturnValue(0);
    vi.doMock(
      "../../src/products/breeze/engine/commands/install.js",
      () => ({ runInstall: runInstallSpy }),
    );

    const { runBreeze: freshRun } = await import(
      "../../src/products/breeze/cli.js"
    );

    const code = await freshRun(["install"], () => {});
    expect(code).toBe(0);
    expect(runInstallSpy).toHaveBeenCalledWith([]);
  });

  it("routes poll through the TS port (not the runner)", async () => {
    vi.doMock("../../src/products/breeze/engine/bridge.js", () => ({
      resolveBreezeRunner: vi.fn(() => {
        throw new Error("poll must not route through the runner bridge");
      }),
      resolveBundledBreezeScript: vi.fn(),
      resolveFirstTreePackageRoot: vi.fn(() => "/pkg"),
      spawnInherit: vi.fn(() => {
        throw new Error("poll must not route through the runner bridge");
      }),
    }));

    const runPoll = vi.fn(async () => 0);
    vi.doMock("../../src/products/breeze/engine/commands/poll.js", () => ({
      runPoll,
    }));

    const { runBreeze: freshRun } = await import(
      "../../src/products/breeze/cli.js"
    );
    const code = await freshRun(["poll", "--foo"], () => {});
    expect(code).toBe(0);
    expect(runPoll).toHaveBeenCalledWith(["--foo"]);
  });

  it("routes watch through the TS port (not the bridge)", async () => {
    vi.doMock("../../src/products/breeze/engine/bridge.js", () => ({
      resolveBreezeRunner: vi.fn(),
      resolveBundledBreezeScript: vi.fn(() => {
        throw new Error("watch must not route through the bundled script bridge");
      }),
      resolveFirstTreePackageRoot: vi.fn(() => "/pkg"),
      spawnInherit: vi.fn(() => {
        throw new Error("watch must not route through the bundled script bridge");
      }),
    }));

    const runWatch = vi.fn(async () => 0);
    vi.doMock("../../src/products/breeze/engine/commands/watch.js", () => ({
      runWatch,
    }));

    const { runBreeze: freshRun } = await import(
      "../../src/products/breeze/cli.js"
    );
    const code = await freshRun(["watch"], () => {});
    expect(code).toBe(0);
    expect(runWatch).toHaveBeenCalledWith([]);
  });

  it("propagates the runDaemon exit code for `run`", async () => {
    const runDaemonSpy = vi.fn(async () => 13);
    vi.doMock("../../src/products/breeze/engine/daemon/runner-skeleton.js", () => ({
      runDaemon: runDaemonSpy,
    }));
    const { runBreeze: freshRun } = await import(
      "../../src/products/breeze/cli.js"
    );
    const code = await freshRun(["run"], () => {});
    expect(code).toBe(13);
  });

  it("routes status-manager through the TS port (not the bash bridge)", async () => {
    // If the dispatcher still spawned the bash script, the bridge helpers
    // would be called. Stub them to throw so any bridge call fails loudly.
    vi.doMock("../../src/products/breeze/engine/bridge.js", () => ({
      resolveBreezeRunner: vi.fn(),
      resolveBundledBreezeScript: vi.fn(() => {
        throw new Error("should not be called for status-manager");
      }),
      resolveFirstTreePackageRoot: vi.fn(() => "/pkg"),
      spawnInherit: vi.fn(() => {
        throw new Error("should not be called for status-manager");
      }),
    }));

    const runStatusManager = vi.fn(async () => 0);
    vi.doMock("../../src/products/breeze/engine/commands/status-manager.js", () => ({
      runStatusManager,
    }));

    const { runBreeze: freshRun } = await import(
      "../../src/products/breeze/cli.js"
    );
    const code = await freshRun(["status-manager", "list"], () => {});
    expect(code).toBe(0);
    expect(runStatusManager).toHaveBeenCalledWith(["list"]);
  });

  it("surfaces runDaemon errors to stderr and returns 1", async () => {
    vi.doMock("../../src/products/breeze/engine/daemon/runner-skeleton.js", () => ({
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
      const { runBreeze: freshRun } = await import(
        "../../src/products/breeze/cli.js"
      );
      const code = await freshRun(["run"], () => {});
      expect(code).toBe(1);
      expect(writes.join("")).toContain("daemon init failed");
    } finally {
      process.stderr.write = origWrite;
    }
  });
});
