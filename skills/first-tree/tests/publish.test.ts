import { join, relative } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Repo } from "#skill/engine/repo.js";
import {
  PUBLISH_USAGE,
  parsePublishArgs,
  runPublish,
  type CommandRunner,
} from "#skill/engine/publish.js";
import { writeBootstrapState } from "#skill/engine/runtime/bootstrap.js";
import {
  AGENT_INSTRUCTIONS_FILE,
  CLAUDE_INSTRUCTIONS_FILE,
  LOCAL_TREE_CONFIG,
} from "#skill/engine/runtime/asset-loader.js";
import { buildSourceIntegrationBlock } from "#skill/engine/runtime/source-integration.js";
import {
  makeAgentsMd,
  makeClaudeMd,
  makeFramework,
  makeGitRepo,
  makeMembers,
  makeNode,
  makeSourceRepo,
  makeTreeMetadata,
  useTmpDir,
} from "./helpers.js";

interface RecordedCommand {
  args: string[];
  command: string;
  cwd: string;
}

function makeTreeRepo(root: string): void {
  makeGitRepo(root);
  makeTreeMetadata(root, "0.2.0");
  makeNode(root);
  makeAgentsMd(root, { markers: true });
  makeClaudeMd(root, { markers: true });
  makeMembers(root);
}

function makeSourceIntegration(root: string): void {
  writeFileSync(
    join(root, AGENT_INSTRUCTIONS_FILE),
    buildSourceIntegrationBlock("ADHD-context"),
  );
  writeFileSync(
    join(root, CLAUDE_INSTRUCTIONS_FILE),
    buildSourceIntegrationBlock("ADHD-context"),
  );
}

function createRunner(
  sourceRoot: string,
  treeRoot: string,
  treeRepoName: string,
): { calls: RecordedCommand[]; runner: CommandRunner } {
  const calls: RecordedCommand[] = [];
  let treeOriginExists = false;
  const runner: CommandRunner = (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd });

    if (command === "git" && args[0] === "remote" && args[1] === "get-url") {
      if (options.cwd === sourceRoot) {
        return "git@github.com:acme/ADHD.git";
      }
      if (!treeOriginExists) {
        throw new Error("missing origin");
      }
      return `git@github.com:acme/${treeRepoName}.git`;
    }

    if (command === "gh" && args[0] === "repo" && args[1] === "view") {
      if (args[2] === "acme/ADHD") {
        return JSON.stringify({
          defaultBranchRef: { name: "main" },
          nameWithOwner: "acme/ADHD",
          visibility: "PRIVATE",
        });
      }
      throw new Error("not found");
    }

    if (
      command === "git"
      && args[0] === "rev-parse"
      && args[1] === "--verify"
      && args[2] === "HEAD"
      && options.cwd === treeRoot
    ) {
      throw new Error("missing HEAD");
    }

    if (
      command === "git"
      && args[0] === "diff"
      && args[1] === "--cached"
      && args[2] === "--quiet"
    ) {
      throw new Error("changes present");
    }

    if (command === "git" && args[0] === "branch" && args[1] === "--show-current") {
      return "main";
    }

    if (
      command === "git"
      && args[0] === "rev-parse"
      && args[1] === "--verify"
      && args[2] === "refs/remotes/origin/main"
    ) {
      return "origin/main";
    }

    if (
      command === "git"
      && args[0] === "rev-parse"
      && args[1] === "--verify"
      && args[2].startsWith("refs/heads/")
    ) {
      throw new Error("missing local branch");
    }

    if (command === "gh" && args[0] === "pr" && args[1] === "create") {
      return "https://github.com/acme/ADHD/pull/123";
    }

    if (command === "gh" && args[0] === "repo" && args[1] === "create") {
      treeOriginExists = true;
      return "";
    }

    if (command === "git" && args[0] === "remote" && args[1] === "add") {
      treeOriginExists = true;
      return "";
    }

    return "";
  };

  return { calls, runner };
}

describe("parsePublishArgs", () => {
  it("documents the publish command", () => {
    expect(PUBLISH_USAGE).toContain("first-tree publish");
    expect(PUBLISH_USAGE).toContain("--open-pr");
    expect(PUBLISH_USAGE).toContain("--source-repo PATH");
  });

  it("parses supported publish flags", () => {
    expect(
      parsePublishArgs([
        "--open-pr",
        "--tree-path",
        "../ADHD-tree",
        "--source-repo",
        "../ADHD",
        "--source-remote",
        "origin",
      ]),
    ).toEqual({
      openPr: true,
      sourceRemote: "origin",
      sourceRepoPath: "../ADHD",
      treePath: "../ADHD-tree",
    });
  });
});

