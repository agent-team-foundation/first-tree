import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeConfigPayload } from "@first-tree/shared";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildCodexAgentBriefing } from "../handlers/codex.js";
import { bootstrapWorkspace, FIRST_TREE_WORKSPACE_MARKER } from "../runtime/bootstrap.js";
import type { ChatContext } from "../runtime/chat-context.js";
import { setCliBinding } from "../runtime/cli-binding.js";

// `bootstrapWorkspace` internally writes `.agent/tools.md`, which reads the
// channel-resolved CLI binding for the binary name. Pin it to the prod
// identity so the helper has a binding installed even when these tests run
// in isolation (the production CLI entry installs it via channel-env.ts,
// but vitest workers boot without that side effect).
beforeAll(() => {
  setCliBinding({ binName: "first-tree", packageName: "first-tree" });
});

function codexPayload(
  overrides: Partial<Extract<AgentRuntimeConfigPayload, { kind: "codex" }>> = {},
): AgentRuntimeConfigPayload {
  return {
    kind: "codex",
    prompt: { append: "" },
    model: "",
    mcpServers: [],
    env: [],
    gitRepos: [],
    resourceSkills: [],
    reasoningEffort: "high",
    ...overrides,
  };
}

describe("bootstrapWorkspace — codex briefing + workspace marker", () => {
  let workspacePath: string;

  beforeEach(() => {
    workspacePath = mkdtempSync(join(tmpdir(), "first-tree-codex-bootstrap-"));
  });

  afterEach(() => {
    rmSync(workspacePath, { recursive: true, force: true });
  });

  it("writes the .first-tree-workspace marker for every workspace", () => {
    bootstrapWorkspace({
      workspacePath,
      identity: {
        agentId: "agent-1",
        inboxId: "inbox_agent-1",
        displayName: "Tester",
        type: "agent",
        visibility: "organization",
        delegateMention: null,
        metadata: {},
      },
      contextTreePath: null,
      serverUrl: "http://first-tree.test",
    });

    expect(existsSync(join(workspacePath, FIRST_TREE_WORKSPACE_MARKER))).toBe(true);
  });

  it("bootstrapWorkspace no longer writes the briefing (callers route through writeAgentBriefing)", () => {
    // Briefing materialisation is now the caller's responsibility — the
    // handler computes the unified briefing via `buildAgentBriefing` and
    // hands it to `writeAgentBriefing` (or to `ensureAgentBootstrap` which
    // calls writeAgentBriefing internally). `bootstrapWorkspace` is back to
    // owning only the stable `.agent/` layout.
    bootstrapWorkspace({
      workspacePath,
      identity: {
        agentId: "agent-1",
        inboxId: "inbox_agent-1",
        displayName: "Tester",
        type: "agent",
        visibility: "organization",
        delegateMention: null,
        metadata: {},
      },
      contextTreePath: null,
      serverUrl: "http://first-tree.test",
    });

    expect(existsSync(join(workspacePath, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(workspacePath, "CLAUDE.md"))).toBe(false);
  });

  it("inlines First Tree tools and messaging rules into the unified briefing", () => {
    setCliBinding({ binName: "first-tree-staging", packageName: "first-tree-staging" });
    const chatContext: ChatContext = {
      chatId: "chat-1",
      title: "Codex routing",
      topic: "Codex routing",
      participants: [
        { name: "baixiaohang", displayName: "Bai Xiaohang", type: "human" },
        { name: "codex-developer", displayName: "Codex Developer", type: "agent" },
      ],
    };

    const briefing = buildCodexAgentBriefing(
      {
        agentId: "codex-developer",
        inboxId: "inbox_codex-developer",
        displayName: "Codex Developer",
        type: "agent",
        visibility: "organization",
        delegateMention: null,
        metadata: {},
      },
      codexPayload({ prompt: { append: "Follow the local implementation plan." } }),
      chatContext,
      "/workspaces/codex-developer",
      [],
    );

    // Section names follow the AGENTS.md restructure: `# Identity`,
    // `## Agent-Specific Prompt`, `# Working in First Tree`, etc.
    expect(briefing).toContain("# Identity");
    expect(briefing).toContain("Codex Developer");
    expect(briefing).toContain("## Agent-Specific Prompt");
    expect(briefing).toContain("Follow the local implementation plan.");
    expect(briefing).toContain("## Current Chat Context");
    expect(briefing).toContain("# Working in First Tree");
    // The long-form Sending Messages CLI usage lives in the top-level
    // first-tree skill; the Communication decision guide + the
    // Fallback paragraph stay inline because first-tree is not in
    // CORE_SKILL_NAMES (tree-less agents would otherwise lose them).
    expect(briefing).toContain("## Communication");
    expect(briefing).toContain("## Workspace Collaboration");
    expect(briefing).toContain("`first-tree` skill");
    expect(briefing).toContain("first-tree-staging chat send");
    expect(briefing).toContain("does NOT wake other agents");
    // The new Skill Map and Context Tree section are now part of every
    // briefing — pin both so a regenerator dropping them doesn't slip past
    // review.
    expect(briefing).toContain("# Context Tree");
    expect(briefing).toContain("## Reading the Tree");
    expect(briefing).toContain("## Writing the Tree");
    expect(briefing).toContain("# Skills");
    expect(briefing).toContain("## First Tree Family");
    // Stale pointer at the retired first-tree-cloud skill must stay gone.
    expect(briefing).not.toContain("first-tree-cloud");
    // Section headers that the restructure renamed must not linger.
    expect(briefing).not.toContain("# First Tree Agent Runtime");
    expect(briefing).not.toContain("# Working Directory Convention");
    expect(briefing).not.toContain("## Agent-Specific Behavior");
  });
});
