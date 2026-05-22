import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createCommandContext } from "../src/commands/context.js";
import { registerSubcommands } from "../src/commands/groups.js";
import {
  isGitHubScanHelpRequest,
  readTreeRepoArg,
  requiresGitHubScanBinding,
  resolveGitHubScanBinding,
  stripTreeRepoArg,
} from "../src/commands/github/scan-binding.js";
import { inspectCurrentWorkingTree, runInspectCommand } from "../src/commands/tree/inspect.js";
import { buildSourceIntegrationBlock } from "../src/commands/tree/source-integration.js";
import { runStatusCommand } from "../src/commands/tree/status.js";
import type { CommandContext, SubcommandModule } from "../src/commands/types.js";

const tempDirs: string[] = [];
const originalCwd = process.cwd();
const testFileDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testFileDir, "..", "..", "..");

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "first-tree-helpers-"));
  tempDirs.push(dir);
  return dir;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(originalCwd);

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();

    if (dir !== undefined) {
      rmSync(dir, { force: true, recursive: true });
    }
  }
});

describe("registerSubcommands", () => {
  it("applies alias and summary when they are provided", () => {
    const program = new Command();
    const group = program.command("example");

    const subcommands: SubcommandModule[] = [
      {
        name: "status",
        alias: "stat",
        summary: "Short summary",
        description: "Long description",
        action: () => {},
      },
    ];

    registerSubcommands(group, subcommands);

    const registered = group.commands[0];
    expect(registered?.name()).toBe("status");
    expect(registered?.aliases()).toEqual(["stat"]);
    expect(registered?.summary()).toBe("Short summary");
    expect(registered?.description()).toBe("Long description");
  });

  it("leaves alias and summary empty when they are omitted", () => {
    const program = new Command();
    const group = program.command("example");

    registerSubcommands(group, [
      {
        name: "inspect",
        alias: "",
        summary: "",
        description: "Inspect",
        action: () => {},
      },
    ]);

    const registered = group.commands[0];
    expect(registered?.aliases()).toEqual([]);
    expect(registered?.summary()).toBe("");
  });
});

describe("createCommandContext", () => {
  it("returns default options when no raw argv is available", () => {
    const program = new Command();
    program.name("first-tree").option("--json").option("--debug").option("--quiet");
    const command = program.command("probe");

    const context = createCommandContext(command);

    expect(context.options).toEqual({
      json: false,
      debug: false,
      quiet: false,
    });
  });
});

describe("shipped github-scan skill payloads", () => {
  it("keeps the repo-root and package-local copies in sync", () => {
    const repoSkillRoot = resolve(repoRoot, "skills", "github-scan");
    const packageSkillRoot = resolve(repoRoot, "packages", "github-scan", "skills", "github-scan");

    for (const relativePath of ["SKILL.md", "VERSION", join("agents", "openai.yaml")]) {
      expect(readFileSync(join(repoSkillRoot, relativePath), "utf8")).toBe(
        readFileSync(join(packageSkillRoot, relativePath), "utf8"),
      );
    }
  });
});

