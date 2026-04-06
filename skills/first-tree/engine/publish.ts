import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  formatDedicatedTreePathExample,
  inferSourceRepoNameFromTreeRepoName,
  relativeRepoPath,
} from "#skill/engine/dedicated-tree.js";
import { Repo } from "#skill/engine/repo.js";
import { readBootstrapState } from "#skill/engine/runtime/bootstrap.js";
import {
  upsertLocalTreeConfig,
  upsertLocalTreeGitIgnore,
} from "#skill/engine/runtime/local-tree-config.js";
import { upsertSourceIntegrationFiles } from "#skill/engine/runtime/source-integration.js";
import {
  AGENT_INSTRUCTIONS_FILE,
  CLAUDE_INSTRUCTIONS_FILE,
  CLAUDE_SKILL_ROOT,
  FIRST_TREE_INDEX_FILE,
  LOCAL_TREE_CONFIG,
  SKILL_ROOT,
} from "#skill/engine/runtime/asset-loader.js";

export const PUBLISH_USAGE = `usage: first-tree publish [--open-pr] [--tree-path PATH] [--source-repo PATH] [--source-remote NAME]

Run this from the dedicated tree repo after \`first-tree init\`. The command
creates or reuses the GitHub \`*-tree\` repo, continues supporting older
\`*-context\` repos, pushes the current tree
commit, records the published tree repo URL back in the source/workspace repo,
refreshes the local tree checkout config, and prepares the source-repo branch.

Options:
  --open-pr               Open a PR in the source/workspace repo after pushing the branch
  --tree-path PATH        Publish a tree repo from another working directory
  --source-repo PATH      Explicit source/workspace repo path when it cannot be inferred
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

  const inferredSourceRepoName = inferSourceRepoNameFromTreeRepoName(
    treeRepo.repoName(),
  );
  if (inferredSourceRepoName !== null) {
    return join(
      dirname(treeRepo.root),
      inferredSourceRepoName,
    );
  }

  return null;
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

function defaultLocalTreeRoot(
  sourceRepo: Repo,
  treeRepoName: string,
): string {
  return join(dirname(sourceRepo.root), treeRepoName);
}

function ensureLocalTreeCheckout(
  runner: CommandRunner,
  sourceRepo: Repo,
  treeRepo: Repo,
  remoteUrl: string,
): string {
  const localTreeRoot = defaultLocalTreeRoot(sourceRepo, treeRepo.repoName());
  if (localTreeRoot === treeRepo.root) {
    return localTreeRoot;
  }

  if (!existsSync(localTreeRoot)) {
    runner("git", ["clone", remoteUrl, localTreeRoot], {
      cwd: dirname(sourceRepo.root),
    });
    return localTreeRoot;
  }

  const localTreeRepo = new Repo(localTreeRoot);
  if (!localTreeRepo.isGitRepo()) {
    throw new Error(
      `Cannot use ${localTreeRoot} as the local tree checkout because that path already exists and is not a git repository.`,
    );
  }

  const localOrigin = getGitRemoteUrl(runner, localTreeRoot, "origin");
  if (localOrigin === null) {
    throw new Error(
      `Cannot reuse ${localTreeRoot} as the local tree checkout because it does not have an \`origin\` remote.`,
    );
  }
  if (localOrigin !== remoteUrl) {
    throw new Error(
      `Cannot reuse ${localTreeRoot} as the local tree checkout because its \`origin\` remote does not match ${remoteUrl}.`,
    );
  }

  runner("git", ["fetch", "origin"], { cwd: localTreeRoot });
  return localTreeRoot;
}

function updateSourceWorkspaceIntegration(
  sourceRepo: Repo,
  treeRepo: Repo,
  treeRepoUrl: string,
  localTreeRoot: string,
): {
  gitIgnoreAction: "created" | "updated" | "unchanged";
  localTreeConfigAction: "created" | "updated" | "unchanged";
} {
  const gitIgnore = upsertLocalTreeGitIgnore(sourceRepo.root);
  const localTreeConfig = upsertLocalTreeConfig(sourceRepo.root, {
    localPath: relativeRepoPath(sourceRepo.root, localTreeRoot),
    treeRepoName: treeRepo.repoName(),
    treeRepoUrl,
  });
  upsertSourceIntegrationFiles(sourceRepo.root, treeRepo.repoName(), {
    treeRepoUrl,
  });
  return {
    gitIgnoreAction: gitIgnore.action,
    localTreeConfigAction: localTreeConfig.action,
  };
}

