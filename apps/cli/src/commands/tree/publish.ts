import { dirname, join, resolve } from "node:path";

import type { Command } from "commander";

import type { CommandContext, SubcommandModule } from "../types.js";
import { removeSourceState, TREE_SOURCE_REPOS_FILE } from "./binding-state.js";
import { readSourceBindingContract } from "./binding-contract.js";
import { syncTreeSourceRepoIndex } from "./source-repo-index.js";
import { upsertSourceIntegrationFiles } from "./source-integration.js";
import { readTreeIdentityContract, syncTreeIdentityFiles } from "./tree-identity.js";
import { listKnownTreeCodeRepos } from "./tree-repo-registry.js";
import {
  isGitRepoRoot,
  parseGitHubRemoteUrl,
  readGitRemoteUrl,
  repoNameForRoot,
  runCommand,
} from "./shared.js";

type PublishOptions = {
  commandRunner?: (command: string, args: string[], cwd: string) => string;
  sourceRemote?: string;
  sourceRepoPath?: string;
  treePath?: string;
};

type PublishSummary = {
  publishedTreeUrl: string;
  refreshedSourceRoots: string[];
  treeRoot: string;
};

export const PUBLISH_USAGE = `usage: first-tree tree publish [--tree-path PATH] [--source-repo PATH] [--source-remote NAME]

Publish a tree repo to GitHub and refresh any locally discoverable bound source repos.

Options:
  --tree-path PATH      publish a tree repo from another working directory
  --source-repo PATH    explicit source/workspace repo path when it cannot be inferred
  --source-remote NAME  source repo remote to mirror on GitHub (default: origin)
  --help                show this help message`;

function configurePublishCommand(command: Command): void {
  command
    .option("--tree-path <path>", "publish a tree repo from another working directory")
    .option("--source-repo <path>", "explicit source/workspace repo path")
    .option("--source-remote <name>", "source repo remote to mirror on GitHub");
}

function readPublishOptions(command: Command): PublishOptions {
  const options = command.opts() as Record<string, string | undefined>;
  return {
    sourceRemote: options.sourceRemote,
    sourceRepoPath: options.sourceRepo,
    treePath: options.treePath,
  };
}

function runPublishCommandLine(command: string, args: string[], cwd: string): string {
  return runCommand(command, args, cwd);
}

function resolveTreeRoot(options: PublishOptions): string {
  const candidate = options.treePath ? resolve(process.cwd(), options.treePath) : process.cwd();
  if (readTreeIdentityContract(candidate) === undefined) {
    throw new Error(
      "Run `first-tree tree publish` from a tree repo, or pass `--tree-path <path>`.",
    );
  }
  return candidate;
}

function resolveTreeSlug(
  treeRoot: string,
  options: PublishOptions,
): { cloneUrl: string; slug: string } {
  const existingRemote =
    readTreeIdentityContract(treeRoot)?.publishedTreeUrl ?? readGitRemoteUrl(treeRoot);
  const existingParsed = existingRemote ? parseGitHubRemoteUrl(existingRemote) : null;
  if (existingParsed !== null) {
    return {
      cloneUrl: `https://github.com/${existingParsed.owner}/${existingParsed.repo}.git`,
      slug: `${existingParsed.owner}/${existingParsed.repo}`,
    };
  }

  const sourceRepoPath = options.sourceRepoPath
    ? resolve(process.cwd(), options.sourceRepoPath)
    : undefined;
  const sourceRemoteName = options.sourceRemote ?? "origin";
  const sourceRemote = sourceRepoPath
    ? readGitRemoteUrl(sourceRepoPath, sourceRemoteName)
    : undefined;
  const sourceParsed = sourceRemote ? parseGitHubRemoteUrl(sourceRemote) : null;
  if (sourceParsed !== null) {
    return {
      cloneUrl: `https://github.com/${sourceParsed.owner}/${repoNameForRoot(treeRoot)}.git`,
      slug: `${sourceParsed.owner}/${repoNameForRoot(treeRoot)}`,
    };
  }

  for (const repo of listKnownTreeCodeRepos(treeRoot)) {
    const parsed = parseGitHubRemoteUrl(repo.url);
    if (parsed !== null) {
      return {
        cloneUrl: `https://github.com/${parsed.owner}/${repoNameForRoot(treeRoot)}.git`,
        slug: `${parsed.owner}/${repoNameForRoot(treeRoot)}`,
      };
    }
  }

  throw new Error(
    "Could not infer the GitHub destination for this tree. Pass `--source-repo <path>` to anchor the publish target.",
  );
}

