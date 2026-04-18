import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  buildDefaultTreeRepoName,
  formatDedicatedTreePathExample,
  relativeRepoPath,
  resolveDedicatedTreeRepoForSource,
} from "#products/tree/engine/dedicated-tree.js";
import { Repo } from "#products/tree/engine/repo.js";
import { readSourceState, writeSourceState } from "#products/tree/engine/runtime/binding-state.js";
import {
  AGENT_INSTRUCTIONS_FILE,
  CLAUDE_INSTRUCTIONS_FILE,
  FIRST_TREE_INDEX_FILE,
  INSTALLED_SKILL_VERSION,
  LEGACY_AGENT_INSTRUCTIONS_FILE,
  LEGACY_REPO_SKILL_ROOT,
  SOURCE_INTEGRATION_MARKER,
  installedSkillRootsDisplay,
  type FrameworkLayout,
} from "#products/tree/engine/runtime/asset-loader.js";
import {
  ensureAgentContextHooks,
  formatAgentContextHookMessages,
  refreshShippedWorkflows,
} from "#products/tree/engine/runtime/adapters.js";
import {
  copyCanonicalSkill,
  resolveBundledAssetRoot,
  resolveBundledPackageRoot,
  wipeInstalledSkill,
  writeTreeRuntimeVersion,
} from "#products/tree/engine/runtime/installer.js";
import { syncTreeSourceRepoIndex } from "#products/tree/engine/runtime/source-repo-index.js";
import {
  upsertFirstTreeIndexFile,
  upsertSourceIntegrationFiles,
} from "#products/tree/engine/runtime/source-integration.js";
import {
  readLocalTreeConfig,
  upsertLocalTreeGitIgnore,
} from "#products/tree/engine/runtime/local-tree-config.js";
import {
  compareSkillVersions,
  readBundledSkillVersion,
} from "#products/tree/engine/runtime/upgrader.js";

export const UPGRADE_USAGE = `usage: first-tree tree upgrade [--tree-path PATH]

Refresh the installed skill payload from the bundled \`first-tree\` package.

The CLI compares the installed skill version (major.minor) against the
bundled skill version. If they match, upgrade is a no-op. If the bundled
version is newer, the installed payload is replaced and a task list is
emitted for any manual follow-ups (e.g., reapplying customizations).

In a source/workspace repo: refreshes only the local installed skill, the
\`WHITEPAPER.md\` symlink, and the managed \`FIRST-TREE-SOURCE-INTEGRATION:\`
section in AGENTS.md/CLAUDE.md. The dedicated tree repo must be upgraded
separately with \`--tree-path\`.

In a dedicated tree repo: refreshes \`.first-tree/VERSION\`, refreshes the
installed tree-repo skill when present, and emits a task list for the
maintainer.

Migrates legacy layouts (\`.context-tree/\`, \`skills/first-tree/\`) onto the
modern \`.agents/skills/first-tree/\` path. To pick up a newer skill version,
install a newer \`first-tree\` package first (or rely on auto-upgrade).

Options:
  --tree-path PATH   Upgrade a tree repo from another working directory
  --help             Show this help message
`;

const SYNC_RUNBOOKS = [
  { rel: "first-tree-sync.md", label: "sync runbook" },
  { rel: "first-tree-sync-schedule.md", label: "sync schedule runbook" },
  { rel: "first-tree-sync-start.md", label: "sync start command" },
  { rel: "first-tree-sync-stop.md", label: "sync stop command" },
  { rel: "first-tree-sync-loop.md", label: "sync loop command" },
];

export function ensureSyncRunbook(
  treeRoot: string,
  sourceRoot: string,
): "created" | "unchanged" | "missing-source" {
  let result: "created" | "unchanged" | "missing-source" = "unchanged";

  for (const { rel, label } of SYNC_RUNBOOKS) {
    const targetPath = join(treeRoot, ".claude", "commands", rel);
    if (existsSync(targetPath)) continue;

    const sourcePath = join(sourceRoot, "assets", "tree", "claude-commands", rel);
    if (!existsSync(sourcePath)) {
      if (result === "unchanged") result = "missing-source";
      continue;
    }
    mkdirSync(dirname(targetPath), { recursive: true });
    copyFileSync(sourcePath, targetPath);
    console.log(`Installed ${label} at \`.claude/commands/${rel}\`.`);
    result = "created";
  }

  // Check for gardener
  const gardenerInstalled = existsSync(join(treeRoot, ".claude", "commands", "gardener-manual.md"));
  if (!gardenerInstalled) {
    console.log(
      "\n\u26A0\uFE0F  repo-gardener is required for sync to review tree-update PRs before merge.\n" +
      "   Install it by running this in Claude Code:\n\n" +
      '   Fetch the latest release of repo-gardener and execute its onboarding script: https://github.com/agent-team-foundation/repo-gardener/releases/latest\n\n' +
      "   After installing gardener, run `first-tree tree upgrade` again.\n",
    );
  }

  return result;
}

