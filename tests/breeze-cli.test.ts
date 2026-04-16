import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BREEZE_USAGE, runBreeze } from "../src/products/breeze/cli.js";

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
    expect(BREEZE_USAGE).toContain("BREEZE_RUNNER_BIN");
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

  it("routes runner subcommands through resolveBreezeRunner + spawnInherit", async () => {
    const spawnSpy = vi.fn().mockReturnValue(7);
    const resolveRunnerSpy = vi
      .fn()
      .mockReturnValue({ path: "/runner", source: "path" });

    vi.doMock("../src/products/breeze/bridge.js", () => ({
      resolveBreezeRunner: resolveRunnerSpy,
      resolveBundledBreezeScript: vi.fn(),
      resolveBreezeSetupScript: vi.fn(),
      spawnInherit: spawnSpy,
    }));

    const { runBreeze: freshRun } = await import(
      "../src/products/breeze/cli.js"
    );

    const cases: Array<{ args: string[]; expected: string[] }> = [
      { args: ["run"], expected: ["run"] },
      { args: ["run-once", "--verbose"], expected: ["run-once", "--verbose"] },
      { args: ["start"], expected: ["start"] },
      { args: ["stop"], expected: ["stop"] },
      { args: ["status", "--json"], expected: ["status", "--json"] },
      { args: ["poll"], expected: ["poll"] },
      { args: ["doctor"], expected: ["doctor"] },
      { args: ["cleanup"], expected: ["cleanup"] },
    ];
    for (const { args, expected } of cases) {
      spawnSpy.mockClear();
      resolveRunnerSpy.mockClear();
      const code = await freshRun(args, () => {});
      expect(code).toBe(7);
      expect(resolveRunnerSpy).toHaveBeenCalledOnce();
      expect(spawnSpy).toHaveBeenCalledWith("/runner", expected);
    }
  });

  it("routes bundled scripts through resolveBundledBreezeScript + spawnInherit", async () => {
    const spawnSpy = vi.fn().mockReturnValue(0);
    const resolveScriptSpy = vi.fn((name: string) => `/pkg/assets/breeze/bin/${name}`);

    vi.doMock("../src/products/breeze/bridge.js", () => ({
      resolveBreezeRunner: vi.fn(),
      resolveBundledBreezeScript: resolveScriptSpy,
      resolveBreezeSetupScript: vi.fn(),
      spawnInherit: spawnSpy,
    }));

    const { runBreeze: freshRun } = await import(
      "../src/products/breeze/cli.js"
    );

    // `status-manager` was migrated to a TS port in Phase 2a; it no longer
    // goes through the bundled-script route. The remaining script targets
    // (`watch`, `statusline`) stay on the bridge.
    const cases: Array<{ args: string[]; script: string; rest: string[] }> = [
      { args: ["watch"], script: "breeze-watch", rest: [] },
      {
        args: ["statusline"],
        script: "breeze-statusline-wrapper",
        rest: [],
      },
    ];
    for (const { args, script, rest } of cases) {
      spawnSpy.mockClear();
      resolveScriptSpy.mockClear();
      await freshRun(args, () => {});
      expect(resolveScriptSpy).toHaveBeenCalledWith(script);
      expect(spawnSpy).toHaveBeenCalledWith(
        `/pkg/assets/breeze/bin/${script}`,
        rest,
      );
    }
  });

  it("routes install through bash + resolveBreezeSetupScript", async () => {
    const spawnSpy = vi.fn().mockReturnValue(0);
    const resolveSetupSpy = vi.fn().mockReturnValue("/pkg/first-tree-breeze/setup");

    vi.doMock("../src/products/breeze/bridge.js", () => ({
      resolveBreezeRunner: vi.fn(),
      resolveBundledBreezeScript: vi.fn(),
      resolveBreezeSetupScript: resolveSetupSpy,
      spawnInherit: spawnSpy,
    }));

    const { runBreeze: freshRun } = await import(
      "../src/products/breeze/cli.js"
    );

    await freshRun(["install"], () => {});
    expect(resolveSetupSpy).toHaveBeenCalled();
    expect(spawnSpy).toHaveBeenCalledWith("bash", [
      "/pkg/first-tree-breeze/setup",
    ]);
  });

  it("propagates the child exit code", async () => {
    const spawnSpy = vi.fn().mockReturnValue(13);
    vi.doMock("../src/products/breeze/bridge.js", () => ({
      resolveBreezeRunner: vi
        .fn()
        .mockReturnValue({ path: "/runner", source: "path" }),
      resolveBundledBreezeScript: vi.fn(),
      resolveBreezeSetupScript: vi.fn(),
      spawnInherit: spawnSpy,
    }));

    const { runBreeze: freshRun } = await import(
      "../src/products/breeze/cli.js"
    );
    const code = await freshRun(["status"], () => {});
    expect(code).toBe(13);
  });

  it("routes status-manager through the TS port (not the bash bridge)", async () => {
    // If the dispatcher still spawned the bash script, the bridge helpers
    // would be called. Stub them to throw so any bridge call fails loudly.
    vi.doMock("../src/products/breeze/bridge.js", () => ({
      resolveBreezeRunner: vi.fn(),
      resolveBundledBreezeScript: vi.fn(() => {
        throw new Error("should not be called for status-manager");
      }),
      resolveBreezeSetupScript: vi.fn(),
      spawnInherit: vi.fn(() => {
        throw new Error("should not be called for status-manager");
      }),
    }));

    const runStatusManager = vi.fn(async () => 0);
    vi.doMock("../src/products/breeze/commands/status-manager.js", () => ({
      runStatusManager,
    }));

    const { runBreeze: freshRun } = await import(
      "../src/products/breeze/cli.js"
    );
    const code = await freshRun(["status-manager", "list"], () => {});
    expect(code).toBe(0);
    expect(runStatusManager).toHaveBeenCalledWith(["list"]);
  });

  it("surfaces resolver errors to stderr and returns 1", async () => {
    vi.doMock("../src/products/breeze/bridge.js", () => ({
      resolveBreezeRunner: () => {
        throw new Error(
          "breeze-runner not found. Install with `cd first-tree-breeze/breeze-runner && cargo install --path .`",
        );
      },
      resolveBundledBreezeScript: vi.fn(),
      resolveBreezeSetupScript: vi.fn(),
      spawnInherit: vi.fn(),
    }));

    const writes: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      const { runBreeze: freshRun } = await import(
        "../src/products/breeze/cli.js"
      );
      const code = await freshRun(["status"], () => {});
      expect(code).toBe(1);
      expect(writes.join("")).toContain("cargo install --path .");
    } finally {
      process.stderr.write = origWrite;
    }
  });
});
