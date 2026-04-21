import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { format } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../../src/cli.js";
import {
  AGENT_INSTRUCTIONS_FILE,
  CLAUDE_INSTRUCTIONS_FILE,
  FIRST_TREE_INDEX_FILE,
  SOURCE_STATE,
  TREE_PROGRESS,
} from "#products/tree/engine/runtime/asset-loader.js";
import {
  readSourceState,
  readTreeBinding,
  readTreeState,
  readWorkspaceState,
} from "#products/tree/engine/runtime/binding-state.js";
import { readLocalTreeConfig } from "#products/tree/engine/runtime/local-tree-config.js";
import { makeMembers, makeSourceRepo, useTmpDir } from "../helpers.js";

const ORIGINAL_CWD = process.cwd();
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_PATH = process.env.PATH;

interface CliRunResult {
  code: number;
  stderr: string;
  stdout: string;
}

interface FakeGitState {
  currentBranch: string;
  hasCommit: boolean;
  localBranches: string[];
  remoteBranches: string[];
  remotes: Record<string, string>;
  stagedChanges: boolean;
}

afterEach(() => {
  process.chdir(ORIGINAL_CWD);
  if (ORIGINAL_HOME === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = ORIGINAL_HOME;
  }
  if (ORIGINAL_PATH === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = ORIGINAL_PATH;
  }
  delete process.env.FAKE_GH_STATE;
  delete process.env.FAKE_GH_SOURCE_DEFAULT_BRANCH;
  delete process.env.FAKE_GH_SOURCE_SLUG;
  delete process.env.FAKE_GH_SOURCE_VISIBILITY;
});

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

