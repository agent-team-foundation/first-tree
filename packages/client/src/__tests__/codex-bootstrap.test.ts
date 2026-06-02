import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

  it("writes AGENTS.md when briefing.format='agents-md'", () => {
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
      briefing: { format: "agents-md", content: "# Hello\n\nFollow your team's playbook.\n" },
    });

    const agentsPath = join(workspacePath, "AGENTS.md");
    expect(existsSync(agentsPath)).toBe(true);
    const text = readFileSync(agentsPath, "utf-8");
    expect(text).toContain("Hello");
    expect(text).toContain("Follow your team's playbook.");
  });

  it("does not write AGENTS.md when no briefing is supplied (claude-code path)", () => {
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
  });

  it("inlines First Tree tools and messaging rules into the Codex AGENTS.md briefing", () => {
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
      codexPayload({ prompt: { append: "Follow the local implementation plan." } }),
      chatContext,
      "/workspaces/codex-developer",
      [],
    );

    expect(briefing).toContain("Follow the local implementation plan.");
    expect(briefing).toContain("## Current Chat Context");
    expect(briefing).toContain("# First Tree Agent Runtime");
    // Per proposal P3 v2, the long-form Sending Messages CLI usage moved
    // to first-tree-cloud; the Communication Rules decision guide + the
    // Fallback paragraph stay inline because first-tree-cloud is not in
    // CORE_SKILL_NAMES (tree-less agents would otherwise lose them).
    expect(briefing).toContain("## Communication Rules");
    expect(briefing).toContain("## Hub Collaboration");
    expect(briefing).toContain("first-tree-cloud");
    expect(briefing).toContain("first-tree-staging chat send");
    expect(briefing).toContain("does NOT wake other agents");
    expect(briefing).not.toContain("`.agent/tools.md` for the");
  });
});
