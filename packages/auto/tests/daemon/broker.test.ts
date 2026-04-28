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

import {
  GhExecutor,
  type GhCommandSpec,
  type ExecOutput,
} from "../../src/daemon/gh-executor.js";
import {
  MUTATION_CACHE_TTL_MS,
  SHIM_SCRIPT,
  mutationFingerprint,
  readCachedMutationResponse,
  stableFileId,
  startGhBroker,
  writeCachedMutationResponse,
} from "../../src/daemon/broker.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length) {
    const dir = tempRoots.pop();
    if (dir && existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `breeze-broker-${prefix}-`));
  tempRoots.push(dir);
  return dir;
}

function buildExecutor(responses: ExecOutput[]): {
  executor: GhExecutor;
  calls: GhCommandSpec[];
} {
  const calls: GhCommandSpec[] = [];
  const queue = [...responses];
  const executor = new GhExecutor({
    realGh: "/usr/bin/gh",
    writeCooldownMs: 0,
    spawnGh: async (spec) => {
      calls.push(spec);
      const next = queue.shift();
      if (!next) throw new Error("no scripted response");
      return next;
    },
    now: () => 0,
    sleep: async () => {},
  });
  return { executor, calls };
}

describe("SHIM_SCRIPT", () => {
  it("references AUTO_BROKER_DIR and writes argv.txt", () => {
    expect(SHIM_SCRIPT).toContain("AUTO_BROKER_DIR");
    expect(SHIM_SCRIPT).toContain("argv.txt");
  });
});

describe("mutationFingerprint", () => {
  it("returns undefined for read-only commands", () => {
    expect(
      mutationFingerprint({
        context: "",
        args: ["api", "/notifications"],
        mutating: false,
        bucket: "core",
      }),
    ).toBeUndefined();
  });

  it("hashes --body so retries with the same text hit cache", () => {
    const base: GhCommandSpec = {
      context: "",
      args: ["issue", "comment", "1", "--body", "hello"],
      mutating: true,
      bucket: "write",
    };
    const other: GhCommandSpec = {
      ...base,
      args: ["issue", "comment", "1", "--body", "hello"],
    };
    expect(mutationFingerprint(base)).toEqual(mutationFingerprint(other));
  });

  it("hashes --body-file contents not path", () => {
    const cwd = makeTempDir("fp");
    const a = join(cwd, "a.txt");
    const b = join(cwd, "b.txt");
    writeFileSync(a, "same body");
    writeFileSync(b, "same body");
    const specA: GhCommandSpec = {
      context: "",
      cwd,
      args: ["pr", "review", "1", "--body-file", "a.txt"],
      mutating: true,
      bucket: "write",
      envs: { GH_REPO: "owner/repo" },
    };
    const specB: GhCommandSpec = {
      ...specA,
      args: ["pr", "review", "1", "--body-file", "b.txt"],
    };
    expect(mutationFingerprint(specA)).toEqual(mutationFingerprint(specB));
  });

  it("includes sorted env and cwd", () => {
    const fp1 = mutationFingerprint({
      context: "",
      cwd: "/tmp/x",
      args: ["pr", "create", "--title", "t"],
      envs: { GH_HOST: "github.com", GH_REPO: "o/r" },
      mutating: true,
      bucket: "write",
    });
    const fp2 = mutationFingerprint({
      context: "",
      cwd: "/tmp/x",
      args: ["pr", "create", "--title", "t"],
      envs: { GH_REPO: "o/r", GH_HOST: "github.com" },
      mutating: true,
      bucket: "write",
    });
    expect(fp1).toEqual(fp2);
    expect(fp1).toContain("env:GH_HOST=github.com");
    expect(fp1).toContain("cwd:/tmp/x");
  });
});

