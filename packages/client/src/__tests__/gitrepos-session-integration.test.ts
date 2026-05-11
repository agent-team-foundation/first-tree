import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeConfig } from "@agent-team-foundation/first-tree-hub-shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Stub the Claude SDK — the handler's internals call `query()` to spawn a
// subprocess, which is irrelevant for this integration test. We only want to
// exercise the gitRepo materialisation that runs BEFORE the subprocess spawns.
vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  const fakeQuery = {
    [Symbol.asyncIterator]() {
      return {
        next: async () => ({ done: true, value: undefined }),
      };
    },
    close: () => {},
    setModel: async () => {},
  };
  return {
    query: () => fakeQuery,
  };
});

import { createClaudeCodeHandler } from "../handlers/claude-code.js";
import { createAgentConfigCache } from "../runtime/agent-config-cache.js";
import { createGitMirrorManager, type GitMirrorManager } from "../runtime/git-mirror-manager.js";
import type { SessionContext } from "../runtime/handler.js";
import { mockCtxPlumbing } from "./test-helpers.js";

/**
 * This test locks down the contract that PRD §5.1.5 Git worktree lifecycle is
 * actually wired into the session-oriented handler. The previous iteration of
 * this PRD shipped `GitMirrorManager` as a standalone utility but never
 * consumed it from the handler — operators could set `gitRepos` in the Hub
 * and the workspace stayed empty. This test prevents that regression by
 * going through the real `createClaudeCodeHandler.start()` path with a stub
 * AgentConfigCache and an on-disk fixture repo.
 */

const AGENT_ID = "019d9a97-90b0-716b-8317-a8c0be8430d7";

let workRoot: string;
let fixtureBareRepo: string;

beforeAll(() => {
  workRoot = mkdtempSync(join(tmpdir(), "ftt-git-session-"));
  const seed = join(workRoot, "seed");
  mkdirSync(seed, { recursive: true });
  execSync("git init -q -b main", { cwd: seed });
  execSync("git config user.email test@example.com && git config user.name test", { cwd: seed, shell: "/bin/bash" });
  writeFileSync(join(seed, "README.md"), "# fixture repo");
  execSync("git add . && git commit -q -m seed", { cwd: seed, shell: "/bin/bash" });

  fixtureBareRepo = join(workRoot, "fixture-bare.git");
  execSync(`git clone -q --bare ${seed} ${fixtureBareRepo}`);
});

afterAll(() => {
  if (existsSync(workRoot)) rmSync(workRoot, { recursive: true, force: true });
});

function buildCache(gitRepos: AgentRuntimeConfig["payload"]["gitRepos"]) {
  const stubSdk = {
    fetchAgentConfig: async () =>
      ({
        agentId: AGENT_ID,
        version: 1,
        payload: {
          prompt: { append: "" },
          model: "",
          mcpServers: [],
          env: [],
          gitRepos,
        },
        updatedAt: new Date().toISOString(),
        updatedBy: "test",
      }) as unknown as AgentRuntimeConfig,
  } as unknown as Parameters<typeof createAgentConfigCache>[0]["sdk"];
  return createAgentConfigCache({ sdk: stubSdk });
}

function buildSessionCtx(chatId: string, log: (msg: string) => void): SessionContext {
  const sendMessage = async () => undefined;
  return {
    agent: {
      agentId: AGENT_ID,
      inboxId: "inbox-test",
      displayName: "test",
      type: "autonomous_agent",
      delegateMention: null,
      metadata: {},
    },
    sdk: { serverUrl: "http://test", sendMessage } as unknown as SessionContext["sdk"],
    chatId,
    log,
    touch: () => {},
    setRuntimeState: () => {},
    emitEvent: () => {},
    reportSessionCompletion: () => {},
    ...mockCtxPlumbing({ sendMessage }, chatId),
  };
}

describe("claude-code handler gitRepos wiring (PRD §5.1.5)", () => {
  it("materialises a worktree under cwd/<localPath> and writes a valid HEAD", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ftt-data-"));
    const workspaceRoot = join(dataDir, "workspaces", "agent-1");
    const gitMirrorManager: GitMirrorManager = createGitMirrorManager({
      dataDir,
      cloneTimeoutMs: 60_000,
    });

    const cache = buildCache([{ url: fixtureBareRepo, localPath: "repos/first-tree" }]);
    await cache.refresh(AGENT_ID);

    const handler = createClaudeCodeHandler({
      workspaceRoot,
      agentConfigCache: cache,
      gitMirrorManager,
    });

    const logs: string[] = [];
    const ctx = buildSessionCtx("chat-1", (m) => logs.push(m));
    await handler.start(
      {
        id: "msg-1",
        chatId: "chat-1",
        senderId: "user",
        format: "text",
        content: "hi",
        metadata: null,
      },
      ctx,
    );

    const worktreePath = join(workspaceRoot, "chat-1", "repos", "first-tree");
    expect(existsSync(worktreePath)).toBe(true);
    expect(existsSync(join(worktreePath, "README.md"))).toBe(true);
    expect(readFileSync(join(worktreePath, "README.md"), "utf-8")).toContain("fixture repo");
    // A worktree has a .git FILE (not directory) pointing at the bare mirror.
    expect(existsSync(join(worktreePath, ".git"))).toBe(true);

    // shutdown should remove the worktree AND the whole session workspace
    await handler.shutdown();
    expect(existsSync(worktreePath)).toBe(false);
    expect(existsSync(join(workspaceRoot, "chat-1"))).toBe(false);
    // Bare mirror is shared across sessions — must survive session cleanup.
    expect(existsSync(gitMirrorManager.mirrorsRoot)).toBe(true);
  });

  it("aborts session creation when a gitRepo URL is unreachable (PRD D10)", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ftt-data-"));
    const workspaceRoot = join(dataDir, "workspaces", "agent-2");
    const gitMirrorManager: GitMirrorManager = createGitMirrorManager({
      dataDir,
      cloneTimeoutMs: 5_000,
    });

    const cache = buildCache([{ url: "/nonexistent/repo-does-not-exist.git" }]);
    await cache.refresh(AGENT_ID);

    const handler = createClaudeCodeHandler({
      workspaceRoot,
      agentConfigCache: cache,
      gitMirrorManager,
    });

    const ctx = buildSessionCtx("chat-fail", () => {});
    await expect(
      handler.start(
        {
          id: "msg-x",
          chatId: "chat-fail",
          senderId: "user",
          format: "text",
          content: "hi",
          metadata: null,
        },
        ctx,
      ),
    ).rejects.toThrow();
  });

  it("is a no-op when gitRepos is empty", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ftt-data-"));
    const workspaceRoot = join(dataDir, "workspaces", "agent-3");
    const gitMirrorManager: GitMirrorManager = createGitMirrorManager({ dataDir });

    const cache = buildCache([]);
    await cache.refresh(AGENT_ID);

    const handler = createClaudeCodeHandler({
      workspaceRoot,
      agentConfigCache: cache,
      gitMirrorManager,
    });

    const ctx = buildSessionCtx("chat-empty", () => {});
    await handler.start(
      {
        id: "msg-0",
        chatId: "chat-empty",
        senderId: "user",
        format: "text",
        content: "hi",
        metadata: null,
      },
      ctx,
    );

    // No mirror should have been created since no repos.
    if (existsSync(gitMirrorManager.mirrorsRoot)) {
      const { readdirSync } = await import("node:fs");
      expect(readdirSync(gitMirrorManager.mirrorsRoot)).toHaveLength(0);
    }

    await handler.shutdown();
  });
});
