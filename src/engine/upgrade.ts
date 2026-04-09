import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  buildDefaultTreeRepoName,
  formatDedicatedTreePathExample,
  relativeRepoPath,
  resolveDedicatedTreeRepoForSource,
} from "#engine/dedicated-tree.js";
import { Repo } from "#engine/repo.js";
import { readSourceState } from "#engine/runtime/binding-state.js";
import {
  AGENT_INSTRUCTIONS_FILE,
  CLAUDE_INSTRUCTIONS_FILE,
  FIRST_TREE_INDEX_FILE,
  LEGACY_AGENT_INSTRUCTIONS_FILE,
  LEGACY_REPO_SKILL_ROOT,
  SOURCE_INTEGRATION_MARKER,
  installedSkillRootsDisplay,
  type FrameworkLayout,
} from "#engine/runtime/asset-loader.js";
import {
  refreshInjectContextHook,
  refreshShippedWorkflows,
} from "#engine/runtime/adapters.js";
import {
  copyCanonicalSkill,
  resolveBundledAssetRoot,
  resolveBundledPackageRoot,
  wipeInstalledSkill,
  writeTreeRuntimeVersion,
} from "#engine/runtime/installer.js";
import {
  upsertFirstTreeIndexFile,
  upsertSourceIntegrationFiles,
} from "#engine/runtime/source-integration.js";
import {
  readLocalTreeConfig,
  upsertLocalTreeConfig,
  upsertLocalTreeGitIgnore,
} from "#engine/runtime/local-tree-config.js";
import {
  compareSkillVersions,
  extractMajorMinor,
  readBundledSkillVersion,
} from "#engine/runtime/upgrader.js";

