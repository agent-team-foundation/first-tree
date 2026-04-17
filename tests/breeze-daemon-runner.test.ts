/**
 * Tests for the Phase 3a daemon runner-skeleton entrypoint and CLI wiring.
 *
 * Covers:
 *   - `parseDaemonArgs` parses the recognised flag set and ignores unknowns
 *   - `extractBackendFlag` (from cli.ts) separates --backend from the residual argv
 *   - `daemon --backend=ts` invokes the TS runner; `--backend=rust` bridges
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  parseDaemonArgs,
  runDaemon,
} from "../src/products/breeze/daemon/runner-skeleton.js";
import { extractBackendFlag } from "../src/products/breeze/cli.js";

describe("parseDaemonArgs", () => {
  it("parses all recognised flags", () => {
    const out = parseDaemonArgs([
      "--poll-interval-secs",
      "30",
      "--host",
      "ghe.example.com",
      "--log-level",
      "debug",
      "--http-port",
      "9191",
      "--task-timeout-secs",
      "600",
    ]);
    expect(out).toEqual({
      pollIntervalSec: 30,
      host: "ghe.example.com",
      logLevel: "debug",
      httpPort: 9191,
      taskTimeoutSec: 600,
    });
  });

  it("accepts --poll-interval-sec as a singular alias", () => {
    const out = parseDaemonArgs(["--poll-interval-sec", "10"]);
    expect(out.pollIntervalSec).toBe(10);
  });

  it("ignores unknown flags for forward-compat", () => {
    const out = parseDaemonArgs(["--frobnicate", "1", "--host", "gh.io"]);
    expect(out).toEqual({ host: "gh.io" });
  });

  it("drops invalid numeric values", () => {
    const out = parseDaemonArgs([
      "--poll-interval-secs",
      "nope",
      "--http-port",
      "-1",
    ]);
    expect(out.pollIntervalSec).toBeUndefined();
    expect(out.httpPort).toBeUndefined();
  });
});

describe("extractBackendFlag", () => {
  it("defaults to rust when no flag is present", () => {
    const { backend, rest } = extractBackendFlag(["run", "--foo"]);
    expect(backend).toBe("rust");
    expect(rest).toEqual(["run", "--foo"]);
  });

  it("supports --backend=ts / --backend=rust", () => {
    expect(extractBackendFlag(["--backend=ts"])).toEqual({
      backend: "ts",
      rest: [],
    });
    expect(extractBackendFlag(["--backend=rust", "--verbose"])).toEqual({
      backend: "rust",
      rest: ["--verbose"],
    });
  });

  it("supports space-separated --backend ts", () => {
    expect(extractBackendFlag(["--backend", "ts", "--x"])).toEqual({
      backend: "ts",
      rest: ["--x"],
    });
  });

  it("keeps unknown --backend values in rest and defaults to rust", () => {
    const { backend, rest } = extractBackendFlag(["--backend=julia"]);
    expect(backend).toBe("rust");
    expect(rest).toEqual(["--backend=julia"]);
  });
});

describe("runDaemon end-to-end skeleton", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("exits cleanly when the injected AbortSignal is pre-aborted", async () => {
    // Signal is already aborted → the poller loop runs zero iterations
    // and runDaemon returns 0. We stub out identity resolution failure
    // so the test doesn't touch the real `gh` binary.
    const controller = new AbortController();
    controller.abort();

    const logs: string[] = [];
    const logger = {
      info: (line: string) => logs.push(`INFO ${line}`),
      warn: (line: string) => logs.push(`WARN ${line}`),
      error: (line: string) => logs.push(`ERROR ${line}`),
    };

    // Even though identity will fail (no `gh` in test env), runDaemon
    // should continue and the poller should exit immediately because
    // the signal is pre-aborted.
    const code = await runDaemon([], {
      cliOverrides: { pollIntervalSec: 1 },
      installSignalHandlers: false,
      signal: controller.signal,
      logger,
    });
    expect(code).toBe(0);
    expect(logs.some((l) => l.includes("shutdown complete"))).toBe(true);
  });
});

describe("cli dispatcher routes daemon --backend flag", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("routes `daemon --backend=ts` to the TS runner", async () => {
    const runDaemonSpy = vi.fn(async () => 0);

    vi.doMock("../src/products/breeze/daemon/runner-skeleton.js", () => ({
      runDaemon: runDaemonSpy,
    }));
    vi.doMock("../src/products/breeze/bridge.js", () => ({
      resolveBreezeRunner: vi.fn(() => {
        throw new Error("TS backend must not call the Rust bridge");
      }),
      resolveBundledBreezeScript: vi.fn(),
      resolveBreezeSetupScript: vi.fn(),
      resolveFirstTreePackageRoot: vi.fn(() => "/pkg"),
      spawnInherit: vi.fn(() => {
        throw new Error("TS backend must not spawn");
      }),
    }));

    const { runBreeze } = await import("../src/products/breeze/cli.js");
    const code = await runBreeze(
      ["daemon", "--backend=ts", "--poll-interval-secs", "30"],
      () => {},
    );
    expect(code).toBe(0);
    expect(runDaemonSpy).toHaveBeenCalledWith([
      "--poll-interval-secs",
      "30",
    ]);
  });

  it("routes `daemon` (default backend) through the Rust bridge's `run` subcommand", async () => {
    const spawnSpy = vi.fn().mockReturnValue(0);
    const resolveRunnerSpy = vi
      .fn()
      .mockReturnValue({ path: "/runner", source: "path" });

    vi.doMock("../src/products/breeze/daemon/runner-skeleton.js", () => ({
      runDaemon: vi.fn(() => {
        throw new Error("Rust backend must not call the TS daemon");
      }),
    }));
    vi.doMock("../src/products/breeze/bridge.js", () => ({
      resolveBreezeRunner: resolveRunnerSpy,
      resolveBundledBreezeScript: vi.fn(),
      resolveBreezeSetupScript: vi.fn(),
      resolveFirstTreePackageRoot: vi.fn(() => "/pkg"),
      spawnInherit: spawnSpy,
    }));

    const { runBreeze } = await import("../src/products/breeze/cli.js");
    const code = await runBreeze(["daemon", "--verbose"], () => {});
    expect(code).toBe(0);
    expect(resolveRunnerSpy).toHaveBeenCalledOnce();
    expect(spawnSpy).toHaveBeenCalledWith("/runner", ["run", "--verbose"]);
  });
});
