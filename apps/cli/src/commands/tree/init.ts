import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import type { Command } from "commander";

import { channelConfig } from "../../core/channel.js";
import { pickImmediateWorkspaceSources, writeWorkspaceManifest } from "../../core/workspace.js";
import type { CommandContext, SubcommandModule } from "../types.js";
import { bootstrapTreeRoot } from "./bootstrap.js";
import { isGitRepoRoot, parseGitHubRemoteUrl, readGitRemoteUrl, repoNameForRoot, runCommand } from "./shared.js";
import { copyCanonicalSkills } from "./skill-lib.js";
import { upsertLocalTreeGitIgnore, upsertSourceIntegrationFiles } from "./source-integration.js";
import { readTreeIdentityContract, syncTreeIdentityFiles } from "./tree-identity.js";
import { upsertTreeCodeRepoRegistry } from "./tree-repo-registry.js";

type InitOptions = {
  // `treeMode` is retained as a programmatic-only override of the inert
  // tree-state metadata field. Real users no longer reach it — the
  // user-facing `--tree-mode` parser flag was hard-deleted in PR-C
  // (one release cycle after PR-B's deprecate-and-warn). The default,
  // derived from `--tree-url` presence by `resolveTreeMode`, matches
  // every recipe / e2e shape in main.
  treeMode?: "dedicated" | "shared";
  treePath?: string;
  treeUrl?: string;
  workspaceId?: string;
};

type InitSummary = {
  bindingMode: "workspace-root";
  sourceRoot: string;
  treeRoot: string;
  treeMode: "dedicated" | "shared";
  workspaceId?: string;
  workspaceManifest: {
    tree: string;
    sources: string[];
  };
};

export const INIT_USAGE = `usage: first-tree tree init [--tree-path PATH | --tree-url URL] [--workspace-id ID]

Onboard a workspace root to a Context Tree.

Options:
  --tree-path PATH    use an explicit local tree repo path
  --tree-url URL      bind to an existing remote tree repo
  --workspace-id ID   workspace identifier for shared workspace onboarding
  --help              show this help message`;

function configureInitCommand(command: Command): void {
  command
    .option("--tree-path <path>", "use an explicit local tree repo path")
    .option("--tree-url <url>", "bind to an existing remote tree repo")
    .option("--workspace-id <id>", "workspace identifier for shared workspace onboarding");
  // PR-C: `--tree-name`, `--tree-mode`, `--scope` are hard-deleted from
  // the parser. PR-B left them as deprecated-and-warn for one release
  // cycle to survive the staging auto-publish window where a new CLI
  // could briefly coexist with an old bundled skill payload that still
  // passed them. By PR-C the bundled skill no longer mentions them,
  // first-party CLI hints have moved off them, and e2e harnesses use
  // the W1-clean shape. Any remaining caller now sees a clear
  // "unknown option" error from commander, which is the right signal.
}

