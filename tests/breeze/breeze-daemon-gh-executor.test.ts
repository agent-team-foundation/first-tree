import { describe, expect, it } from "vitest";

import {
  GhExecutor,
  bucketForArgs,
  commandIsMutating,
  isRateLimited,
  type ExecOutput,
  type GhCommandSpec,
} from "../../src/products/breeze/engine/daemon/gh-executor.js";

describe("bucketForArgs", () => {
  it("classifies search commands", () => {
    expect(bucketForArgs(["search", "prs", "--review-requested=@me"])).toBe(
      "search",
    );
  });

  it("classifies api search/* paths as search", () => {
    expect(bucketForArgs(["api", "search/issues?q=foo"])).toBe("search");
    expect(bucketForArgs(["api", "/repos/x/y/search/issues"])).toBe("search");
  });

  it("classifies mutating commands as write", () => {
    expect(
      bucketForArgs(["issue", "comment", "1", "--body", "hi"]),
    ).toBe("write");
  });

  it("classifies read commands as core", () => {
    expect(bucketForArgs(["api", "/notifications"])).toBe("core");
    expect(bucketForArgs(["pr", "view", "1"])).toBe("core");
  });
});

describe("commandIsMutating", () => {
  it("flags issue/pr/label mutating subcommands", () => {
    expect(commandIsMutating(["issue", "comment", "1", "-b", "x"])).toBe(true);
    expect(commandIsMutating(["pr", "merge", "1"])).toBe(true);
    expect(commandIsMutating(["label", "create", "breeze:wip"])).toBe(true);
  });

  it("does not flag read subcommands", () => {
    expect(commandIsMutating(["issue", "view", "1"])).toBe(false);
    expect(commandIsMutating(["pr", "list"])).toBe(false);
  });

  it("treats api --method GET as read", () => {
    expect(
      commandIsMutating(["api", "/repos/x/y/issues", "-X", "GET"]),
    ).toBe(false);
  });

  it("treats api --method POST as write", () => {
    expect(
      commandIsMutating(["api", "/repos/x/y/issues", "--method", "POST"]),
    ).toBe(true);
  });

  it("treats api with -f/-F/--field as write", () => {
    expect(
      commandIsMutating([
        "api",
        "/repos/x/y/issues",
        "-f",
        "title=foo",
      ]),
    ).toBe(true);
    expect(
      commandIsMutating([
        "api",
        "/repos/x/y/issues",
        "--field",
        "title=foo",
      ]),
    ).toBe(true);
    expect(
      commandIsMutating(["api", "/repos/x/y/issues", "--input", "-"]),
    ).toBe(true);
  });
});

describe("isRateLimited", () => {
  const mk = (stdout: string, stderr: string): ExecOutput => ({
    stdout,
    stderr,
    statusCode: 1,
  });

  it("detects common rate-limit messages", () => {
    expect(
      isRateLimited(mk("", "API rate limit exceeded for this resource")),
    ).toBe(true);
    expect(isRateLimited(mk("secondary rate limit hit", ""))).toBe(true);
    expect(isRateLimited(mk("", "abuse detection mechanism triggered"))).toBe(
      true,
    );
    expect(isRateLimited(mk("", "retry after 30 seconds"))).toBe(true);
  });

  it("ignores unrelated errors", () => {
    expect(isRateLimited(mk("", "could not resolve host"))).toBe(false);
  });
});