function writeProgress(repo: Repo, content: string): void {
  const progressPath = join(repo.root, repo.preferredProgressPath());
  mkdirSync(dirname(progressPath), { recursive: true });
  writeFileSync(progressPath, content);
}

function syncLocalSourceWorkspaceState(
  sourceRepo: Repo,
  treeRepoName: string,
  treeRoot: string,
): {
  gitIgnoreAction: "created" | "updated" | "unchanged";
  sourceStateAction: "created" | "updated" | "unchanged";
} {
  const gitIgnore = upsertLocalTreeGitIgnore(sourceRepo.root);
  const existingSourceState = readSourceState(sourceRepo.root);
  if (existingSourceState !== null) {
    const before = JSON.stringify(existingSourceState);
    writeSourceState(sourceRepo.root, {
      ...existingSourceState,
      tree: {
        ...existingSourceState.tree,
        localPath: relativeRepoPath(sourceRepo.root, treeRoot),
        treeRepoName,
      },
    });
    const after = JSON.stringify(readSourceState(sourceRepo.root));
    return {
      gitIgnoreAction: gitIgnore.action,
      sourceStateAction: before === after ? "unchanged" : "updated",
    };
  }
  return {
    gitIgnoreAction: gitIgnore.action,
    sourceStateAction: "unchanged",
  };
}

function sourceIntegrationOptionsForUpgrade(sourceRepo: Repo): {
  bindingMode?:
    | "shared-source"
    | "standalone-source"
    | "workspace-member"
    | "workspace-root";
  entrypoint?: string;
  treeMode?: "dedicated" | "shared";
  treeRepoUrl?: string;
  workspaceId?: string;
} {
  const sourceState = readSourceState(sourceRepo.root);
  const localTreeConfig = readLocalTreeConfig(sourceRepo.root);
  return {
    bindingMode: sourceState?.bindingMode ?? localTreeConfig?.bindingMode,
    entrypoint: sourceState?.tree.entrypoint ?? localTreeConfig?.entrypoint,
    treeMode: sourceState?.tree.treeMode ?? localTreeConfig?.treeMode,
    treeRepoUrl: sourceState?.tree.remoteUrl ?? localTreeConfig?.treeRepoUrl,
    workspaceId: sourceState?.workspaceId ?? localTreeConfig?.workspaceId,
  };
}

function logLocalSourceWorkspaceState(
  state: ReturnType<typeof syncLocalSourceWorkspaceState>,
): void {
  if (state.gitIgnoreAction === "created") {
    console.log("Created `.gitignore` entries for local tree checkout state.");
  } else if (state.gitIgnoreAction === "updated") {
    console.log("Updated `.gitignore` for local tree checkout state.");
  }

  if (state.sourceStateAction === "created") {
    console.log("Created `.first-tree/source.json` for the local tree checkout.");
  } else if (state.sourceStateAction === "updated") {
    console.log("Updated `.first-tree/source.json` for the local tree checkout.");
  }
}

function logTreeSourceRepoIndexSync(
  state: ReturnType<typeof syncTreeSourceRepoIndex>,
): void {
  if (state.indexAction === "created") {
    console.log("Created `source-repos.md` from the current tree bindings.");
  } else if (state.indexAction === "updated") {
    console.log("Updated `source-repos.md` from the current tree bindings.");
  }

  if (state.rootNodeAction === "updated") {
    console.log("Updated the root `NODE.md` with the source repo index link.");
  }

  if (state.agentsAction === "updated") {
    console.log("Updated `AGENTS.md` with source repo index guidance.");
  }
}

function logAgentContextHookRefresh(
  hookRefresh: ReturnType<typeof ensureAgentContextHooks>,
): void {
  for (const message of formatAgentContextHookMessages(hookRefresh)) {
    console.log(message);
  }
}