describe("inspectCurrentWorkingTree", () => {
  it("classifies a plain folder", () => {
    const root = makeTempDir();
    const result = inspectCurrentWorkingTree(root);

    expect(result.classification).toBe("folder");
    expect(result.role).toBe("unknown");
    expect(result.rootKind).toBe("folder");
    expect(result.rootPath).toBe(root);
  });

  it("classifies an unbound workspace-like folder via role", () => {
    const root = makeTempDir();
    mkdirSync(join(root, "repo-a"));
    mkdirSync(join(root, "repo-b"));
    writeFileSync(join(root, "repo-a", ".git"), "gitdir: /tmp/a\n");
    writeFileSync(join(root, "repo-b", ".git"), "gitdir: /tmp/b\n");

    const result = inspectCurrentWorkingTree(root);

    expect(result.classification).toBe("folder");
    expect(result.role).toBe("unbound-workspace-root");
  });

  it("classifies a workspace root from source binding metadata", () => {
    const root = makeTempDir();
    writeFileSync(join(root, ".git"), "gitdir: /tmp/mock\n");
    writeFileSync(
      join(root, "AGENTS.md"),
      `${buildSourceIntegrationBlock("context", {
        bindingMode: "workspace-root",
        entrypoint: "members/platform",
        treeMode: "shared",
        treeRepoUrl: "git@github.com:acme/context.git",
      })}\n`,
    );

    const result = inspectCurrentWorkingTree(root);

    expect(result.classification).toBe("workspace-root");
    expect(result.role).toBe("workspace-root-bound");
    expect(result.binding?.treeRepo).toBe("acme/context");
    expect(result.binding?.treeEntrypoint).toBe("members/platform");
    expect(result.binding?.treeMode).toBe("shared");
  });

  it("classifies a tree repo from tree metadata", () => {
    const root = makeTempDir();
    mkdirSync(join(root, ".first-tree"), { recursive: true });
    mkdirSync(join(root, "members"), { recursive: true });
    writeFileSync(join(root, ".git"), "gitdir: /tmp/mock\n");
    writeFileSync(join(root, "NODE.md"), "# root node\n");
    writeFileSync(join(root, "members", "NODE.md"), "# members\n");
    writeJson(join(root, ".first-tree", "tree.json"), {
      treeRepoName: "first-tree-context",
    });

    const result = inspectCurrentWorkingTree(root);

    expect(result.classification).toBe("tree-repo");
    expect(result.role).toBe("tree-repo");
    expect(result.binding?.treeRepoName).toBe("first-tree-context");
    expect(result.treeStatePath).toBe(join(root, ".first-tree", "tree.json"));
  });
});

describe("runInspectCommand", () => {
  const baseContext: CommandContext = {
    command: new Command("inspect"),
    options: {
      debug: false,
      json: false,
      quiet: false,
    },
  };

  it("prints human-readable output with binding details", () => {
    const root = makeTempDir();
    writeFileSync(join(root, ".git"), "gitdir: /tmp/mock\n");
    writeFileSync(
      join(root, "AGENTS.md"),
      `${buildSourceIntegrationBlock("context", {
        bindingMode: "shared-source",
        entrypoint: ".",
        treeMode: "shared",
        treeRepoName: "context",
        treeRepoUrl: "https://github.com/acme/context.git",
      })}\n`,
    );

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    process.chdir(root);

    runInspectCommand(baseContext);

    expect(log).toHaveBeenCalledOnce();
    expect(String(log.mock.calls[0]?.[0])).toContain("role: source-repo-bound");
    expect(String(log.mock.calls[0]?.[0])).toContain("classification: source-repo");
    expect(String(log.mock.calls[0]?.[0])).toContain("tree repo: acme/context");
    expect(String(log.mock.calls[0]?.[0])).toContain("tree entrypoint: .");
  });

  it("prints JSON output when requested", () => {
    const root = makeTempDir();
    mkdirSync(join(root, ".first-tree"), { recursive: true });
    writeJson(join(root, ".first-tree", "tree.json"), {
      treeRepoName: "context",
    });
    writeFileSync(join(root, "NODE.md"), "# node\n");
    mkdirSync(join(root, "members"), { recursive: true });
    writeFileSync(join(root, "members", "NODE.md"), "# members\n");

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    process.chdir(root);

    runInspectCommand({
      ...baseContext,
      options: {
        ...baseContext.options,
        json: true,
      },
    });

    expect(log).toHaveBeenCalledOnce();
    expect(String(log.mock.calls[0]?.[0])).toContain('"role": "tree-repo"');
    expect(String(log.mock.calls[0]?.[0])).toContain('"classification": "tree-repo"');
  });

  it("prints tree repo name when only tree metadata is available", () => {
    const root = makeTempDir();
    mkdirSync(join(root, ".first-tree"), { recursive: true });
    writeJson(join(root, ".first-tree", "tree.json"), {
      treeRepoName: "context",
    });

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    process.chdir(root);

    runInspectCommand(baseContext);

    expect(String(log.mock.calls[0]?.[0])).toContain("tree repo name: context");
    expect(String(log.mock.calls[0]?.[0])).toContain("tree state:");
  });

  it("lets status delegate to inspect output", () => {
    const root = makeTempDir();
    writeFileSync(join(root, ".git"), "gitdir: /tmp/mock\n");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    process.chdir(root);

    runStatusCommand(baseContext);

    expect(log).toHaveBeenCalledOnce();
    expect(String(log.mock.calls[0]?.[0])).toContain("first-tree tree inspect");
  });
});

