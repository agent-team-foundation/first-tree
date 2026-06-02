import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  BUNDLED_CLI_VERSION_REL,
  bootstrapWorkspace,
  buildChatSystemPrompt,
  CONTEXT_TREE_HEAD_REL,
  type ContextTreeBinding,
  deepEqualIdentity,
  generateToolsDoc,
  type InstallFirstTreeIntegrationExec,
  installCoreSkills,
  installFirstTreeIntegration,
  readCachedBundledCliVersion,
  readCachedContextTreeHead,
  readContextTreeHead,
  resolveBundledCliVersion,
  withContextTreeSyncLock,
  writeBundledCliVersion,
  writeContextTreeHead,
} from "../runtime/bootstrap.js";
import { setCliBinding } from "../runtime/cli-binding.js";
import type { AgentIdentity } from "../runtime/handler.js";

// Pin the CLI binding to the prod identity so assertions against the
// emitted tools.md and CLI sub-process names keep matching the literals
// they have always matched. Production-channel tests stay untouched;
// non-prod channels are exercised in dedicated test cases below.
beforeAll(() => {
  setCliBinding({ binName: "first-tree", packageName: "first-tree" });
});

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
  // Reset the binding to prod after every test so a case that switches
  // channels (staging / dev) does not leak into the next case. The
  // file-level `beforeAll` already set this; we mirror it here.
  setCliBinding({ binName: "first-tree", packageName: "first-tree" });
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

  it("writes tools.md with the runtime invariants the result-sink + silence-turn rely on", () => {
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
    expect(content).toContain("First Tree Agent Runtime");
    expect(content).toContain("[From: <agent-name>]");
    expect(content).toContain("first-tree chat send");
    // L4 silent-turn protocol: the prompt directive that pairs with the
    // result-sink empty-output guard. Tells the agent that silence is the
    // correct response when it has nothing new — drops courtesy fillers
    // that would otherwise sustain agent↔agent loops. MUST stay in
    // tools.md (not progressive-disclosure) — see proposal P3.
    expect(content).toContain("Stay silent when you have nothing to add");
    expect(content).toContain("If you have nothing new for the recipient, output nothing");
    expect(content).toContain("the runtime ends the turn");
    // Issue #389: pin the anti-double-encode directive so future prompt edits
    // don't accidentally drop it. The CLI passes content as-is; agents that
    // JSON.stringify before sending produce a literal `"@x ...\n..."` row
    // that the UI cannot render as markdown. Stays in tools.md — runtime
    // safety invariant.
    expect(content).toContain("Content rules");
    expect(content).toContain("JSON.stringify");
  });

  it("tools.md pins the final-text contract, Decision guide + Fallback, and points the long-form CLI usage at the first-tree skill", () => {
    const workspace = join(tmpBase, "ws-tools-rules");
    mkdirSync(workspace, { recursive: true });

    bootstrapWorkspace({
      workspacePath: workspace,
      identity: makeIdentity(),
      contextTreePath: null,
      serverUrl: "http://localhost:8000",
    });

    const content = readFileSync(join(workspace, ".agent", "tools.md"), "utf-8");
    // Final-text contract still pinned in tools.md (load-bearing for
    // result-sink + agent↔agent echo-loop prevention; see v1 §四 改造 4).
    expect(content).toContain("human observers");
    expect(content).toContain("does NOT wake other agents");
    // The Decision guide table and the Fallback paragraph stay inline
    // because `first-tree` is in TREE_SKILL_NAMES, not CORE_SKILL_NAMES —
    // a tree-less agent (contextTreePath: null) would otherwise lose them
    // entirely. Only the long-form CLI mechanics (chat invite / markdown /
    // stdin / mention resolution) sink into the skill.
    expect(content).toContain("## Communication Rules");
    expect(content).toContain("Decision guide");
    expect(content).toMatch(/Target is a \*\*human\*\* in this chat/);
    expect(content).toMatch(/Target is an \*\*agent\*\* in this chat/);
    expect(content).toContain("**Fallback**");
    expect(content).toContain("conservative mode");
    // tools.md still carries the pointer at the first-tree skill for the
    // long-form CLI usage (and explicitly notes the tree-less case).
    expect(content).toContain("## Workspace Collaboration");
    expect(content).toContain("`first-tree` skill");
    // Old contract text must stay gone — these are the lines the v1.5 spec
    // requires 改造 4 to overwrite.
    expect(content).not.toContain("Your final text response is automatically delivered");
    expect(content).not.toMatch(/Otherwise it falls back to a direct chat/i);
    // Stale pointer at the retired first-tree-cloud skill must stay gone.
    expect(content).not.toContain("first-tree-cloud");
  });

  it("tools.md is generated from the shared tools doc helper", () => {
    const workspace = join(tmpBase, "ws-tools-helper");
    mkdirSync(workspace, { recursive: true });

    bootstrapWorkspace({
      workspacePath: workspace,
      identity: makeIdentity(),
      contextTreePath: null,
      serverUrl: "http://localhost:8000",
    });

    const content = readFileSync(join(workspace, ".agent", "tools.md"), "utf-8");
    expect(content).toBe(generateToolsDoc());
  });

  it("tools.md uses the channel-resolved binary name in the surviving chat-send invariant (post-P3 sink)", () => {
    // Regression for the multi-env follow-up: the agent-facing tools.md used
    // to hardcode `first-tree chat send`, which on staging hosts asks the
    // agent to call a binary that doesn't exist (only `first-tree-staging`
    // is installed). After the long-form CLI usage was sunk into the
    // top-level `first-tree` skill, tools.md no longer carries `chat invite`
    // / `agent list` examples — but the load-bearing `chat send <name>`
    // directive (and the pointer's binary substitution note) still go
    // through `${bin}`, so the channel binding must thread through.
    // The full chat-send/invite/agent-list usage now lives in
    // `skills/first-tree/references/agent-communication.md`; that file's
    // channel-correctness is covered by the skill-content tests in
    // `apps/cli/src/__tests__/skill-artifacts.test.ts`.
    setCliBinding({ binName: "first-tree-staging", packageName: "first-tree-staging" });
    const workspace = join(tmpBase, "ws-tools-staging");
    mkdirSync(workspace, { recursive: true });

    bootstrapWorkspace({
      workspacePath: workspace,
      identity: makeIdentity(),
      contextTreePath: null,
      serverUrl: "http://localhost:8000",
    });

    const content = readFileSync(join(workspace, ".agent", "tools.md"), "utf-8");
    expect(content).toContain("first-tree-staging chat send");
    // The hardcoded prod name must NOT leak through — the literal
    // `first-tree chat` would mis-direct staging agents to the prod binary.
    // (The pointer text mentioning `first-tree` as a literal-to-substitute
    // does so inside backticks and is not followed by `chat ` — the regex
    // anchors on the literal CLI form `first-tree chat ` only.)
    expect(content).not.toMatch(/\bfirst-tree chat /);
  });

  it("tools.md notes the ask-a-human flow is pending redesign", () => {
    // The NHA / attention surface was removed; the prompt-layer text now
    // carries a placeholder telling the agent to use its own judgment until
    // a replacement is designed.
    setCliBinding({ binName: "first-tree", packageName: "first-tree" });
    const workspace = join(tmpBase, "ws-tools-askhuman");
    mkdirSync(workspace, { recursive: true });

    bootstrapWorkspace({
      workspacePath: workspace,
      identity: makeIdentity(),
      contextTreePath: null,
      serverUrl: "http://localhost:8000",
    });

    const content = readFileSync(join(workspace, ".agent", "tools.md"), "utf-8");
    expect(content).toContain("[pending redesign, 自行判断]");
    // The retired NHA surface must not leak back into the prompt.
    expect(content).not.toMatch(/attention raise/);
    expect(content).not.toContain("AskUserQuestion");
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

  it("logs non-Error integration failures without retrying", () => {
    const workspace = join(tmpBase, "integrate-string-error");
    const treePath = join(tmpBase, "ctx-string-error");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(treePath, { recursive: true });

    const { exec, calls } = makeRecordingExec(() => {
      throw "plain failure";
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
    expect(logs.join("\n")).toContain("plain failure");
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

  it("uses the staging binName + npx packageName when the CLI binding points at the staging channel", () => {
    // Regression for the multi-env follow-up: bootstrap used to hardcode
    // "first-tree", which on staging hosts called a non-existent binary
    // (only `first-tree-staging` is installed there). Both the PATH attempt
    // and the npx fallback must follow the channel binding.
    setCliBinding({ binName: "first-tree-staging", packageName: "first-tree-staging" });

    const workspace = join(tmpBase, "integrate-staging");
    const treePath = join(tmpBase, "ctx-staging");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(treePath, { recursive: true });

    let call = 0;
    const { exec, calls } = makeRecordingExec(() => {
      call += 1;
      if (call === 1) {
        const err = new Error("spawn first-tree-staging ENOENT") as Error & { code?: string };
        err.code = "ENOENT";
        throw err;
      }
    });

    const logs: string[] = [];
    const result = installFirstTreeIntegration({
      workspacePath: workspace,
      contextTreePath: treePath,
      workspaceId: "agent-staging",
      log: (m) => logs.push(m),
      exec,
    });

    expect(result, logs.join("\n")).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.command).toBe("first-tree-staging");
    expect(calls[1]?.command).toBe("npx");
    expect(calls[1]?.args.slice(0, 2)).toEqual(["-y", "first-tree-staging@latest"]);
    expect(logs.join("\n")).toContain("first-tree-staging (PATH)");
    expect(logs.join("\n")).toContain("npx first-tree-staging@latest");
  });

  it("skips the npx fallback for the dev channel because dev binaries are not published", () => {
    // Dev channel sets `packageName: null` in `channelConfig` — there is
    // no `first-tree-dev` tarball on npm. The PATH attempt must still run
    // (developers install via scripts/dev-install.sh), but if it fails the
    // helper must NOT try `npx null@latest` or `npx first-tree-dev@latest`.
    setCliBinding({ binName: "first-tree-dev", packageName: null });

    const workspace = join(tmpBase, "integrate-dev");
    const treePath = join(tmpBase, "ctx-dev");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(treePath, { recursive: true });

    const { exec, calls } = makeRecordingExec(() => {
      const err = new Error("spawn first-tree-dev ENOENT") as Error & { code?: string };
      err.code = "ENOENT";
      throw err;
    });

    const logs: string[] = [];
    const result = installFirstTreeIntegration({
      workspacePath: workspace,
      contextTreePath: treePath,
      workspaceId: "agent-dev",
      log: (m) => logs.push(m),
      exec,
    });

    expect(result).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("first-tree-dev");
    expect(logs.join("\n")).not.toContain("npx");
  });
});

describe("installCoreSkills", () => {
  it("shells out to `first-tree tree skill install-core --root <workspace>`", () => {
    const workspace = join(tmpBase, "core-skills-happy");
    mkdirSync(workspace, { recursive: true });

    const { exec, calls } = makeRecordingExec();
    const logs: string[] = [];

    const result = installCoreSkills({
      workspacePath: workspace,
      log: (m) => logs.push(m),
      exec,
    });

    expect(result).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("first-tree");
    expect(calls[0]?.args).toEqual(["tree", "skill", "install-core", "--root", workspace]);
    expect(calls[0]?.options.cwd).toBe(workspace);
    expect(logs.join("\n")).toContain("Core skills installed via first-tree (PATH)");
  });

  it("falls back to npx when the channel binary is missing", () => {
    const workspace = join(tmpBase, "core-skills-fallback");
    mkdirSync(workspace, { recursive: true });

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
    const result = installCoreSkills({
      workspacePath: workspace,
      log: (m) => logs.push(m),
      exec,
    });

    expect(result).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.command).toBe("npx");
    expect(calls[1]?.args.slice(0, 3)).toEqual(["-y", "first-tree@latest", "tree"]);
    expect(calls[1]?.args.slice(3)).toEqual(["skill", "install-core", "--root", workspace]);
  });

  it("uses the channel-resolved binary name", () => {
    setCliBinding({ binName: "first-tree-staging", packageName: "first-tree-staging" });
    try {
      const workspace = join(tmpBase, "core-skills-staging");
      mkdirSync(workspace, { recursive: true });

      const { exec, calls } = makeRecordingExec();
      const result = installCoreSkills({
        workspacePath: workspace,
        log: () => {},
        exec,
      });

      expect(result).toBe(true);
      expect(calls[0]?.command).toBe("first-tree-staging");
      expect(calls[0]?.args).toContain("install-core");
    } finally {
      setCliBinding({ binName: "first-tree", packageName: "first-tree" });
    }
  });

  it("returns false and logs gracefully when the binary itself is missing on dev channel (no npx fallback)", () => {
    setCliBinding({ binName: "first-tree-dev", packageName: null });
    try {
      const workspace = join(tmpBase, "core-skills-dev-miss");
      mkdirSync(workspace, { recursive: true });

      const { exec } = makeRecordingExec(() => {
        const err = new Error("spawn first-tree-dev ENOENT") as Error & { code?: string };
        err.code = "ENOENT";
        throw err;
      });

      const logs: string[] = [];
      const result = installCoreSkills({
        workspacePath: workspace,
        log: (m) => logs.push(m),
        exec,
      });

      expect(result).toBe(false);
      expect(logs.join("\n")).toContain("Core skill install skipped");
      expect(logs.join("\n")).not.toContain("npx");
    } finally {
      setCliBinding({ binName: "first-tree", packageName: "first-tree" });
    }
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
    // The pre-checked-out source repo is on a never-advanced hub-session
    // branch — the prompt must warn the agent NOT to reuse it for new
    // work and instead branch a fresh worktree from a freshly-fetched
    // origin ref (issue #655).
    expect(text).toContain("refreshed during this chat");
    expect(text).toContain("git fetch origin");
    expect(text).toContain("origin/main");
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

  it("readContextTreeHead returns null when git rev-parse fails", () => {
    const brokenGit = join(tmpBase, "tree-head-broken-git");
    mkdirSync(brokenGit, { recursive: true });
    writeFileSync(join(brokenGit, ".git"), "gitdir: /path/that/does/not/exist\n");

    expect(readContextTreeHead(brokenGit)).toBeNull();
  });

  it("write/read roundtrip pins the HEAD value for drift comparison", () => {
    const workspace = join(tmpBase, "tree-head-cache");
    mkdirSync(workspace, { recursive: true });

    expect(readCachedContextTreeHead(workspace)).toBeNull();

    writeContextTreeHead(workspace, "abc123def456");
    expect(readCachedContextTreeHead(workspace)).toBe("abc123def456");
    expect(existsSync(join(workspace, CONTEXT_TREE_HEAD_REL))).toBe(true);
  });

  it("readCachedContextTreeHead returns null when the cache file cannot be read", () => {
    const workspace = join(tmpBase, "tree-head-cache-unreadable");
    const path = join(workspace, CONTEXT_TREE_HEAD_REL);
    mkdirSync(join(workspace, ".agent"), { recursive: true });
    writeFileSync(path, "abc123");
    chmodSync(path, 0);

    expect(readCachedContextTreeHead(workspace)).toBeNull();
  });

  it("readCachedContextTreeHead returns null for an empty cache file", () => {
    const workspace = join(tmpBase, "tree-head-cache-empty");
    mkdirSync(join(workspace, ".agent"), { recursive: true });
    writeFileSync(join(workspace, CONTEXT_TREE_HEAD_REL), "  \n");

    expect(readCachedContextTreeHead(workspace)).toBeNull();
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

  it("resolveBundledCliVersion keeps walking past a corrupt package.json", () => {
    const dir = join(tmpBase, "cli-version-corrupt", "nested");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(tmpBase, "cli-version-corrupt", "package.json"), "{not-json");

    expect(resolveBundledCliVersion(`file://${join(dir, "module.js")}`)).toMatch(/^\d+\.\d+\.\d+/u);
  });

  it("dev channel: appends a build fingerprint to the version", () => {
    // Switch to the dev binding so the resolver appends the mtime
    // suffix. Default moduleUrl points at this test bundle's own file,
    // which exists, so statSync succeeds and the suffix is present.
    setCliBinding({ binName: "first-tree-dev", packageName: null });
    const version = resolveBundledCliVersion();
    expect(version).toMatch(/\+build\.\d+$/u);
  });

  it("prod and staging channels: bare version, no fingerprint suffix", () => {
    // CI bumps the package manifest's version on every release, so the
    // fingerprint would be redundant noise in the `.agent/cli-version`
    // pin. Assert both published channels explicitly.
    setCliBinding({ binName: "first-tree", packageName: "first-tree" });
    expect(resolveBundledCliVersion()).not.toMatch(/\+build\./u);

    setCliBinding({ binName: "first-tree-staging", packageName: "first-tree-staging" });
    expect(resolveBundledCliVersion()).not.toMatch(/\+build\./u);
  });

  it("dev channel: build fingerprint changes when the module file's mtime changes", () => {
    setCliBinding({ binName: "first-tree-dev", packageName: null });
    const dir = join(tmpBase, "cli-version-fingerprint");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "9.9.9" }));
    const modulePath = join(dir, "module.js");
    writeFileSync(modulePath, "// stub");
    const moduleUrl = `file://${modulePath}`;

    utimesSync(modulePath, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    const first = resolveBundledCliVersion(moduleUrl);

    utimesSync(modulePath, new Date(1_800_000_000_000), new Date(1_800_000_000_000));
    const second = resolveBundledCliVersion(moduleUrl);

    expect(first).toMatch(/^9\.9\.9\+build\.\d+$/u);
    expect(second).toMatch(/^9\.9\.9\+build\.\d+$/u);
    expect(first).not.toBe(second);
  });

  it("dev channel: falls back to bare version when the module file is missing (statSync throws)", () => {
    setCliBinding({ binName: "first-tree-dev", packageName: null });
    const dir = join(tmpBase, "cli-version-no-mtime");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "0.0.1" }));
    // Synthetic module URL — statSync throws and the resolver must
    // degrade to the bare version (still drift-comparable, just not
    // build-sensitive).
    expect(resolveBundledCliVersion(`file://${join(dir, "ghost.js")}`)).toBe("0.0.1");
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

  it("readCachedBundledCliVersion returns null when the cache file cannot be read", () => {
    const workspace = join(tmpBase, "cli-version-unreadable");
    const path = join(workspace, BUNDLED_CLI_VERSION_REL);
    mkdirSync(join(workspace, ".agent"), { recursive: true });
    writeFileSync(path, "0.5.3");
    chmodSync(path, 0);

    expect(readCachedBundledCliVersion(workspace)).toBeNull();
  });

  it("readCachedBundledCliVersion returns null for an empty cache file", () => {
    const workspace = join(tmpBase, "cli-version-empty");
    mkdirSync(join(workspace, ".agent"), { recursive: true });
    writeFileSync(join(workspace, BUNDLED_CLI_VERSION_REL), "  \n");

    expect(readCachedBundledCliVersion(workspace)).toBeNull();
  });
});

describe("deepEqualIdentity", () => {
  it("compares primitives, nested objects, changed values, and extra keys", () => {
    expect(deepEqualIdentity("same", "same")).toBe(true);
    expect(deepEqualIdentity("left", "right")).toBe(false);
    expect(deepEqualIdentity({ metadata: { tier: "prod" } }, { metadata: { tier: "prod" } })).toBe(true);
    expect(deepEqualIdentity({ metadata: { tier: "prod" } }, { metadata: { tier: "dev" } })).toBe(false);
    expect(deepEqualIdentity({ agentId: "agent-1" }, { agentId: "agent-1", displayName: "Agent" })).toBe(false);
    expect(deepEqualIdentity({ agentId: "agent-1" }, { agentId: "agent-1" })).toBe(true);
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