export const UPGRADE_USAGE = `usage: first-tree upgrade [--tree-path PATH]

Refresh the installed skill payload from the bundled \`first-tree\` package.

The CLI compares the installed skill version (major.minor) against the
bundled skill version. If they match, upgrade is a no-op. If the bundled
version is newer, the installed payload is replaced and a task list is
emitted for any manual follow-ups (e.g., reapplying customizations).

In a source/workspace repo: refreshes only the local installed skill, the
\`FIRST_TREE.md\` symlink, and the managed \`FIRST-TREE-SOURCE-INTEGRATION:\`
section in AGENTS.md/CLAUDE.md. The dedicated tree repo must be upgraded
separately with \`--tree-path\`.

In a dedicated tree repo: refreshes \`.first-tree/VERSION\` and emits a task
list for the maintainer.

Migrates legacy layouts (\`.context-tree/\`, \`skills/first-tree/\`) onto the
modern \`.agents/skills/first-tree/\` path. To pick up a newer skill version,
install a newer \`first-tree\` package first (or rely on auto-upgrade).

Options:
  --tree-path PATH   Upgrade a tree repo from another working directory
  --help             Show this help message
`;

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
  localTreeConfigAction: "created" | "updated" | "unchanged";
} {
  const gitIgnore = upsertLocalTreeGitIgnore(sourceRepo.root);
  const existingLocalTreeConfig = readLocalTreeConfig(sourceRepo.root);
  const localTreeConfig = upsertLocalTreeConfig(sourceRepo.root, {
    bindingMode: existingLocalTreeConfig?.bindingMode,
    entrypoint: existingLocalTreeConfig?.entrypoint,
    localPath: relativeRepoPath(sourceRepo.root, treeRoot),
    sourceId: existingLocalTreeConfig?.sourceId,
    treeMode: existingLocalTreeConfig?.treeMode,
    treeRepoName,
    ...(existingLocalTreeConfig?.treeRepoName === treeRepoName
      && existingLocalTreeConfig.treeRepoUrl
      ? { treeRepoUrl: existingLocalTreeConfig.treeRepoUrl }
      : {}),
    workspaceId: existingLocalTreeConfig?.workspaceId,
  });
  return {
    gitIgnoreAction: gitIgnore.action,
    localTreeConfigAction: localTreeConfig.action,
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

  if (state.localTreeConfigAction === "created") {
    console.log("Created `.first-tree/local-tree.json` for the local tree checkout.");
  } else if (state.localTreeConfigAction === "updated") {
    console.log("Updated `.first-tree/local-tree.json` for the local tree checkout.");
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
      "- [ ] Replace any stale `context-tree` CLI command references in repo-specific docs, scripts, workflows, or agent config with `first-tree`",
      "",
    );
  } else {
    lines.push(
      "## Installed Skill",
      `- [ ] The skill payload at ${installedSkillRootsDisplay()} was wiped and replaced with the lightweight \`SKILL.md\` + \`references/\` + \`VERSION\` layout. Verify root symlinks (\`principles.md\`, \`ownership-and-naming.md\`, \`FIRST_TREE.md\`) still resolve.`,
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
      `- [ ] Compare the framework section in \`${AGENT_INSTRUCTIONS_FILE}\` with the bundled template (run \`first-tree init --help\` to see what templates ship) and update the text between the markers if needed`,
      `- [ ] Compare the framework section in \`${CLAUDE_INSTRUCTIONS_FILE}\` with the bundled template and update the text between the markers if needed`,
      "",
    );
  }

  lines.push(
    "## Verification",
    `- [ ] \`${repo.frameworkVersionPath()}\` reads \`${packagedVersion}\``,
    "- [ ] `first-tree verify` passes",
    "",
    "---",
    "",
    "**Important:** As you complete each task, check it off in" +
      ` \`${repo.preferredProgressPath()}\` by changing \`- [ ]\` to \`- [x]\`.` +
      " Run `first-tree verify` when done — it will fail if any" +
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
      "Error: no installed framework skill found here. This looks like a source/workspace repo. Run `first-tree init` to create a dedicated tree repo, or pass `--tree-path` to upgrade an existing tree repo.",
    );
    return 1;
  }

  if (!workingRepo.hasFramework()) {
    console.error(
      "Error: no first-tree framework metadata found. Run `first-tree init` first.",
    );
    return 1;
  }

  const layout = workingRepo.frameworkLayout();
  if (layout === null) {
    console.error(
      "Error: no first-tree framework metadata found. Run `first-tree init` first.",
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
      "The installed skill is newer than the skill bundled with this `first-tree` package. Install a newer package version before running `first-tree upgrade`.",
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
    "first-tree upgrade",
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
      const indexChanged =
        firstTreeIndex.action === "created" || firstTreeIndex.action === "updated";
      if (changedFiles.length === 0 && !indexChanged) {
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
    const hookRefresh = refreshInjectContextHook(workingRepo.root);
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
    if (hookRefresh === "updated") {
      console.log(
        "Updated `.claude/settings.json` SessionStart hook to use `npx -p first-tree first-tree inject-context --skip-version-check`.",
      );
    }
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
    if (compareSkillVersions(localVersion, packagedVersion) === 0) {
      console.log(
        `Already up to date with the bundled tree metadata (${workingRepo.frameworkVersionPath()} = ${localVersion}).`,
      );
      return 0;
    }

    writeTreeRuntimeVersion(workingRepo.root, packagedVersion);
    console.log(
      `Refreshed dedicated tree metadata at \`${workingRepo.frameworkVersionPath()}\`.`,
    );

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
    console.log(
      `Already up to date with the bundled skill (${workingRepo.frameworkVersionPath()} = ${localVersion}).`,
    );
    return 0;
  }

  const wipedPaths = wipeInstalledSkill(workingRepo.root);
  copyCanonicalSkill(sourceRoot, workingRepo.root);
  const hookRefresh = refreshInjectContextHook(workingRepo.root);
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
  if (hookRefresh === "updated") {
    console.log(
      "Updated `.claude/settings.json` SessionStart hook to use `npx -p first-tree first-tree inject-context --skip-version-check`.",
    );
  }
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