function formatUpgradeTaskList(
  repo: Repo,
  localVersion: string,
  packagedVersion: string,
  layout: FrameworkLayout,
): string {
  const lines: string[] = [
    `# Context Tree Upgrade — v${localVersion} -> v${packagedVersion}\n`,
  ];

  if (layout === "tree") {
    lines.push(
      "## Tree Metadata",
      `- [ ] Confirm the tree-repo skill at ${installedSkillRootsDisplay()} still resolves correctly after the refresh`,
      "- [ ] Replace any stale `context-tree` CLI command references in repo-specific docs, scripts, workflows, or agent config with `first-tree`",
      "",
      "## Sync",
      "- [ ] Review .claude/commands/first-tree-sync.md and set up scheduling via /schedule or cron",
      "",
    );
  } else {
    lines.push(
      "## Installed Skill",
      `- [ ] The skill payload at ${installedSkillRootsDisplay()} was wiped and replaced with the lightweight \`SKILL.md\` + \`references/\` + \`VERSION\` layout. Verify root symlinks (\`principles.md\`, \`ownership-and-naming.md\`, \`WHITEPAPER.md\`) still resolve.`,
      "- [ ] If any local automation or docs still reference paths like `.agents/skills/first-tree/engine/`, `.agents/skills/first-tree/assets/`, or `.agents/skills/first-tree/helpers/`, update them to invoke the CLI instead (e.g. `npx -p first-tree first-tree <command>`).",
      "",
    );
  }

  const migrationTasks: string[] = [];
  if (layout === "legacy") {
    migrationTasks.push(
      "- [ ] Remove any stale `.context-tree/` references from repo-specific docs, scripts, or workflow files",
    );
  }

  if (layout === "legacy-repo-skill") {
    lines.push(
      "## Migration",
      `- [ ] Remove any stale \`${LEGACY_REPO_SKILL_ROOT}/\` references from repo-specific docs, scripts, workflow files, or agent config`,
      "",
    );
  }

  if (
    repo.hasCanonicalAgentInstructionsFile() &&
    repo.hasLegacyAgentInstructionsFile()
  ) {
    migrationTasks.push(
      `- [ ] Merge any remaining user-authored content from \`${LEGACY_AGENT_INSTRUCTIONS_FILE}\` into \`${AGENT_INSTRUCTIONS_FILE}\`, then delete the legacy file`,
    );
  } else if (repo.hasLegacyAgentInstructionsFile()) {
    migrationTasks.push(
      `- [ ] Rename \`${LEGACY_AGENT_INSTRUCTIONS_FILE}\` to \`${AGENT_INSTRUCTIONS_FILE}\` to use the canonical agent instructions filename`,
    );
  }

  if (migrationTasks.length > 0) {
    lines.push("## Migration", ...migrationTasks, "");
  }

  if (repo.hasAgentInstructionsMarkers()) {
    lines.push(
      "## Agent Instructions",
      `- [ ] Compare the framework section in \`${AGENT_INSTRUCTIONS_FILE}\` with the bundled template (run \`first-tree tree init --help\` to see what templates ship) and update the text between the markers if needed`,
      `- [ ] Compare the framework section in \`${CLAUDE_INSTRUCTIONS_FILE}\` with the bundled template and update the text between the markers if needed`,
      "",
    );
  }

  lines.push(
    "## Verification",
    `- [ ] \`${repo.frameworkVersionPath()}\` reads \`${packagedVersion}\``,
    "- [ ] `first-tree tree verify` passes",
    "",
    "---",
    "",
    "**Important:** As you complete each task, check it off in" +
      ` \`${repo.preferredProgressPath()}\` by changing \`- [ ]\` to \`- [x]\`.` +
      " Run `first-tree tree verify` when done — it will fail if any" +
      " items remain unchecked.",
    "",
  );

  return lines.join("\n");
}

export interface UpgradeOptions {
  sourceRoot?: string;
}

