import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeConfig } from "@first-tree/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Phase-E专项 e2e for the 2026-05-22 agent cwd redesign.
 *
 * Drives real `createClaudeCodeHandler.start()` / `.resume()` against a real
 * temp filesystem + real GitMirrorManager + fixture bare repo. The Claude
 * SDK is the ONLY mock — we capture the `query()` options so we can assert
 * the system-prompt block the handler actually sends.
 *
 * Covers the 7 invariants the proposal's §⑦ T1–T9 + this round's redesign
 * leave open after unit tests:
 *
 *   E1  Predeclared repos land at `<agentHome>/<localPath>` (TOP LEVEL),
 *       not under `worktrees/`.
 *   E2  `worktrees/` subdir is NOT pre-created by `start()` — reserved
 *       for the agent's on-demand worktrees.
 *   E3  Second chat on same agent skips bootstrap (sentinel guard) and
 *       reuses the source repo without re-creating it.
 *   E4  System prompt contains "Source Repositories" + "Creating Worktrees
 *       On Demand"; does NOT contain legacy "Predeclared worktrees".
 *   E5  Concurrent two-chat start mutex serialises filesystem writes —
 *       no race throws or missing checkouts.
 *   E6  `.agent/identity.json` carries agent-level stable fields only —
 *       no `chatId` / `chatContext`.
 *   E7  Legacy `<chatId>/` directories that pre-date the redesign are
 *       left untouched when a fresh session starts.
 */

const capturedSdkOptions: Array<{ options?: Record<string, unknown> }> = [];

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
    query: (args: { options?: Record<string, unknown> }) => {
      capturedSdkOptions.push({ options: args?.options });
      return fakeQuery;
    },
  };
});

import { createClaudeCodeHandler } from "../handlers/claude-code.js";
import { createAgentConfigCache } from "../runtime/agent-config-cache.js";
import { createGitMirrorManager, type GitMirrorManager } from "../runtime/git-mirror-manager.js";
import type { SessionContext } from "../runtime/handler.js";
import { INIT_COMPLETE_SENTINEL_REL } from "../runtime/workspace.js";
import { mockCtxPlumbing } from "./test-helpers.js";

const AGENT_ID = "019d9a97-90b0-716b-8317-a8c0be8430d7";

let workRoot: string;
let fixtureBareRepo: string;

