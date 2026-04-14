import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { Repo } from "#engine/repo.js";
import {
  buildStableSourceId,
  buildTreeId,
  deriveDefaultEntrypoint,
  readTreeState,
  readWorkspaceState,
  type BoundTreeReference,
  type RootKind,
  type SourceBindingMode,
  type SourceScope,
  type TreeMode,
  upsertWorkspaceMember,
  writeSourceState,
  writeTreeBinding,
  writeTreeState,
  writeWorkspaceState,
} from "#engine/runtime/binding-state.js";
import {
  copyCanonicalSkill,
  resolveBundledPackageRoot,
} from "#engine/runtime/installer.js";
import { syncTreeSourceRepoIndex } from "#engine/runtime/source-repo-index.js";
import {
  upsertLocalTreeGitIgnore,
} from "#engine/runtime/local-tree-config.js";
import { upsertFirstTreeIndexFile, upsertSourceIntegrationFiles } from "#engine/runtime/source-integration.js";
import { relativeRepoPath } from "#engine/dedicated-tree.js";

export const BIND_USAGE = `usage: first-tree bind [--tree-path PATH | --tree-url URL] [--tree-mode dedicated|shared] [--mode standalone-source|shared-source|workspace-root|workspace-member] [--workspace-id ID] [--workspace-root PATH] [--entrypoint PATH]

Bind the current source/workspace root to an existing Context Tree repo.

What it does:
  1. Installs or refreshes the lightweight first-tree skill locally
  2. Updates FIRST_TREE.md plus the managed FIRST-TREE-SOURCE-INTEGRATION block
  3. Writes .first-tree/source.json
  4. Writes .first-tree/tree.json and .first-tree/bindings/<source-id>.json
     in the target tree repo, and refreshes source-repos.md plus root guidance
  5. Ensures the target tree repo also has the first-tree skill installed
  6. Syncs the bound codebase repo into the tree repo under .first-tree/submodules/

Typical examples:
  first-tree bind --tree-path ../org-context --tree-mode shared
  first-tree bind --tree-path ../org-context --tree-mode shared --mode workspace-root --workspace-id my-workspace
  first-tree bind --tree-path ../org-context --tree-mode shared --mode workspace-member --workspace-id my-workspace --workspace-root ..

Options:
  --tree-path PATH      Local checkout of the tree repo to bind
  --tree-url URL        Remote URL for the tree repo; if --tree-path is omitted, clone it to a sibling checkout
  --tree-mode MODE      dedicated or shared (default: infer)
  --mode MODE           standalone-source, shared-source, workspace-root, or workspace-member (default: infer)
  --workspace-id ID     Workspace identifier for workspace-root/member bindings
  --workspace-root PATH Workspace root path when binding a workspace member repo
  --entrypoint PATH     Override the default tree entrypoint for this binding
  --help                Show this help message
`;

interface CommandRunOptions {
  cwd: string;
}

type CommandRunner = (
  command: string,
  args: string[],
  options: CommandRunOptions,
) => string;

