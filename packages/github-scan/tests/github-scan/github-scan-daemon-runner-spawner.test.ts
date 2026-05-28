import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentRequest } from "../../src/github-scan/engine/daemon/runner.js";

const tempRoots: string[] = [];
const spawnCalls: Array<{ cmd: string; args: string[]; cwd: string | undefined; env: NodeJS.ProcessEnv }> = [];

class FakePipe {
  constructor(private readonly text: string) {}

  pipe(target: { write: (chunk: string) => unknown }): void {
    target.write(this.text);
  }
}

vi.doMock("node:child_process", async () => ({
  spawn: (cmd: string, args: string[], options: { cwd?: string; env: NodeJS.ProcessEnv }) => {
    spawnCalls.push({ cmd, args, cwd: options.cwd, env: options.env });
    const child = Object.assign(new EventEmitter(), {
      stdout: new FakePipe("stdout from agent\n"),
      stderr: new FakePipe("stderr from agent\n"),
    });
    queueMicrotask(() => child.emit("close", 0));
    return child;
  },
}));

afterEach(() => {
  vi.resetModules();
  spawnCalls.length = 0;
  while (tempRoots.length) {
    const root = tempRoots.pop();
    if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `github-scan-spawner-${prefix}-`));
  tempRoots.push(dir);
  return dir;
}

function fakeRequest(root: string): AgentRequest {
  return {
    task: {
      repo: "owner/repo",
      workspaceRepo: "owner/repo",
      kind: "issue",
      title: "Example",
      taskUrl: "https://github.com/owner/repo/issues/1",
    },
    taskId: "task-1",
    taskDir: root,
    workspaceDir: join(root, "workspace"),
    snapshotDir: join(root, "snapshot"),
    ghShimDir: join(root, "shim", "bin"),
    ghBrokerDir: join(root, "shim"),
    identity: { login: "alice", host: "github.com" },
    disclosureText: "Agent note: this is github-scan.",
    treeRepo: "owner/context-tree",
  };
}

describe("defaultAgentSpawner", () => {
  it("spawns the selected runtime, pipes logs, and returns the exit status", async () => {
    const root = makeTempDir("ok");
    const request = fakeRequest(root);
    const { defaultAgentSpawner } = await import("../../src/github-scan/engine/daemon/runner.js");

    const result = await defaultAgentSpawner({
      spec: { kind: "codex", model: "gpt-5", env: { EXTRA_FLAG: "1" } },
      request,
      promptPath: join(root, "prompt.txt"),
      promptText: "prompt",
      outputPath: join(root, "runner-output.txt"),
      stdoutPath: join(root, "runner-stdout.log"),
      stderrPath: join(root, "runner-stderr.log"),
    });

    expect(result.statusCode).toBe(0);
    expect(spawnCalls[0].cmd).toBe("codex");
    expect(spawnCalls[0].args).toContain("--model");
    expect(spawnCalls[0].env.EXTRA_FLAG).toBe("1");
    expect(spawnCalls[0].env.GITHUB_SCAN_TASK_DIR).toBe(root);
    expect(readFileSync(join(root, "runner-stdout.log"), "utf8")).toContain("stdout from agent");
    expect(readFileSync(join(root, "runner-stderr.log"), "utf8")).toContain("stderr from agent");
  });
});
