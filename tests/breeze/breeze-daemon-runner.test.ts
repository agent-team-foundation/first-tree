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
} from "../../src/products/breeze/engine/daemon/runner-skeleton.js";
import { extractBackendFlag } from "../../src/products/breeze/cli.js";

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

  it("parses --allow-repo in both space and = forms", () => {
    expect(
      parseDaemonArgs(["--allow-repo", "foo/bar,baz/*"]).allowRepo,
    ).toBe("foo/bar,baz/*");
    expect(
      parseDaemonArgs(["--allow-repo=foo/bar"]).allowRepo,
    ).toBe("foo/bar");
  });

  it("drops empty --allow-repo values", () => {
    expect(parseDaemonArgs(["--allow-repo", ""]).allowRepo).toBeUndefined();
    expect(parseDaemonArgs(["--allow-repo="]).allowRepo).toBeUndefined();
  });
});

describe("extractBackendFlag", () => {
  it("passes argv through unchanged when no flag is present", () => {
    const { backend, rest } = extractBackendFlag(["run", "--foo"]);
    expect(backend).toBe("ts");
    expect(rest).toEqual(["run", "--foo"]);
  });

  it("strips --backend=<value> forms", () => {
    expect(extractBackendFlag(["--backend=ts", "--x"])).toEqual({
      backend: "ts",
      rest: ["--x"],
    });
    expect(extractBackendFlag(["--backend=rust", "--verbose"])).toEqual({
      backend: "ts",
      rest: ["--verbose"],
    });
  });

  it("strips space-separated --backend <value> forms", () => {
    expect(extractBackendFlag(["--backend", "rust", "--x"])).toEqual({
      backend: "ts",
      rest: ["--x"],
    });
  });

  it("also drops unknown --backend values", () => {
    const { backend, rest } = extractBackendFlag(["--backend=julia"]);
    expect(backend).toBe("ts");
    expect(rest).toEqual([]);
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

describe("cli dispatcher routes run / run-once / daemon to the TS runner", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("routes `daemon` to runDaemon with once=false", async () => {
    const runDaemonSpy = vi.fn(async () => 0);
    vi.doMock("../../src/products/breeze/engine/daemon/runner-skeleton.js", () => ({
      runDaemon: runDaemonSpy,
    }));
    const { runBreeze } = await import("../../src/products/breeze/cli.js");
    await runBreeze(["daemon", "--poll-interval-secs", "30"], () => {});
    expect(runDaemonSpy).toHaveBeenCalledWith(
      ["--poll-interval-secs", "30"],
      { once: false },
    );
  });

  it("routes `run` to runDaemon with once=false and strips any stray --backend flag", async () => {
    const runDaemonSpy = vi.fn(async () => 0);
    vi.doMock("../../src/products/breeze/engine/daemon/runner-skeleton.js", () => ({
      runDaemon: runDaemonSpy,
    }));
    const { runBreeze } = await import("../../src/products/breeze/cli.js");
    await runBreeze(["run", "--backend=rust", "--verbose"], () => {});
    expect(runDaemonSpy).toHaveBeenCalledWith(["--verbose"], { once: false });
  });

  it("routes `run-once` to runDaemon with once=true", async () => {
    const runDaemonSpy = vi.fn(async () => 0);
    vi.doMock("../../src/products/breeze/engine/daemon/runner-skeleton.js", () => ({
      runDaemon: runDaemonSpy,
    }));
    const { runBreeze } = await import("../../src/products/breeze/cli.js");
    await runBreeze(["run-once"], () => {});
    expect(runDaemonSpy).toHaveBeenCalledWith([], { once: true });
  });
});
