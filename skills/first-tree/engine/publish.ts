import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { Repo } from "#skill/engine/repo.js";
import { readBootstrapState } from "#skill/engine/runtime/bootstrap.js";
import {
  AGENT_INSTRUCTIONS_FILE,
  CLAUDE_INSTRUCTIONS_FILE,
  CLAUDE_SKILL_ROOT,
  SKILL_ROOT,
} from "#skill/engine/runtime/asset-loader.js";

export const PUBLISH_USAGE = `usage: context-tree publish [--open-pr] [--tree-path PATH] [--source-repo PATH] [--submodule-path PATH] [--source-remote NAME]

Run this from the dedicated tree repo after \`context-tree init\`. The command
creates or reuses the GitHub \`*-context\` repo, pushes the current tree
commit, adds that repo back to the source/workspace repo as a git submodule,
and prepares the source-repo branch.

Options:
  --open-pr               Open a PR in the source/workspace repo after pushing the branch
  --tree-path PATH        Publish a tree repo from another working directory
  --source-repo PATH      Explicit source/workspace repo path when it cannot be inferred
  --submodule-path PATH   Path to use inside the source/workspace repo (default: tree repo name)
  --source-remote NAME    Source/workspace repo remote to mirror on GitHub (default: origin)
  --help                  Show this help message
`;

interface CommandRunOptions {
  cwd: string;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options: CommandRunOptions,
) => string;

export interface ParsedPublishArgs {
  openPr?: boolean;
  sourceRemote?: string;
  sourceRepoPath?: string;
  submodulePath?: string;
  treePath?: string;
}

export interface PublishOptions extends ParsedPublishArgs {
  commandRunner?: CommandRunner;
  currentCwd?: string;
}

interface GitHubRemote {
  cloneStyle: "https" | "ssh";
  owner: string;
  repo: string;
  slug: string;
}

interface GitHubRepoMetadata {
  defaultBranch: string;
  nameWithOwner: string;
  visibility: "internal" | "private" | "public";
}

