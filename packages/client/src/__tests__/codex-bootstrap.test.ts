import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapWorkspace, FIRST_TREE_WORKSPACE_MARKER } from "../runtime/bootstrap.js";
import { setCliBinding } from "../runtime/cli-binding.js";

// `bootstrapWorkspace` internally writes `.agent/tools.md`, which reads the
// channel-resolved CLI binding for the binary name. Pin it to the prod
// identity so the helper has a binding installed even when these tests run
// in isolation (the production CLI entry installs it via cli-binding-init,
// but vitest workers boot without that side effect).
beforeAll(() => {
  setCliBinding({ binName: "first-tree", packageName: "first-tree" });
});

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
      serverUrl: "http://hub.test",
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
      serverUrl: "http://hub.test",
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
      serverUrl: "http://hub.test",
    });

    expect(existsSync(join(workspacePath, "AGENTS.md"))).toBe(false);
  });
});
