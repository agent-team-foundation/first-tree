import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeTreeState } from "../commands/tree/binding-state.js";
import { syncTreeIdentityFiles } from "../commands/tree/tree-identity.js";
import type { CommandContext } from "../commands/types.js";

const runCommandMock = vi.hoisted(() => vi.fn());

vi.mock("../commands/tree/shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../commands/tree/shared.js")>();
  return {
    ...actual,
    runCommand: runCommandMock,
  };
});

let root = "";
const tempDirs: string[] = [];
const originalCwd = process.cwd();

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeGitRepo(target: string, remote = "https://github.com/acme/context-tree.git"): void {
  mkdirSync(join(target, ".git", "refs", "heads"), { recursive: true });
  mkdirSync(join(target, ".git", "objects"), { recursive: true });
  writeFileSync(join(target, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(
    join(target, ".git", "config"),
    `[core]\n  repositoryformatversion = 0\n[remote "origin"]\n  url = ${remote}\n`,
  );
}

function writeTreeRoot(target: string): void {
  mkdirSync(target, { recursive: true });
  makeGitRepo(target);
  writeFileSync(join(target, "NODE.md"), "# Context Tree\n");
  writeFileSync(join(target, "AGENTS.md"), "BEGIN CONTEXT-TREE FRAMEWORK\n");
  writeFileSync(join(target, "CLAUDE.md"), "BEGIN CONTEXT-TREE FRAMEWORK\n");
  writeTreeState(target, { treeId: "context-tree", treeMode: "shared", treeRepoName: "context-tree" });
  syncTreeIdentityFiles(target, {
    publishedTreeUrl: "https://github.com/acme/context-tree.git",
    treeMode: "shared",
    treeRepoName: "context-tree",
  });
}

function commandWithOptions(options: Record<string, unknown>): Command {
  const command = new Command("test");
  for (const [key, value] of Object.entries(options)) {
    command.setOptionValue(key, value);
  }
  return command;
}

function context(command: Command, json = false): CommandContext {
  return { command, options: { debug: false, json, quiet: false } };
}

beforeEach(() => {
  vi.clearAllMocks();
  root = makeTempDir("ft-tree-actions-mocked-");
  writeTreeRoot(root);
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  writeFileSync(join(root, ".github", "workflows", "auto-merge.yml"), "# first-tree-template-version: 99\n");
  writeFileSync(join(root, ".github", "workflows", "review-enforcer.yml"), "# first-tree-template-version: 99\n");
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  process.exitCode = undefined;
  process.chdir(root);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(originalCwd);
  process.exitCode = undefined;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("tree command actions with mocked shell runner", () => {
  it("prints automation summaries in human and JSON modes", async () => {
    const workflowContent = Buffer.from("# first-tree-template-version: 99\nname: managed\n").toString("base64");
    runCommandMock.mockImplementation((command: string, args: string[]) => {
      if (command === "gh" && args[0] === "api" && args[1] === "repos/acme/context-tree") {
        return JSON.stringify({ default_branch: "main" });
      }
      if (command === "gh" && args[0] === "api" && args[1] === "repos/acme/context-tree/installation") return "{}";
      if (command === "gh" && args[0] === "api" && String(args[1]).includes("/contents/")) return workflowContent;
      if (command === "gh" && args[0] === "api" && String(args[1]).includes("/rulesets?")) {
        return JSON.stringify([
          {
            enforcement: "active",
            id: 42,
            name: "first-tree owners gate",
            target: "branch",
          },
        ]);
      }
      return "";
    });
    const { automationSubcommands } = await import("../commands/tree/automation.js");

    automationSubcommands[0]?.action(context(commandWithOptions({ tier: "2", treePath: root }), false));
    const human = vi
      .mocked(console.log)
      .mock.calls.map((call) => String(call[0]))
      .join("\n");
    expect(human).toContain("Context Tree Automation");
    expect(human).toContain("Ruleset:");
    expect(human).toContain("Workflows:");

    vi.mocked(console.log).mockClear();
    automationSubcommands[0]?.action(context(commandWithOptions({ dryRun: true, tier: "2", treePath: root }), true));
    const payload = JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0])) as { stage: string };
    expect(payload.stage).toBe("configured");
  });

  it("prints publish human and JSON summaries through the command action", async () => {
    runCommandMock.mockImplementation((command: string, args: string[]) => {
      if (command === "git" && args.join(" ") === "remote get-url origin") {
        return "https://github.com/acme/context-tree.git";
      }
      return "";
    });
    const { publishCommand } = await import("../commands/tree/publish.js");

    publishCommand.action(context(commandWithOptions({}), false));
    const human = vi
      .mocked(console.log)
      .mock.calls.map((call) => String(call[0]))
      .join("\n");
    expect(human).toContain("Context Tree Publish");
    expect(human).toContain("No local source roots were refreshed");

    vi.mocked(console.log).mockClear();
    publishCommand.action(context(commandWithOptions({ treePath: root }), true));
    const payload = JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0])) as { publishedTreeUrl: string };
    expect(payload.publishedTreeUrl).toBe("https://github.com/acme/context-tree.git");
  });
});
