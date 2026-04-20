/**
 * Tests for the Phase 3a daemon runner-skeleton entrypoint and CLI wiring.
 *
 * Covers:
 *   - `parseDaemonArgs` parses the recognised flag set and ignores unknowns
 *   - `extractBackendFlag` (from cli.ts) separates --backend from the residual argv
 *   - `daemon --backend=ts` invokes the TS runner; `--backend=rust` bridges
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as identityModule from "../../src/products/breeze/engine/daemon/identity.js";
import * as httpModule from "../../src/products/breeze/engine/daemon/http.js";
import * as pollerModule from "../../src/products/breeze/engine/daemon/poller.js";
import {
  parseDaemonArgs,
  runDaemon,
} from "../../src/products/breeze/engine/daemon/runner-skeleton.js";
import { extractBackendFlag } from "../../src/products/breeze/cli.js";

const tempRoots: string[] = [];
const ORIGINAL_BREEZE_DIR = process.env.BREEZE_DIR;
const ORIGINAL_BREEZE_HOME = process.env.BREEZE_HOME;
const ORIGINAL_PATH = process.env.PATH;

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root && existsSync(root)) {
      rmSync(root, { recursive: true, force: true });
    }
  }
  if (ORIGINAL_BREEZE_DIR === undefined) delete process.env.BREEZE_DIR;
  else process.env.BREEZE_DIR = ORIGINAL_BREEZE_DIR;
  if (ORIGINAL_BREEZE_HOME === undefined) delete process.env.BREEZE_HOME;
  else process.env.BREEZE_HOME = ORIGINAL_BREEZE_HOME;
  if (ORIGINAL_PATH === undefined) delete process.env.PATH;
  else process.env.PATH = ORIGINAL_PATH;
  vi.useRealTimers();
});

function makeTempRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `breeze-daemon-${prefix}-`));
  tempRoots.push(dir);
  return dir;
}

function parseEnvFile(path: string): Record<string, string> {
  return Object.fromEntries(
    readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => {
        const idx = line.indexOf("=");
        return [line.slice(0, idx), line.slice(idx + 1)];
      }),
  );
}

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
      "--max-parallel",
      "7",
      "--search-limit",
      "25",
    ]);
    expect(out).toEqual({
      pollIntervalSec: 30,
      host: "ghe.example.com",
      logLevel: "debug",
      httpPort: 9191,
      taskTimeoutSec: 600,
      maxParallel: 7,
      searchLimit: 25,
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

  it("parses numeric equals-forms for max-parallel and search-limit", () => {
    const out = parseDaemonArgs([
      "--max-parallel=11",
      "--search-limit=31",
    ]);
    expect(out.maxParallel).toBe(11);
    expect(out.searchLimit).toBe(31);
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

  it("refreshes the service lock heartbeat and writes runtime status while running", async () => {
    const breezeDir = makeTempRoot("status");
    process.env.BREEZE_DIR = breezeDir;
    delete process.env.BREEZE_HOME;
    process.env.PATH = "";

    vi.spyOn(identityModule, "resolveDaemonIdentity").mockReturnValue({
        host: "github.com",
        login: "tester",
        gitProtocol: "https",
        scopes: ["repo", "notifications"],
      });
    vi.spyOn(identityModule, "identityHasRequiredScope").mockReturnValue(true);
    vi.spyOn(httpModule, "startHttpServer").mockImplementation(
      async ({ signal }: { signal?: AbortSignal }) => ({
        port: 7878,
        done: signal?.aborted
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              signal?.addEventListener("abort", () => resolve(), { once: true });
            }),
        stop: async () => undefined,
      }),
    );
    vi.spyOn(pollerModule, "runPoller").mockImplementation(
      async ({ signal }: { signal?: AbortSignal }) =>
        await new Promise<void>((resolve) => {
          if (signal?.aborted) {
            resolve();
            return;
          }
          signal?.addEventListener("abort", () => resolve(), { once: true });
        }),
    );

    const controller = new AbortController();
    const runPromise = runDaemon([], {
      cliOverrides: { pollIntervalSec: 1 },
      installSignalHandlers: false,
      signal: controller.signal,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 2_200));

    const runnerHome = join(breezeDir, "runner");
    const lockPath = join(
      runnerHome,
      "locks",
      "github.com__tester__default",
      "lock.env",
    );
    const runtimePath = join(runnerHome, "runtime", "status.env");

    expect(existsSync(lockPath)).toBe(true);
    expect(existsSync(runtimePath)).toBe(true);

    const lock = parseEnvFile(lockPath);
    expect(Number(lock.heartbeat_epoch)).toBeGreaterThan(
      Number(lock.started_epoch),
    );
    expect(lock.note).toBe("running");

    const runtime = parseEnvFile(runtimePath);
    expect(runtime.last_note).toBe("running");
    expect(runtime.last_identity).toBe("tester@github.com");
    expect(runtime.allowed_repos).toBe("all");
    expect(runtime.active_tasks).toBe("0");
    expect(runtime.queued_tasks).toBe("0");

    controller.abort();
    await expect(runPromise).resolves.toBe(0);
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