describe("GhExecutor", () => {
  /** Build an executor with a deterministic clock + injected spawn. */
  function buildExecutor(opts: {
    responses: ExecOutput[];
    writeCooldownMs?: number;
  }): {
    executor: GhExecutor;
    clock: { now: number };
    sleeps: number[];
    calls: GhCommandSpec[];
  } {
    const clock = { now: 1_000_000 };
    const sleeps: number[] = [];
    const calls: GhCommandSpec[] = [];
    const responses = [...opts.responses];
    const spawnGh = async (spec: GhCommandSpec): Promise<ExecOutput> => {
      calls.push(spec);
      const next = responses.shift();
      if (!next) throw new Error("no scripted response left");
      return next;
    };
    const sleep = async (ms: number): Promise<void> => {
      sleeps.push(ms);
      clock.now += ms;
    };
    const executor = new GhExecutor({
      realGh: "/usr/bin/gh",
      writeCooldownMs: opts.writeCooldownMs ?? 1_250,
      spawnGh,
      now: () => clock.now,
      sleep,
    });
    return { executor, clock, sleeps, calls };
  }

  it("runs once on success and records write cooldown timestamp", async () => {
    const { executor, clock, calls, sleeps } = buildExecutor({
      responses: [{ stdout: "ok", stderr: "", statusCode: 0 }],
    });
    const output = await executor.run({
      context: "test",
      args: ["issue", "comment", "1", "-b", "hi"],
    });
    expect(output.statusCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(executor.getState().lastWriteEpochMs).toBe(clock.now);
    expect(sleeps).toHaveLength(0);
  });

  it("retries on rate-limit and backs off with increasing streak", async () => {
    const { executor, calls, sleeps } = buildExecutor({
      responses: [
        { stdout: "", stderr: "API rate limit exceeded", statusCode: 1 },
        { stdout: "", stderr: "secondary rate limit", statusCode: 1 },
        { stdout: "ok", stderr: "", statusCode: 0 },
      ],
    });
    const output = await executor.run({
      context: "test",
      args: ["api", "/notifications"],
    });
    expect(output.statusCode).toBe(0);
    expect(calls).toHaveLength(3);
    // Streak should be zero on final success (registerCompletion clears it).
    expect(executor.getState().rateLimitStreak).toBe(0);
    // Backoff slept on attempts 1 and 2.
    expect(sleeps.length).toBeGreaterThanOrEqual(2);
  });

  it("gives up after 3 rate-limited attempts", async () => {
    const { executor, calls } = buildExecutor({
      responses: [
        { stdout: "", stderr: "API rate limit exceeded", statusCode: 1 },
        { stdout: "", stderr: "API rate limit exceeded", statusCode: 1 },
        { stdout: "", stderr: "API rate limit exceeded", statusCode: 1 },
      ],
    });
    const output = await executor.run({
      context: "test",
      args: ["api", "/notifications"],
    });
    expect(output.statusCode).toBe(1);
    expect(calls).toHaveLength(3);
    expect(executor.getState().rateLimitStreak).toBeGreaterThanOrEqual(3);
  });

  it("waits writeCooldownMs between consecutive mutations", async () => {
    const { executor, sleeps } = buildExecutor({
      responses: [
        { stdout: "ok", stderr: "", statusCode: 0 },
        { stdout: "ok", stderr: "", statusCode: 0 },
      ],
      writeCooldownMs: 1_250,
    });
    await executor.run({
      context: "first",
      args: ["issue", "comment", "1", "-b", "a"],
    });
    await executor.run({
      context: "second",
      args: ["issue", "comment", "2", "-b", "b"],
    });
    // Second call should have slept at least once for the cooldown.
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(1_250);
  });

  it("runChecked throws on non-zero exit", async () => {
    const { executor } = buildExecutor({
      responses: [{ stdout: "", stderr: "nope", statusCode: 1 }],
    });
    await expect(
      executor.runChecked({ context: "test", args: ["api", "/x"] }),
    ).rejects.toThrow(/failed with exit code 1/);
  });

  it("respects abort signal and returns synthetic 124", async () => {
    const controller = new AbortController();
    controller.abort();
    const executor = new GhExecutor({
      realGh: "/usr/bin/gh",
      writeCooldownMs: 0,
      spawnGh: async () => {
        throw new Error("should not spawn after abort");
      },
      now: () => 0,
      sleep: async () => {},
      signal: controller.signal,
    });
    const output = await executor.run({
      context: "test",
      args: ["api", "/notifications"],
    });
    expect(output.statusCode).toBe(124);
  });
});