describe("runPublish", () => {
  it("publishes the tree repo, records the GitHub URL, and opens the source PR", () => {
    const rootDir = useTmpDir();
    const sourceRoot = join(rootDir.path, "ADHD");
    const treeRoot = join(rootDir.path, "ADHD-tree");

    makeSourceRepo(sourceRoot);
    makeFramework(sourceRoot, "0.2.0");
    makeSourceIntegration(sourceRoot);
    makeTreeRepo(treeRoot);
    writeBootstrapState(treeRoot, {
      sourceRepoName: "ADHD",
      sourceRepoPath: relative(treeRoot, sourceRoot),
      treeRepoName: "ADHD-tree",
    });

    const { calls, runner } = createRunner(sourceRoot, treeRoot, "ADHD-tree");
    const result = runPublish(new Repo(treeRoot), {
      commandRunner: runner,
      openPr: true,
    });

    expect(result).toBe(0);
    expect(
      calls.some(
        (call) =>
          call.command === "gh"
          && call.args[0] === "repo"
          && call.args[1] === "create"
          && call.args[2] === "acme/ADHD-tree",
      ),
    ).toBe(true);
    expect(
      calls.some(
        (call) =>
          call.command === "git"
          && call.args[0] === "switch"
          && call.args[1] === "-c"
          && call.args[2] === "chore/connect-adhd-tree",
      ),
    ).toBe(true);
    expect(
      calls.some(
        (call) =>
          call.command === "gh"
          && call.args[0] === "pr"
          && call.args[1] === "create"
          && call.args.includes("--repo")
          && call.args.includes("acme/ADHD"),
      ),
    ).toBe(true);
    expect(
      readFileSync(join(sourceRoot, AGENT_INSTRUCTIONS_FILE), "utf-8"),
    ).toContain("FIRST-TREE-TREE-REPO-URL: `git@github.com:acme/ADHD-tree.git`");
    expect(
      JSON.parse(readFileSync(join(sourceRoot, LOCAL_TREE_CONFIG), "utf-8")),
    ).toEqual({
      localPath: "../ADHD-tree",
      treeRepoName: "ADHD-tree",
      treeRepoUrl: "git@github.com:acme/ADHD-tree.git",
    });
    expect(readFileSync(join(sourceRoot, ".gitignore"), "utf-8")).toContain(
      ".first-tree/local-tree.json",
    );
  });

  it("creates a sibling local checkout when the published tree repo is elsewhere", () => {
    const rootDir = useTmpDir();
    const sourceRoot = join(rootDir.path, "ADHD");
    const bootstrapRoot = join(rootDir.path, "bootstrap", "ADHD-tree");

    makeSourceRepo(sourceRoot);
    makeFramework(sourceRoot, "0.2.0");
    makeSourceIntegration(sourceRoot);
    makeTreeRepo(bootstrapRoot);
    writeBootstrapState(bootstrapRoot, {
      sourceRepoName: "ADHD",
      sourceRepoPath: relative(bootstrapRoot, sourceRoot),
      treeRepoName: "ADHD-tree",
    });

    const { calls, runner } = createRunner(sourceRoot, bootstrapRoot, "ADHD-tree");
    const result = runPublish(new Repo(bootstrapRoot), {
      commandRunner: runner,
    });

    expect(result).toBe(0);
    expect(
      calls.some(
        (call) =>
          call.command === "git"
          && call.args[0] === "clone"
          && call.args[1] === "git@github.com:acme/ADHD-tree.git"
          && call.args[2] === join(rootDir.path, "ADHD-tree"),
      ),
    ).toBe(true);
    expect(
      JSON.parse(readFileSync(join(sourceRoot, LOCAL_TREE_CONFIG), "utf-8")),
    ).toEqual({
      localPath: "../ADHD-tree",
      treeRepoName: "ADHD-tree",
      treeRepoUrl: "git@github.com:acme/ADHD-tree.git",
    });
  });

  it("still infers the source repo from a legacy context repo name", () => {
    const rootDir = useTmpDir();
    const sourceRoot = join(rootDir.path, "ADHD");
    const treeRoot = join(rootDir.path, "ADHD-context");

    makeSourceRepo(sourceRoot);
    makeFramework(sourceRoot, "0.2.0");
    makeSourceIntegration(sourceRoot);
    makeTreeRepo(treeRoot);

    const { calls, runner } = createRunner(sourceRoot, treeRoot, "ADHD-context");
    const result = runPublish(new Repo(treeRoot), {
      commandRunner: runner,
    });

    expect(result).toBe(0);
    expect(
      calls.some(
        (call) =>
          call.command === "gh"
          && call.args[0] === "repo"
          && call.args[1] === "create"
          && call.args[2] === "acme/ADHD-context",
      ),
    ).toBe(true);
  });

  it("errors when the source repo cannot be inferred", () => {
    const treeRoot = useTmpDir();
    makeTreeRepo(treeRoot.path);

    const result = runPublish(new Repo(treeRoot.path));

    expect(result).toBe(1);
  });
});