function ensureTreeRemote(
  treeRoot: string,
  cloneUrl: string,
  commandRunner: NonNullable<PublishOptions["commandRunner"]>,
): void {
  let currentRemote: string | undefined;
  try {
    currentRemote = commandRunner("git", ["remote", "get-url", "origin"], treeRoot);
  } catch {
    currentRemote = undefined;
  }
  if (currentRemote === cloneUrl) {
    return;
  }

  if (currentRemote === undefined) {
    commandRunner("git", ["remote", "add", "origin", cloneUrl], treeRoot);
    return;
  }

  commandRunner("git", ["remote", "set-url", "origin", cloneUrl], treeRoot);
}

function ensureGitHubRepo(
  treeRoot: string,
  slug: string,
  commandRunner: NonNullable<PublishOptions["commandRunner"]>,
): void {
  try {
    commandRunner("gh", ["repo", "view", slug], treeRoot);
  } catch {
    commandRunner(
      "gh",
      ["repo", "create", slug, "--private", "--source", treeRoot, "--remote", "origin"],
      treeRoot,
    );
  }
}

function pushTree(
  treeRoot: string,
  commandRunner: NonNullable<PublishOptions["commandRunner"]>,
): void {
  commandRunner("git", ["push", "-u", "origin", "HEAD:main"], treeRoot);
}

function resolveLocalSourceRoots(treeRoot: string, options: PublishOptions): string[] {
  if (options.sourceRepoPath) {
    return [resolve(process.cwd(), options.sourceRepoPath)];
  }

  const roots: string[] = [];
  for (const repo of listKnownTreeCodeRepos(treeRoot)) {
    const sibling = join(dirname(treeRoot), repo.name);
    if (isGitRepoRoot(sibling)) {
      roots.push(sibling);
    }
  }

  return [...new Set(roots)];
}

function refreshBoundSourceRoots(
  treeRoot: string,
  publishedTreeUrl: string,
  sourceRoots: string[],
): string[] {
  const refreshed: string[] = [];

  for (const sourceRoot of sourceRoots) {
    const sourceBinding = readSourceBindingContract(sourceRoot);
    if (sourceBinding === undefined || sourceBinding.treeRepoName === undefined) {
      continue;
    }

    upsertSourceIntegrationFiles(sourceRoot, sourceBinding.treeRepoName, {
      bindingMode: sourceBinding.bindingMode,
      entrypoint: sourceBinding.entrypoint,
      treeMode: sourceBinding.treeMode,
      treeRepoName: sourceBinding.treeRepoName,
      treeRepoUrl: publishedTreeUrl,
      workspaceId: sourceBinding.workspaceId,
    });
    removeSourceState(sourceRoot);
    refreshed.push(sourceRoot);
  }

  syncTreeSourceRepoIndex(treeRoot);
  return refreshed;
}

export function publishTreeRoot(treeRoot: string, options: PublishOptions = {}): PublishSummary {
  const commandRunner = options.commandRunner ?? runPublishCommandLine;
  const { cloneUrl, slug } = resolveTreeSlug(treeRoot, options);
  ensureTreeRemote(treeRoot, cloneUrl, commandRunner);
  ensureGitHubRepo(treeRoot, slug, commandRunner);
  pushTree(treeRoot, commandRunner);
  const treeIdentity = readTreeIdentityContract(treeRoot);
  if (treeIdentity === undefined) {
    throw new Error("Tree identity disappeared during publish.");
  }
  syncTreeIdentityFiles(treeRoot, {
    ...treeIdentity,
    publishedTreeUrl: cloneUrl,
  });

  const refreshedSourceRoots = refreshBoundSourceRoots(
    treeRoot,
    cloneUrl,
    resolveLocalSourceRoots(treeRoot, options),
  );

  return {
    publishedTreeUrl: cloneUrl,
    refreshedSourceRoots,
    treeRoot,
  };
}

function runPublishCommand(context: CommandContext): void {
  try {
    const options = readPublishOptions(context.command);
    const summary = publishTreeRoot(resolveTreeRoot(options), options);

    if (context.options.json) {
      console.log(JSON.stringify(summary, null, 2));
      return;
    }

    console.log("Context Tree Publish\n");
    console.log(`  Tree root:          ${summary.treeRoot}`);
    console.log(`  Published tree URL: ${summary.publishedTreeUrl}`);
    console.log(`  Refreshed sources:  ${summary.refreshedSourceRoots.length}`);
    for (const sourceRoot of summary.refreshedSourceRoots) {
      console.log(`  - ${sourceRoot}`);
    }
    if (summary.refreshedSourceRoots.length === 0) {
      console.log(
        `  No local source roots were refreshed. Update \`${TREE_SOURCE_REPOS_FILE}\` consumers manually if needed.`,
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export const publishCommand: SubcommandModule = {
  name: "publish",
  alias: "",
  summary: "",
  description: "Publish a tree repo and refresh bound source repos.",
  action: runPublishCommand,
  configure: configurePublishCommand,
};
