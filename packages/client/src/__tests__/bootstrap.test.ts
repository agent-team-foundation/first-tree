import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootstrapWorkspace } from "../runtime/bootstrap.js";
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
    displayName: "Test Agent",
    type: "autonomous_agent",
    delegateMention: null,
    metadata: {},
    ...overrides,
  };
}

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
    expect(content).toContain("FIRST_TREE_HUB_SERVER_URL");
    expect(content).toContain("FIRST_TREE_HUB_ACCESS_TOKEN");
    expect(content).toContain("How You Communicate");
    expect(content).toContain("Agent Hub");
    expect(content).toContain("[From: sender-id]");
    expect(content).toContain("Use your judgment about when to respond");
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
