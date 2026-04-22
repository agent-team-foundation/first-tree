import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  buildClaudeCliEnvironment,
  ClaudeCliClassifierError,
  createClaudeCliClassifier,
  isAuthFailure,
  isBinaryMissing,
} from "#products/gardener/engine/classifiers/claude-cli.js";
import type { ClassifyInput } from "#products/gardener/engine/comment.js";

const input: ClassifyInput = {
  type: "pr",
  treeRoot: "/tmp/nonexistent-tree-root-cli-test",
  prView: { number: 1, title: "t", body: "b", headRefOid: "x", state: "OPEN" },
  diff: "diff --git a/x b/x\n",
};

function makeFakeChild(opts: {
  stdout?: string;
  stderr?: string;
  code?: number | null;
  emitError?: NodeJS.ErrnoException;
  delayCloseMs?: number;
}): any {
  const child = new EventEmitter() as any;
  const stdout = new EventEmitter() as any;
  const stderr = new EventEmitter() as any;
  const stdin: any = { end: () => {} };
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdin = stdin;
  child.kill = () => {};
  setImmediate(() => {
    if (opts.emitError) {
      child.emit("error", opts.emitError);
      return;
    }
    if (opts.stdout) stdout.emit("data", Buffer.from(opts.stdout, "utf-8"));
    if (opts.stderr) stderr.emit("data", Buffer.from(opts.stderr, "utf-8"));
    const fire = () => child.emit("close", opts.code ?? 0);
    if (opts.delayCloseMs) setTimeout(fire, opts.delayCloseMs);
    else fire();
  });
  return child;
}

describe("createClaudeCliClassifier", () => {
  it("parses valid JSON verdict from stdout", async () => {
    const classifier = createClaudeCliClassifier({
      spawnImpl: (() =>
        makeFakeChild({
          stdout: JSON.stringify({
            verdict: "NEW_TERRITORY",
            severity: "low",
            summary: "ok",
            treeNodes: [],
          }),
          code: 0,
        })) as any,
    });
    const out = await classifier(input);
    expect(out.verdict).toBe("NEW_TERRITORY");
  });

  it("throws auth_failed on stderr auth signals", async () => {
    const classifier = createClaudeCliClassifier({
      spawnImpl: (() =>
        makeFakeChild({
          stderr: "Error: not logged in. Please run `claude login`.",
          code: 1,
        })) as any,
    });
    await expect(classifier(input)).rejects.toSatisfy((e) => isAuthFailure(e));
  });

  it("treats 'Invalid API key · Fix external API key' as auth_failed", async () => {
    const classifier = createClaudeCliClassifier({
      spawnImpl: (() =>
        makeFakeChild({
          stderr: "Invalid API key · Fix external API key",
          code: 1,
        })) as any,
    });
    await expect(classifier(input)).rejects.toSatisfy((e) => isAuthFailure(e));
  });

  it("scrubs ANTHROPIC_API_KEY from subprocess env", async () => {
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const originalKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-parent-should-not-leak";
    try {
      const classifier = createClaudeCliClassifier({
        spawnImpl: ((_bin: string, _args: string[], opts: any) => {
          capturedEnv = opts?.env;
          return makeFakeChild({
            stdout: JSON.stringify({
              verdict: "NEW_TERRITORY",
              severity: "low",
              summary: "ok",
              treeNodes: [],
            }),
            code: 0,
          });
        }) as any,
      });
      await classifier(input);
      expect(capturedEnv).toBeDefined();
      expect(capturedEnv!.ANTHROPIC_API_KEY).toBeUndefined();
    } finally {
      if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = originalKey;
    }
  });
  it("throws non_zero_exit when stderr has no auth signal", async () => {
    const classifier = createClaudeCliClassifier({
      spawnImpl: (() =>
        makeFakeChild({ stderr: "random failure", code: 2 })) as any,
    });
    await expect(classifier(input)).rejects.toMatchObject({
      kind: "non_zero_exit",
    });
  });

  it("throws binary_not_found on code 127", async () => {
    const classifier = createClaudeCliClassifier({
      spawnImpl: (() => makeFakeChild({ code: 127, stderr: "" })) as any,
    });
    await expect(classifier(input)).rejects.toSatisfy((e) => isBinaryMissing(e));
  });

  it("throws unparseable_output on junk stdout", async () => {
    const classifier = createClaudeCliClassifier({
      spawnImpl: (() =>
        makeFakeChild({ stdout: "not json at all", code: 0 })) as any,
    });
    await expect(classifier(input)).rejects.toMatchObject({
      kind: "unparseable_output",
    });
  });

  it("maps ENOENT spawn error to binary_not_found", async () => {
    const err = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    const classifier = createClaudeCliClassifier({
      spawnImpl: (() => makeFakeChild({ emitError: err })) as any,
    });
    await expect(classifier(input)).rejects.toSatisfy((e) => isBinaryMissing(e));
  });

  it("scrubs ANTHROPIC_API_KEY from injected env", async () => {
    const calls: Array<{ env?: NodeJS.ProcessEnv }> = [];
    const classifier = createClaudeCliClassifier({
      env: {
        PATH: "/usr/bin:/bin",
        ANTHROPIC_API_KEY: "sk-test",
        GARDENER_DIR: "/tmp/gardener",
      },
      spawnImpl: ((
        _command: string,
        _args: string[],
        options?: { env?: NodeJS.ProcessEnv },
      ) => {
        calls.push(options ?? {});
        return makeFakeChild({
          stdout: JSON.stringify({
            verdict: "ALIGNED",
            severity: "low",
            summary: "ok",
            treeNodes: [],
          }),
          code: 0,
        });
      }) as any,
    });
    await classifier(input);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(calls[0]?.env?.GARDENER_DIR).toBe("/tmp/gardener");
  });

  it("ClaudeCliClassifierError carries kind and stderr", () => {
    const e = new ClaudeCliClassifierError("auth_failed", "msg", "stderr body");
    expect(e.kind).toBe("auth_failed");
    expect(e.stderr).toBe("stderr body");
  });

  it("buildClaudeCliEnvironment removes ANTHROPIC_API_KEY", () => {
    expect(
      buildClaudeCliEnvironment({
        PATH: "/usr/bin:/bin",
        ANTHROPIC_API_KEY: "sk-test",
        GARDENER_DIR: "/tmp/gardener",
      }).ANTHROPIC_API_KEY,
    ).toBeUndefined();
  });
});
