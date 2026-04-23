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
  AgentPool,
  buildAgentEnv,
  buildCommand,
  buildPrompt,
  executeAgent,
  parseResult,
  runWithTimeout,
  type AgentRequest,
  type AgentSpawner,
} from "../../src/products/breeze/engine/daemon/runner.js";

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
  const dir = mkdtempSync(join(tmpdir(), `breeze-runner-${prefix}-`));
  tempRoots.push(dir);
  return dir;
}

function fakeRequest(overrides: Partial<AgentRequest> = {}): AgentRequest {
  const base: AgentRequest = {
    task: {
      repo: "owner/repo",
      workspaceRepo: "owner/repo",
      kind: "issue",
      title: "Example",
      taskUrl: "https://github.com/owner/repo/issues/1",
    },
    taskId: "task-1",
    taskDir: makeTempDir("task"),
    workspaceDir: "/tmp/workspace",
    snapshotDir: "/tmp/snapshot",
    ghShimDir: "/tmp/shim/bin",
    ghBrokerDir: "/tmp/shim",
    identity: { login: "alice", host: "github.com" },
    disclosureText: "Agent note: this is breeze.",
  };
  return { ...base, ...overrides };
}

describe("parseResult", () => {
  it("parses status and summary from last BREEZE_RESULT line", () => {
    const { status, summary } = parseResult(
      "working...\nBREEZE_RESULT: status=handled summary=reviewed and replied",
    );
    expect(status).toBe("handled");
    expect(summary).toBe("reviewed and replied");
  });

  it("prefers the last BREEZE_RESULT when multiple appear", () => {
    const { status } = parseResult(
      "BREEZE_RESULT: status=failed summary=nope\nBREEZE_RESULT: status=handled summary=ok",
    );
    expect(status).toBe("handled");
  });

  it("falls back to handled + last line when missing", () => {
    const { status, summary } = parseResult("done working\nall good");
    expect(status).toBe("handled");
    expect(summary).toBe("all good");
  });

  it("handles skipped status", () => {
    const { status } = parseResult(
      "BREEZE_RESULT: status=skipped summary=already handled",
    );
    expect(status).toBe("skipped");
  });
});

describe("buildPrompt", () => {
  it("includes identity, task URL, local context, disclosure", () => {
    const prompt = buildPrompt(fakeRequest());
    expect(prompt).toContain("representing alice");
    expect(prompt).toContain("https://github.com/owner/repo/issues/1");
    expect(prompt).toContain("- Task ID: task-1");
    expect(prompt).toContain("Agent note: this is breeze.");
    expect(prompt).toContain("BREEZE_RESULT: status=");
  });

  it("adds Working repository line only when it differs from repo", () => {
    const same = buildPrompt(fakeRequest());
    expect(same).not.toContain("Working repository:");

    const differ = buildPrompt(
      fakeRequest({
        task: {
          repo: "owner/original",
          workspaceRepo: "alice/self",
          kind: "issue",
          title: "x",
          taskUrl: "u",
        },
      }),
    );
    expect(differ).toContain("Working repository: alice/self");
  });

  it("includes the gardener sync-proposal dispatch rule", () => {
    const prompt = buildPrompt(fakeRequest());
    expect(prompt).toContain("gardener:sync-proposal");
    expect(prompt).toContain("first-tree gardener draft-node");
    expect(prompt).toContain("--issue");
    expect(prompt).toContain("--tree-repo");
  });
});

describe("buildCommand", () => {
  it("builds codex argv with --cd and --output-last-message", () => {
    const request = fakeRequest();
    const { cmd, args, cwd } = buildCommand({
      spec: { kind: "codex", model: "gpt-5" },
      request,
      promptPath: "/tmp/prompt.txt",
      promptText: "ignored for codex",
      outputPath: "/tmp/out.txt",
    });
    expect(cmd).toBe("codex");
    expect(args).toContain("--cd");
    expect(args).toContain(request.workspaceDir);
    expect(args).toContain("--output-last-message");
    expect(args).toContain("/tmp/out.txt");
    expect(args).toContain("--model");
    expect(args).toContain("gpt-5");
    expect(args[args.length - 1]).toBe("/tmp/prompt.txt");
    expect(cwd).toBeUndefined();
  });

  it("builds claude argv with workspace cwd and prompt text", () => {
    const request = fakeRequest();
    const { cmd, args, cwd } = buildCommand({
      spec: { kind: "claude" },
      request,
      promptPath: "/tmp/prompt.txt",
      promptText: "hello world",
      outputPath: "/tmp/out.txt",
    });
    expect(cmd).toBe("claude");
    expect(args).toContain("-p");
    expect(args).toContain("--permission-mode");
    expect(args).toContain("bypassPermissions");
    expect(args[args.length - 1]).toBe("hello world");
    expect(cwd).toBe(request.workspaceDir);
  });
});

