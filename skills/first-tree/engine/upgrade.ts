import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  buildDefaultTreeRepoName,
  formatDedicatedTreePathExample,
  resolveDedicatedTreeRepoForSource,
} from "#skill/engine/dedicated-tree.js";
import { Repo } from "#skill/engine/repo.js";
import {
  AGENT_INSTRUCTIONS_FILE,
  AGENT_INSTRUCTIONS_TEMPLATE,
  CLAUDE_INSTRUCTIONS_FILE,
  CLAUDE_INSTRUCTIONS_TEMPLATE,
  CLAUDE_SKILL_ROOT,
  FRAMEWORK_WORKFLOWS_DIR,
  FRAMEWORK_TEMPLATES_DIR,
  FRAMEWORK_VERSION,
  FIRST_TREE_INDEX_FILE,
  LEGACY_AGENT_INSTRUCTIONS_FILE,
  LEGACY_FRAMEWORK_ROOT,
  LEGACY_REPO_SKILL_ROOT,
  SKILL_ROOT,
  SOURCE_INTEGRATION_MARKER,
  installedSkillRootsDisplay,
  type FrameworkLayout,
} from "#skill/engine/runtime/asset-loader.js";
import {
  copyCanonicalSkill,
  resolveBundledPackageRoot,
  writeTreeRuntimeVersion,
} from "#skill/engine/runtime/installer.js";
import {
  upsertFirstTreeIndexFile,
  upsertSourceIntegrationFiles,
} from "#skill/engine/runtime/source-integration.js";
import {
  compareFrameworkVersions,
  readSourceVersion,
} from "#skill/engine/runtime/upgrader.js";

export const UPGRADE_USAGE = `usage: first-tree upgrade [--tree-path PATH]

Options:
  --tree-path PATH   Upgrade a tree repo from another working directory
  --help             Show this help message
`;

function writeProgress(repo: Repo, content: string): void {
  const progressPath = join(repo.root, repo.preferredProgressPath());
  mkdirSync(dirname(progressPath), { recursive: true });
  writeFileSync(progressPath, content);
}

