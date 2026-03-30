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
 * Layered Bootstrap: identity + profile + instructions + domain map + tree location + SDK.
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

  // Layer 1: Member profile
  const selfMdPath = join(contextDir, "self.md");
  if (existsSync(selfMdPath)) {
    const selfContent = readFileSync(selfMdPath, "utf-8");
    sections.push(`## Your Profile\n\n${selfContent}\n`);
  } else {
    sections.push(
      "## Your Profile\n\nNo member profile available. Your responsibilities are not loaded from the Context Tree.\n",
    );
  }

  // Layer 1: AGENT.md operating instructions
  const agentInstructionsPath = join(contextDir, "agent-instructions.md");
  if (existsSync(agentInstructionsPath)) {
    const instructions = readFileSync(agentInstructionsPath, "utf-8");
    sections.push(`## Context Tree Operating Instructions\n\n${instructions}\n`);
  } else {
    sections.push(
      "## Context Tree Operating Instructions\n\nContext Tree instructions unavailable. Organizational context is not loaded for this session.\n",
    );
  }

  // Layer 2: Domain map
  const domainMapPath = join(contextDir, "domain-map.md");
  if (existsSync(domainMapPath)) {
    const domainMap = readFileSync(domainMapPath, "utf-8");
    sections.push(`## Organization Domain Map\n\n${domainMap}\n`);
  }

  // Layer 3: Context Tree location
  if (contextTreePath) {
    sections.push(
      `## Context Tree Location\n\nThe full Context Tree is available at: \`${contextTreePath}\`\n\nRead specific domain nodes as needed following the operating instructions above.\n`,
    );
  } else {
    const degradedPath = join(contextDir, "degraded.md");
    if (existsSync(degradedPath)) {
      const degradedMsg = readFileSync(degradedPath, "utf-8");
      sections.push(
        `## Context Tree Location\n\nWARNING: ${degradedMsg}\nYou can still use the SDK tools below, but you lack organizational context for decisions.\n`,
      );
    }
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
      displayName: "Code Reviewer",
      type: "autonomous_agent",
      delegateMention: null,
      metadata: {},
    };

    const md = generateClaudeMd(workspace, identity, null);
    expect(md).toContain("Code Reviewer, an autonomous agent");
    expect(md).not.toContain("personal assistant");
  });

  it("includes member profile from self.md", () => {
    const workspace = join(tmpBase, "ws-self");
    mkdirSync(join(workspace, ".agent", "context"), { recursive: true });
    writeFileSync(
      join(workspace, ".agent", "context", "self.md"),
      "---\ntype: personal_assistant\nrole: Personal Assistant\n---\nI help yuezengwu with tasks.",
    );

    const identity: AgentIdentity = {
      agentId: "yuezengwu-assistant",
      displayName: "yuezengwu-assistant",
      type: "personal_assistant",
      delegateMention: null,
      metadata: {},
    };

    const md = generateClaudeMd(workspace, identity, null);
    expect(md).toContain("Your Profile");
    expect(md).toContain("I help yuezengwu with tasks.");
  });

  it("shows fallback when no self.md exists", () => {
    const workspace = join(tmpBase, "ws-no-self");
    mkdirSync(join(workspace, ".agent", "context"), { recursive: true });

    const identity: AgentIdentity = {
      agentId: "test",
      displayName: "Test",
      type: "autonomous_agent",
      delegateMention: null,
      metadata: {},
    };

    const md = generateClaudeMd(workspace, identity, null);
    expect(md).toContain("No member profile available");
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
      displayName: "Test",
      type: "autonomous_agent",
      delegateMention: null,
      metadata: {},
    };

    const md = generateClaudeMd(workspace, identity, null);
    expect(md).toContain("Context Tree Operating Instructions");
    expect(md).toContain("Before Every Task");
    expect(md).toContain("Read the root NODE.md");
  });

  it("shows fallback when no agent-instructions.md exists", () => {
    const workspace = join(tmpBase, "ws-no-instructions");
    mkdirSync(join(workspace, ".agent", "context"), { recursive: true });

    const identity: AgentIdentity = {
      agentId: "test",
      displayName: "Test",
      type: "autonomous_agent",
      delegateMention: null,
      metadata: {},
    };

    const md = generateClaudeMd(workspace, identity, null);
    expect(md).toContain("Context Tree instructions unavailable");
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
      displayName: "Test",
      type: "autonomous_agent",
      delegateMention: null,
      metadata: {},
    };

    const md = generateClaudeMd(workspace, identity, "/home/user/.first-tree-hub/data/context-tree");
    expect(md).toContain("Context Tree Location");
    expect(md).toContain("/home/user/.first-tree-hub/data/context-tree");
    expect(md).toContain("Read specific domain nodes as needed");
  });

  it("shows degraded warning when context tree unavailable", () => {
    const workspace = join(tmpBase, "ws-degraded");
    mkdirSync(join(workspace, ".agent", "context"), { recursive: true });
    writeFileSync(
      join(workspace, ".agent", "context", "degraded.md"),
      "Context Tree is not available for this session.\nOrganizational context is not loaded.\n",
    );

    const identity: AgentIdentity = {
      agentId: "test",
      displayName: "Test",
      type: "autonomous_agent",
      delegateMention: null,
      metadata: {},
    };

    const md = generateClaudeMd(workspace, identity, null);
    expect(md).toContain("WARNING:");
    expect(md).toContain("Context Tree is not available");
    expect(md).toContain("you lack organizational context");
  });

  it("includes tools.md content", () => {
    const workspace = join(tmpBase, "ws-tools");
    mkdirSync(join(workspace, ".agent"), { recursive: true });
    writeFileSync(join(workspace, ".agent", "tools.md"), "# Tools\n\nUse the SDK.");

    const identity: AgentIdentity = {
      agentId: "test",
      displayName: "Test",
      type: "autonomous_agent",
      delegateMention: null,
      metadata: {},
    };

    const md = generateClaudeMd(workspace, identity, null);
    expect(md).toContain("# Tools");
    expect(md).toContain("Use the SDK.");
  });

  it("uses agentId when displayName is null", () => {
    const workspace = join(tmpBase, "ws-no-name");
    mkdirSync(join(workspace, ".agent", "context"), { recursive: true });

    const identity: AgentIdentity = {
      agentId: "my-agent",
      displayName: null,
      type: "autonomous_agent",
      delegateMention: null,
      metadata: {},
    };

    const md = generateClaudeMd(workspace, identity, null);
    expect(md).toContain("You are my-agent, an autonomous agent");
  });
});