function defaultCommandRunner(
  command: string,
  args: string[],
  options: CommandRunOptions,
): string {
  try {
    return execFileSync(command, args, {
      cwd: options.cwd,
      encoding: "utf-8",
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    throw new Error(
      `Command failed in ${options.cwd}: ${command} ${args.join(" ")}\n${message}`,
    );
  }
}

function commandSucceeds(
  runner: CommandRunner,
  command: string,
  args: string[],
  cwd: string,
): boolean {
  try {
    runner(command, args, { cwd });
    return true;
  } catch {
    return false;
  }
}

function parseGitHubRemote(url: string): GitHubRemote | null {
  if (url.startsWith("https://") || url.startsWith("http://")) {
    try {
      const parsed = new URL(url);
      if (parsed.hostname !== "github.com") {
        return null;
      }
      const parts = parsed.pathname.replace(/^\/+/, "").replace(/\.git$/, "").split("/");
      if (parts.length !== 2 || parts.some((part) => part.trim() === "")) {
        return null;
      }
      return {
        cloneStyle: "https",
        owner: parts[0],
        repo: parts[1],
        slug: `${parts[0]}/${parts[1]}`,
      };
    } catch {
      return null;
    }
  }

  if (url.startsWith("ssh://")) {
    try {
      const parsed = new URL(url);
      if (parsed.hostname !== "github.com") {
        return null;
      }
      const parts = parsed.pathname.replace(/^\/+/, "").replace(/\.git$/, "").split("/");
      if (parts.length !== 2 || parts.some((part) => part.trim() === "")) {
        return null;
      }
      return {
        cloneStyle: "ssh",
        owner: parts[0],
        repo: parts[1],
        slug: `${parts[0]}/${parts[1]}`,
      };
    } catch {
      return null;
    }
  }

  const scpMatch = url.match(/^git@github\.com:(.+?)\/(.+?)(?:\.git)?$/);
  if (scpMatch === null) {
    return null;
  }
  return {
    cloneStyle: "ssh",
    owner: scpMatch[1],
    repo: scpMatch[2],
    slug: `${scpMatch[1]}/${scpMatch[2]}`,
  };
}

function visibilityFlag(
  visibility: GitHubRepoMetadata["visibility"],
): "--internal" | "--private" | "--public" {
  switch (visibility) {
    case "internal":
      return "--internal";
    case "private":
      return "--private";
    default:
      return "--public";
  }
}

function buildGitHubCloneUrl(
  slug: string,
  cloneStyle: GitHubRemote["cloneStyle"],
): string {
  if (cloneStyle === "ssh") {
    return `git@github.com:${slug}.git`;
  }
  return `https://github.com/${slug}.git`;
}

function readGitHubRepoMetadata(
  runner: CommandRunner,
  slug: string,
  cwd: string,
): GitHubRepoMetadata {
  const raw = runner(
    "gh",
    ["repo", "view", slug, "--json", "defaultBranchRef,nameWithOwner,visibility"],
    { cwd },
  );
  const parsed = JSON.parse(raw) as {
    defaultBranchRef?: { name?: string };
    nameWithOwner?: string;
    visibility?: string;
  };
  const defaultBranch = parsed.defaultBranchRef?.name;
  const nameWithOwner = parsed.nameWithOwner;
  const visibility = parsed.visibility?.toLowerCase();
  if (
    typeof defaultBranch !== "string"
    || typeof nameWithOwner !== "string"
    || (visibility !== "internal" && visibility !== "private" && visibility !== "public")
  ) {
    throw new Error(`Could not read GitHub metadata for ${slug}.`);
  }
  return {
    defaultBranch,
    nameWithOwner,
    visibility,
  };
}

function readCurrentBranch(
  runner: CommandRunner,
  root: string,
): string {
  return runner("git", ["branch", "--show-current"], { cwd: root }).trim();
}

function hasCommit(
  runner: CommandRunner,
  root: string,
): boolean {
  return commandSucceeds(runner, "git", ["rev-parse", "--verify", "HEAD"], root);
}

function hasIndexedChanges(
  runner: CommandRunner,
  root: string,
  paths?: string[],
): boolean {
  const args = ["diff", "--cached", "--quiet"];
  if (paths && paths.length > 0) {
    args.push("--", ...paths);
  }
  return !commandSucceeds(runner, "git", args, root);
}

function commitTreeState(
  runner: CommandRunner,
  treeRepo: Repo,
): boolean {
  const hadCommit = hasCommit(runner, treeRepo.root);
  runner("git", ["add", "-A"], { cwd: treeRepo.root });
  if (!hasIndexedChanges(runner, treeRepo.root)) {
    return false;
  }
  runner(
    "git",
    ["commit", "-m", hadCommit ? "chore: update context tree" : "chore: bootstrap context tree"],
    { cwd: treeRepo.root },
  );
  return true;
}

function resolveSourceRepoRoot(
  treeRepo: Repo,
  options?: PublishOptions,
): string | null {
  const cwd = options?.currentCwd ?? process.cwd();

  if (options?.sourceRepoPath) {
    return resolve(cwd, options.sourceRepoPath);
  }

  const bootstrap = readBootstrapState(treeRepo.root);
  if (bootstrap !== null) {
    return resolve(treeRepo.root, bootstrap.sourceRepoPath);
  }

  if (treeRepo.repoName().endsWith("-context")) {
    return join(
      dirname(treeRepo.root),
      treeRepo.repoName().slice(0, -"-context".length),
    );
  }

  return null;
}

function normalizeSubmodulePath(input: string): string | null {
  if (input.trim() === "") {
    return null;
  }
  if (isAbsolute(input)) {
    return null;
  }
  const normalized = normalize(input).replaceAll("\\", "/");
  if (
    normalized === "."
    || normalized === ""
    || normalized.startsWith("../")
    || normalized.includes("/../")
  ) {
    return null;
  }
  return normalized;
}

function getGitRemoteUrl(
  runner: CommandRunner,
  root: string,
  remote: string,
): string | null {
  try {
    return runner("git", ["remote", "get-url", remote], { cwd: root }).trim();
  } catch {
    return null;
  }
}

function localBranchExists(
  runner: CommandRunner,
  root: string,
  branch: string,
): boolean {
  return commandSucceeds(
    runner,
    "git",
    ["rev-parse", "--verify", `refs/heads/${branch}`],
    root,
  );
}

function remoteTrackingBranchExists(
  runner: CommandRunner,
  root: string,
  remote: string,
  branch: string,
): boolean {
  return commandSucceeds(
    runner,
    "git",
    ["rev-parse", "--verify", `refs/remotes/${remote}/${branch}`],
    root,
  );
}

function buildPublishBranchName(treeRepoName: string): string {
  const token = treeRepoName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `chore/connect-${token}`;
}

function ensureSourceBranch(
  runner: CommandRunner,
  sourceRepo: Repo,
  sourceRemote: string,
  defaultBranch: string,
  treeRepoName: string,
): string {
  const branch = buildPublishBranchName(treeRepoName);
  const currentBranch = readCurrentBranch(runner, sourceRepo.root);

  if (currentBranch === branch) {
    return branch;
  }

  if (localBranchExists(runner, sourceRepo.root, branch)) {
    runner("git", ["switch", branch], { cwd: sourceRepo.root });
    return branch;
  }

  if (!remoteTrackingBranchExists(runner, sourceRepo.root, sourceRemote, defaultBranch)) {
    runner("git", ["fetch", sourceRemote, defaultBranch], { cwd: sourceRepo.root });
  }

  if (remoteTrackingBranchExists(runner, sourceRepo.root, sourceRemote, defaultBranch)) {
    runner(
      "git",
      ["switch", "-c", branch, "--track", `${sourceRemote}/${defaultBranch}`],
      { cwd: sourceRepo.root },
    );
    return branch;
  }

  runner("git", ["switch", "-c", branch], { cwd: sourceRepo.root });
  return branch;
}

function isTrackedSubmodule(
  runner: CommandRunner,
  sourceRoot: string,
  submodulePath: string,
): boolean {
  try {
    const output = runner(
      "git",
      ["ls-files", "--stage", "--", submodulePath],
      { cwd: sourceRoot },
    );
    return output
      .split(/\r?\n/)
      .some((line) => line.startsWith("160000 "));
  } catch {
    return false;
  }
}

function ensureSubmodule(
  runner: CommandRunner,
  sourceRepo: Repo,
  submodulePath: string,
  remoteUrl: string,
): "added" | "updated" {
  if (isTrackedSubmodule(runner, sourceRepo.root, submodulePath)) {
    runner(
      "git",
      ["submodule", "set-url", "--", submodulePath, remoteUrl],
      { cwd: sourceRepo.root },
    );
    runner(
      "git",
      ["submodule", "sync", "--", submodulePath],
      { cwd: sourceRepo.root },
    );
    runner(
      "git",
      ["submodule", "update", "--init", "--", submodulePath],
      { cwd: sourceRepo.root },
    );
    return "updated";
  }

  const submoduleRoot = join(sourceRepo.root, submodulePath);
  if (existsSync(submoduleRoot)) {
    throw new Error(
      `Cannot add the submodule at ${submodulePath} because that path already exists in the source/workspace repo.`,
    );
  }

  runner(
    "git",
    ["submodule", "add", remoteUrl, submodulePath],
    { cwd: sourceRepo.root },
  );
  return "added";
}

function commitSourceIntegration(
  runner: CommandRunner,
  sourceRepo: Repo,
  submodulePath: string,
  treeRepoName: string,
): boolean {
  const managedPaths = [
    ...[
      SKILL_ROOT,
      CLAUDE_SKILL_ROOT,
      AGENT_INSTRUCTIONS_FILE,
      CLAUDE_INSTRUCTIONS_FILE,
    ].filter((path) => existsSync(join(sourceRepo.root, path))),
    ".gitmodules",
    submodulePath,
  ].filter((path, index, items) => items.indexOf(path) === index);

  runner("git", ["add", "--", ...managedPaths], { cwd: sourceRepo.root });
  if (!hasIndexedChanges(runner, sourceRepo.root, managedPaths)) {
    return false;
  }
  runner(
    "git",
    [
      "commit",
      "-m",
      `chore: connect ${treeRepoName} context tree`,
      "--",
      ...managedPaths,
    ],
    { cwd: sourceRepo.root },
  );
  return true;
}

function ensureTreeRemotePublished(
  runner: CommandRunner,
  treeRepo: Repo,
  treeSlug: string,
  sourceCloneStyle: GitHubRemote["cloneStyle"],
  visibility: GitHubRepoMetadata["visibility"],
): { createdRemote: boolean; remoteUrl: string } {
  const existingOrigin = getGitRemoteUrl(runner, treeRepo.root, "origin");
  if (existingOrigin !== null) {
    runner("git", ["push", "-u", "origin", "HEAD"], { cwd: treeRepo.root });
    return {
      createdRemote: false,
      remoteUrl: existingOrigin,
    };
  }

  const desiredCloneUrl = buildGitHubCloneUrl(treeSlug, sourceCloneStyle);
  const repoAlreadyExists = commandSucceeds(
    runner,
    "gh",
    ["repo", "view", treeSlug, "--json", "nameWithOwner"],
    treeRepo.root,
  );

  if (repoAlreadyExists) {
    runner(
      "git",
      ["remote", "add", "origin", desiredCloneUrl],
      { cwd: treeRepo.root },
    );
    runner("git", ["push", "-u", "origin", "HEAD"], { cwd: treeRepo.root });
    return {
      createdRemote: false,
      remoteUrl: desiredCloneUrl,
    };
  }

  runner(
    "gh",
    [
      "repo",
      "create",
      treeSlug,
      visibilityFlag(visibility),
      "--source",
      treeRepo.root,
      "--remote",
      "origin",
      "--push",
    ],
    { cwd: treeRepo.root },
  );

  return {
    createdRemote: true,
    remoteUrl: getGitRemoteUrl(runner, treeRepo.root, "origin") ?? desiredCloneUrl,
  };
}

function buildPrBody(
  treeRepoName: string,
  treeSlug: string,
  submodulePath: string,
): string {
  return [
    `Connect the published \`${treeRepoName}\` Context Tree back into this source/workspace repo.`,
    "",
    `- add \`${submodulePath}\` as the tracked Context Tree submodule`,
    "- keep the local first-tree skill + source integration marker lines in this repo",
    `- use \`${treeSlug}\` as the GitHub home for tree content`,
  ].join("\n");
}

export function parsePublishArgs(
  args: string[],
): ParsedPublishArgs | { error: string } {
  const parsed: ParsedPublishArgs = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--open-pr":
        parsed.openPr = true;
        break;
      case "--tree-path": {
        const value = args[index + 1];
        if (!value) {
          return { error: "Missing value for --tree-path" };
        }
        parsed.treePath = value;
        index += 1;
        break;
      }
      case "--source-repo": {
        const value = args[index + 1];
        if (!value) {
          return { error: "Missing value for --source-repo" };
        }
        parsed.sourceRepoPath = value;
        index += 1;
        break;
      }
      case "--submodule-path": {
        const value = args[index + 1];
        if (!value) {
          return { error: "Missing value for --submodule-path" };
        }
        parsed.submodulePath = value;
        index += 1;
        break;
      }
      case "--source-remote": {
        const value = args[index + 1];
        if (!value) {
          return { error: "Missing value for --source-remote" };
        }
        parsed.sourceRemote = value;
        index += 1;
        break;
      }
      default:
        return { error: `Unknown publish option: ${arg}` };
    }
  }

  return parsed;
}

