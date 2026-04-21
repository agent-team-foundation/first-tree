import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  type CommandRunner,
  defaultCommandRunner,
  determineScope,
  inferBindingMode,
  inferTreeMode,
  readGitRemoteUrl,
  resolveWorkspaceId,
} from "#products/tree/engine/bind.js";
import { Repo } from "#products/tree/engine/repo.js";
import {
  ensureAgentContextHooks,
  formatAgentContextHookMessages,
} from "#products/tree/engine/runtime/adapters.js";
import {
  type BoundTreeReference,
  buildStableSourceId,
  buildTreeId,
  deriveDefaultEntrypoint,
  type RootKind,
  type SourceBindingMode,
  type SourceScope,
  type TreeMode,
  writeSourceState,
} from "#products/tree/engine/runtime/binding-state.js";
import {
  copyCanonicalSkill,
  resolveBundledPackageRoot,
} from "#products/tree/engine/runtime/installer.js";
import { upsertLocalTreeGitIgnore } from "#products/tree/engine/runtime/local-tree-config.js";
import {
  upsertFirstTreeIndexFile,
  upsertSourceIntegrationFiles,
} from "#products/tree/engine/runtime/source-integration.js";

export const INTEGRATE_USAGE = `usage: first-tree tree integrate --tree-path PATH [--tree-url URL] [--tree-mode dedicated|shared] [--mode standalone-source|shared-source|workspace-root|workspace-member] [--workspace-id ID] [--workspace-root PATH] [--entrypoint PATH] [--source-path PATH]

Install the first-tree skill and the FIRST-TREE-SOURCE-INTEGRATION block into the current folder, without touching the tree repo.

What it does:
  1. Installs or refreshes the lightweight first-tree skill locally
  2. Updates WHITEPAPER.md plus the managed FIRST-TREE-SOURCE-INTEGRATION block in AGENTS.md and CLAUDE.md
  3. Writes .first-tree/source.json

Unlike \`first-tree tree bind\`, this command does NOT:
  - Clone the tree repo
  - Write .first-tree/tree.json, bindings/, or source-repos.md into the tree repo
  - Install the skill into the tree repo

Use this when the tree repo is managed externally — for example, when an agent runtime
owns its own long-lived tree checkout and wants ephemeral workspaces to reference it
without polluting the shared tree repo.

Options:
  --tree-path PATH      Local checkout of the tree repo (required)
  --tree-url URL        Tree repo URL recorded in source.json (default: read from tree checkout's git remote)
  --tree-mode MODE      dedicated or shared (default: infer)
  --mode MODE           standalone-source, shared-source, workspace-root, or workspace-member (default: infer)
  --workspace-id ID     Workspace identifier for workspace-root/member bindings
  --workspace-root PATH Workspace root path when binding a workspace member repo
  --entrypoint PATH     Override the default tree entrypoint for this binding
  --source-path PATH    Source/workspace root to integrate into (default: current directory)
  --help                Show this help message
`;

export interface ParsedIntegrateArgs {
  entrypoint?: string;
  mode?: SourceBindingMode;
  sourcePath?: string;
  treeMode?: TreeMode;
  treePath?: string;
  treeUrl?: string;
  workspaceId?: string;
  workspaceRoot?: string;
}

export interface IntegrateOptions extends ParsedIntegrateArgs {
  commandRunner?: CommandRunner;
  currentCwd?: string;
  sourceRoot?: string;
}

export function parseIntegrateArgs(
  args: string[],
): ParsedIntegrateArgs | { error: string } {
  const parsed: ParsedIntegrateArgs = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--tree-path":
        parsed.treePath = args[index + 1];
        index += 1;
        break;
      case "--tree-url":
        parsed.treeUrl = args[index + 1];
        index += 1;
        break;
      case "--tree-mode":
        parsed.treeMode = args[index + 1] as TreeMode;
        index += 1;
        break;
      case "--mode":
        parsed.mode = args[index + 1] as SourceBindingMode;
        index += 1;
        break;
      case "--workspace-id":
        parsed.workspaceId = args[index + 1];
        index += 1;
        break;
      case "--workspace-root":
        parsed.workspaceRoot = args[index + 1];
        index += 1;
        break;
      case "--entrypoint":
        parsed.entrypoint = args[index + 1];
        index += 1;
        break;
      case "--source-path":
        parsed.sourcePath = args[index + 1];
        index += 1;
        break;
      default:
        return { error: `Unknown integrate option: ${arg}` };
    }

    if (args[index] === undefined || args[index]?.startsWith("--")) {
      return { error: `Missing value for ${arg}` };
    }
  }

  if (!parsed.treePath) {
    return { error: "Missing --tree-path" };
  }

  if (
    parsed.treeMode !== undefined
    && parsed.treeMode !== "dedicated"
    && parsed.treeMode !== "shared"
  ) {
    return { error: `Unsupported value for --tree-mode: ${parsed.treeMode}` };
  }

  if (
    parsed.mode !== undefined
    && parsed.mode !== "standalone-source"
    && parsed.mode !== "shared-source"
    && parsed.mode !== "workspace-root"
    && parsed.mode !== "workspace-member"
  ) {
    return { error: `Unsupported value for --mode: ${parsed.mode}` };
  }

  return parsed;
}