describe("buildAgentEnv", () => {
  it("prefixes shim dir to PATH and exports BREEZE_* env vars", () => {
    const env = buildAgentEnv(
      fakeRequest({
        ghShimDir: "/opt/shim/bin",
        ghBrokerDir: "/opt/shim",
        snapshotDir: "/snap",
        taskDir: "/task",
      }),
    );
    expect(env.PATH).toMatch(/^\/opt\/shim\/bin:/);
    expect(env.BREEZE_BROKER_DIR).toBe("/opt/shim");
    expect(env.BREEZE_SNAPSHOT_DIR).toBe("/snap");
    expect(env.BREEZE_TASK_DIR).toBe("/task");
  });
});

describe("AgentPool", () => {
  it("rotates execution order across calls", () => {
    const pool = new AgentPool([
      { kind: "codex" },
      { kind: "claude" },
    ]);
    const first = pool.executionOrder().map((r) => r.kind);
    const second = pool.executionOrder().map((r) => r.kind);
    expect(first).toEqual(["codex", "claude"]);
    expect(second).toEqual(["claude", "codex"]);
  });

  it("throws when no agents are configured", () => {
    expect(() => new AgentPool([])).toThrow(/no configured agent/);
  });

  it("exposes available names", () => {
    const pool = new AgentPool([{ kind: "claude" }]);
    expect(pool.availableNames()).toEqual(["claude"]);
  });
});

describe("executeAgent", () => {
  it("writes prompt, invokes spawner, parses result", async () => {
    const request = fakeRequest();
    const finalOutputPath = join(request.taskDir, "runner-output.txt");
    writeFileSync(finalOutputPath, "stale output");
    const spawner: AgentSpawner = async ({ outputPath }) => {
      expect(outputPath).not.toBe(finalOutputPath);
      writeFileSync(
        outputPath,
        "doing things\nBREEZE_RESULT: status=handled summary=all good",
      );
      return { statusCode: 0 };
    };
    const outcome = await executeAgent(
      { kind: "codex" },
      request,
      { timeoutMs: 1_000, spawner },
    );
    expect(outcome.status).toBe("handled");
    expect(outcome.summary).toBe("all good");
    expect(existsSync(join(request.taskDir, "prompt.txt"))).toBe(true);
    expect(readFileSync(finalOutputPath, "utf8")).toContain("all good");
    expect(existsSync(join(request.taskDir, "runner-last-message.txt"))).toBe(false);
  });

  it("copies claude stdout into runner-output.txt", async () => {
    const request = fakeRequest();
    const spawner: AgentSpawner = async ({ stdoutPath }) => {
      writeFileSync(
        stdoutPath,
        "chatter\nBREEZE_RESULT: status=handled summary=ok",
      );
      return { statusCode: 0 };
    };
    const outcome = await executeAgent(
      { kind: "claude" },
      request,
      { timeoutMs: 1_000, spawner },
    );
    expect(outcome.status).toBe("handled");
    expect(
      readFileSync(join(request.taskDir, "runner-output.txt"), "utf8"),
    ).toContain("BREEZE_RESULT:");
  });

  it("throws on non-zero exit code", async () => {
    const spawner: AgentSpawner = async () => ({ statusCode: 42 });
    await expect(
      executeAgent({ kind: "codex" }, fakeRequest(), {
        timeoutMs: 1_000,
        spawner,
      }),
    ).rejects.toThrow(/exited with status 42/);
  });
});

describe("runWithTimeout", () => {
  it("resolves when the underlying promise finishes in time", async () => {
    const value = await runWithTimeout({
      run: async () => "done",
      kill: () => {},
      timeoutMs: 100,
    });
    expect(value).toBe("done");
  });

  it("rejects and calls kill when timeout elapses", async () => {
    let killed = false;
    await expect(
      runWithTimeout({
        run: () => new Promise(() => {}),
        kill: () => {
          killed = true;
        },
        timeoutMs: 20,
      }),
    ).rejects.toThrow(/timed out/);
    expect(killed).toBe(true);
  });

  it("respects an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    let killed = false;
    await expect(
      runWithTimeout({
        run: () => new Promise(() => {}),
        kill: () => {
          killed = true;
        },
        timeoutMs: 1_000,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/aborted/);
    expect(killed).toBe(true);
  });
});