export function runPublish(repo?: Repo, options?: PublishOptions): number {
  const cwd = options?.currentCwd ?? process.cwd();
  const runner = options?.commandRunner ?? defaultCommandRunner;
  const treeRepo = repo
    ?? new Repo(options?.treePath ? resolve(cwd, options.treePath) : undefined);

  if (treeRepo.hasSourceWorkspaceIntegration() && !treeRepo.looksLikeTreeRepo()) {
    console.error(
      `Error: this repo only has the first-tree source/workspace integration installed. Run \`context-tree publish --tree-path ../${treeRepo.repoName()}-context\` or switch into the dedicated tree repo first.`,
    );
    return 1;
  }

  if (!treeRepo.hasFramework() || !treeRepo.looksLikeTreeRepo()) {
    console.error(
      "Error: `context-tree publish` must run from a dedicated tree repo (or use `--tree-path` to point at one). Run `context-tree init` first.",
    );
    return 1;
  }

  const sourceRepoRoot = resolveSourceRepoRoot(treeRepo, options);
  if (sourceRepoRoot === null) {
    console.error(
      "Error: could not determine the source/workspace repo for this tree. Re-run `context-tree init` from the source repo first, or pass `--source-repo PATH`.",
    );
    return 1;
  }

  const sourceRepo = new Repo(sourceRepoRoot);
  if (!sourceRepo.isGitRepo()) {
    console.error(
      `Error: the resolved source/workspace repo is not a git repository: ${sourceRepoRoot}`,
    );
    return 1;
  }

  if (sourceRepo.root === treeRepo.root) {
    console.error(
      "Error: the source/workspace repo and dedicated tree repo resolved to the same path. `context-tree publish` expects two separate repos.",
    );
    return 1;
  }

  if (!sourceRepo.hasCurrentInstalledSkill() || !sourceRepo.hasSourceWorkspaceIntegration()) {
    console.error(
      "Error: the source/workspace repo does not have the first-tree source integration installed. Run `context-tree init` from the source/workspace repo first.",
    );
    return 1;
  }

  const submodulePath = normalizeSubmodulePath(
    options?.submodulePath ?? treeRepo.repoName(),
  );
  if (submodulePath === null) {
    console.error(
      "Error: `--submodule-path` must be a relative path inside the source/workspace repo.",
    );
    return 1;
  }

  const sourceRemoteName = options?.sourceRemote ?? "origin";

  try {
    console.log("Context Tree Publish\n");
    console.log(`  Tree repo:   ${treeRepo.root}`);
    console.log(`  Source repo: ${sourceRepo.root}\n`);

    const sourceRemoteUrl = getGitRemoteUrl(runner, sourceRepo.root, sourceRemoteName);
    if (sourceRemoteUrl === null) {
      throw new Error(
        `Could not read git remote \`${sourceRemoteName}\` from the source/workspace repo.`,
      );
    }

    const sourceGitHub = parseGitHubRemote(sourceRemoteUrl);
    if (sourceGitHub === null) {
      throw new Error(
        `The source/workspace remote \`${sourceRemoteName}\` is not a GitHub remote: ${sourceRemoteUrl}`,
      );
    }

    const sourceMetadata = readGitHubRepoMetadata(
      runner,
      sourceGitHub.slug,
      sourceRepo.root,
    );
    const treeSlug = `${sourceGitHub.owner}/${treeRepo.repoName()}`;

    const committedTreeChanges = commitTreeState(runner, treeRepo);
    if (committedTreeChanges) {
      console.log("  Committed the current tree state.");
    } else {
      console.log("  Tree repo already had a committed working state.");
    }

    const treeRemote = ensureTreeRemotePublished(
      runner,
      treeRepo,
      treeSlug,
      sourceGitHub.cloneStyle,
      sourceMetadata.visibility,
    );
    if (treeRemote.createdRemote) {
      console.log(`  Created and pushed ${treeSlug}.`);
    } else {
      console.log(`  Pushed the tree repo to ${treeRemote.remoteUrl}.`);
    }

    const sourceBranch = ensureSourceBranch(
      runner,
      sourceRepo,
      sourceRemoteName,
      sourceMetadata.defaultBranch,
      treeRepo.repoName(),
    );
    console.log(`  Working on source/workspace branch \`${sourceBranch}\`.`);

    const submoduleAction = ensureSubmodule(
      runner,
      sourceRepo,
      submodulePath,
      treeRemote.remoteUrl,
    );
    console.log(
      submoduleAction === "added"
        ? `  Added \`${submodulePath}\` as a git submodule.`
        : `  Updated the \`${submodulePath}\` submodule URL and checkout.`,
    );

    const committedSourceChanges = commitSourceIntegration(
      runner,
      sourceRepo,
      submodulePath,
      treeRepo.repoName(),
    );
    if (committedSourceChanges) {
      console.log("  Committed the source/workspace integration branch.");
    } else {
      console.log(
        "  Source/workspace integration was already up to date; no new commit was needed.",
      );
    }

    if (committedSourceChanges || options?.openPr) {
      runner(
        "git",
        ["push", "-u", sourceRemoteName, sourceBranch],
        { cwd: sourceRepo.root },
      );
      console.log(`  Pushed \`${sourceBranch}\` to \`${sourceRemoteName}\`.`);
    }

    if (options?.openPr) {
      const prUrl = runner(
        "gh",
        [
          "pr",
          "create",
          "--repo",
          sourceMetadata.nameWithOwner,
          "--base",
          sourceMetadata.defaultBranch,
          "--head",
          sourceBranch,
          "--title",
          `chore: connect ${treeRepo.repoName()} context tree`,
          "--body",
          buildPrBody(treeRepo.repoName(), treeSlug, submodulePath),
        ],
        { cwd: sourceRepo.root },
      );
      console.log(`  Opened PR: ${prUrl}`);
    }

    console.log();
    console.log(
      `The source/workspace repo's \`${submodulePath}\` checkout is now the canonical local working copy for this tree.`,
    );
    console.log(
      `You can delete the temporary bootstrap checkout at ${treeRepo.root} once you no longer need it.`,
    );
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error(`Error: ${message}`);
    return 1;
  }
}

export function runPublishCli(args: string[] = []): number {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(PUBLISH_USAGE);
    return 0;
  }

  const parsed = parsePublishArgs(args);
  if ("error" in parsed) {
    console.error(parsed.error);
    console.log(PUBLISH_USAGE);
    return 1;
  }

  return runPublish(undefined, parsed);
}