describe("cache round-trip", () => {
  it("reads back a success within TTL and drops after expiry", () => {
    const historyDir = makeTempDir("cache");
    const clock = { now: 1_000 };
    writeCachedMutationResponse({
      historyDir,
      fingerprint: "foo",
      stdout: "ok",
      stderr: "",
      statusCode: 0,
      now: () => clock.now,
    });

    const hit = readCachedMutationResponse({
      historyDir,
      fingerprint: "foo",
      now: () => clock.now + 1_000,
    });
    expect(hit?.stdout).toBe("ok");

    const miss = readCachedMutationResponse({
      historyDir,
      fingerprint: "foo",
      now: () => clock.now + MUTATION_CACHE_TTL_MS + 1,
    });
    expect(miss).toBeUndefined();
  });

  it("drops non-zero status codes from cache", () => {
    const historyDir = makeTempDir("cache-bad");
    writeCachedMutationResponse({
      historyDir,
      fingerprint: "bad",
      stdout: "",
      stderr: "oops",
      statusCode: 1,
      now: () => 1,
    });
    expect(
      readCachedMutationResponse({
        historyDir,
        fingerprint: "bad",
        now: () => 2,
      }),
    ).toBeUndefined();
  });
});

describe("stableFileId", () => {
  it("is deterministic for identical inputs", () => {
    expect(stableFileId("hello")).toBe(stableFileId("hello"));
  });
  it("differs across inputs", () => {
    expect(stableFileId("a")).not.toBe(stableFileId("b"));
  });
});

