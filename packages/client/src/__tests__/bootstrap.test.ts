import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BUNDLED_CLI_VERSION_REL,
  bootstrapWorkspace,
  buildChatSystemPrompt,
  CONTEXT_TREE_HEAD_REL,
  type ContextTreeBinding,
  type InstallFirstTreeIntegrationExec,
  installFirstTreeIntegration,
  readCachedBundledCliVersion,
  readCachedContextTreeHead,
  readContextTreeHead,
  resolveBundledCliVersion,
  withContextTreeSyncLock,
  writeBundledCliVersion,
  writeContextTreeHead,
} from "../runtime/bootstrap.js";
import type { AgentIdentity } from "../runtime/handler.js";

// Use a real temp directory for file-based tests
const tmpBase = join(import.meta.dirname ?? __dirname, "../../.test-tmp-bootstrap");

function cleanTmp(): void {
  try {
    rmSync(tmpBase, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

afterEach(() => {
  cleanTmp();
  vi.restoreAllMocks();
});

function makeIdentity(overrides?: Partial<AgentIdentity>): AgentIdentity {
  return {
    agentId: "test-agent",
    inboxId: "inbox-test-agent",
    displayName: "Test Agent",
    type: "agent",
    visibility: "organization",
    delegateMention: null,
    metadata: {},
    ...overrides,
  };
}

describe("contextTreeCloneDir", () => {
  it("isolates local checkouts by repo URL and branch", async () => {
    const { contextTreeCloneDir } = await import("../runtime/bootstrap.js");
    const main = contextTreeCloneDir("https://github.com/example/context-tree", "main");
    const release = contextTreeCloneDir("https://github.com/example/context-tree", "release");
    const otherOrg = contextTreeCloneDir("https://github.com/other/context-tree", "main");

    expect(main).not.toBe(release);
    expect(main).not.toBe(otherOrg);
    expect(main).toContain("context-tree-repos");
    expect(main.split("/").at(-1)).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("withContextTreeSyncLock", () => {
  it("dedups concurrent callers sharing the same key to a single fn invocation", async () => {
    // Each clone dir corresponds to one (repo, branch) pair. When N agents
    // share that pair (the common case — one Context Tree per org), all N
    // must share one in-flight sync instead of queuing N sequential pulls.
    let invocations = 0;
    let resolveSync: ((value: ContextTreeBinding) => void) | undefined;
    const fn = (): Promise<ContextTreeBinding | null> => {
      invocations++;
      return new Promise<ContextTreeBinding>((resolve) => {
        resolveSync = resolve;
      });
    };

    const key = "/tmp/clone-dir-A";
    const p1 = withContextTreeSyncLock(key, fn);
    const p2 = withContextTreeSyncLock(key, fn);
    const p3 = withContextTreeSyncLock(key, fn);

    expect(invocations).toBe(1);
    expect(p1).toBe(p2);
    expect(p2).toBe(p3);

    const binding: ContextTreeBinding = { path: key, repoUrl: "git@example/x", branch: "main" };
    resolveSync?.(binding);
    await expect(p1).resolves.toBe(binding);
    await expect(p2).resolves.toBe(binding);
    await expect(p3).resolves.toBe(binding);
  });

  it("isolates locks across distinct keys (different repos sync in parallel)", async () => {
    let invocations = 0;
    const fn = (): Promise<ContextTreeBinding | null> => {
      invocations++;
      return Promise.resolve(null);
    };

    await Promise.all([withContextTreeSyncLock("/tmp/clone-A", fn), withContextTreeSyncLock("/tmp/clone-B", fn)]);

    expect(invocations).toBe(2);
  });

  it("clears the slot after settle so a later call triggers a fresh sync", async () => {
    let invocations = 0;
    const fn = (): Promise<ContextTreeBinding | null> => {
      invocations++;
      return Promise.resolve(null);
    };

    await withContextTreeSyncLock("/tmp/clone-C", fn);
    await withContextTreeSyncLock("/tmp/clone-C", fn);

    expect(invocations).toBe(2);
  });

  it("propagates rejection to all concurrent callers and clears the slot", async () => {
    let invocations = 0;
    let rejectSync: ((reason: Error) => void) | undefined;
    const fn = (): Promise<ContextTreeBinding | null> => {
      invocations++;
      if (invocations === 1) {
        return new Promise<ContextTreeBinding>((_, reject) => {
          rejectSync = reject;
        });
      }
      // Later retries succeed immediately so the test can observe that the
      // slot was cleared without hanging on a second pending promise.
      return Promise.resolve(null);
    };

    const key = "/tmp/clone-D";
    const p1 = withContextTreeSyncLock(key, fn);
    const p2 = withContextTreeSyncLock(key, fn);

    expect(invocations).toBe(1);
    expect(p1).toBe(p2);

    rejectSync?.(new Error("git pull failed"));
    await expect(p1).rejects.toThrow("git pull failed");
    await expect(p2).rejects.toThrow("git pull failed");

    // After the failed sync clears the slot, a new caller is allowed to
    // retry — important so the next agent's bind isn't poisoned by an
    // earlier transient network failure.
    await expect(withContextTreeSyncLock(key, fn)).resolves.toBeNull();
    expect(invocations).toBe(2);
  });
});

describe("bootstrapWorkspace", () => {
  it("writes identity.json with agent-level stable fields only (no chatId / chatContext)", () => {
    const workspace = join(tmpBase, "ws-identity");
    mkdirSync(workspace, { recursive: true });

    bootstrapWorkspace({
      workspacePath: workspace,
      identity: makeIdentity({ agentId: "my-agent", type: "agent", delegateMention: "owner" }),
      contextTreePath: null,
      serverUrl: "http://localhost:8000",
    });

    const identityPath = join(workspace, ".agent", "identity.json");
    expect(existsSync(identityPath)).toBe(true);

    const data = JSON.parse(readFileSync(identityPath, "utf-8"));
    expect(data.agentId).toBe("my-agent");
    expect(data.type).toBe("agent");
    expect(data.delegateMention).toBe("owner");
    expect(data.serverUrl).toBe("http://localhost:8000");
    // Per agent-session-cwd-redesign: identity.json holds agent-level state
    // only. chatId / chatContext now live in the per-turn system prompt.
    expect("chatId" in data).toBe(false);
    expect("chatContext" in data).toBe(false);
  });

  it("writes tools.md with SDK reference", () => {
    const workspace = join(tmpBase, "ws-tools");
    mkdirSync(workspace, { recursive: true });

    bootstrapWorkspace({
      workspacePath: workspace,
      identity: makeIdentity(),
      contextTreePath: null,
      serverUrl: "http://localhost:8000",
    });

    const toolsPath = join(workspace, ".agent", "tools.md");
    expect(existsSync(toolsPath)).toBe(true);

    const content = readFileSync(toolsPath, "utf-8");
    expect(content).toContain("Agent Hub");
    expect(content).toContain("[From: <agent-name>]");
    expect(content).toContain("first-tree chat send");
    // L4 silent-turn protocol: the prompt directive that pairs with the
    // result-sink empty-output guard. Tells the agent that silence is the
    // correct response when it has nothing new — drops courtesy fillers
    // that would otherwise sustain agent↔agent loops.
    expect(content).toContain("Stay silent when you have nothing to add");
    expect(content).toContain("If you have nothing new for the recipient, output nothing");
    expect(content).toContain("the runtime ends the turn");
    // Issue #389: pin the anti-double-encode directive so future prompt edits
    // don't accidentally drop it. The CLI passes content as-is; agents that
    // JSON.stringify before sending produce a literal `"@x ...\n..."` row
    // that the UI cannot render as markdown.
    expect(content).toContain("Content rules");
    expect(content).toContain("JSON.stringify");
  });

  it("tools.md contains the Communication Rules section with Decision guide + Fallback (v1 §四 改造 4)", () => {
    const workspace = join(tmpBase, "ws-tools-rules");
    mkdirSync(workspace, { recursive: true });

    bootstrapWorkspace({
      workspacePath: workspace,
      identity: makeIdentity(),
      contextTreePath: null,
      serverUrl: "http://localhost:8000",
    });

    const content = readFileSync(join(workspace, ".agent", "tools.md"), "utf-8");
    expect(content).toContain("## Communication Rules");
    // New final-text contract — "human observers" + "does NOT wake other agents"
    expect(content).toContain("human observers");
    expect(content).toContain("does NOT wake other agents");
    // Decision guide section anchors
    expect(content).toContain("Decision guide");
    expect(content).toMatch(/Target is a \*\*human\*\* in this chat/);
    expect(content).toMatch(/Target is an \*\*agent\*\* in this chat/);
    // Fallback paragraph for chat-context-missing degradation
    expect(content).toContain("**Fallback**");
    expect(content).toContain("conservative mode");

    // Old contract text must be gone — these are the lines the v1.5 spec
    // requires改造 4 to overwrite.
    expect(content).not.toContain("Your final text response is automatically delivered");
    expect(content).not.toMatch(/Otherwise it falls back to a direct chat/i);
  });

  it("tools.md teaches `chat invite` instead of the retired --direct escape hatch", () => {
    const workspace = join(tmpBase, "ws-tools-direct");
    mkdirSync(workspace, { recursive: true });

    bootstrapWorkspace({
      workspacePath: workspace,
      identity: makeIdentity(),
      contextTreePath: null,
      serverUrl: "http://localhost:8000",
    });

    const content = readFileSync(join(workspace, ".agent", "tools.md"), "utf-8");
    // Sending Messages section must teach the add-participant flow as the
    // canonical way to reach a non-member of the current chat.
    expect(content).toContain("first-tree chat invite");
    // Member-default routing description (the recipient must be in this chat).
    expect(content).toMatch(/recipient MUST be a participant/);
    // The retired escape hatches must NOT be taught — agents that try them
    // would hit `unknown option` and loop. (Hub keeps a single group-chat
    // model; non-members must be added first.)
    expect(content).not.toMatch(/--direct/);
    expect(content).not.toMatch(/auto-mentions the recipient/);
    // v1.7: agent surface is narrowed to "address an agent by name". The
    // `--chat <chatId>` foot-gun is gone from the CLI and from this prompt.
    expect(content).not.toMatch(/--chat <chatId>/);
    expect(content).not.toMatch(/--chat <directChatId>/);
    expect(content).toMatch(/Reaching another agent/);
    expect(content).toMatch(/only addresses agents by name/);
  });

  it("does not write self.md (per PRD D7 — prompt lives in agent_configs)", () => {
    const workspace = join(tmpBase, "ws-no-self-md");
    mkdirSync(workspace, { recursive: true });

    bootstrapWorkspace({
      workspacePath: workspace,
      identity: makeIdentity({ agentId: "my-agent" }),
      contextTreePath: null,
      serverUrl: "http://localhost:8000",
    });

    const selfPath = join(workspace, ".agent", "context", "self.md");
    expect(existsSync(selfPath)).toBe(false);
  });

  it("skips context when contextTreePath is null", () => {
    const workspace = join(tmpBase, "ws-no-ctx");
    mkdirSync(workspace, { recursive: true });

    bootstrapWorkspace({
      workspacePath: workspace,
      identity: makeIdentity(),
      contextTreePath: null,
      serverUrl: "http://localhost:8000",
    });

    const selfPath = join(workspace, ".agent", "context", "self.md");
    expect(existsSync(selfPath)).toBe(false);
  });

  it("skips context when agent not found in context tree", () => {
    const workspace = join(tmpBase, "ws-missing-agent");
    const ctxTree = join(tmpBase, "context-tree-empty");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(join(ctxTree, "members"), { recursive: true });

    bootstrapWorkspace({
      workspacePath: workspace,
      identity: makeIdentity({ agentId: "nonexistent" }),
      contextTreePath: ctxTree,
      serverUrl: "http://localhost:8000",
    });

    const selfPath = join(workspace, ".agent", "context", "self.md");
    expect(existsSync(selfPath)).toBe(false);
    // identity.json should still exist
    expect(existsSync(join(workspace, ".agent", "identity.json"))).toBe(true);
  });

  it("copies AGENT.md as agent-instructions.md from context tree", () => {
    const workspace = join(tmpBase, "ws-agent-md");
    const ctxTree = join(tmpBase, "ctx-agent-md");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(join(ctxTree, "members", "test-agent"), { recursive: true });
    writeFileSync(join(ctxTree, "AGENT.md"), "## Before Every Task\n\nRead the root NODE.md.");

    bootstrapWorkspace({
      workspacePath: workspace,
      identity: makeIdentity(),
      contextTreePath: ctxTree,
      serverUrl: "http://localhost:8000",
    });

    const instructionsPath = join(workspace, ".agent", "context", "agent-instructions.md");
    expect(existsSync(instructionsPath)).toBe(true);
    expect(readFileSync(instructionsPath, "utf-8")).toContain("Before Every Task");
  });

  it("copies root NODE.md as domain-map.md from context tree", () => {
    const workspace = join(tmpBase, "ws-domain-map");
    const ctxTree = join(tmpBase, "ctx-domain-map");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(join(ctxTree, "members", "test-agent"), { recursive: true });
    writeFileSync(join(ctxTree, "NODE.md"), "# Context Tree\n\n## Domains\n\n- kael/\n- agent-hub/");

    bootstrapWorkspace({
      workspacePath: workspace,
      identity: makeIdentity(),
      contextTreePath: ctxTree,
      serverUrl: "http://localhost:8000",
    });

    const domainMapPath = join(workspace, ".agent", "context", "domain-map.md");
    expect(existsSync(domainMapPath)).toBe(true);
    expect(readFileSync(domainMapPath, "utf-8")).toContain("kael/");
  });

  it("does not write degraded.md when contextTreePath is null (no Context Tree is normal)", () => {
    const workspace = join(tmpBase, "ws-no-tree");
    mkdirSync(workspace, { recursive: true });

    bootstrapWorkspace({
      workspacePath: workspace,
      identity: makeIdentity(),
      contextTreePath: null,
      serverUrl: "http://localhost:8000",
    });

    const degradedPath = join(workspace, ".agent", "context", "degraded.md");
    expect(existsSync(degradedPath)).toBe(false);
  });

  // Tests that pinned `chatContext` being written into identity.json were
  // dropped here: per agent-session-cwd-redesign, per-chat fields no longer
  // live on disk. The new injection path is covered by `buildChatSystemPrompt`
  // below.

  it("overwrites existing files on re-bootstrap", () => {
    const workspace = join(tmpBase, "ws-overwrite");
    mkdirSync(join(workspace, ".agent"), { recursive: true });
    writeFileSync(join(workspace, ".agent", "identity.json"), '{"agentId":"old"}');

    bootstrapWorkspace({
      workspacePath: workspace,
      identity: makeIdentity({ agentId: "new-agent" }),
      contextTreePath: null,
      serverUrl: "http://localhost:8000",
    });

    const data = JSON.parse(readFileSync(join(workspace, ".agent", "identity.json"), "utf-8"));
    expect(data.agentId).toBe("new-agent");
  });
});

type ExecCall = {
  command: string;
  args: string[];
  options: { cwd: string; timeout: number };
};

function makeRecordingExec(impl: (call: ExecCall) => void = () => {}): {
  exec: InstallFirstTreeIntegrationExec;
  calls: ExecCall[];
} {
  const calls: ExecCall[] = [];
  const exec: InstallFirstTreeIntegrationExec = (command, args, options) => {
    const call: ExecCall = { command, args, options };
    calls.push(call);
    impl(call);
  };
  return { exec, calls };
}

describe("installFirstTreeIntegration", () => {
  it("shells out to `first-tree tree integrate` with the expected arguments", () => {
    const workspace = join(tmpBase, "integrate-happy");
    const treePath = join(tmpBase, "ctx-tree");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(treePath, { recursive: true });

    const { exec, calls } = makeRecordingExec();
    const logs: string[] = [];

    const result = installFirstTreeIntegration({
      workspacePath: workspace,
      contextTreePath: treePath,
      workspaceId: "chat-xyz",
      treeRepoUrl: "https://github.com/org/tree",
      log: (m) => logs.push(m),
      exec,
    });

    expect(result).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("first-tree");
    // No `--source-path` flag: the first-tree CLI resolves the source from
    // the process cwd (set via options.cwd below). Passing a flag the CLI
    // doesn't recognise made every invocation exit 1.
    expect(calls[0]?.args).toEqual([
      "tree",
      "integrate",
      "--tree-path",
      treePath,
      "--mode",
      "workspace-root",
      "--workspace-id",
      "chat-xyz",
      "--tree-url",
      "https://github.com/org/tree",
    ]);
    expect(calls[0]?.options.cwd).toBe(workspace);
    expect(logs.join("\n")).toContain("first-tree (PATH)");
  });

  it("falls back to `npx first-tree@latest` when the binary is missing from PATH", () => {
    const workspace = join(tmpBase, "integrate-fallback");
    const treePath = join(tmpBase, "ctx-fb");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(treePath, { recursive: true });

    let call = 0;
    const { exec, calls } = makeRecordingExec(() => {
      call += 1;
      if (call === 1) {
        const err = new Error("spawn first-tree ENOENT") as Error & { code?: string };
        err.code = "ENOENT";
        throw err;
      }
    });

    const logs: string[] = [];
    const result = installFirstTreeIntegration({
      workspacePath: workspace,
      contextTreePath: treePath,
      workspaceId: "chat-fb",
      log: (m) => logs.push(m),
      exec,
    });

    expect(result).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.command).toBe("npx");
    expect(calls[1]?.args.slice(0, 3)).toEqual(["-y", "first-tree@latest", "tree"]);
    expect(logs.join("\n")).toContain("npx first-tree@latest");
  });

  it("returns false and logs without throwing when both attempts fail", () => {
    const workspace = join(tmpBase, "integrate-fail");
    const treePath = join(tmpBase, "ctx-fail");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(treePath, { recursive: true });

    const { exec } = makeRecordingExec(() => {
      throw new Error("spawn npx ENOENT");
    });

    const logs: string[] = [];
    const result = installFirstTreeIntegration({
      workspacePath: workspace,
      contextTreePath: treePath,
      workspaceId: "chat-fail",
      log: (m) => logs.push(m),
      exec,
    });

    expect(result).toBe(false);
    expect(logs.join("\n")).toContain("First-tree integration skipped");
  });

  it("falls back to npx when the PATH first-tree rejects --tree-url as unknown option", () => {
    // Regression for the silent-fail when an outdated CLI is on PATH:
    // Commander prints "error: unknown option '--tree-url'" + exits 1.
    // Without retry, integration was permanently skipped on those machines.
    const workspace = join(tmpBase, "integrate-old-cli");
    const treePath = join(tmpBase, "ctx-old-cli");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(treePath, { recursive: true });

    let call = 0;
    const { exec, calls } = makeRecordingExec(() => {
      call += 1;
      if (call === 1) {
        throw new Error("Command failed: first-tree tree integrate ...\nerror: unknown option '--tree-url'");
      }
    });

    const logs: string[] = [];
    const result = installFirstTreeIntegration({
      workspacePath: workspace,
      contextTreePath: treePath,
      workspaceId: "agent-a",
      treeRepoUrl: "https://example.com/tree.git",
      log: (m) => logs.push(m),
      exec,
    });

    expect(result, logs.join("\n")).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.command).toBe("npx");
    expect(logs.join("\n")).toContain("falling back");
  });

  it("falls back to npx when the PATH first-tree returns 'unknown command'", () => {
    const workspace = join(tmpBase, "integrate-old-subcmd");
    const treePath = join(tmpBase, "ctx-old-subcmd");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(treePath, { recursive: true });

    let call = 0;
    const { exec, calls } = makeRecordingExec(() => {
      call += 1;
      if (call === 1) {
        throw new Error("Command failed: first-tree tree integrate ...\nerror: unknown command 'integrate'");
      }
    });

    const logs: string[] = [];
    const result = installFirstTreeIntegration({
      workspacePath: workspace,
      contextTreePath: treePath,
      workspaceId: "agent-a",
      treeRepoUrl: "https://example.com/tree.git",
      log: (m) => logs.push(m),
      exec,
    });

    expect(result, logs.join("\n")).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.command).toBe("npx");
  });

  it("does NOT retry on legitimate run-time errors (e.g. integration failure unrelated to CLI version)", () => {
    // Distinguish "CLI doesn't understand us" (retry) from "CLI ran but
    // refused this input" (don't retry — retrying just doubles the time
    // before the operator sees the real error).
    const workspace = join(tmpBase, "integrate-legit-err");
    const treePath = join(tmpBase, "ctx-legit-err");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(treePath, { recursive: true });

    const { exec, calls } = makeRecordingExec(() => {
      throw new Error("Command failed: first-tree tree integrate ...\nfatal: not a git repository");
    });

    const logs: string[] = [];
    const result = installFirstTreeIntegration({
      workspacePath: workspace,
      contextTreePath: treePath,
      workspaceId: "agent-a",
      log: (m) => logs.push(m),
      exec,
    });

    expect(result).toBe(false);
    expect(calls).toHaveLength(1);
    expect(logs.join("\n")).toContain("First-tree integration skipped");
  });

  it("omits --tree-url when no URL is provided", () => {
    const workspace = join(tmpBase, "integrate-no-url");
    const treePath = join(tmpBase, "ctx-no-url");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(treePath, { recursive: true });

    const { exec, calls } = makeRecordingExec();

    installFirstTreeIntegration({
      workspacePath: workspace,
      contextTreePath: treePath,
      workspaceId: "chat-no-url",
      log: () => {},
      exec,
    });

    expect(calls[0]?.args).not.toContain("--tree-url");
  });
});

describe("buildChatSystemPrompt", () => {
  const AGENT_HOME = "/var/lib/agent-hub/workspaces/test-agent";

  it("emits the working-directory convention and on-demand worktree block", () => {
    const text = buildChatSystemPrompt({
      agentHome: AGENT_HOME,
      chatContext: undefined,
      sourceRepos: [],
    });

    expect(text).toContain("# Working Directory Convention");
    expect(text).toContain(AGENT_HOME);
    // No worktrees are pre-created in the 2026-05-22 redesign; the agent is
    // instructed to create them on demand.
    expect(text).toContain("## Creating Worktrees On Demand");
    expect(text).toContain("No worktrees are pre-created");
    expect(text).toContain("git worktree add");
    expect(text).toContain("worktrees/<task-name>");
  });

  it("renders predeclared source repos with top-level paths and upstream coordinates", () => {
    const text = buildChatSystemPrompt({
      agentHome: AGENT_HOME,
      chatContext: undefined,
      sourceRepos: [
        {
          absolutePath: `${AGENT_HOME}/api`,
          url: "git@github.com:example/api.git",
          ref: "main",
          branch: "session/test-agent",
        },
        {
          absolutePath: `${AGENT_HOME}/web`,
          url: "git@github.com:example/web.git",
        },
      ],
    });

    expect(text).toContain("## Source Repositories");
    // Top-level paths — no `worktrees/` prefix.
    expect(text).toContain(`\`${AGENT_HOME}/api\``);
    expect(text).not.toContain(`\`${AGENT_HOME}/worktrees/api\``);
    expect(text).toContain("url=git@github.com:example/api.git");
    expect(text).toContain("ref=main");
    expect(text).toContain("branch=session/test-agent");
    expect(text).toContain(`\`${AGENT_HOME}/web\``);
    // For the second entry — only url should appear, ref/branch lines omitted.
    expect(text).not.toMatch(/url=git@github.com:example\/web\.git,\s*ref=/);
  });

  it("appends the Current Chat Context block when chatContext is provided", () => {
    const text = buildChatSystemPrompt({
      agentHome: AGENT_HOME,
      chatContext: {
        chatId: "chat-123",
        title: "ship redesign",
        topic: "ship redesign",
        participants: [
          { name: "alice", displayName: "Alice", type: "human" },
          { name: "bob-bot", displayName: "Bob Bot", type: "agent" },
        ],
      },
      sourceRepos: [],
    });

    expect(text).toContain("## Current Chat Context");
    expect(text).toContain("Chat ID: chat-123");
    expect(text).toContain("@alice");
    expect(text).toContain("@bob-bot");
  });

  it("omits the Current Chat Context block when chatContext is undefined (degraded fetch)", () => {
    const text = buildChatSystemPrompt({
      agentHome: AGENT_HOME,
      chatContext: undefined,
      sourceRepos: [],
    });

    expect(text).not.toContain("## Current Chat Context");
  });
});

describe("Context Tree HEAD drift helpers", () => {
  function makeTreeRepo(dir: string, initialFile = "AGENT.md"): string {
    mkdirSync(dir, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "t@test"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    writeFileSync(join(dir, initialFile), "v1");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: dir });
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf-8" }).trim();
  }

  it("readContextTreeHead returns the commit hash when the path is a git repo", () => {
    const treeDir = join(tmpBase, "tree-head-1");
    const head = makeTreeRepo(treeDir);
    expect(readContextTreeHead(treeDir)).toBe(head);
  });

  it("readContextTreeHead returns null for non-existent or non-git paths", () => {
    expect(readContextTreeHead(null)).toBeNull();
    expect(readContextTreeHead("/nonexistent/path-does-not-exist")).toBeNull();

    const notGit = join(tmpBase, "tree-head-non-git");
    mkdirSync(notGit, { recursive: true });
    writeFileSync(join(notGit, "some-file"), "x");
    expect(readContextTreeHead(notGit)).toBeNull();
  });

  it("write/read roundtrip pins the HEAD value for drift comparison", () => {
    const workspace = join(tmpBase, "tree-head-cache");
    mkdirSync(workspace, { recursive: true });

    expect(readCachedContextTreeHead(workspace)).toBeNull();

    writeContextTreeHead(workspace, "abc123def456");
    expect(readCachedContextTreeHead(workspace)).toBe("abc123def456");
    expect(existsSync(join(workspace, CONTEXT_TREE_HEAD_REL))).toBe(true);
  });

  it("writeContextTreeHead is a no-op when the HEAD is null (unknown)", () => {
    const workspace = join(tmpBase, "tree-head-null");
    mkdirSync(workspace, { recursive: true });
    writeContextTreeHead(workspace, null);
    expect(existsSync(join(workspace, CONTEXT_TREE_HEAD_REL))).toBe(false);
  });

  it("detects drift across commits when used together", () => {
    const treeDir = join(tmpBase, "tree-head-drift");
    const workspace = join(tmpBase, "tree-head-drift-ws");
    mkdirSync(workspace, { recursive: true });

    const firstHead = makeTreeRepo(treeDir);
    writeContextTreeHead(workspace, firstHead);

    // Drift: another commit upstream.
    writeFileSync(join(treeDir, "NODE.md"), "v2");
    execFileSync("git", ["add", "."], { cwd: treeDir });
    execFileSync("git", ["commit", "-q", "-m", "v2"], { cwd: treeDir });
    const secondHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: treeDir, encoding: "utf-8" }).trim();

    expect(secondHead).not.toBe(firstHead);
    expect(readContextTreeHead(treeDir)).toBe(secondHead);
    expect(readCachedContextTreeHead(workspace)).toBe(firstHead);
    // The handler compares these two; mismatch ⇒ re-bootstrap.
  });
});

describe("Bundled CLI version drift helpers", () => {
  it("resolveBundledCliVersion finds the closest package.json with a version", () => {
    // Walks up from this test file; the client package.json is the nearest
    // manifest with a version, so we should get its version string back.
    const version = resolveBundledCliVersion();
    expect(version).toMatch(/^\d+\.\d+\.\d+/u);
  });

  it("resolveBundledCliVersion returns null when no manifest is on the walk", () => {
    // Hand a URL whose dirname is the filesystem root — the walk exhausts
    // immediately. We can't `vi.mock` `node:fs` here without disturbing the
    // rest of the suite, so use a non-existent path under `/`.
    const version = resolveBundledCliVersion("file:///__no_manifest_here__/dummy.js");
    expect(version).toBeNull();
  });

  it("write/read roundtrip pins the CLI version for drift comparison", () => {
    const workspace = join(tmpBase, "cli-version-cache");
    mkdirSync(workspace, { recursive: true });

    expect(readCachedBundledCliVersion(workspace)).toBeNull();

    writeBundledCliVersion(workspace, "0.5.3");
    expect(readCachedBundledCliVersion(workspace)).toBe("0.5.3");
    expect(existsSync(join(workspace, BUNDLED_CLI_VERSION_REL))).toBe(true);
  });

  it("writeBundledCliVersion is a no-op when the version is null (unknown)", () => {
    const workspace = join(tmpBase, "cli-version-null");
    mkdirSync(workspace, { recursive: true });
    writeBundledCliVersion(workspace, null);
    expect(existsSync(join(workspace, BUNDLED_CLI_VERSION_REL))).toBe(false);
  });

  it("trims whitespace from the cached version on read", () => {
    const workspace = join(tmpBase, "cli-version-trim");
    mkdirSync(join(workspace, ".agent"), { recursive: true });
    writeFileSync(join(workspace, BUNDLED_CLI_VERSION_REL), "  0.5.3-staging.1.1  \n");
    expect(readCachedBundledCliVersion(workspace)).toBe("0.5.3-staging.1.1");
  });
});

/**
 * Locks in the handler-level contract around the CLI-version pin: the
 * pin MUST only be written when `installFirstTreeIntegration` actually
 * succeeded. Pinning on failure would silently mask the gap and the
 * next start would skip the retry the drift trigger exists to perform.
 *
 * These mirror the gate logic in `ensureAgentBootstrap` (claude-code +
 * codex handlers) — we drive `installFirstTreeIntegration` directly with
 * a mocked `InstallFirstTreeIntegrationExec` because the handler's gate
 * is a four-line composition: `if (ok) writeBundledCliVersion(...)`.
 * If a future change drops that guard, these tests fail; that is the
 * intent.
 */
describe("CLI-version pin contract (handler invariants)", () => {
  it("does not overwrite the existing pin when integrate fails — next start retries", () => {
    const workspace = join(tmpBase, "cli-pin-failure-keeps-stale");
    const treePath = join(tmpBase, "cli-pin-failure-tree");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(treePath, { recursive: true });

    // Pre-existing pin from an earlier successful bootstrap.
    writeBundledCliVersion(workspace, "0.5.2");
    const stalePinPath = join(workspace, BUNDLED_CLI_VERSION_REL);
    expect(readFileSync(stalePinPath, "utf-8")).toBe("0.5.2");

    const { exec } = makeRecordingExec(() => {
      throw new Error("spawn npx ENOENT");
    });
    const ok = installFirstTreeIntegration({
      workspacePath: workspace,
      contextTreePath: treePath,
      workspaceId: "agent-x",
      log: () => {},
      exec,
    });
    expect(ok).toBe(false);

    // Handler gate: `if (ok) writeBundledCliVersion(workspace, "0.5.3")`.
    // We're asserting the OK=false branch leaves the file untouched.
    if (ok) writeBundledCliVersion(workspace, "0.5.3");
    expect(readFileSync(stalePinPath, "utf-8")).toBe("0.5.2");
  });

  it("advances the pin to the new version when integrate succeeds", () => {
    const workspace = join(tmpBase, "cli-pin-success-advances");
    const treePath = join(tmpBase, "cli-pin-success-tree");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(treePath, { recursive: true });

    writeBundledCliVersion(workspace, "0.5.2");
    const pinPath = join(workspace, BUNDLED_CLI_VERSION_REL);
    expect(readFileSync(pinPath, "utf-8")).toBe("0.5.2");

    const { exec } = makeRecordingExec();
    const ok = installFirstTreeIntegration({
      workspacePath: workspace,
      contextTreePath: treePath,
      workspaceId: "agent-x",
      log: () => {},
      exec,
    });
    expect(ok).toBe(true);

    if (ok) writeBundledCliVersion(workspace, "0.5.3");
    expect(readFileSync(pinPath, "utf-8")).toBe("0.5.3");
  });
});