beforeAll(() => {
  workRoot = mkdtempSync(join(tmpdir(), "ftt-cwd-redesign-"));
  const seed = join(workRoot, "seed");
  mkdirSync(seed, { recursive: true });
  execSync("git init -q -b main", { cwd: seed });
  execSync("git config user.email t@test.com && git config user.name test", { cwd: seed, shell: "/bin/bash" });
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

function buildSessionCtx(chatId: string): SessionContext {
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
    log: () => {},
    touch: () => {},
    setRuntimeState: () => {},
    emitEvent: () => {},
    ...mockCtxPlumbing({ sendMessage }, chatId),
  };
}

function makeMessage(chatId: string, id: string) {
  return {
    id,
    chatId,
    senderId: "user",
    format: "text" as const,
    content: "hello",
    metadata: null,
  };
}

describe("Phase E · agent cwd redesign — end-to-end invariants", () => {
  it("E1: predeclared repo materialises at <agentHome>/<localPath>/ (top-level)", async () => {
    capturedSdkOptions.length = 0;
    const dataDir = mkdtempSync(join(tmpdir(), "ftt-e1-"));
    const workspaceRoot = join(dataDir, "workspaces", "agent-1");
    const gitMirrorManager: GitMirrorManager = createGitMirrorManager({ dataDir, cloneTimeoutMs: 60_000 });

    const cache = buildCache([{ url: fixtureBareRepo, localPath: "repos/first-tree" }]);
    await cache.refresh(AGENT_ID);

    const handler = createClaudeCodeHandler({ workspaceRoot, agentConfigCache: cache, gitMirrorManager });
    const ctx = buildSessionCtx("chat-e1");
    await handler.start(makeMessage("chat-e1", "msg-1"), ctx);

    // Predeclared repo at TOP LEVEL — `<agentHome>/<localPath>/`.
    const topLevel = join(workspaceRoot, "repos", "first-tree");
    expect(existsSync(topLevel)).toBe(true);
    expect(existsSync(join(topLevel, "README.md"))).toBe(true);
    // A worktree-style checkout has a `.git` FILE (not directory).
    expect(existsSync(join(topLevel, ".git"))).toBe(true);

    await handler.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("E2: worktrees/ subdir is NOT pre-created by start()", async () => {
    capturedSdkOptions.length = 0;
    const dataDir = mkdtempSync(join(tmpdir(), "ftt-e2-"));
    const workspaceRoot = join(dataDir, "workspaces", "agent-1");
    const gitMirrorManager: GitMirrorManager = createGitMirrorManager({ dataDir, cloneTimeoutMs: 60_000 });

    const cache = buildCache([{ url: fixtureBareRepo, localPath: "repos/first-tree" }]);
    await cache.refresh(AGENT_ID);

    const handler = createClaudeCodeHandler({ workspaceRoot, agentConfigCache: cache, gitMirrorManager });
    await handler.start(makeMessage("chat-e2", "msg-1"), buildSessionCtx("chat-e2"));

    // `worktrees/` subdir is reserved for agent's on-demand worktrees only;
    // runtime must never pre-create it. Use both negation forms (the subdir
    // itself + the old-design-style path) to lock down regression risk.
    expect(existsSync(join(workspaceRoot, "worktrees"))).toBe(false);
    expect(existsSync(join(workspaceRoot, "worktrees", "repos", "first-tree"))).toBe(false);

    await handler.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("E3: second chat on same agent reuses checkout and skips bootstrap (sentinel guard)", async () => {
    capturedSdkOptions.length = 0;
    const dataDir = mkdtempSync(join(tmpdir(), "ftt-e3-"));
    const workspaceRoot = join(dataDir, "workspaces", "agent-1");
    const gitMirrorManager: GitMirrorManager = createGitMirrorManager({ dataDir, cloneTimeoutMs: 60_000 });

    const cache = buildCache([{ url: fixtureBareRepo, localPath: "repo-a" }]);
    await cache.refresh(AGENT_ID);

    // First chat — full bootstrap path.
    const h1 = createClaudeCodeHandler({ workspaceRoot, agentConfigCache: cache, gitMirrorManager });
    await h1.start(makeMessage("chat-A", "msg-A1"), buildSessionCtx("chat-A"));

    const sourceRepoPath = join(workspaceRoot, "repo-a");
    const sentinelPath = join(workspaceRoot, INIT_COMPLETE_SENTINEL_REL);
    expect(existsSync(sentinelPath)).toBe(true);
    expect(existsSync(sourceRepoPath)).toBe(true);

    // Capture repo `.git` pointer — if bootstrap is skipped on chat 2 the
    // worktree's mirror linkage must NOT be recreated.
    const repoGitDir1 = readFileSync(join(sourceRepoPath, ".git"), "utf-8");
    await h1.shutdown();

    // Second chat — different chatId, same workspaceRoot.
    const h2 = createClaudeCodeHandler({ workspaceRoot, agentConfigCache: cache, gitMirrorManager });
    await h2.start(makeMessage("chat-B", "msg-B1"), buildSessionCtx("chat-B"));

    // The source repo path AND its underlying .git pointer must survive
    // unchanged (sentinel-guarded bootstrap means createWorktree did NOT run
    // a second time).
    expect(existsSync(sourceRepoPath)).toBe(true);
    const repoGitDir2 = readFileSync(join(sourceRepoPath, ".git"), "utf-8");
    expect(repoGitDir2).toBe(repoGitDir1);
    // Sentinel re-written is fine (idempotent) — the body's `completedAt`
    // refreshes — but the file must still exist.
    expect(existsSync(sentinelPath)).toBe(true);

    await h2.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("E4: system prompt contains new redesign sections; no legacy 'Predeclared worktrees' wording", async () => {
    capturedSdkOptions.length = 0;
    const dataDir = mkdtempSync(join(tmpdir(), "ftt-e4-"));
    const workspaceRoot = join(dataDir, "workspaces", "agent-1");
    const gitMirrorManager: GitMirrorManager = createGitMirrorManager({ dataDir, cloneTimeoutMs: 60_000 });

    const cache = buildCache([{ url: fixtureBareRepo, localPath: "lib" }]);
    await cache.refresh(AGENT_ID);

    const handler = createClaudeCodeHandler({ workspaceRoot, agentConfigCache: cache, gitMirrorManager });
    await handler.start(makeMessage("chat-e4", "msg-e4"), buildSessionCtx("chat-e4"));

    expect(capturedSdkOptions.length).toBeGreaterThan(0);
    const lastOptions = capturedSdkOptions[capturedSdkOptions.length - 1]?.options;
    const systemPrompt = lastOptions?.systemPrompt as { append?: string } | undefined;
    expect(systemPrompt).toBeDefined();
    const append = systemPrompt?.append ?? "";

    // New redesign sections — must be present.
    expect(append).toContain("# Working Directory Convention");
    expect(append).toContain("## Source Repositories");
    expect(append).toContain("## Creating Worktrees On Demand");
    expect(append).toContain("git worktree add");
    expect(append).toContain("No worktrees are pre-created");

    // Top-level path of predeclared repo surfaces in prompt.
    expect(append).toContain(join(workspaceRoot, "lib"));

    // Legacy wording from the previous design MUST be gone.
    expect(append).not.toContain("Predeclared worktrees");
    // Negation: the repo path should NOT be presented under worktrees/.
    expect(append).not.toContain(`${workspaceRoot}/worktrees/lib`);

    await handler.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("E5: concurrent two-chat start on the same agent serialises via per-path mutex", async () => {
    capturedSdkOptions.length = 0;
    const dataDir = mkdtempSync(join(tmpdir(), "ftt-e5-"));
    const workspaceRoot = join(dataDir, "workspaces", "agent-1");
    const gitMirrorManager: GitMirrorManager = createGitMirrorManager({ dataDir, cloneTimeoutMs: 60_000 });

    const cache = buildCache([{ url: fixtureBareRepo, localPath: "shared-lib" }]);
    await cache.refresh(AGENT_ID);

    const h1 = createClaudeCodeHandler({ workspaceRoot, agentConfigCache: cache, gitMirrorManager });
    const h2 = createClaudeCodeHandler({ workspaceRoot, agentConfigCache: cache, gitMirrorManager });

    // Fire both starts in parallel; mutex must serialise the worktree-add.
    await Promise.all([
      h1.start(makeMessage("chat-X", "msg-X"), buildSessionCtx("chat-X")),
      h2.start(makeMessage("chat-Y", "msg-Y"), buildSessionCtx("chat-Y")),
    ]);

    // Both sessions land on the same shared source repo.
    const sourceRepoPath = join(workspaceRoot, "shared-lib");
    expect(existsSync(sourceRepoPath)).toBe(true);
    expect(existsSync(join(sourceRepoPath, ".git"))).toBe(true);
    expect(existsSync(join(sourceRepoPath, "README.md"))).toBe(true);

    // No worktrees/ subdir was pre-created — even with two concurrent starts
    // racing, neither went down the legacy path.
    expect(existsSync(join(workspaceRoot, "worktrees"))).toBe(false);

    await Promise.all([h1.shutdown(), h2.shutdown()]);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("E6: identity.json carries agent-level stable fields only (no chatId / chatContext)", async () => {
    capturedSdkOptions.length = 0;
    const dataDir = mkdtempSync(join(tmpdir(), "ftt-e6-"));
    const workspaceRoot = join(dataDir, "workspaces", "agent-1");
    const gitMirrorManager: GitMirrorManager = createGitMirrorManager({ dataDir });

    const cache = buildCache([]);
    await cache.refresh(AGENT_ID);

    const handler = createClaudeCodeHandler({ workspaceRoot, agentConfigCache: cache, gitMirrorManager });
    await handler.start(makeMessage("chat-e6", "msg-e6"), buildSessionCtx("chat-e6"));

    const identityPath = join(workspaceRoot, ".agent", "identity.json");
    expect(existsSync(identityPath)).toBe(true);
    const identity = JSON.parse(readFileSync(identityPath, "utf-8"));

    expect(identity.agentId).toBe(AGENT_ID);
    expect(identity.serverUrl).toBe("http://test");
    expect(identity.displayName).toBe("test");

    // Per the redesign — chat-scoped fields MUST be absent from disk.
    expect("chatId" in identity).toBe(false);
    expect("chatContext" in identity).toBe(false);

    await handler.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("E7: legacy <chatId>/ directories pre-dating the redesign survive a fresh session start", async () => {
    capturedSdkOptions.length = 0;
    const dataDir = mkdtempSync(join(tmpdir(), "ftt-e7-"));
    const workspaceRoot = join(dataDir, "workspaces", "agent-1");
    const gitMirrorManager: GitMirrorManager = createGitMirrorManager({ dataDir });

    // Simulate a v1.x-era residual directory inside the agent home.
    const legacyChatDir = join(workspaceRoot, "legacy-chat-id-019d");
    mkdirSync(join(legacyChatDir, ".agent"), { recursive: true });
    writeFileSync(join(legacyChatDir, "CLAUDE.md"), "legacy content", "utf-8");
    writeFileSync(join(legacyChatDir, ".agent", "identity.json"), "{}", "utf-8");

    const cache = buildCache([]);
    await cache.refresh(AGENT_ID);

    const handler = createClaudeCodeHandler({ workspaceRoot, agentConfigCache: cache, gitMirrorManager });
    await handler.start(makeMessage("chat-e7", "msg-e7"), buildSessionCtx("chat-e7"));

    // Fresh session creates agent home + new layout.
    expect(existsSync(join(workspaceRoot, ".agent", "identity.json"))).toBe(true);

    // Legacy dir survives byte-identical — that's the migration story.
    expect(existsSync(legacyChatDir)).toBe(true);
    expect(readFileSync(join(legacyChatDir, "CLAUDE.md"), "utf-8")).toBe("legacy content");
    expect(readFileSync(join(legacyChatDir, ".agent", "identity.json"), "utf-8")).toBe("{}");

    await handler.shutdown();
    // Legacy must STILL survive after shutdown (no rm of cwd or sibling).
    expect(existsSync(legacyChatDir)).toBe(true);
    rmSync(dataDir, { recursive: true, force: true });
  });
});
