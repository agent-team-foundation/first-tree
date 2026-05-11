import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentIdentity } from "../runtime/handler.js";

// We test the generateClaudeMd function indirectly by checking its output.
// Since it's a module-private function in claude-code.ts, we re-implement
// the template logic here to test independently.

const tmpBase = join(import.meta.dirname ?? __dirname, "../../.test-tmp-claude-md");

function cleanTmp(): void {
  try {
    rmSync(tmpBase, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

afterEach(() => {
  cleanTmp();
});

/**
 * Mirror of generateClaudeMd from claude-code.ts.
 * Must stay in sync with the real implementation.
 *
 * Layer 1 (always): Agent identity + profile (from Hub)
 * Layer 2 (if Context Tree configured): Operating instructions + domain map
 * Layer 3 (if Context Tree configured): Context Tree location for on-demand reading
 */
function generateClaudeMd(workspacePath: string, identity: AgentIdentity, contextTreePath: string | null): string {
  const sections: string[] = [];
  const contextDir = join(workspacePath, ".agent", "context");

  // Identity
  const name = identity.displayName ?? identity.agentId;
  if (identity.type === "personal_assistant") {
    sections.push(`# Agent Identity\n\nYou are ${name}, a personal assistant agent.\n`);
  } else {
    sections.push(`# Agent Identity\n\nYou are ${name}, an autonomous agent.\n`);
  }

  // PRD D7: profile / self.md is intentionally not consumed here — the
  // agent's behavior prompt now lives in `agent_configs.payload.prompt.append`
  // and is passed to the Claude SDK via `systemPrompt.append`.

  // Context Tree operating instructions (AGENT.md)
  const agentInstructionsPath = join(contextDir, "agent-instructions.md");
  if (existsSync(agentInstructionsPath)) {
    const instructions = readFileSync(agentInstructionsPath, "utf-8");
    sections.push(`## Operating Instructions\n\n${instructions}\n`);
  }

  // Organization domain map (root NODE.md)
  const domainMapPath = join(contextDir, "domain-map.md");
  if (existsSync(domainMapPath)) {
    const domainMap = readFileSync(domainMapPath, "utf-8");
    sections.push(`## Organization Domain Map\n\n${domainMap}\n`);
  }

  // Context Tree location for on-demand reading
  if (contextTreePath) {
    sections.push(
      `## Context Tree Location\n\nThe full Context Tree is available at: \`${contextTreePath}\`\n\nRead specific domain nodes as needed following the operating instructions above.\n`,
    );
  }

  // SDK tools
  const toolsPath = join(workspacePath, ".agent", "tools.md");
  if (existsSync(toolsPath)) {
    const toolsContent = readFileSync(toolsPath, "utf-8");
    sections.push(toolsContent);
  }

  return sections.join("\n");
}

describe("CLAUDE.md generation", () => {
  it("generates personal_assistant identity based on type alone", () => {
    const workspace = join(tmpBase, "ws-pa");
    mkdirSync(join(workspace, ".agent", "context"), { recursive: true });

    const identity: AgentIdentity = {
      agentId: "yuezengwu-assistant",
      inboxId: "inbox-yuezengwu-assistant",
      displayName: "yuezengwu-assistant",
      type: "personal_assistant",
      delegateMention: null, // null — should still detect as personal_assistant
      metadata: {},
    };

    const md = generateClaudeMd(workspace, identity, null);
    expect(md).toContain("personal assistant agent");
    expect(md).not.toContain("autonomous agent");
  });

  it("generates autonomous_agent template", () => {
    const workspace = join(tmpBase, "ws-auto");
    mkdirSync(join(workspace, ".agent", "context"), { recursive: true });

    const identity: AgentIdentity = {
      agentId: "code-reviewer",
      inboxId: "inbox-code-reviewer",
      displayName: "Code Reviewer",
      type: "autonomous_agent",
      delegateMention: null,
      metadata: {},
    };

    const md = generateClaudeMd(workspace, identity, null);
    expect(md).toContain("Code Reviewer, an autonomous agent");
    expect(md).not.toContain("personal assistant");
  });

  it("never includes a Profile section — prompt lives in agent_configs per PRD D7", () => {
    const workspace = join(tmpBase, "ws-no-profile");
    mkdirSync(join(workspace, ".agent", "context"), { recursive: true });
    // Drop a self.md anyway to prove generateClaudeMd does not consume it.
    writeFileSync(join(workspace, ".agent", "context", "self.md"), "stale profile content");

    const identity: AgentIdentity = {
      agentId: "test",
      inboxId: "inbox-test",
      displayName: "Test",
      type: "autonomous_agent",
      delegateMention: null,
      metadata: {},
    };

    const md = generateClaudeMd(workspace, identity, null);
    expect(md).not.toContain("Your Profile");
    expect(md).not.toContain("stale profile content");
  });

  it("includes AGENT.md operating instructions", () => {
    const workspace = join(tmpBase, "ws-instructions");
    mkdirSync(join(workspace, ".agent", "context"), { recursive: true });
    writeFileSync(
      join(workspace, ".agent", "context", "agent-instructions.md"),
      "## Before Every Task\n\n1. Read the root NODE.md\n2. Read relevant domain nodes",
    );

    const identity: AgentIdentity = {
      agentId: "test",
      inboxId: "inbox-test",
      displayName: "Test",
      type: "autonomous_agent",
      delegateMention: null,
      metadata: {},
    };

    const md = generateClaudeMd(workspace, identity, null);
    expect(md).toContain("Operating Instructions");
    expect(md).toContain("Before Every Task");
    expect(md).toContain("Read the root NODE.md");
  });

  it("omits instructions section when no agent-instructions.md exists", () => {
    const workspace = join(tmpBase, "ws-no-instructions");
    mkdirSync(join(workspace, ".agent", "context"), { recursive: true });

    const identity: AgentIdentity = {
      agentId: "test",
      inboxId: "inbox-test",
      displayName: "Test",
      type: "autonomous_agent",
      delegateMention: null,
      metadata: {},
    };

    const md = generateClaudeMd(workspace, identity, null);
    expect(md).not.toContain("Operating Instructions");
  });

  it("includes domain map when present", () => {
    const workspace = join(tmpBase, "ws-domain-map");
    mkdirSync(join(workspace, ".agent", "context"), { recursive: true });
    writeFileSync(
      join(workspace, ".agent", "context", "domain-map.md"),
      "# Context Tree\n\n## Domains\n\n- kael/\n- agent-hub/",
    );

    const identity: AgentIdentity = {
      agentId: "test",
      inboxId: "inbox-test",
      displayName: "Test",
      type: "autonomous_agent",
      delegateMention: null,
      metadata: {},
    };

    const md = generateClaudeMd(workspace, identity, null);
    expect(md).toContain("Organization Domain Map");
    expect(md).toContain("kael/");
  });

  it("includes context tree location when path is available", () => {
    const workspace = join(tmpBase, "ws-ctx-path");
    mkdirSync(join(workspace, ".agent", "context"), { recursive: true });

    const identity: AgentIdentity = {
      agentId: "test",
      inboxId: "inbox-test",
      displayName: "Test",
      type: "autonomous_agent",
      delegateMention: null,
      metadata: {},
    };

    const md = generateClaudeMd(workspace, identity, "/home/user/.first-tree/hub/data/context-tree");
    expect(md).toContain("Context Tree Location");
    expect(md).toContain("/home/user/.first-tree/hub/data/context-tree");
    expect(md).toContain("Read specific domain nodes as needed");
  });

  it("omits context tree section when path is null (normal mode)", () => {
    const workspace = join(tmpBase, "ws-no-tree");
    mkdirSync(join(workspace, ".agent", "context"), { recursive: true });

    const identity: AgentIdentity = {
      agentId: "test",
      inboxId: "inbox-test",
      displayName: "Test",
      type: "autonomous_agent",
      delegateMention: null,
      metadata: {},
    };

    const md = generateClaudeMd(workspace, identity, null);
    expect(md).not.toContain("Context Tree Location");
  });

  it("includes tools.md content", () => {
    const workspace = join(tmpBase, "ws-tools");
    mkdirSync(join(workspace, ".agent"), { recursive: true });
    writeFileSync(join(workspace, ".agent", "tools.md"), "# Tools\n\nUse the SDK.");

    const identity: AgentIdentity = {
      agentId: "test",
      inboxId: "inbox-test",
      displayName: "Test",
      type: "autonomous_agent",
      delegateMention: null,
      metadata: {},
    };

    const md = generateClaudeMd(workspace, identity, null);
    expect(md).toContain("# Tools");
    expect(md).toContain("Use the SDK.");
  });

  // The pre-Phase-2 "uses agentId when displayName is null" case is now
  // unreachable (server enforces NOT NULL + a default), and the coverage
  // it pinned — that the identity banner renders `displayName` verbatim —
  // is already covered by the "generates autonomous_agent template" test
  // above. Intentionally no test here.
});
