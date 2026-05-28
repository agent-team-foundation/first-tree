import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeSourceState, writeTreeState } from "../commands/tree/binding-state.js";
import { verifyCommand } from "../commands/tree/verify.js";
import type { CommandContext } from "../commands/types.js";

describe("tree verify command", () => {
  let tmp: string;
  let originalExitCode: typeof process.exitCode;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "first-tree-verify-"));
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    rmSync(tmp, { recursive: true, force: true });
  });

  function write(relPath: string, content: string): void {
    const fullPath = join(tmp, relPath);
    mkdirSync(join(fullPath, ".."), { recursive: true });
    writeFileSync(fullPath, content);
  }

  function commandContext(args: string[], json = false): CommandContext {
    const command = new Command();
    verifyCommand.configure?.(command);
    command.parse(["node", "verify", ...args], { from: "node" });
    return { command, options: { debug: false, json, quiet: false } };
  }

  function writeValidTree(): void {
    write("NODE.md", "---\ntitle: Root\nowners: [alice]\n---\n\n# Root\n");
    write(
      "members/alice/NODE.md",
      "---\ntitle: Alice\nowners: [alice]\ntype: human\nrole: Engineer\ndomains:\n  - Platform\n---\n",
    );
    write("AGENTS.md", "# Tree\n\n<!-- BEGIN CONTEXT-TREE FRAMEWORK -->\n<!-- END CONTEXT-TREE FRAMEWORK -->\n");
    write("CLAUDE.md", "# Tree\n");
    write(".first-tree/VERSION", "1\n");
    writeTreeState(tmp, {
      published: { remoteUrl: "https://github.com/example/tree" },
      treeId: "tree",
      treeMode: "shared",
      treeRepoName: "tree",
    });
  }

  it("prints a successful JSON summary for a valid tree root", () => {
    writeValidTree();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    verifyCommand.action(commandContext(["--tree-path", tmp], true));

    const output = String(log.mock.calls[0]?.[0] ?? "");
    const parsed = JSON.parse(output);
    expect(parsed.ok).toBe(true);
    expect(parsed.targetRoot).toBe(tmp);
    expect(parsed.checks.progress.uncheckedItems).toEqual([]);
    expect(process.exitCode).toBeUndefined();
    log.mockRestore();
  });

  it("reports failed checks and unchecked progress items", () => {
    write("NODE.md", "# Missing frontmatter\n");
    write("AGENTS.md", "# Missing framework marker\n");
    write("CLAUDE.md", "# Companion\n");
    write(".first-tree/progress.md", "- [ ] publish tree\n- [x] done\n- [ ] bind workspace\n");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    verifyCommand.action(commandContext(["--tree-path", tmp]));

    const output = log.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
    expect(output).toContain("[FAIL] framework version");
    expect(output).toContain("Root NODE.md is missing frontmatter.");
    expect(output).toContain("Unchecked progress item: publish tree");
    expect(process.exitCode).toBe(1);
    log.mockRestore();
  });

  it("explains when verify is pointed at a source repo binding", () => {
    writeSourceState(tmp, {
      bindingMode: "workspace-member",
      rootKind: "git-repo",
      scope: "workspace",
      sourceId: "api",
      sourceName: "api",
      tree: {
        entrypoint: "/workspaces/app/repos/api",
        remoteUrl: "https://github.com/example/tree",
        treeId: "tree",
        treeMode: "shared",
        treeRepoName: "tree",
      },
      workspaceId: "app",
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    verifyCommand.action(commandContext(["--tree-path", tmp]));

    expect(error).toHaveBeenCalledWith(expect.stringContaining("Verify the tree repo instead"));
    expect(process.exitCode).toBe(1);
    error.mockRestore();
  });
});