function commitSourceIntegration(
  runner: CommandRunner,
  sourceRepo: Repo,
  treeRepoName: string,
): boolean {
  const managedPaths = [
    ...[
      SKILL_ROOT,
      CLAUDE_SKILL_ROOT,
      FIRST_TREE_INDEX_FILE,
      AGENT_INSTRUCTIONS_FILE,
      CLAUDE_INSTRUCTIONS_FILE,
      ".gitignore",
    ].filter((path) => existsSync(join(sourceRepo.root, path))),
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
): string {
  return [
    `Connect the published \`${treeRepoName}\` Context Tree back into this source/workspace repo.`,
    "",
    `- record \`${treeSlug}\` as the published GitHub home for the tree`,
    `- refresh the managed source/workspace instructions with the tree repo URL and local checkout guidance`,
    `- keep the local checkout state only in ignored \`${LOCAL_TREE_CONFIG}\``,
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
      `Error: this repo only has the first-tree source/workspace integration installed. Run ${formatDedicatedTreePathExample("first-tree publish", treeRepo)} or switch into the dedicated tree repo first.`,
    );
    return 1;
  }

  if (!treeRepo.hasFramework() || !treeRepo.looksLikeTreeRepo()) {
    console.error(
      "Error: `first-tree publish` must run from a dedicated tree repo (or use `--tree-path` to point at one). Run `first-tree init` first.",
    );
    return 1;
  }

  const sourceRepoRoot = resolveSourceRepoRoot(treeRepo, options);
  if (sourceRepoRoot === null) {
    console.error(
      "Error: could not determine the source/workspace repo for this tree. Re-run `first-tree init` from the source repo first, or pass `--source-repo PATH`.",
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
      "Error: the source/workspace repo and dedicated tree repo resolved to the same path. `first-tree publish` expects two separate repos.",
    );
    return 1;
  }

  if (!sourceRepo.hasCurrentInstalledSkill() || !sourceRepo.hasSourceWorkspaceIntegration()) {
    console.error(
      "Error: the source/workspace repo does not have the first-tree source integration installed. Run `first-tree init` from the source/workspace repo first.",
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

    const localTreeRoot = ensureLocalTreeCheckout(
      runner,
      sourceRepo,
      treeRepo,
      treeRemote.remoteUrl,
    );
    const sourceIntegrationState = updateSourceWorkspaceIntegration(
      sourceRepo,
      treeRepo,
      treeRemote.remoteUrl,
      localTreeRoot,
    );
    console.log(
      `  Recorded \`${treeRemote.remoteUrl}\` in the source/workspace instructions.`,
    );
    if (sourceIntegrationState.gitIgnoreAction === "created") {
      console.log("  Created `.gitignore` entries for local tree checkout state.");
    } else if (sourceIntegrationState.gitIgnoreAction === "updated") {
      console.log("  Updated `.gitignore` for local tree checkout state.");
    }
    console.log(
      sourceIntegrationState.localTreeConfigAction === "created"
        ? `  Created \`${LOCAL_TREE_CONFIG}\` for \`${relativeRepoPath(sourceRepo.root, localTreeRoot)}\`.`
        : sourceIntegrationState.localTreeConfigAction === "updated"
        ? `  Updated \`${LOCAL_TREE_CONFIG}\` for \`${relativeRepoPath(sourceRepo.root, localTreeRoot)}\`.`
        : `  Reused the existing \`${LOCAL_TREE_CONFIG}\` entry for \`${relativeRepoPath(sourceRepo.root, localTreeRoot)}\`.`,
    );

    const committedSourceChanges = commitSourceIntegration(
      runner,
      sourceRepo,
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
          buildPrBody(treeRepo.repoName(), treeSlug),
        ],
        { cwd: sourceRepo.root },
      );
      console.log(`  Opened PR: ${prUrl}`);
    }

    console.log();
    console.log(
      `The source/workspace repo's local tree config now points to \`${LOCAL_TREE_CONFIG}\` and the canonical checkout at \`${relativeRepoPath(sourceRepo.root, localTreeRoot)}\`.`,
    );
    console.log(
      treeRepo.root === localTreeRoot
        ? `This sibling checkout is already the canonical local working copy for the tree.`
        : `You can delete the bootstrap checkout at ${treeRepo.root} once you no longer need it.`,
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