function formatUpgradeTaskList(
  repo: Repo,
  localVersion: string,
  packagedVersion: string,
  layout: FrameworkLayout,
): string {
  const lines: string[] = [`# Context Tree Upgrade — v${localVersion} -> v${packagedVersion}\n`];

  if (layout === "tree") {
    lines.push(
      "## Tree Metadata",
      "- [ ] Review any repo docs, hooks, or automation that still assume the dedicated tree repo keeps local `.agents/skills/first-tree/` or `.claude/skills/first-tree/` copies",
      "- [ ] Replace any stale `context-tree` CLI command references in repo-specific docs, scripts, workflows, or agent config with `first-tree`",
      "",
    );
  } else {
    lines.push(
      "## Installed Skill",
      `- [ ] Review local customizations under ${installedSkillRootsDisplay()} and reapply them if needed`,
      `- [ ] Re-copy any workflow updates you want from \`${FRAMEWORK_WORKFLOWS_DIR}/\` into \`.github/workflows/\``,
      `- [ ] Re-check any local agent setup that references \`${CLAUDE_SKILL_ROOT}/assets/framework/examples/\` or \`${CLAUDE_SKILL_ROOT}/assets/framework/helpers/\``,
      `- [ ] Re-check any repo scripts or workflow files that reference \`${SKILL_ROOT}/assets/framework/\``,
      "- [ ] Replace any stale `context-tree` CLI command references in repo-specific docs, scripts, workflows, or agent config with `first-tree`",
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

  if (repo.hasCanonicalAgentInstructionsFile() && repo.hasLegacyAgentInstructionsFile()) {
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
      layout === "tree"
        ? `- [ ] Compare the framework section in \`${AGENT_INSTRUCTIONS_FILE}\` with the bundled \`${AGENT_INSTRUCTIONS_TEMPLATE}\` template and update the text between the markers if needed`
        : `- [ ] Compare the framework section in \`${AGENT_INSTRUCTIONS_FILE}\` with \`${FRAMEWORK_TEMPLATES_DIR}/${AGENT_INSTRUCTIONS_TEMPLATE}\` and update the content between the markers if needed`,
      layout === "tree"
        ? `- [ ] Compare the framework section in \`${CLAUDE_INSTRUCTIONS_FILE}\` with the bundled \`${CLAUDE_INSTRUCTIONS_TEMPLATE}\` template and update the text between the markers if needed`
        : `- [ ] Compare the framework section in \`${CLAUDE_INSTRUCTIONS_FILE}\` with \`${FRAMEWORK_TEMPLATES_DIR}/${CLAUDE_INSTRUCTIONS_TEMPLATE}\` and update the content between the markers if needed`,
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

  const packagedVersion = readSourceVersion(sourceRoot);
  if (packagedVersion === null) {
    console.log(
      "Could not read the bundled framework version. Reinstall or update `first-tree` and try again.",
    );
    return 1;
  }

  if (
    localVersion !== "unknown" &&
    compareFrameworkVersions(localVersion, packagedVersion) > 0
  ) {
    console.log(
      "The installed framework is newer than the skill bundled with this `first-tree` package. Install a newer package version before running `first-tree upgrade`.",
    );
    return 1;
  }

  const missingInstalledRoots = workingRepo.missingInstalledSkillRoots();
  const treeResolution = resolveDedicatedTreeRepoForSource(workingRepo);
  const treeRepoName = treeResolution.ok
    ? treeResolution.value.treeRepoName
    : buildDefaultTreeRepoName(workingRepo.repoName());
  const sourceRepoTreePathHint = formatDedicatedTreePathExample(
    "first-tree upgrade",
    workingRepo,
  );

  if (workspaceOnlyIntegration) {
    const firstTreeIndex = upsertFirstTreeIndexFile(workingRepo.root);
    if (
      layout === "skill" &&
      missingInstalledRoots.length === 0 &&
      packagedVersion === localVersion
    ) {
      const updates = upsertSourceIntegrationFiles(
        workingRepo.root,
        treeRepoName,
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
          `Already up to date with the bundled skill (${FRAMEWORK_VERSION} = ${localVersion}).`,
        );
        console.log(
          `This repo only carries source/workspace integration. Upgrade the dedicated tree repo separately with ${sourceRepoTreePathHint}.`,
        );
        return 0;
      }
      console.log(
        `Already up to date with the bundled skill (${FRAMEWORK_VERSION} = ${localVersion}).`,
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
      console.log(
        `This repo only carries source/workspace integration. Upgrade the dedicated tree repo separately with ${sourceRepoTreePathHint}.`,
      );
      return 0;
    }

    copyCanonicalSkill(sourceRoot, workingRepo.root);
    const updates = upsertSourceIntegrationFiles(
      workingRepo.root,
      treeRepoName,
    );
    const changedFiles = updates
      .filter((update) => update.action !== "unchanged")
      .map((update) => update.file);
    console.log(
      `Refreshed ${installedSkillRootsDisplay()} in this source/workspace repo.`,
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
    console.log(
      `This repo is not the Context Tree. Upgrade the dedicated tree repo separately with ${sourceRepoTreePathHint}.`,
    );
    return 0;
  }

  if (layout === "tree") {
    if (packagedVersion === localVersion) {
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
    layout === "skill" &&
    missingInstalledRoots.length === 0 &&
    packagedVersion === localVersion
  ) {
    console.log(
      `Already up to date with the bundled skill (${FRAMEWORK_VERSION} = ${localVersion}).`,
    );
    return 0;
  }

  copyCanonicalSkill(sourceRoot, workingRepo.root);
  if (layout === "legacy") {
    rmSync(join(workingRepo.root, LEGACY_FRAMEWORK_ROOT), {
      recursive: true,
      force: true,
    });
    console.log(
      `Migrated legacy .context-tree/ layout to ${installedSkillRootsDisplay()}.`,
    );
  } else if (layout === "legacy-repo-skill") {
    console.log(
      `Migrated legacy ${LEGACY_REPO_SKILL_ROOT}/ layout to ${installedSkillRootsDisplay()}.`,
    );
  } else {
    if (missingInstalledRoots.length > 0) {
      console.log(
        `Repaired missing installed skill roots (${missingInstalledRoots.map((root) => `${root}/`).join(", ")}) and refreshed ${installedSkillRootsDisplay()} from the bundled first-tree package.`,
      );
    } else {
      console.log(
        `Refreshed ${installedSkillRootsDisplay()} from the bundled first-tree package.`,
      );
    }
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
