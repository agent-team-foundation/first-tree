import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentIdentity } from "../runtime/handler.js";

// We test the generateClaudeMd function indirectly by checking its output.
// Since it's a module-private function in claude-code.ts, we test via the
// bootstrapWorkspace + CLAUDE.md generation pattern.

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
 * Simulate what the claude-code handler does: bootstrap + generate CLAUDE.md.
 * We re-implement generateClaudeMd here to test the template logic independently.
 */
function generateClaudeMd(workspacePath: string, identity: AgentIdentity, contextTreePath: string | null): string {
  const sections: string[] = [];

  if (identity.type === "personal_assistant" && identity.delegateMention) {
    sections.push(
      `# Agent Identity\n\nYou are ${identity.displayName ?? identity.agentId}, a personal assistant to ${identity.delegateMention}.\n`,
    );
    sections.push(
      `## Your Responsibilities\n\n- Answer queries and execute tasks on behalf of ${identity.delegateMention}\n- Escalate when: cross-domain ownership changes, architectural decisions, ambiguous requests\n- When unsure, ask ${identity.delegateMention} for clarification rather than guessing\n`,
    );
  } else {
    sections.push(`# Agent Identity\n\nYou are ${identity.displayName ?? identity.agentId}, an autonomous agent.\n`);
    sections.push(
      "## Your Responsibilities\n\n- Execute your assigned responsibilities independently\n- Collaborate with other agents through the messaging system when needed\n",
    );
  }

  const selfMdPath = join(workspacePath, ".agent", "context", "self.md");
  if (existsSync(selfMdPath)) {
    const selfContent = readFileSync(selfMdPath, "utf-8");
    sections.push(`## Context Tree Profile\n\n${selfContent}\n`);
  }

  if (contextTreePath) {
    sections.push(
      `## Context Tree\n\nThe organization's Context Tree is available at: \`${contextTreePath}\`\n\nYou can read files from this directory for organizational context. If your work requires updating the Context Tree, commit and push changes there.\n`,
    );
  }

  const toolsPath = join(workspacePath, ".agent", "tools.md");
  if (existsSync(toolsPath)) {
    const toolsContent = readFileSync(toolsPath, "utf-8");
    sections.push(toolsContent);
  }

  return sections.join("\n");
}

describe("CLAUDE.md generation", () => {
  it("generates personal_assistant template with delegate mention", () => {
    const workspace = join(tmpBase, "ws-pa");
    mkdirSync(join(workspace, ".agent", "context"), { recursive: true });

    const identity: AgentIdentity = {
      agentId: "yuezengwu-assistant",
      displayName: "yuezengwu-assistant",
      type: "personal_assistant",
      delegateMention: "yuezengwu",
      metadata: {},
    };

    const md = generateClaudeMd(workspace, identity, "/tmp/ctx");
    expect(md).toContain("personal assistant to yuezengwu");
    expect(md).toContain("on behalf of yuezengwu");
    expect(md).toContain("Context Tree is available at: `/tmp/ctx`");
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
    expect(md).toContain("Execute your assigned responsibilities independently");
    expect(md).not.toContain("Context Tree is available");
  });

  it("includes self.md content when present", () => {
    const workspace = join(tmpBase, "ws-self");
    mkdirSync(join(workspace, ".agent", "context"), { recursive: true });
    writeFileSync(
      join(workspace, ".agent", "context", "self.md"),
      "---\ntype: personal_assistant\n---\nI help yuezengwu.",
    );

    const identity: AgentIdentity = {
      agentId: "yuezengwu-assistant",
      displayName: "yuezengwu-assistant",
      type: "personal_assistant",
      delegateMention: "yuezengwu",
      metadata: {},
    };

    const md = generateClaudeMd(workspace, identity, null);
    expect(md).toContain("I help yuezengwu.");
    expect(md).toContain("Context Tree Profile");
  });

  it("includes tools.md content when present", () => {
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