export function runUpgrade(repo?: Repo, options?: UpgradeOptions): number {
  const workingRepo = repo ?? new Repo();
  const workspaceOnlyIntegration =
    workingRepo.hasSourceWorkspaceIntegration() && !workingRepo.looksLikeTreeRepo();

  if (workingRepo.isLikelySourceRepo() && !workingRepo.looksLikeTreeRepo() && !workspaceOnlyIntegration) {
    console.error(
      "Error: no installed framework skill found here. This looks like a source/workspace repo. Run `first-tree tree init` to create a dedicated tree repo, or pass `--tree-path` to upgrade an existing tree repo.",
    );
    return 1;
  }

  if (!workingRepo.hasFramework()) {
    console.error(
      "Error: no first-tree framework metadata found. Run `first-tree tree init` first.",
    );
    return 1;
  }

  const layout = workingRepo.frameworkLayout();
  if (layout === null) {
    console.error(
      "Error: no first-tree framework metadata found. Run `first-tree tree init` first.",
    );
    return 1;
  }
  const localVersion = workingRepo.readVersion() ?? "unknown";
  console.log(`Local framework version: ${localVersion}\n`);

  console.log(
    "Checking the framework skill bundled with this first-tree package...",
  );

  let sourceRoot: string;
  try {
    sourceRoot = options?.sourceRoot ?? resolveBundledPackageRoot();
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error(`Error: ${message}`);
    return 1;
  }

  const packagedVersion = readBundledSkillVersion(sourceRoot);
  if (packagedVersion === null) {
    console.log(
      "Could not read the bundled skill version. Reinstall or update `first-tree` and try again.",
    );
    return 1;
  }

  if (
    localVersion !== "unknown" &&
    compareSkillVersions(localVersion, packagedVersion) > 0
  ) {
    console.log(
      "The installed skill is newer than the skill bundled with this `first-tree` package. Install a newer package version before running `first-tree tree upgrade`.",
    );
    return 1;
  }

  const missingInstalledRoots = workingRepo.missingInstalledSkillRoots();
  const treeResolution = resolveDedicatedTreeRepoForSource(workingRepo);
  const treeRepoName = treeResolution.ok
    ? treeResolution.value.treeRepoName
    : buildDefaultTreeRepoName(workingRepo.repoName());
  const sourceRepoTreeRoot = treeResolution.ok
    ? treeResolution.value.root
    : join(dirname(workingRepo.root), treeRepoName);
  const sourceRepoTreePathHint = formatDedicatedTreePathExample(
    "first-tree tree upgrade",
    workingRepo,
  );

  if (workspaceOnlyIntegration) {
    const firstTreeIndex = upsertFirstTreeIndexFile(workingRepo.root);
    if (
      (layout === "skill" || layout === "lightweight-skill") &&
      missingInstalledRoots.length === 0 &&
      compareSkillVersions(localVersion, packagedVersion) === 0
    ) {
      const localSourceWorkspaceState = syncLocalSourceWorkspaceState(
        workingRepo,
        treeRepoName,
        sourceRepoTreeRoot,
      );
      const sourceIntegrationOptions = sourceIntegrationOptionsForUpgrade(
        workingRepo,
      );
      const updates = upsertSourceIntegrationFiles(
        workingRepo.root,
        treeRepoName,
        sourceIntegrationOptions,
      );
      const changedFiles = updates
        .filter((update) => update.action !== "unchanged")
        .map((update) => update.file);
      const hookRefresh = ensureAgentContextHooks(workingRepo.root);
      const indexChanged =
        firstTreeIndex.action === "created" || firstTreeIndex.action === "updated";
      const hookChanged = formatAgentContextHookMessages(hookRefresh).length > 0;
      if (changedFiles.length === 0 && !indexChanged && !hookChanged) {
        if (firstTreeIndex.action === "skipped") {
          console.log(
            `Left \`${FIRST_TREE_INDEX_FILE}\` unchanged because it already contains unmanaged content.`,
          );
        }
        console.log(
          `Already up to date with the bundled skill (${workingRepo.frameworkVersionPath()} = ${localVersion}).`,
        );
        logLocalSourceWorkspaceState(localSourceWorkspaceState);
        console.log(
          `This repo only carries source/workspace integration. Upgrade the dedicated tree repo separately with ${sourceRepoTreePathHint}.`,
        );
        return 0;
      }
      console.log(
        `Already up to date with the bundled skill (${workingRepo.frameworkVersionPath()} = ${localVersion}).`,
      );
      if (firstTreeIndex.action === "created") {
        console.log(`Created \`${FIRST_TREE_INDEX_FILE}\`.`);
      } else if (firstTreeIndex.action === "updated") {
        console.log(`Updated \`${FIRST_TREE_INDEX_FILE}\`.`);
      } else if (firstTreeIndex.action === "skipped") {
        console.log(
          `Left \`${FIRST_TREE_INDEX_FILE}\` unchanged because it already contains unmanaged content.`,
        );
      }
      logAgentContextHookRefresh(hookRefresh);
      if (changedFiles.length > 0) {
        console.log(
          `Updated the ${SOURCE_INTEGRATION_MARKER} marker lines in ${changedFiles.map((file) => `\`${file}\``).join(" and ")}.`,
        );
      } else {
        console.log(
          `The ${SOURCE_INTEGRATION_MARKER} marker lines in ${AGENT_INSTRUCTIONS_FILE} and ${CLAUDE_INSTRUCTIONS_FILE} were already current.`,
        );
      }
      logLocalSourceWorkspaceState(localSourceWorkspaceState);
      console.log(
        `This repo only carries source/workspace integration. Upgrade the dedicated tree repo separately with ${sourceRepoTreePathHint}.`,
      );
      return 0;
    }

    const wipedPaths = wipeInstalledSkill(workingRepo.root);
    copyCanonicalSkill(sourceRoot, workingRepo.root);
    const hookRefresh = ensureAgentContextHooks(workingRepo.root);
    const refreshedWorkflows = refreshShippedWorkflows(
      workingRepo.root,
      join(resolveBundledAssetRoot(sourceRoot), "workflows"),
    );
    const localSourceWorkspaceState = syncLocalSourceWorkspaceState(
      workingRepo,
      treeRepoName,
      sourceRepoTreeRoot,
    );
    const sourceIntegrationOptions = sourceIntegrationOptionsForUpgrade(
      workingRepo,
    );
    const updates = upsertSourceIntegrationFiles(
      workingRepo.root,
      treeRepoName,
      sourceIntegrationOptions,
    );
    const changedFiles = updates
      .filter((update) => update.action !== "unchanged")
      .map((update) => update.file);
    if (wipedPaths.length > 0) {
      console.log(
        `Wiped previous skill installation: ${wipedPaths.map((p) => `\`${p}/\``).join(", ")}.`,
      );
    }
    console.log(
      `Refreshed ${installedSkillRootsDisplay()} in this source/workspace repo.`,
    );
    logAgentContextHookRefresh(hookRefresh);
    if (refreshedWorkflows.length > 0) {
      console.log(
        `Overwrote shipped workflow files: ${refreshedWorkflows.map((f) => `\`.github/workflows/${f}\``).join(", ")}.`,
      );
    }
    if (firstTreeIndex.action === "created") {
      console.log(`Created \`${FIRST_TREE_INDEX_FILE}\`.`);
    } else if (firstTreeIndex.action === "updated") {
      console.log(`Updated \`${FIRST_TREE_INDEX_FILE}\`.`);
    } else if (firstTreeIndex.action === "skipped") {
      console.log(
        `Left \`${FIRST_TREE_INDEX_FILE}\` unchanged because it already contains unmanaged content.`,
      );
    }
    if (changedFiles.length > 0) {
      console.log(
        `Updated the ${SOURCE_INTEGRATION_MARKER} marker lines in ${changedFiles.map((file) => `\`${file}\``).join(" and ")}.`,
      );
    } else {
      console.log(
        `The ${SOURCE_INTEGRATION_MARKER} marker lines in ${AGENT_INSTRUCTIONS_FILE} and ${CLAUDE_INSTRUCTIONS_FILE} were already current.`,
      );
    }
    logLocalSourceWorkspaceState(localSourceWorkspaceState);
    console.log(
      `This repo is not the Context Tree. Upgrade the dedicated tree repo separately with ${sourceRepoTreePathHint}.`,
    );
    return 0;
  }

  if (layout === "tree") {
    const installedTreeSkillVersion =
      workingRepo.readFile(INSTALLED_SKILL_VERSION)?.trim() ?? null;
    if (
      installedTreeSkillVersion !== null
      && compareSkillVersions(installedTreeSkillVersion, packagedVersion) > 0
    ) {
      console.log(
        "The installed tree-repo skill is newer than the skill bundled with this `first-tree` package. Install a newer package version before running `first-tree tree upgrade`.",
      );
      return 1;
    }

    const treeMetadataUpToDate =
      compareSkillVersions(localVersion, packagedVersion) === 0;
    const treeSkillUpToDate =
      installedTreeSkillVersion !== null
      && missingInstalledRoots.length === 0
      && compareSkillVersions(installedTreeSkillVersion, packagedVersion) === 0;
    const hookRefresh = ensureAgentContextHooks(workingRepo.root);

    if (treeMetadataUpToDate && treeSkillUpToDate) {
      const sourceRepoIndex = syncTreeSourceRepoIndex(workingRepo.root);
      ensureSyncRunbook(workingRepo.root, sourceRoot);
      console.log(
        `Already up to date with the bundled tree metadata and installed tree skill (${workingRepo.frameworkVersionPath()} = ${localVersion}).`,
      );
      logTreeSourceRepoIndexSync(sourceRepoIndex);
      logAgentContextHookRefresh(hookRefresh);
      return 0;
    }

    if (!treeMetadataUpToDate) {
      writeTreeRuntimeVersion(workingRepo.root, packagedVersion);
      console.log(
        `Refreshed dedicated tree metadata at \`${workingRepo.frameworkVersionPath()}\`.`,
      );
    }
    if (!treeSkillUpToDate) {
      const wipedPaths = wipeInstalledSkill(workingRepo.root);
      copyCanonicalSkill(sourceRoot, workingRepo.root);
      if (wipedPaths.length > 0) {
        console.log(
          `Wiped previous tree skill installation: ${wipedPaths.map((p) => `\`${p}/\``).join(", ")}.`,
        );
      }
      console.log(
        `Refreshed tree-repo skill payload at ${installedSkillRootsDisplay()}.`,
      );
    }
    const sourceRepoIndex = syncTreeSourceRepoIndex(workingRepo.root);
    logTreeSourceRepoIndexSync(sourceRepoIndex);
    ensureSyncRunbook(workingRepo.root, sourceRoot);
    logAgentContextHookRefresh(hookRefresh);

    const output = formatUpgradeTaskList(
      workingRepo,
      localVersion,
      packagedVersion,
      layout,
    );
    console.log(`\n${output}`);
    writeProgress(workingRepo, output);
    console.log(`Progress file written to ${workingRepo.preferredProgressPath()}`);
    return 0;
  }

  if (
    (layout === "skill" || layout === "lightweight-skill") &&
    missingInstalledRoots.length === 0 &&
    compareSkillVersions(localVersion, packagedVersion) === 0
  ) {
    const hookRefresh = ensureAgentContextHooks(workingRepo.root);
    console.log(
      `Already up to date with the bundled skill (${workingRepo.frameworkVersionPath()} = ${localVersion}).`,
    );
    logAgentContextHookRefresh(hookRefresh);
    return 0;
  }

  const wipedPaths = wipeInstalledSkill(workingRepo.root);
  copyCanonicalSkill(sourceRoot, workingRepo.root);
  const hookRefresh = ensureAgentContextHooks(workingRepo.root);
  const refreshedWorkflows = refreshShippedWorkflows(
    workingRepo.root,
    join(resolveBundledAssetRoot(sourceRoot), "workflows"),
  );
  if (wipedPaths.length > 0) {
    console.log(
      `Wiped previous skill installation: ${wipedPaths.map((p) => `\`${p}/\``).join(", ")}.`,
    );
  }
  console.log(
    `Installed lightweight skill payload at ${installedSkillRootsDisplay()}.`,
  );
  logAgentContextHookRefresh(hookRefresh);
  if (refreshedWorkflows.length > 0) {
    console.log(
      `Overwrote shipped workflow files: ${refreshedWorkflows.map((f) => `\`.github/workflows/${f}\``).join(", ")}.`,
    );
  }

  const output = formatUpgradeTaskList(
    workingRepo,
    localVersion,
    packagedVersion,
    layout,
  );
  console.log(`\n${output}`);
  writeProgress(workingRepo, output);
  console.log(`Progress file written to ${workingRepo.preferredProgressPath()}`);
  return 0;
}

export function runUpgradeCli(args: string[] = []): number {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(UPGRADE_USAGE);
    return 0;
  }

  let treePath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--tree-path") {
      const value = args[index + 1];
      if (!value) {
        console.error("Missing value for --tree-path");
        console.log(UPGRADE_USAGE);
        return 1;
      }
      treePath = value;
      index += 1;
      continue;
    }

    console.error(`Unknown upgrade option: ${arg}`);
    console.log(UPGRADE_USAGE);
    return 1;
  }

  return runUpgrade(treePath ? new Repo(resolve(process.cwd(), treePath)) : undefined);
}