describe("github scan binding helpers", () => {
  it("detects help requests in both root and subcommand position", () => {
    expect(isGitHubScanHelpRequest([])).toBe(true);
    expect(isGitHubScanHelpRequest(["--help"])).toBe(true);
    expect(isGitHubScanHelpRequest(["poll", "--help"])).toBe(true);
    expect(isGitHubScanHelpRequest(["poll"])).toBe(false);
  });

  it("knows which github scan subcommands require a tree binding", () => {
    expect(requiresGitHubScanBinding("poll")).toBe(true);
    expect(requiresGitHubScanBinding("start")).toBe(true);
    expect(requiresGitHubScanBinding("status")).toBe(false);
    expect(requiresGitHubScanBinding(undefined)).toBe(false);
  });

  it("reads and strips --tree-repo in both supported forms", () => {
    expect(readTreeRepoArg(["poll", "--tree-repo", "acme/context"])).toBe("acme/context");
    expect(readTreeRepoArg(["poll", "--tree-repo=acme/context"])).toBe("acme/context");
    expect(
      stripTreeRepoArg(["poll", "--tree-repo", "acme/context", "--allow-repo", "acme/*"]),
    ).toEqual(["poll", "--allow-repo", "acme/*"]);
    expect(stripTreeRepoArg(["poll", "--tree-repo=acme/context"])).toEqual(["poll"]);
  });

  it("rejects an invalid explicit tree repo override", () => {
    const result = resolveGitHubScanBinding(["poll", "--tree-repo", "not a repo"]);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Invalid `--tree-repo` value");
  });

  it("resolves binding data from source.json", () => {
    const root = makeTempDir();
    writeFileSync(
      join(root, "AGENTS.md"),
      `${buildSourceIntegrationBlock("context", {
        bindingMode: "shared-source",
        entrypoint: "/repos/app",
        treeMode: "shared",
        treeRepoName: "context",
        treeRepoUrl: "https://github.com/acme/context.git",
      })}\n`,
    );
    process.chdir(root);

    const result = resolveGitHubScanBinding(["poll"]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toBe("managed-file");
      expect(result.treeRepo).toBe("acme/context");
      expect(result.treeRepoName).toBe("context");
      expect(result.managedBindingPath?.endsWith("/AGENTS.md")).toBe(true);
    }
  });

  it("falls back to source.json when managed binding files are absent", () => {
    const root = makeTempDir();
    mkdirSync(join(root, ".first-tree"), { recursive: true });
    writeJson(join(root, ".first-tree", "source.json"), {
      tree: {
        treeRepo: "acme/context",
        treeRepoName: "context",
      },
    });
    process.chdir(root);

    const result = resolveGitHubScanBinding(["poll"]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toBe("source-state");
      expect(result.treeRepo).toBe("acme/context");
      expect(result.sourceStatePath?.endsWith("/.first-tree/source.json")).toBe(true);
    }
  });

  it("accepts remote URLs and tree_repo legacy fields from source.json", () => {
    const root = makeTempDir();
    mkdirSync(join(root, ".first-tree"), { recursive: true });
    writeJson(join(root, ".first-tree", "source.json"), {
      tree_repo: "acme/context",
      tree: {
        remoteUrl: "https://github.com/acme/context.git",
      },
    });
    process.chdir(root);

    const result = resolveGitHubScanBinding(["start"]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.treeRepo).toBe("acme/context");
    }
  });

  it("fails closed when source.json exists but does not contain tree binding data", () => {
    const root = makeTempDir();
    mkdirSync(join(root, ".first-tree"), { recursive: true });
    writeJson(join(root, ".first-tree", "source.json"), {
      bindingMode: "shared-source",
    });
    process.chdir(root);

    const result = resolveGitHubScanBinding(["poll"]);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("AGENTS.md");
  });

  it("returns an actionable error when no binding metadata exists", () => {
    const root = makeTempDir();
    process.chdir(root);

    const result = resolveGitHubScanBinding(["run"]);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("first-tree github scan requires a bound tree repo");
    expect(result.error).toContain("first-tree tree bind");
  });
});