async function runCliCaptured(
  cwd: string,
  args: string[],
  envOverrides?: Record<string, string>,
): Promise<CliRunResult> {
  const previousCwd = process.cwd();
  const previousEnv = new Map<string, string | undefined>();
  const stdout: string[] = [];
  const stderr: string[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => {
    stdout.push(format(...values));
  });
  const errorSpy = vi.spyOn(console, "error").mockImplementation((...values: unknown[]) => {
    stderr.push(format(...values));
  });

  process.chdir(cwd);
  for (const [key, value] of Object.entries(envOverrides ?? {})) {
    previousEnv.set(key, process.env[key]);
    process.env[key] = value;
  }

  try {
    const code = await runCli(args);
    return {
      code,
      stderr: stderr.join("\n"),
      stdout: stdout.join("\n"),
    };
  } finally {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    process.chdir(previousCwd);
    for (const [key, value] of previousEnv) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function addMemberNode(treeRoot: string, memberName = "member-0"): void {
  makeMembers(treeRoot, 1);
  writeFileSync(
    join(treeRoot, "members", "NODE.md"),
    [
      "---",
      'title: "Members"',
      "owners: [tree-owner]",
      "---",
      "",
      "# Members",
      "",
      "People and agents participating in this smoke-test tree.",
      "",
    ].join("\n"),
  );
  const memberRoot = join(treeRoot, "members", memberName);
  mkdirSync(memberRoot, { recursive: true });
  writeFileSync(
    join(memberRoot, "NODE.md"),
    [
      "---",
      'title: "Member 0"',
      "owners: [member-0]",
      "type: human",
      "role: Engineer",
      "domains:",
      "  - engineering",
      "---",
      "",
      "# Member 0",
      "",
      "## About",
      "",
      "Bootstrapped for smoke tests.",
      "",
      "## Current Focus",
      "",
      "Keeping the tree healthy.",
      "",
    ].join("\n"),
  );
}

function customizeTreeRoot(treeRoot: string): void {
  writeFileSync(
    join(treeRoot, "NODE.md"),
    [
      "---",
      'title: "Example Org"',
      "owners: [tree-owner]",
      "---",
      "",
      "# Example Org",
      "",
      "A compact but valid smoke-test tree for end-to-end CLI verification.",
      "",
      "## Domains",
      "",
      "- **[members/](members/NODE.md)** — Test collaborators.",
      "",
    ].join("\n"),
  );
}

function markChecklistComplete(treeRoot: string): void {
  const progressPath = join(treeRoot, TREE_PROGRESS);
  const text = readFileSync(progressPath, "utf-8");
  writeFileSync(progressPath, text.replace(/- \[ \]/g, "- [x]"));
}

function seedFakeGitRepo(root: string, state: Partial<FakeGitState> = {}): void {
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(
    join(root, ".fake-git-state.json"),
    JSON.stringify(
      {
        currentBranch: "main",
        hasCommit: true,
        localBranches: ["main"],
        remoteBranches: ["origin/main"],
        remotes: {},
        stagedChanges: false,
        ...state,
      },
      null,
      2,
    ),
  );
}

function installFakePublishBinaries(root: string): string {
  const binDir = join(root, "fake-bin");
  mkdirSync(binDir, { recursive: true });

  writeExecutable(
    join(binDir, "git"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const cwd = process.cwd();
const args = process.argv.slice(2);

function fail(message) {
  if (message) {
    process.stderr.write(String(message));
  }
  process.exit(1);
}

function statePath(root) {
  return path.join(root, ".fake-git-state.json");
}

function loadState(root) {
  const file = statePath(root);
  if (!fs.existsSync(file)) {
    return {
      currentBranch: "main",
      hasCommit: false,
      localBranches: ["main"],
      remoteBranches: [],
      remotes: {},
      stagedChanges: false,
    };
  }
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

function saveState(root, state) {
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  fs.writeFileSync(statePath(root), JSON.stringify(state, null, 2));
}

if (args[0] === "init") {
  saveState(cwd, loadState(cwd));
  process.exit(0);
}

if (args[0] === "clone") {
  const url = args[1];
  const target = path.resolve(cwd, args[2]);
  fs.mkdirSync(target, { recursive: true });
  saveState(target, {
    currentBranch: "main",
    hasCommit: true,
    localBranches: ["main"],
    remoteBranches: ["origin/main"],
    remotes: { origin: url },
    stagedChanges: false,
  });
  process.exit(0);
}

const state = loadState(cwd);

if (args[0] === "remote" && args[1] === "get-url") {
  const remote = args[2];
  const url = state.remotes[remote];
  if (!url) {
    fail("");
  }
  process.stdout.write(String(url));
  process.exit(0);
}

if (args[0] === "remote" && args[1] === "add") {
  state.remotes[args[2]] = args[3];
  saveState(cwd, state);
  process.exit(0);
}

if (args[0] === "branch" && args[1] === "--show-current") {
  process.stdout.write(state.currentBranch);
  process.exit(0);
}

if (args[0] === "rev-parse" && args[1] === "--verify") {
  const target = args[2];
  if (target === "HEAD") {
    process.exit(state.hasCommit ? 0 : 1);
  }
  if (target.startsWith("refs/heads/")) {
    const branch = target.slice("refs/heads/".length);
    process.exit(state.localBranches.includes(branch) ? 0 : 1);
  }
  if (target.startsWith("refs/remotes/")) {
    const branch = target.slice("refs/remotes/".length);
    process.exit(state.remoteBranches.includes(branch) ? 0 : 1);
  }
  fail("");
}

if (args[0] === "diff" && args[1] === "--cached" && args[2] === "--quiet") {
  process.exit(state.stagedChanges ? 1 : 0);
}

if (args[0] === "add") {
  state.stagedChanges = true;
  saveState(cwd, state);
  process.exit(0);
}

if (args[0] === "commit") {
  state.hasCommit = true;
  state.stagedChanges = false;
  saveState(cwd, state);
  process.exit(0);
}

if (args[0] === "switch" && args[1] === "-c") {
  const branch = args[2];
  if (!state.localBranches.includes(branch)) {
    state.localBranches.push(branch);
  }
  state.currentBranch = branch;
  saveState(cwd, state);
  process.exit(0);
}

if (args[0] === "switch") {
  state.currentBranch = args[1];
  if (!state.localBranches.includes(args[1])) {
    state.localBranches.push(args[1]);
  }
  saveState(cwd, state);
  process.exit(0);
}

if (args[0] === "fetch") {
  const remote = args[1];
  const branch = args[2] || "main";
  const ref = remote + "/" + branch;
  if (!state.remoteBranches.includes(ref)) {
    state.remoteBranches.push(ref);
  }
  saveState(cwd, state);
  process.exit(0);
}

if (args[0] === "push") {
  const remote = args[1] === "-u" ? args[2] : args[1] || "origin";
  const branch = args.includes("HEAD")
    ? state.currentBranch
    : args[args.length - 1];
  const ref = remote + "/" + branch;
  if (!state.remoteBranches.includes(ref)) {
    state.remoteBranches.push(ref);
  }
  saveState(cwd, state);
  process.exit(0);
}

fail("Unsupported fake git invocation: " + args.join(" "));
`,
  );

  writeExecutable(
    join(binDir, "gh"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
const stateFile = process.env.FAKE_GH_STATE;

function fail(message) {
  if (message) {
    process.stderr.write(String(message));
  }
  process.exit(1);
}

function loadState() {
  if (!stateFile || !fs.existsSync(stateFile)) {
    return { repos: {} };
  }
  return JSON.parse(fs.readFileSync(stateFile, "utf-8"));
}

function saveState(state) {
  if (!stateFile) {
    fail("Missing FAKE_GH_STATE");
  }
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

const state = loadState();

if (args[0] === "repo" && args[1] === "view") {
  const slug = args[2];
  if (slug === process.env.FAKE_GH_SOURCE_SLUG) {
    process.stdout.write(JSON.stringify({
      defaultBranchRef: { name: process.env.FAKE_GH_SOURCE_DEFAULT_BRANCH || "main" },
      nameWithOwner: slug,
      visibility: process.env.FAKE_GH_SOURCE_VISIBILITY || "private",
    }));
    process.exit(0);
  }

  if (!state.repos[slug]) {
    process.exit(1);
  }

  process.stdout.write(JSON.stringify({
    defaultBranchRef: { name: state.repos[slug].defaultBranch || "main" },
    nameWithOwner: slug,
    visibility: state.repos[slug].visibility || "private",
  }));
  process.exit(0);
}

if (args[0] === "repo" && args[1] === "create") {
  const slug = args[2];
  const visibility = args.includes("--public")
    ? "public"
    : args.includes("--internal")
    ? "internal"
    : "private";
  state.repos[slug] = { defaultBranch: "main", visibility };
  saveState(state);

  const sourceIndex = args.indexOf("--source");
  if (sourceIndex !== -1) {
    const treeRoot = args[sourceIndex + 1];
    const gitStatePath = path.join(treeRoot, ".fake-git-state.json");
    if (fs.existsSync(gitStatePath)) {
      const gitState = JSON.parse(fs.readFileSync(gitStatePath, "utf-8"));
      gitState.remotes.origin = "git@github.com:" + slug + ".git";
      fs.writeFileSync(gitStatePath, JSON.stringify(gitState, null, 2));
    }
  }

  process.exit(0);
}

if (args[0] === "pr" && args[1] === "create") {
  const repoIndex = args.indexOf("--repo");
  const slug = repoIndex === -1 ? "unknown/unknown" : args[repoIndex + 1];
  process.stdout.write("https://github.com/" + slug + "/pull/123");
  process.exit(0);
}

fail("Unsupported fake gh invocation: " + args.join(" "));
`,
  );

  return binDir;
}

function installFakeClaude(homeRoot: string): void {
  const binDir = join(homeRoot, ".local", "bin");
  mkdirSync(binDir, { recursive: true });
  writeExecutable(
    join(binDir, "claude"),
    `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  type: "assistant",
  message: {
    content: [
      {
        type: "text",
        text: "{\\"verdict\\":\\"approve\\",\\"summary\\":\\"Smoke test review\\"}"
      }
    ]
  }
}) + "\\n");
`,
  );
}

describe.sequential("CLI e2e smoke", () => {
  it("runs the dedicated source-repo workflow through the CLI entrypoint", async () => {
    const sandbox = useTmpDir();
    const sourceRoot = join(sandbox.path, "product-repo");
    makeSourceRepo(sourceRoot);

    const inspectBefore = await runCliCaptured(sourceRoot, [
      "--skip-version-check",
      "tree", "inspect",
      "--json",
    ]);
    expect(inspectBefore.code).toBe(0);
    expect(JSON.parse(inspectBefore.stdout).classification).toBe("source-repo");

    const initResult = await runCliCaptured(sourceRoot, [
      "--skip-version-check",
      "tree", "init",
    ]);
    expect(initResult.code).toBe(0);

    const treeRoot = join(sandbox.path, "product-repo-tree");
    const sourceState = readSourceState(sourceRoot);
    expect(sourceState?.bindingMode).toBe("standalone-source");
    expect(readLocalTreeConfig(sourceRoot)?.treeRepoName).toBe("product-repo-tree");
    expect(readTreeState(treeRoot)?.treeRepoName).toBe("product-repo-tree");
    expect(readTreeBinding(treeRoot, sourceState!.sourceId)).not.toBeNull();
    expect(readFileSync(join(sourceRoot, AGENT_INSTRUCTIONS_FILE), "utf-8")).toContain(
      "FIRST-TREE-SOURCE-INTEGRATION",
    );
    expect(readFileSync(join(sourceRoot, CLAUDE_INSTRUCTIONS_FILE), "utf-8")).toContain(
      "FIRST-TREE-SOURCE-INTEGRATION",
    );
    expect(readFileSync(join(sourceRoot, FIRST_TREE_INDEX_FILE), "utf-8")).toContain(
      "First Tree — White Paper",
    );
    expect(readFileSync(join(treeRoot, ".agents", "skills", "first-tree", "SKILL.md"), "utf-8")).toContain(
      "name: first-tree",
    );

    const inspectAfter = await runCliCaptured(treeRoot, [
      "--skip-version-check",
      "tree", "inspect",
      "--json",
    ]);
    expect(inspectAfter.code).toBe(0);
    expect(JSON.parse(inspectAfter.stdout).classification).toBe("tree-repo");

    customizeTreeRoot(treeRoot);
    addMemberNode(treeRoot);
    markChecklistComplete(treeRoot);

    const verifyResult = await runCliCaptured(sourceRoot, [
      "--skip-version-check",
      "tree", "verify",
      "--tree-path",
      "../product-repo-tree",
    ]);
    expect(
      verifyResult.code,
      `stdout:\n${verifyResult.stdout}\n\nstderr:\n${verifyResult.stderr}`,
    ).toBe(0);

    const generateResult = await runCliCaptured(treeRoot, [
      "--skip-version-check",
      "tree", "generate-codeowners",
    ]);
    expect(generateResult.code).toBe(0);
    expect(readFileSync(join(treeRoot, ".github", "CODEOWNERS"), "utf-8")).toContain(
      "@tree-owner",
    );

    const codeownersCheck = await runCliCaptured(treeRoot, [
      "--skip-version-check",
      "tree", "generate-codeowners",
      "--check",
    ]);
    expect(codeownersCheck.code).toBe(0);

    const injectResult = await runCliCaptured(treeRoot, [
      "--skip-version-check",
      "tree", "inject-context",
    ]);
    expect(injectResult.code).toBe(0);
    expect(
      JSON.parse(injectResult.stdout).hookSpecificOutput.additionalContext,
    ).toContain("# Example Org");

    const upgradeSource = await runCliCaptured(sourceRoot, [
      "--skip-version-check",
      "tree", "upgrade",
    ]);
    expect(upgradeSource.code).toBe(0);

    const upgradeTree = await runCliCaptured(sourceRoot, [
      "--skip-version-check",
      "tree", "upgrade",
      "--tree-path",
      "../product-repo-tree",
    ]);
    expect(upgradeTree.code).toBe(0);
  });

  it("supports shared-tree onboarding for workspace folders and linked member repos", async () => {
    const sandbox = useTmpDir();
    const workspaceRoot = join(sandbox.path, "workspace-root");
    const treeRoot = join(sandbox.path, "org-context");
    const childOne = join(workspaceRoot, "apps", "app-one");
    const childTwo = join(workspaceRoot, "services", "service-two");
    const childThree = join(workspaceRoot, "tools", "tool-three");
    const standaloneRepo = join(sandbox.path, "standalone-repo");

    mkdirSync(workspaceRoot, { recursive: true });
    makeSourceRepo(childOne);
    makeSourceRepo(childTwo);

    const inspectWorkspace = await runCliCaptured(workspaceRoot, [
      "--skip-version-check",
      "tree", "inspect",
      "--json",
    ]);
    expect(inspectWorkspace.code).toBe(0);
    expect(JSON.parse(inspectWorkspace.stdout).classification).toBe("workspace-folder");

    const treeInit = await runCliCaptured(workspaceRoot, [
      "--skip-version-check",
      "tree", "init",
      "tree",
      "--tree-path",
      "../org-context",
    ]);
    expect(treeInit.code).toBe(0);

    const workspaceInit = await runCliCaptured(workspaceRoot, [
      "--skip-version-check",
      "tree", "init",
      "--scope",
      "workspace",
      "--tree-path",
      "../org-context",
      "--tree-mode",
      "shared",
      "--sync-members",
    ]);
    expect(workspaceInit.code).toBe(0);

    const workspaceSourceState = readSourceState(workspaceRoot);
    const workspaceState = readWorkspaceState(workspaceRoot);
    expect(workspaceSourceState?.bindingMode).toBe("workspace-root");
    expect(workspaceState?.members).toHaveLength(2);
    expect(workspaceSourceState?.rootKind).toBe("folder");
    expect(readLocalTreeConfig(workspaceRoot)?.treeMode).toBe("shared");
    expect(readFileSync(join(treeRoot, ".agents", "skills", "first-tree", "SKILL.md"), "utf-8")).toContain(
      "name: first-tree",
    );

    for (const childRoot of [childOne, childTwo]) {
      const childSourceState = readSourceState(childRoot);
      expect(childSourceState?.bindingMode).toBe("workspace-member");
      expect(childSourceState?.workspaceId).toBe("workspace-root");
      expect(readTreeBinding(treeRoot, childSourceState!.sourceId)).not.toBeNull();
      expect(readFileSync(join(childRoot, AGENT_INSTRUCTIONS_FILE), "utf-8")).toContain(
        "FIRST-TREE-SOURCE-INTEGRATION",
      );
    }

    makeSourceRepo(childThree);
    const workspaceSync = await runCliCaptured(workspaceRoot, [
      "--skip-version-check",
      "tree", "workspace",
      "sync",
      "--tree-path",
      "../org-context",
    ]);
    expect(workspaceSync.code).toBe(0);
    expect(readSourceState(childThree)?.bindingMode).toBe("workspace-member");
    expect(readWorkspaceState(workspaceRoot)?.members).toHaveLength(3);

    makeSourceRepo(standaloneRepo);
    const bindResult = await runCliCaptured(standaloneRepo, [
      "--skip-version-check",
      "tree", "bind",
      "--tree-path",
      "../org-context",
      "--tree-mode",
      "shared",
    ]);
    expect(bindResult.code).toBe(0);
    expect(readSourceState(standaloneRepo)?.bindingMode).toBe("shared-source");
    expect(readFileSync(join(standaloneRepo, FIRST_TREE_INDEX_FILE), "utf-8")).toContain(
      "First Tree — White Paper",
    );
  });

  it("publishes a tree and runs review in a fully mocked CLI environment", { timeout: 15000 }, async () => {
    const sandbox = useTmpDir();
    const sourceRoot = join(sandbox.path, "ADHD");
    const treeRoot = join(sandbox.path, "ADHD-tree");
    const fakeHome = join(sandbox.path, "fake-home");
    const ghStatePath = join(sandbox.path, "fake-gh-state.json");
    makeSourceRepo(sourceRoot);

    const initResult = await runCliCaptured(sourceRoot, [
      "--skip-version-check",
      "tree", "init",
    ]);
    expect(initResult.code).toBe(0);

    seedFakeGitRepo(sourceRoot, {
      hasCommit: true,
      remotes: {
        origin: "git@github.com:acme/ADHD.git",
      },
    });
    seedFakeGitRepo(treeRoot, {
      hasCommit: false,
    });
    writeFileSync(ghStatePath, JSON.stringify({ repos: {} }, null, 2));
    installFakeClaude(fakeHome);
    const fakeBinDir = installFakePublishBinaries(sandbox.path);
    const env = {
      FAKE_GH_SOURCE_DEFAULT_BRANCH: "main",
      FAKE_GH_SOURCE_SLUG: "acme/ADHD",
      FAKE_GH_SOURCE_VISIBILITY: "private",
      FAKE_GH_STATE: ghStatePath,
      HOME: fakeHome,
      PATH: `${fakeBinDir}:${ORIGINAL_PATH ?? ""}`,
    };

    const publishResult = await runCliCaptured(sourceRoot, [
      "--skip-version-check",
      "tree", "publish",
      "--tree-path",
      "../ADHD-tree",
      "--open-pr",
    ], env);
    expect(publishResult.code).toBe(0);
    expect(readTreeState(treeRoot)?.published?.remoteUrl).toBe(
      "git@github.com:acme/ADHD-tree.git",
    );
    expect(readLocalTreeConfig(sourceRoot)?.treeRepoUrl).toBe(
      "git@github.com:acme/ADHD-tree.git",
    );
    expect(readFileSync(join(sourceRoot, AGENT_INSTRUCTIONS_FILE), "utf-8")).toContain(
      "git@github.com:acme/ADHD-tree.git",
    );
    expect(
      JSON.parse(readFileSync(join(sourceRoot, SOURCE_STATE), "utf-8")).tree.remoteUrl,
    ).toBe("git@github.com:acme/ADHD-tree.git");

    const diffPath = join(sandbox.path, "pr.diff");
    const outputPath = join(sandbox.path, "review.json");
    writeFileSync(diffPath, "diff --git a/example.ts b/example.ts\n");

    const reviewResult = await runCliCaptured(treeRoot, [
      "--skip-version-check",
      "tree", "review",
      "--diff",
      diffPath,
      "--output",
      outputPath,
    ], env);
    expect(reviewResult.code).toBe(0);
    expect(JSON.parse(readFileSync(outputPath, "utf-8"))).toEqual({
      verdict: "approve",
      summary: "Smoke test review",
    });
  });

  it("classifies and onboards a git-backed workspace root with shared-tree members", async () => {
    const sandbox = useTmpDir();
    const workspaceRoot = join(sandbox.path, "git-workspace");
    const treeRoot = join(sandbox.path, "git-workspace-tree");
    const childRepo = join(workspaceRoot, "packages", "feature-repo");

    makeSourceRepo(workspaceRoot);
    makeSourceRepo(childRepo);

    const inspectWorkspace = await runCliCaptured(workspaceRoot, [
      "--skip-version-check",
      "tree", "inspect",
      "--json",
    ]);
    expect(inspectWorkspace.code).toBe(0);
    expect(JSON.parse(inspectWorkspace.stdout).classification).toBe("workspace-repo");

    const initTree = await runCliCaptured(workspaceRoot, [
      "--skip-version-check",
      "tree", "init",
      "tree",
      "--tree-path",
      "../git-workspace-tree",
    ]);
    expect(initTree.code).toBe(0);

    const initWorkspace = await runCliCaptured(workspaceRoot, [
      "--skip-version-check",
      "tree", "init",
      "--scope",
      "workspace",
      "--tree-path",
      "../git-workspace-tree",
      "--tree-mode",
      "shared",
      "--sync-members",
    ]);
    expect(initWorkspace.code).toBe(0);
    expect(readSourceState(workspaceRoot)?.bindingMode).toBe("workspace-root");
    expect(readSourceState(workspaceRoot)?.rootKind).toBe("git-repo");
    expect(readSourceState(childRepo)?.bindingMode).toBe("workspace-member");
    expect(readTreeBinding(treeRoot, readSourceState(childRepo)!.sourceId)).not.toBeNull();
  });
});