function defaultCommandRunner(
  command: string,
  args: string[],
  options: CommandRunOptions,
): string {
  return execFileSync(command, args, {
    cwd: options.cwd,
    encoding: "utf-8",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export interface ParsedBindArgs {
  entrypoint?: string;
  mode?: SourceBindingMode;
  treeMode?: TreeMode;
  treePath?: string;
  treeUrl?: string;
  workspaceId?: string;
  workspaceRoot?: string;
}

export interface BindOptions extends ParsedBindArgs {
  commandRunner?: CommandRunner;
  currentCwd?: string;
  sourceRoot?: string;
}

function commandOutput(
  runner: CommandRunner,
  root: string,
  args: string[],
): string | null {
  try {
    return runner("git", args, { cwd: root }).trim();
  } catch {
    return null;
  }
}

function readGitRemoteUrl(
  runner: CommandRunner,
  root: string,
  remote = "origin",
): string | null {
  return commandOutput(runner, root, ["remote", "get-url", remote]);
}

function cloneTreeCheckout(
  runner: CommandRunner,
  treeUrl: string,
  targetRoot: string,
): void {
  runner("git", ["clone", treeUrl, targetRoot], {
    cwd: dirname(targetRoot),
  });
}

function inferTreeRepoNameFromUrl(treeUrl: string): string {
  const scpMatch = treeUrl.match(/^.+[:/]([^/]+?)(?:\.git)?$/);
  return scpMatch?.[1] ?? basename(treeUrl).replace(/\.git$/, "");
}

function inferTreeMode(
  repo: Repo,
  treeRepoName: string,
  explicit?: TreeMode,
): TreeMode {
  if (explicit !== undefined) {
    return explicit;
  }
  const defaultDedicatedNames = new Set([
    `${repo.repoName()}-tree`,
    `${repo.repoName()}-context`,
  ]);
  return defaultDedicatedNames.has(treeRepoName) ? "dedicated" : "shared";
}

function inferBindingMode(
  scope: SourceScope,
  treeMode: TreeMode,
  explicit?: SourceBindingMode,
): SourceBindingMode {
  if (explicit !== undefined) {
    return explicit;
  }
  if (scope === "workspace") {
    return "workspace-root";
  }
  return treeMode === "shared" ? "shared-source" : "standalone-source";
}

function determineScope(bindingMode: SourceBindingMode): SourceScope {
  return bindingMode === "workspace-root" || bindingMode === "workspace-member"
    ? "workspace"
    : "repo";
}

function resolveWorkspaceId(
  repo: Repo,
  bindingMode: SourceBindingMode,
  explicit?: string,
): string | undefined {
  if (
    bindingMode !== "workspace-root" && bindingMode !== "workspace-member"
  ) {
    return undefined;
  }
  return explicit?.trim() || repo.repoName();
}

function resolveWorkspaceRootPath(
  cwd: string,
  repo: Repo,
  bindingMode: SourceBindingMode,
  explicit?: string,
): string | undefined {
  if (bindingMode !== "workspace-member") {
    return undefined;
  }
  if (explicit === undefined) {
    return dirname(repo.root);
  }
  return resolve(cwd, explicit);
}

function ensureTreeCheckout(
  cwd: string,
  sourceRepo: Repo,
  treePath: string | undefined,
  treeUrl: string | undefined,
  runner: CommandRunner,
): { treeRepo: Repo; treeRepoName: string; treeUrl?: string } {
  if (!treePath && !treeUrl) {
    throw new Error("Missing --tree-path or --tree-url.");
  }

  let resolvedTreeRoot: string | undefined = treePath
    ? resolve(cwd, treePath)
    : undefined;
  let resolvedTreeUrl = treeUrl?.trim() || undefined;

  if (!resolvedTreeRoot && resolvedTreeUrl) {
    const inferredName = inferTreeRepoNameFromUrl(resolvedTreeUrl);
    resolvedTreeRoot = join(dirname(sourceRepo.root), inferredName);
    if (!existsSync(resolvedTreeRoot)) {
      cloneTreeCheckout(runner, resolvedTreeUrl, resolvedTreeRoot);
    }
  }

  if (resolvedTreeRoot === undefined) {
    throw new Error("Could not resolve the tree checkout.");
  }

  const treeRepo = new Repo(resolvedTreeRoot);
  if (!treeRepo.isGitRepo()) {
    throw new Error(
      `Tree checkout is not a git repository: ${resolvedTreeRoot}. Run \`first-tree init tree\` first or point bind at an existing tree checkout.`,
    );
  }
  if (treeRepo.root === sourceRepo.root) {
    throw new Error(
      "The source/workspace root and tree repo resolved to the same path. Use `first-tree init --here` only when the current repo itself should become the tree.",
    );
  }

  if (resolvedTreeUrl === undefined) {
    resolvedTreeUrl =
      readGitRemoteUrl(runner, treeRepo.root)
      ?? readTreeState(treeRepo.root)?.published?.remoteUrl
      ?? undefined;
  }

  return {
    treeRepo,
    treeRepoName: treeRepo.repoName(),
    ...(resolvedTreeUrl ? { treeUrl: resolvedTreeUrl } : {}),
  };
}

function installSkillIfNeeded(
  targetRepo: Repo,
  sourceRoot: string,
): "installed" | "reused" {
  if (!targetRepo.hasCurrentInstalledSkill()) {
    copyCanonicalSkill(sourceRoot, targetRepo.root);
    return "installed";
  }
  return "reused";
}

export function parseBindArgs(
  args: string[],
): ParsedBindArgs | { error: string } {
  const parsed: ParsedBindArgs = {};

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
      default:
        return { error: `Unknown bind option: ${arg}` };
    }

    if (args[index] === undefined || args[index]?.startsWith("--")) {
      return { error: `Missing value for ${arg}` };
    }
  }

  if (!parsed.treePath && !parsed.treeUrl) {
    return { error: "Missing --tree-path or --tree-url" };
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

export function runBind(repo?: Repo, options?: BindOptions): number {
  const cwd = options?.currentCwd ?? process.cwd();
  const runner = options?.commandRunner ?? defaultCommandRunner;
  const sourceRepo = repo ?? new Repo();
  const treeResolution = (() => {
    try {
      return ensureTreeCheckout(
        cwd,
        sourceRepo,
        options?.treePath,
        options?.treeUrl,
        runner,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      console.error(`Error: ${message}`);
      return null;
    }
  })();
  if (treeResolution === null) {
    return 1;
  }

  const sourceRoot = options?.sourceRoot ?? resolveBundledPackageRoot();
  const treeMode = inferTreeMode(
    sourceRepo,
    treeResolution.treeRepoName,
    options?.treeMode,
  );
  const scopeHint: SourceScope = options?.mode === "workspace-root"
    || options?.mode === "workspace-member"
    ? "workspace"
    : "repo";
  const bindingMode = inferBindingMode(scopeHint, treeMode, options?.mode);
  const scope = determineScope(bindingMode);
  const workspaceId = resolveWorkspaceId(
    sourceRepo,
    bindingMode,
    options?.workspaceId,
  );
  const workspaceRootPath = resolveWorkspaceRootPath(
    cwd,
    sourceRepo,
    bindingMode,
    options?.workspaceRoot,
  );
  const rootKind: RootKind = sourceRepo.isGitRepo() ? "git-repo" : "folder";
  const sourceId = buildStableSourceId(sourceRepo.root, sourceRepo.repoName());
  const entrypoint = options?.entrypoint
    ?? deriveDefaultEntrypoint(bindingMode, sourceRepo.repoName(), workspaceId);
  const localTreePath = relativeRepoPath(sourceRepo.root, treeResolution.treeRepo.root);
  const remoteUrl = treeResolution.treeUrl;
  const treeReference: BoundTreeReference = {
    entrypoint,
    localPath: localTreePath,
    ...(remoteUrl ? { remoteUrl } : {}),
    treeId: buildTreeId(treeResolution.treeRepoName),
    treeMode,
    treeRepoName: treeResolution.treeRepoName,
  };

  try {
    console.log("Context Tree Bind\n");
    console.log(`  Source/workspace root: ${sourceRepo.root}`);
    console.log(`  Tree repo:             ${treeResolution.treeRepo.root}`);
    console.log(`  Binding mode:          ${bindingMode}`);
    console.log(`  Tree mode:             ${treeMode}\n`);

    const sourceSkillAction = installSkillIfNeeded(sourceRepo, sourceRoot);
    const treeSkillAction = installSkillIfNeeded(
      treeResolution.treeRepo,
      sourceRoot,
    );

    const firstTreeIndex = upsertFirstTreeIndexFile(sourceRepo.root);
    const gitIgnore = upsertLocalTreeGitIgnore(sourceRepo.root);
    const integrationUpdates = upsertSourceIntegrationFiles(
      sourceRepo.root,
      treeResolution.treeRepoName,
      {
        bindingMode,
        entrypoint,
        treeMode,
        treeRepoUrl: remoteUrl,
        workspaceId,
      },
    );
    writeSourceState(sourceRepo.root, {
      bindingMode,
      rootKind,
      scope,
      sourceId,
      sourceName: sourceRepo.repoName(),
      tree: treeReference,
      workspaceId,
      workspaceRootPath: workspaceRootPath
        ? relativeRepoPath(sourceRepo.root, workspaceRootPath)
        : undefined,
    });

    const existingTreeState = readTreeState(treeResolution.treeRepo.root);
    writeTreeState(treeResolution.treeRepo.root, {
      published: remoteUrl
        ? { remoteUrl }
        : existingTreeState?.published,
      treeId: treeReference.treeId,
      treeMode,
      treeRepoName: treeResolution.treeRepoName,
    });
    const sourceRemoteUrl = sourceRepo.isGitRepo()
      ? readGitRemoteUrl(runner, sourceRepo.root)
      : null;
    writeTreeBinding(treeResolution.treeRepo.root, sourceId, {
      bindingMode,
      entrypoint,
      remoteUrl: sourceRemoteUrl ?? undefined,
      rootKind,
      scope,
      sourceId,
      sourceName: sourceRepo.repoName(),
      sourceRootPath: relativeRepoPath(treeResolution.treeRepo.root, sourceRepo.root),
      treeMode,
      treeRepoName: treeResolution.treeRepoName,
      workspaceId,
      workspaceRootPath: workspaceRootPath
        ? relativeRepoPath(treeResolution.treeRepo.root, workspaceRootPath)
        : undefined,
    });
    const sourceRepoIndex = syncTreeSourceRepoIndex(treeResolution.treeRepo.root);

    if (bindingMode === "workspace-member" && workspaceId && workspaceRootPath) {
      upsertWorkspaceMember(
        workspaceRootPath,
        workspaceId,
        new Repo(workspaceRootPath).isGitRepo() ? "git-repo" : "folder",
        {
          ...treeReference,
          localPath: relativeRepoPath(workspaceRootPath, treeResolution.treeRepo.root),
        },
        {
          bindingMode: "workspace-member",
          relativePath: relativeRepoPath(workspaceRootPath, sourceRepo.root),
          rootKind,
          sourceId,
          sourceName: sourceRepo.repoName(),
        },
      );
    }

    if (bindingMode === "workspace-root" && workspaceId) {
      writeWorkspaceState(sourceRepo.root, {
        members: readWorkspaceState(sourceRepo.root)?.members ?? [],
        rootKind,
        tree: treeReference,
        workspaceId,
      });
    }

    if (firstTreeIndex.action === "created") {
      console.log("  Created FIRST_TREE.md.");
    } else if (firstTreeIndex.action === "updated") {
      console.log("  Updated FIRST_TREE.md.");
    }
    if (sourceSkillAction === "installed") {
      console.log("  Installed the bundled first-tree skill locally.");
    } else {
      console.log("  Reused the existing installed first-tree skill locally.");
    }
    if (treeSkillAction === "installed") {
      console.log("  Installed the bundled first-tree skill in the tree repo.");
    } else {
      console.log("  Reused the existing first-tree skill in the tree repo.");
    }
    if (sourceRepoIndex.indexAction === "created") {
      console.log("  Created source-repos.md in the tree repo.");
    } else if (sourceRepoIndex.indexAction === "updated") {
      console.log("  Updated source-repos.md in the tree repo.");
    }
    if (sourceRepoIndex.rootNodeAction === "updated") {
      console.log("  Updated the root NODE.md with the source repo index link.");
    }
    if (sourceRepoIndex.agentsAction === "updated") {
      console.log("  Updated AGENTS.md with source repo index guidance.");
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
    console.log("  Wrote source and tree binding metadata.");
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error(`Error: ${message}`);
    return 1;
  }
}

export function runBindCli(args: string[] = []): number {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(BIND_USAGE);
    return 0;
  }
  const parsed = parseBindArgs(args);
  if ("error" in parsed) {
    console.error(parsed.error);
    console.log(BIND_USAGE);
    return 1;
  }
  return runBind(undefined, parsed);
}