function readStringOption(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readInitOptions(command: Command): InitOptions {
  const options: Record<string, unknown> = command.opts();
  return {
    treePath: readStringOption(options.treePath),
    treeUrl: readStringOption(options.treeUrl),
    workspaceId: readStringOption(options.workspaceId),
  };
}

function resolveTreeMode(options: InitOptions): "dedicated" | "shared" {
  // Programmatic override wins (only path that reaches here under PR-C
  // since the user-facing flag is gone). Otherwise derive from
  // `--tree-url` presence so the recorded `.first-tree/tree.json`
  // metadata field reflects the actual scaffold-vs-clone shape.
  if (options.treeMode !== undefined) {
    return options.treeMode;
  }
  return options.treeUrl !== undefined ? "shared" : "dedicated";
}

function resolveTreeRoot(workspaceRoot: string, options: InitOptions): string {
  if (options.treePath) {
    return resolve(workspaceRoot, options.treePath);
  }

  if (options.treeUrl) {
    const parsed = parseGitHubRemoteUrl(options.treeUrl);
    const defaultName = parsed?.repo ?? basename(options.treeUrl).replace(/\.git$/u, "");
    return join(workspaceRoot, defaultName);
  }

  const defaultName = `${repoNameForRoot(workspaceRoot)}-tree`;
  return join(workspaceRoot, defaultName);
}

function ensureTreeCheckout(treeRoot: string, options: { treeUrl?: string; treeMode: "dedicated" | "shared" }): void {
  if (existsSync(treeRoot)) {
    if (!isGitRepoRoot(treeRoot)) {
      throw new Error(
        `Tree path exists but is not a git repository: ${treeRoot}. Point --tree-path at an existing tree checkout, or remove the directory and let init scaffold it.`,
      );
    }
    return;
  }

  if (options.treeUrl) {
    runCommand("git", ["clone", options.treeUrl, treeRoot], dirname(treeRoot));
    return;
  }

  bootstrapTreeRoot(treeRoot, { treeMode: options.treeMode });
}

function resolveWorkspaceId(workspaceRoot: string, options: InitOptions): string {
  return options.workspaceId?.trim() || repoNameForRoot(workspaceRoot);
}

export function initializeWorkspaceRoot(workspaceRoot: string, options: InitOptions = {}): InitSummary {
  const treeMode = resolveTreeMode(options);
  const treeRoot = resolveTreeRoot(workspaceRoot, options);

  if (resolve(treeRoot) === resolve(workspaceRoot)) {
    throw new Error("The workspace root and tree repo resolved to the same path.");
  }

  if (dirname(resolve(treeRoot)) !== resolve(workspaceRoot)) {
    throw new Error(
      `Tree must live as an immediate subdirectory of the workspace root. Got tree=${treeRoot}, workspace=${workspaceRoot}.`,
    );
  }

  ensureTreeCheckout(treeRoot, {
    ...(options.treeUrl ? { treeUrl: options.treeUrl } : {}),
    treeMode,
  });

  if (readTreeIdentityContract(treeRoot) === undefined) {
    bootstrapTreeRoot(treeRoot, { treeMode });
  }

  const workspaceId = resolveWorkspaceId(workspaceRoot, options);
  const treeRepoName = repoNameForRoot(treeRoot);
  const treeUrl =
    options.treeUrl?.trim() || readGitRemoteUrl(treeRoot) || readTreeIdentityContract(treeRoot)?.publishedTreeUrl;

  syncTreeIdentityFiles(treeRoot, {
    ...(treeUrl ? { publishedTreeUrl: treeUrl } : {}),
    treeMode,
    treeRepoName,
  });

  copyCanonicalSkills(workspaceRoot);
  upsertLocalTreeGitIgnore(workspaceRoot);
  upsertSourceIntegrationFiles(workspaceRoot, treeRepoName, {
    binName: channelConfig.binName,
    bindingMode: "workspace-root",
    entrypoint: "/",
    treeMode,
    ...(treeUrl ? { treeRepoUrl: treeUrl } : {}),
    workspaceId,
  });

  const workspaceRemoteUrl = readGitRemoteUrl(workspaceRoot);
  if (workspaceRemoteUrl && parseGitHubRemoteUrl(workspaceRemoteUrl) !== null) {
    upsertTreeCodeRepoRegistry(treeRoot, workspaceRemoteUrl);
  }

  const manifest = writeWorkspaceManifestFromState(workspaceRoot, treeRoot);

  return {
    bindingMode: "workspace-root",
    sourceRoot: workspaceRoot,
    treeRoot,
    treeMode,
    workspaceId,
    workspaceManifest: manifest,
  };
}

function writeWorkspaceManifestFromState(workspaceRoot: string, treeRoot: string): { tree: string; sources: string[] } {
  const workspaceResolved = resolve(workspaceRoot);
  const treeResolved = resolve(treeRoot);
  const treeName = basename(treeResolved);
  const sources = pickImmediateWorkspaceSources(workspaceResolved, treeName);
  const manifest = { tree: treeName, sources };
  writeWorkspaceManifest(workspaceResolved, manifest);
  return manifest;
}

function runInitCommand(context: CommandContext): void {
  try {
    const workspaceRoot = resolve(process.cwd());
    if (!existsSync(workspaceRoot)) {
      throw new Error(`Workspace root does not exist: ${workspaceRoot}`);
    }

    const options = readInitOptions(context.command);
    const summary = initializeWorkspaceRoot(workspaceRoot, options);

    if (context.options.json) {
      console.log(JSON.stringify(summary, null, 2));
      return;
    }

    console.log("Context Tree Init\n");
    console.log(`  Workspace root:        ${summary.sourceRoot}`);
    console.log(`  Tree root:             ${summary.treeRoot}`);
    console.log(`  Binding mode:          ${summary.bindingMode}`);
    console.log(`  Tree mode:             ${summary.treeMode}`);
    if (summary.workspaceId) {
      console.log(`  Workspace id:          ${summary.workspaceId}`);
    }
    console.log(
      `  Workspace manifest:    .first-tree/workspace.json (tree=${summary.workspaceManifest.tree}, ${summary.workspaceManifest.sources.length} sources)`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export const initCommand: SubcommandModule = {
  name: "init",
  alias: "",
  summary: "",
  description: "Onboard a workspace root to a Context Tree.",
  action: runInitCommand,
  configure: configureInitCommand,
};
