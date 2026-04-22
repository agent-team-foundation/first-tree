import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  formatDedicatedTreePathExample,
  inferSourceRepoNameFromTreeRepoName,
} from "#products/tree/engine/dedicated-tree.js";
import { Repo } from "#products/tree/engine/repo.js";
import {
  buildTreeId,
  listTreeBindings,
  readSourceState,
  readTreeState,
  writeSourceState,
  writeTreeState,
} from "#products/tree/engine/runtime/binding-state.js";
import { readBootstrapState } from "#products/tree/engine/runtime/bootstrap.js";
import {
  upsertLocalTreeGitIgnore,
} from "#products/tree/engine/runtime/local-tree-config.js";
import { upsertSourceIntegrationFiles } from "#products/tree/engine/runtime/source-integration.js";
import {
  ensureAgentContextHooks,
  formatAgentContextHookMessages,
  CODEX_CONFIG_PATH,
  CODEX_HOOKS_PATH,
  CLAUDE_SETTINGS_PATH,
} from "#products/tree/engine/runtime/adapters.js";
import {
  AGENT_INSTRUCTIONS_FILE,
  CLAUDE_INSTRUCTIONS_FILE,
  CLAUDE_SKILL_ROOT,
  FIRST_TREE_INDEX_FILE,
  SOURCE_STATE,
  SKILL_ROOT,
} from "#products/tree/engine/runtime/asset-loader.js";

