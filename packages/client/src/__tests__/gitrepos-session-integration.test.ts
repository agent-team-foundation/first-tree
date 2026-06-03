import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeConfig } from "@first-tree/shared";
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
 * consumed it from the handler — operators could set `gitRepos` on the server
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
          resourceSkills: [],
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
      type: "agent",
      visibility: "organization",
      delegateMention: null,
      metadata: {},
    },
    sdk: { serverUrl: "http://test", sendMessage } as unknown as SessionContext["sdk"],
    chatId,
    log,
    touch: () => {},
    setRuntimeState: () => {},
    emitEvent: () => {},
    ...mockCtxPlumbing({ sendMessage }, chatId),
  };
}

describe("claude-code handler gitRepos wiring (PRD §5.1.5)", () => {
  it("materialises a source repo at cwd/<localPath>/ (top-level) and writes a valid HEAD", async () => {
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

    // Per the 2026-05-22 redesign: cwd is the agent home (workspaceRoot),
    // predeclared source repos land at TOP LEVEL `<agentHome>/<localPath>/`
    // (no `worktrees/` prefix — that subdir is reserved for the agent's
    // own on-demand worktrees).
    const sourceRepoPath = join(workspaceRoot, "repos", "first-tree");
    expect(existsSync(sourceRepoPath)).toBe(true);
    expect(existsSync(join(sourceRepoPath, "README.md"))).toBe(true);
    expect(readFileSync(join(sourceRepoPath, "README.md"), "utf-8")).toContain("fixture repo");
    // A worktree-style checkout has a .git FILE (not directory) pointing at the bare mirror.
    expect(existsSync(join(sourceRepoPath, ".git"))).toBe(true);
    // The `worktrees/` subdir is NOT pre-created — it's the agent's on-demand
    // space, populated only when the agent runs `git worktree add` itself.
    expect(existsSync(join(workspaceRoot, "worktrees"))).toBe(false);

    // Per agent-session-cwd-redesign: predeclared source repos + the agent
    // home are persistent across session shutdowns so the next chat finds
    // them ready. shutdown() does NOT remove either.
    await handler.shutdown();
    expect(existsSync(sourceRepoPath)).toBe(true);
    expect(existsSync(workspaceRoot)).toBe(true);
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