export function runIntegrate(options: IntegrateOptions): number {
  const cwd = options.currentCwd ?? process.cwd();
  const runner = options.commandRunner ?? defaultCommandRunner;

  if (!options.treePath) {
    console.error("Missing --tree-path.");
    return 1;
  }

  const sourceRootPath = options.sourcePath
    ? resolve(cwd, options.sourcePath)
    : cwd;
  const sourceRepo = new Repo(sourceRootPath);

  const resolvedTreeRoot = resolve(cwd, options.treePath);
  if (!existsSync(resolvedTreeRoot)) {
    console.error(`Tree checkout does not exist: ${resolvedTreeRoot}`);
    return 1;
  }
  const treeRepo = new Repo(resolvedTreeRoot);
  if (treeRepo.root === sourceRepo.root) {
    console.error(
      "The source/workspace root and tree repo resolved to the same path.",
    );
    return 1;
  }

  const treeRepoName = treeRepo.repoName();
  const resolvedTreeUrl = options.treeUrl?.trim()
    || (treeRepo.isGitRepo()
      ? readGitRemoteUrl(runner, treeRepo.root) ?? undefined
      : undefined)
    || undefined;

  const bundledPackageRoot = options.sourceRoot ?? resolveBundledPackageRoot();
  const treeMode = inferTreeMode(sourceRepo, treeRepoName, options.treeMode);
  const scopeHint: SourceScope = options.mode === "workspace-root"
      || options.mode === "workspace-member"
    ? "workspace"
    : "repo";
  const bindingMode = inferBindingMode(scopeHint, treeMode, options.mode);
  const scope = determineScope(bindingMode);
  const workspaceId = resolveWorkspaceId(
    sourceRepo,
    bindingMode,
    options.workspaceId,
  );
  const rootKind: RootKind = sourceRepo.isGitRepo() ? "git-repo" : "folder";
  const sourceRemoteUrl = sourceRepo.isGitRepo()
    ? readGitRemoteUrl(runner, sourceRepo.root)
    : null;
  const sourceId = buildStableSourceId(sourceRepo.repoName(), {
    fallbackRoot: sourceRepo.root,
    remoteUrl: sourceRemoteUrl ?? undefined,
  });
  const entrypoint = options.entrypoint
    ?? deriveDefaultEntrypoint(
      bindingMode,
      sourceRepo.repoName(),
      workspaceId,
    );
  const treeReference: BoundTreeReference = {
    entrypoint,
    ...(resolvedTreeUrl ? { remoteUrl: resolvedTreeUrl } : {}),
    treeId: buildTreeId(treeRepoName),
    treeMode,
    treeRepoName,
  };

  try {
    console.log("Context Tree Integrate\n");
    console.log(`  Source/workspace root: ${sourceRepo.root}`);
    console.log(`  Tree repo:             ${treeRepo.root}`);
    console.log(`  Binding mode:          ${bindingMode}`);
    console.log(`  Tree mode:             ${treeMode}\n`);

    let sourceSkillAction: "installed" | "reused";
    if (sourceRepo.hasCurrentInstalledSkill()) {
      sourceSkillAction = "reused";
    } else {
      copyCanonicalSkill(bundledPackageRoot, sourceRepo.root);
      sourceSkillAction = "installed";
    }

    const firstTreeIndex = upsertFirstTreeIndexFile(sourceRepo.root);
    const gitIgnore = upsertLocalTreeGitIgnore(sourceRepo.root);
    const integrationUpdates = upsertSourceIntegrationFiles(
      sourceRepo.root,
      treeRepoName,
      {
        bindingMode,
        entrypoint,
        treeMode,
        treeRepoUrl: resolvedTreeUrl,
        workspaceId,
      },
    );
    const sourceAgentHooks = ensureAgentContextHooks(sourceRepo.root);
    writeSourceState(sourceRepo.root, {
      bindingMode,
      rootKind,
      scope,
      sourceId,
      sourceName: sourceRepo.repoName(),
      tree: treeReference,
      workspaceId,
    });

    if (firstTreeIndex.action === "created") {
      console.log("  Created WHITEPAPER.md.");
    } else if (firstTreeIndex.action === "updated") {
      console.log("  Updated WHITEPAPER.md.");
    }
    if (sourceSkillAction === "installed") {
      console.log("  Installed the bundled first-tree skill locally.");
    } else {
      console.log("  Reused the existing installed first-tree skill locally.");
    }
    if (gitIgnore.action === "created") {
      console.log("  Created .gitignore entries for first-tree local state.");
    } else if (gitIgnore.action === "updated") {
      console.log("  Updated .gitignore entries for first-tree local state.");
    }
    const changedFiles = integrationUpdates
      .filter((update) => update.action !== "unchanged")
      .map((update) => update.file);
    if (changedFiles.length > 0) {
      console.log(`  Updated ${changedFiles.join(" and ")}.`);
    } else {
      console.log("  Source integration instructions were already current.");
    }
    for (const message of formatAgentContextHookMessages(sourceAgentHooks)) {
      console.log(`  ${message}`);
    }
    console.log("  Wrote source binding metadata.");
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error(`Error: ${message}`);
    return 1;
  }
}

export function runIntegrateCli(args: string[] = []): number {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(INTEGRATE_USAGE);
    return 0;
  }
  const parsed = parseIntegrateArgs(args);
  if ("error" in parsed) {
    console.error(parsed.error);
    console.log(INTEGRATE_USAGE);
    return 1;
  }
  return runIntegrate(parsed);
}