export const PUBLISH_USAGE = `usage: first-tree tree publish [--open-pr] [--tree-path PATH] [--source-repo PATH] [--source-remote NAME]

Publish a Context Tree repo to GitHub and refresh any explicit or locally
discoverable bound source/workspace repos with the published tree URL. This is the networked second-stage command
after \`first-tree tree init\` / \`first-tree tree bind\`, run from the tree repo (or
pointed at one with --tree-path).

What it does:
  1. Resolves the GitHub destination from bound source repos, tree bindings,
     legacy bootstrap metadata, or from --source-repo / --source-remote flags
  2. Creates the GitHub tree repo if it doesn't exist (reuses an existing
     remote when already bound)
  3. Pushes the local tree commits via the \`gh\` CLI
  4. Refreshes each explicit or locally discoverable source/workspace repo's
     \`FIRST-TREE-SOURCE-INTEGRATION:\` block and \`.first-tree/source.json\`
     when that source/workspace repo is available locally
  5. Optionally opens a PR in the source repo when exactly one source repo is
     being refreshed

Requires the \`gh\` CLI installed and authenticated. Requires the source repo
to be discoverable locally (for example via --source-repo PATH or a sibling
checkout that matches the binding metadata).

After publish succeeds, the canonical shared identity is the published tree URL
recorded in each bound source repo. Local checkouts can live wherever is
convenient on each machine.

Options:
  --open-pr               Open a PR in the source/workspace repo after pushing the branch
  --tree-path PATH        Publish a tree repo from another working directory
  --source-repo PATH      Explicit source/workspace repo path when it cannot be inferred from a sibling layout
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

function remoteUrlsMatch(left: string | null, right: string | undefined): boolean {
  if (!left || !right) {
    return false;
  }
  const leftGitHub = parseGitHubRemote(left);
  const rightGitHub = parseGitHubRemote(right);
  if (leftGitHub && rightGitHub) {
    return leftGitHub.slug.toLowerCase() === rightGitHub.slug.toLowerCase();
  }
  return left.trim().replace(/\.git$/u, "") === right.trim().replace(/\.git$/u, "");
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

function resolveBoundSourceRepoRoots(
  treeRepo: Repo,
  runner: CommandRunner,
  options?: PublishOptions,
): string[] {
  const cwd = options?.currentCwd ?? process.cwd();

  if (options?.sourceRepoPath) {
    return [resolve(cwd, options.sourceRepoPath)];
  }

  const bindings = listTreeBindings(treeRepo.root);
  if (bindings.length > 0) {
    const candidates = bindings
      .map((binding) => {
        const siblingRoot = join(dirname(treeRepo.root), binding.sourceName);
        const siblingRepo = new Repo(siblingRoot);
        if (!siblingRepo.isGitRepo()) {
          return null;
        }
        if (
          binding.remoteUrl
          && !remoteUrlsMatch(getGitRemoteUrl(runner, siblingRoot, "origin"), binding.remoteUrl)
        ) {
          return null;
        }
        return siblingRoot;
      })
      .filter((candidate): candidate is string => candidate !== null);
    return [...new Set(candidates)];
  }

  const bootstrap = readBootstrapState(treeRepo.root);
  if (bootstrap?.sourceRepoPath) {
    return [resolve(treeRepo.root, bootstrap.sourceRepoPath)];
  }
  if (bootstrap !== null) {
    const siblingRoot = join(dirname(treeRepo.root), bootstrap.sourceRepoName);
    const siblingRepo = new Repo(siblingRoot);
    if (
      siblingRepo.isGitRepo()
      && (
        !bootstrap.sourceRepoRemoteUrl
        || remoteUrlsMatch(
          getGitRemoteUrl(runner, siblingRoot, "origin"),
          bootstrap.sourceRepoRemoteUrl,
        )
      )
    ) {
      return [siblingRoot];
    }
  }

  const inferredSourceRepoName = inferSourceRepoNameFromTreeRepoName(
    treeRepo.repoName(),
  );
  if (inferredSourceRepoName !== null) {
    const siblingRoot = join(
      dirname(treeRepo.root),
      inferredSourceRepoName,
    );
    if (new Repo(siblingRoot).isGitRepo()) {
      return [siblingRoot];
    }
  }

  return [];
}

function resolvePrimarySourceRepoRoot(
  treeRepo: Repo,
  runner: CommandRunner,
  options?: PublishOptions,
): string | null {
  const resolvedRoots = resolveBoundSourceRepoRoots(treeRepo, runner, options);
  return resolvedRoots[0] ?? null;
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

function updateSourceWorkspaceIntegration(
  sourceRepo: Repo,
  treeRepo: Repo,
  treeRepoUrl: string,
): {
  agentHookActions: ReturnType<typeof ensureAgentContextHooks>;
  gitIgnoreAction: "created" | "updated" | "unchanged";
  sourceStateAction: "created" | "updated" | "unchanged";
} {
  const gitIgnore = upsertLocalTreeGitIgnore(sourceRepo.root);
  const sourceState = readSourceState(sourceRepo.root);
  if (sourceState !== null) {
    const updatedTree = {
      ...sourceState.tree,
      remoteUrl: treeRepoUrl,
      treeRepoName: treeRepo.repoName(),
    };
    const before = JSON.stringify(sourceState);
    writeSourceState(sourceRepo.root, {
      ...sourceState,
      tree: updatedTree,
    });
    const after = JSON.stringify(readSourceState(sourceRepo.root));
    const sourceStateAction = before === after ? "unchanged" : "updated";
    upsertSourceIntegrationFiles(sourceRepo.root, treeRepo.repoName(), {
      bindingMode: sourceState.bindingMode,
      entrypoint: sourceState.tree.entrypoint,
      treeMode: sourceState.tree.treeMode,
      treeRepoUrl,
      workspaceId: sourceState.workspaceId,
    });
    return {
      agentHookActions: ensureAgentContextHooks(sourceRepo.root),
      gitIgnoreAction: gitIgnore.action,
      sourceStateAction,
    };
  }
  upsertSourceIntegrationFiles(sourceRepo.root, treeRepo.repoName(), {
    treeRepoUrl,
  });
  return {
    agentHookActions: ensureAgentContextHooks(sourceRepo.root),
    gitIgnoreAction: gitIgnore.action,
    sourceStateAction: "unchanged",
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
      CLAUDE_SETTINGS_PATH,
      CODEX_CONFIG_PATH,
      CODEX_HOOKS_PATH,
      ".gitignore",
    ].filter((path) => existsSync(join(sourceRepo.root, path))),
  ].filter((path, index, items) => items.indexOf(path) === index);
  const stageablePaths = resolveStageableManagedPaths(
    runner,
    sourceRepo,
    managedPaths,
  );

  if (stageablePaths.skippedPaths.length > 0) {
    console.log(
      `  Skipped gitignored source skill artifacts: ${stageablePaths.skippedPaths.map((path) => `\`${path}\``).join(", ")}.`,
    );
  }

  if (stageablePaths.paths.length === 0) {
    return false;
  }

  runner("git", ["add", "--", ...stageablePaths.paths], { cwd: sourceRepo.root });
  if (!hasIndexedChanges(runner, sourceRepo.root, stageablePaths.paths)) {
    return false;
  }
  runner(
    "git",
    [
      "commit",
      "-m",
      `chore: connect ${treeRepoName} context tree`,
      "--",
      ...stageablePaths.paths,
    ],
    { cwd: sourceRepo.root },
  );
  return true;
}

function resolveStageableManagedPaths(
  runner: CommandRunner,
  sourceRepo: Repo,
  managedPaths: string[],
): { paths: string[]; skippedPaths: string[] } {
  const skippedPaths = new Set<string>();
  const skillBundlePaths = [
    SKILL_ROOT,
    CLAUDE_SKILL_ROOT,
    FIRST_TREE_INDEX_FILE,
  ].filter((path) => managedPaths.includes(path));

  // WHITEPAPER.md and .claude/skills/first-tree are symlink views into the
  // canonical .agents/skills/first-tree bundle, so stage them only when the
  // canonical skill root itself can be added to git.
  if (
    skillBundlePaths.includes(SKILL_ROOT)
    && pathIsGitIgnored(runner, sourceRepo.root, SKILL_ROOT)
  ) {
    for (const path of skillBundlePaths) {
      skippedPaths.add(path);
    }
  }

  for (const path of managedPaths) {
    if (skippedPaths.has(path)) {
      continue;
    }
    if (pathIsGitIgnored(runner, sourceRepo.root, path)) {
      skippedPaths.add(path);
    }
  }

  return {
    paths: managedPaths.filter((path) => !skippedPaths.has(path)),
    skippedPaths: managedPaths.filter((path) => skippedPaths.has(path)),
  };
}

function pathIsGitIgnored(
  runner: CommandRunner,
  root: string,
  relPath: string,
): boolean {
  return commandSucceeds(
    runner,
    "git",
    ["check-ignore", "-q", "--", relPath],
    root,
  );
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
    `- keep the local checkout state only in ignored \`${SOURCE_STATE}\``,
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
      `Error: this repo only has the first-tree source/workspace integration installed. Run ${formatDedicatedTreePathExample("first-tree tree publish", treeRepo)} or switch into the dedicated tree repo first.`,
    );
    return 1;
  }

  if (!treeRepo.hasFramework() || !treeRepo.looksLikeTreeRepo()) {
    console.error(
      "Error: `first-tree tree publish` must run from a dedicated tree repo (or use `--tree-path` to point at one). Run `first-tree tree init` first.",
    );
    return 1;
  }

  const sourceRepoRoots = resolveBoundSourceRepoRoots(treeRepo, runner, options);
  const primarySourceRepoRoot = resolvePrimarySourceRepoRoot(treeRepo, runner, options);
  const bindings = listTreeBindings(treeRepo.root);
  const bootstrap = readBootstrapState(treeRepo.root);
  const primaryBoundRemoteUrl = bindings
    .map((binding) => binding.remoteUrl)
    .find((remoteUrl): remoteUrl is string => typeof remoteUrl === "string")
    ?? bootstrap?.sourceRepoRemoteUrl
    ?? undefined;

  let sourceRepo: Repo | null = null;
  if (primarySourceRepoRoot !== null) {
    const candidate = new Repo(primarySourceRepoRoot);
    if (!candidate.isGitRepo()) {
      if (options?.sourceRepoPath) {
        console.error(
          `Error: the resolved primary source/workspace repo is not a git repository: ${primarySourceRepoRoot}`,
        );
        return 1;
      }
    } else if (candidate.root === treeRepo.root) {
      console.error(
        "Error: the source/workspace repo and dedicated tree repo resolved to the same path. `first-tree tree publish` expects two separate repos.",
      );
      return 1;
    } else if (options?.sourceRepoPath && (
      !candidate.hasCurrentInstalledSkill() || !candidate.hasSourceWorkspaceIntegration()
    )) {
      console.error(
        "Error: the source/workspace repo does not have the first-tree source integration installed. Run `first-tree tree init` from the source/workspace repo first.",
      );
      return 1;
    } else {
      sourceRepo = candidate;
    }
  }

  if (sourceRepoRoots.length === 0 && !primaryBoundRemoteUrl) {
    console.error(
      "Error: could not determine any bound source/workspace repo metadata for this tree. Re-run `first-tree tree bind` or `first-tree tree init` first, or pass `--source-repo PATH`.",
    );
    return 1;
  }

  const sourceRemoteName = options?.sourceRemote ?? "origin";

  try {
    console.log("Context Tree Publish\n");
    console.log(`  Tree repo:   ${treeRepo.root}`);
    console.log(
      `  Primary source repo: ${sourceRepo?.root ?? "(using binding metadata only)"}`,
    );
    console.log(`  Local bound source roots: ${sourceRepoRoots.length}\n`);

    const sourceRemoteUrl = sourceRepo
      ? getGitRemoteUrl(runner, sourceRepo.root, sourceRemoteName)
      : primaryBoundRemoteUrl ?? null;
    if (sourceRemoteUrl === null) {
      throw new Error(
        `Could not determine a GitHub remote for the source/workspace repo from either local checkout metadata or tree bindings.`,
      );
    }

    const sourceGitHub = parseGitHubRemote(sourceRemoteUrl);
    if (sourceGitHub === null) {
      throw new Error(
        `The source/workspace remote is not a GitHub remote: ${sourceRemoteUrl}`,
      );
    }

    const sourceMetadata = readGitHubRepoMetadata(
      runner,
      sourceGitHub.slug,
      sourceRepo?.root ?? treeRepo.root,
    );
    const treeSlug = `${sourceGitHub.owner}/${treeRepo.repoName()}`;
    const treeAgentHooks = ensureAgentContextHooks(treeRepo.root);
    for (const message of formatAgentContextHookMessages(treeAgentHooks)) {
      console.log(`  ${message}`);
    }

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

    const boundSourceRepos = sourceRepoRoots.map((root) => new Repo(root));
    for (const boundSourceRepo of boundSourceRepos) {
      if (
        !boundSourceRepo.hasCurrentInstalledSkill()
        || !boundSourceRepo.hasSourceWorkspaceIntegration()
      ) {
        console.log(
          `  Skipped ${boundSourceRepo.root} because first-tree source integration is not installed there yet.`,
        );
        continue;
      }

      const sourceIntegrationState = updateSourceWorkspaceIntegration(
        boundSourceRepo,
        treeRepo,
        treeRemote.remoteUrl,
      );
      console.log(
        `  Recorded \`${treeRemote.remoteUrl}\` for ${boundSourceRepo.root}.`,
      );
      if (sourceIntegrationState.gitIgnoreAction === "created") {
        console.log("    Created `.gitignore` entries for local tree working state.");
      } else if (sourceIntegrationState.gitIgnoreAction === "updated") {
        console.log("    Updated `.gitignore` for local tree working state.");
      }
      console.log(
        sourceIntegrationState.sourceStateAction === "created"
          ? `    Created \`${SOURCE_STATE}\` for \`${boundSourceRepo.root}\`.`
          : sourceIntegrationState.sourceStateAction === "updated"
          ? `    Updated \`${SOURCE_STATE}\` for \`${boundSourceRepo.root}\`.`
          : `    Reused the existing \`${SOURCE_STATE}\` entry for \`${boundSourceRepo.root}\`.`,
      );
      for (const message of formatAgentContextHookMessages(sourceIntegrationState.agentHookActions)) {
        console.log(`    ${message}`);
      }
    }

    if (sourceRepoRoots.length === 1 && sourceRepo !== null) {
      const sourceBranch = ensureSourceBranch(
        runner,
        sourceRepo,
        sourceRemoteName,
        sourceMetadata.defaultBranch,
        treeRepo.repoName(),
      );
      console.log(`  Working on source/workspace branch \`${sourceBranch}\`.`);

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
    } else if (options?.openPr) {
      console.log(
        sourceRepo === null
          ? "  Skipped `--open-pr` because no local source/workspace checkout was available."
          : "  Skipped `--open-pr` because this shared tree is bound to multiple source/workspace roots.",
      );
    }

    writeTreeState(treeRepo.root, {
      published: { remoteUrl: treeRemote.remoteUrl },
      treeId: readTreeState(treeRepo.root)?.treeId ?? buildTreeId(treeRepo.repoName()),
      treeMode: readTreeState(treeRepo.root)?.treeMode ?? "shared",
      treeRepoName: treeRepo.repoName(),
    });

    console.log();
    console.log(
      `Bound source/workspace repos now reference \`${SOURCE_STATE}\` and the published tree remote \`${treeRemote.remoteUrl}\`.`,
    );
    if (sourceRepoRoots.length > 1) {
      console.log(
        "Review and commit any updated source/workspace repos locally if you want those URL refreshes under version control.",
      );
    }
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
