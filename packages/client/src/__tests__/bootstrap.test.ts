import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bootstrapWorkspace,
  type InstallFirstTreeIntegrationExec,
  installFirstTreeIntegration,
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
    type: "autonomous_agent",
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

describe("bootstrapWorkspace", () => {
  it("writes identity.json with correct fields", () => {
    const workspace = join(tmpBase, "ws-identity");
    mkdirSync(workspace, { recursive: true });

    bootstrapWorkspace({
      workspacePath: workspace,
      identity: makeIdentity({ agentId: "my-agent", type: "personal_assistant", delegateMention: "owner" }),
      contextTreePath: null,
      serverUrl: "http://localhost:8000",
      chatId: "chat-123",
    });

    const identityPath = join(workspace, ".agent", "identity.json");
    expect(existsSync(identityPath)).toBe(true);

    const data = JSON.parse(readFileSync(identityPath, "utf-8"));
    expect(data.agentId).toBe("my-agent");
    expect(data.type).toBe("personal_assistant");
    expect(data.delegateMention).toBe("owner");
    expect(data.chatId).toBe("chat-123");
    expect(data.serverUrl).toBe("http://localhost:8000");
  });

  it("writes tools.md with SDK reference", () => {
    const workspace = join(tmpBase, "ws-tools");
    mkdirSync(workspace, { recursive: true });

    bootstrapWorkspace({
      workspacePath: workspace,
      identity: makeIdentity(),
      contextTreePath: null,
      serverUrl: "http://localhost:8000",
      chatId: "chat-1",
    });

    const toolsPath = join(workspace, ".agent", "tools.md");
    expect(existsSync(toolsPath)).toBe(true);

    const content = readFileSync(toolsPath, "utf-8");
    expect(content).toContain("Agent Hub");
    expect(content).toContain("[From: <agent-name>]");
    expect(content).toContain("first-tree-hub chat send");
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
      chatId: "chat-1",
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

  it("tools.md shows --direct as a documented chat send option (v1 §四 改造 1)", () => {
    const workspace = join(tmpBase, "ws-tools-direct");
    mkdirSync(workspace, { recursive: true });

    bootstrapWorkspace({
      workspacePath: workspace,
      identity: makeIdentity(),
      contextTreePath: null,
      serverUrl: "http://localhost:8000",
      chatId: "chat-1",
    });

    const content = readFileSync(join(workspace, ".agent", "tools.md"), "utf-8");
    // Sending Messages section must include a --direct example
    expect(content).toContain("first-tree-hub chat send --direct");
    // Member-default routing description (replaces the implicit-fallback note)
    expect(content).toMatch(/recipient MUST be a participant/);
    expect(content).toMatch(/--direct flag explicitly/);
    // v1.7: agent surface is narrowed to "address an agent by name". The
    // `--chat <chatId>` foot-gun is gone from the CLI and from this prompt.
    expect(content).not.toMatch(/--chat <chatId>/);
    expect(content).not.toMatch(/--chat <directChatId>/);
    expect(content).toMatch(/Reaching another agent/);
    expect(content).toMatch(/auto-mentions the recipient/);
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
      chatId: "chat-1",
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
      chatId: "chat-1",
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
      chatId: "chat-1",
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
      chatId: "chat-1",
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
      chatId: "chat-1",
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
      chatId: "chat-1",
    });

    const degradedPath = join(workspace, ".agent", "context", "degraded.md");
    expect(existsSync(degradedPath)).toBe(false);
  });

  it("writes chatContext into identity.json when provided", () => {
    const workspace = join(tmpBase, "ws-chat-context");
    mkdirSync(workspace, { recursive: true });

    bootstrapWorkspace({
      workspacePath: workspace,
      identity: makeIdentity({ agentId: "a", type: "autonomous_agent" }),
      contextTreePath: null,
      serverUrl: "http://localhost:8000",
      chatId: "chat-cc",
      chatContext: {
        chatId: "chat-cc",
        title: "ship v1",
        topic: "ship v1",
        participants: [
          { name: "alice", displayName: "Alice", type: "human" },
          { name: "bob-bot", displayName: "Bob Bot", type: "agent" },
        ],
      },
    });

    const data = JSON.parse(readFileSync(join(workspace, ".agent", "identity.json"), "utf-8"));
    expect(data.chatContext).toMatchObject({
      chatId: "chat-cc",
      title: "ship v1",
      topic: "ship v1",
      participants: [
        { name: "alice", displayName: "Alice", type: "human" },
        { name: "bob-bot", displayName: "Bob Bot", type: "agent" },
      ],
    });
    expect(data.chatContext.selfOwner).toBeUndefined();
  });

  it("omits chatContext from identity.json when not provided (degradation)", () => {
    const workspace = join(tmpBase, "ws-no-chat-context");
    mkdirSync(workspace, { recursive: true });

    bootstrapWorkspace({
      workspacePath: workspace,
      identity: makeIdentity({ agentId: "a" }),
      contextTreePath: null,
      serverUrl: "http://localhost:8000",
      chatId: "chat-nc",
    });

    const data = JSON.parse(readFileSync(join(workspace, ".agent", "identity.json"), "utf-8"));
    expect("chatContext" in data).toBe(false);
  });

  it("overwrites existing files on re-bootstrap", () => {
    const workspace = join(tmpBase, "ws-overwrite");
    mkdirSync(join(workspace, ".agent"), { recursive: true });
    writeFileSync(join(workspace, ".agent", "identity.json"), '{"agentId":"old"}');

    bootstrapWorkspace({
      workspacePath: workspace,
      identity: makeIdentity({ agentId: "new-agent" }),
      contextTreePath: null,
      serverUrl: "http://localhost:8000",
      chatId: "chat-1",
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