describe("startGhBroker serve loop", () => {
  it("installs shim with exec permissions and purges stale requests", async () => {
    const brokerDir = makeTempDir("serve");
    // Plant a stale request dir; broker.start() should purge on boot.
    const stale = join(brokerDir, "requests", "stale");
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, "argv.txt"), "issue\nlist\n");

    const { executor } = buildExecutor([]);
    const broker = await startGhBroker({
      brokerDir,
      executor,
      pollIntervalMs: 10,
    });
    try {
      expect(existsSync(join(broker.shimDir, "gh"))).toBe(true);
      expect(existsSync(stale)).toBe(false);
    } finally {
      await broker.stop();
    }
  });

  it("handles a request end-to-end, writing response.env", async () => {
    const brokerDir = makeTempDir("e2e");
    const { executor, calls } = buildExecutor([
      { stdout: "hello", stderr: "", statusCode: 0 },
    ]);
    const broker = await startGhBroker({
      brokerDir,
      executor,
      pollIntervalMs: 5,
    });
    try {
      const reqDir = join(brokerDir, "requests", "req-1");
      mkdirSync(reqDir, { recursive: true });
      writeFileSync(join(reqDir, "cwd.txt"), "/tmp\n");
      writeFileSync(join(reqDir, "argv.txt"), "api\n/notifications\n");
      await waitFor(
        () => existsSync(join(reqDir, "response.env")),
        2_000,
      );
      const env = readFileSync(join(reqDir, "response.env"), "utf8");
      expect(env).toContain("status_code=0");
      expect(readFileSync(join(reqDir, "stdout.txt"), "utf8")).toBe("hello");
      expect(calls).toHaveLength(1);
      expect(calls[0].args).toEqual(["api", "/notifications"]);
    } finally {
      await broker.stop();
    }
  });

  it("serves a cached response without re-invoking gh", async () => {
    const brokerDir = makeTempDir("cached");
    const { executor, calls } = buildExecutor([
      { stdout: "first", stderr: "", statusCode: 0 },
    ]);
    const broker = await startGhBroker({
      brokerDir,
      executor,
      pollIntervalMs: 5,
    });
    try {
      // First request: hits gh, stores in cache.
      const reqA = join(brokerDir, "requests", "req-A");
      mkdirSync(reqA, { recursive: true });
      writeFileSync(
        join(reqA, "argv.txt"),
        "issue\ncomment\n1\n--body\nhello\n",
      );
      writeFileSync(join(reqA, "cwd.txt"), "/tmp\n");
      await waitFor(
        () => existsSync(join(reqA, "response.env")),
        2_000,
      );
      expect(readFileSync(join(reqA, "stdout.txt"), "utf8")).toBe("first");
      expect(calls).toHaveLength(1);

      // Second request with same body: served from cache. Executor was
      // only primed with one response; a second spawnGh call would throw.
      const reqB = join(brokerDir, "requests", "req-B");
      mkdirSync(reqB, { recursive: true });
      writeFileSync(
        join(reqB, "argv.txt"),
        "issue\ncomment\n1\n--body\nhello\n",
      );
      writeFileSync(join(reqB, "cwd.txt"), "/tmp\n");
      await waitFor(
        () => existsSync(join(reqB, "response.env")),
        2_000,
      );
      expect(readFileSync(join(reqB, "stdout.txt"), "utf8")).toBe("first");
      expect(calls).toHaveLength(1);
    } finally {
      await broker.stop();
    }
  });

  it("recovers when the request dir vanishes mid-handle", async () => {
    // Regression: the shim's request dir could be reaped (by an external
    // cleaner or an abandoned shim timeout) after the broker picked it
    // up. The broker's writeFailureResponse then hit ENOENT and killed
    // the serve loop with an unhandled rejection, losing every in-flight
    // agent's gh request.
    const brokerDir = makeTempDir("reap");
    const reqDir = join(brokerDir, "requests", "req-reap");
    const executor = new GhExecutor({
      realGh: "/usr/bin/gh",
      writeCooldownMs: 0,
      spawnGh: async () => {
        // Simulate the external reap racing against broker response write.
        rmSync(reqDir, { recursive: true, force: true });
        throw new Error("network boom");
      },
      now: () => 0,
      sleep: async () => {},
    });
    const broker = await startGhBroker({
      brokerDir,
      executor,
      pollIntervalMs: 5,
    });
    try {
      mkdirSync(reqDir, { recursive: true });
      writeFileSync(join(reqDir, "argv.txt"), "api\n/notifications\n");
      writeFileSync(join(reqDir, "cwd.txt"), "/tmp\n");
      await waitFor(
        () => existsSync(join(reqDir, "response.env")),
        2_000,
      );
      expect(readFileSync(join(reqDir, "response.env"), "utf8")).toContain(
        "status_code=1",
      );
      // Serve loop survived: a subsequent request still completes.
      const reqDir2 = join(brokerDir, "requests", "req-after");
      mkdirSync(reqDir2, { recursive: true });
      writeFileSync(join(reqDir2, "argv.txt"), "api\n/rate_limit\n");
      writeFileSync(join(reqDir2, "cwd.txt"), "/tmp\n");
      // The executor was primed to throw for every call, but handleRequest
      // will still write a failure response and keep the loop alive.
      await waitFor(
        () => existsSync(join(reqDir2, "response.env")),
        2_000,
      );
    } finally {
      await broker.stop();
    }
  });

  it("writes failure response when executor throws", async () => {
    const brokerDir = makeTempDir("fail");
    const executor = new GhExecutor({
      realGh: "/usr/bin/gh",
      writeCooldownMs: 0,
      spawnGh: async () => {
        throw new Error("boom");
      },
      now: () => 0,
      sleep: async () => {},
    });
    const broker = await startGhBroker({
      brokerDir,
      executor,
      pollIntervalMs: 5,
    });
    try {
      const reqDir = join(brokerDir, "requests", "req-fail");
      mkdirSync(reqDir, { recursive: true });
      writeFileSync(join(reqDir, "argv.txt"), "api\n/notifications\n");
      writeFileSync(join(reqDir, "cwd.txt"), "/tmp\n");
      await waitFor(
        () => existsSync(join(reqDir, "response.env")),
        2_000,
      );
      const env = readFileSync(join(reqDir, "response.env"), "utf8");
      expect(env).toContain("status_code=1");
      expect(readFileSync(join(reqDir, "stderr.txt"), "utf8")).toContain(
        "boom",
      );
    } finally {
      await broker.stop();
    }
  });
});

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}
