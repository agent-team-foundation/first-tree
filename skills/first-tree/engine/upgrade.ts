import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Repo } from "#skill/engine/repo.js";
import {
  AGENT_INSTRUCTIONS_FILE,
  AGENT_INSTRUCTIONS_TEMPLATE,
  FRAMEWORK_WORKFLOWS_DIR,
  FRAMEWORK_TEMPLATES_DIR,
  FRAMEWORK_VERSION,
  INSTALLED_PROGRESS,
  LEGACY_AGENT_INSTRUCTIONS_FILE,
  LEGACY_FRAMEWORK_ROOT,
  LEGACY_SKILL_ROOT,
  SKILL_ROOT,
  type FrameworkLayout,
} from "#skill/engine/runtime/asset-loader.js";
import {
  copyCanonicalSkill,
  resolveBundledPackageRoot,
} from "#skill/engine/runtime/installer.js";
import {
  compareFrameworkVersions,
  readSourceVersion,
} from "#skill/engine/runtime/upgrader.js";

export const UPGRADE_USAGE = `usage: context-tree upgrade [--tree-path PATH]

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
  const lines: string[] = [
    `# Context Tree Upgrade — v${localVersion} -> v${packagedVersion}\n`,
    "## Installed Skill",
    `- [ ] Review local customizations under \`${SKILL_ROOT}/\` and reapply them if needed`,
    `- [ ] Re-copy any workflow updates you want from \`${FRAMEWORK_WORKFLOWS_DIR}/\` into \`.github/workflows/\``,
    `- [ ] Re-check any local agent setup that references \`${SKILL_ROOT}/assets/framework/examples/\` or \`${SKILL_ROOT}/assets/framework/helpers/\``,
    "",
  ];

  const migrationTasks: string[] = [];
  if (layout === "legacy") {
    migrationTasks.push(
      "- [ ] Remove any stale `.context-tree/` references from repo-specific docs, scripts, or workflow files",
    );
  }

  if (layout === "legacy-skill") {
    migrationTasks.push(
      `- [ ] Remove any stale \`${LEGACY_SKILL_ROOT}/\` references from repo-specific docs, scripts, workflow files, or agent config`,
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
      `- [ ] Compare the framework section in \`${AGENT_INSTRUCTIONS_FILE}\` with \`${FRAMEWORK_TEMPLATES_DIR}/${AGENT_INSTRUCTIONS_TEMPLATE}\` and update the content between the markers if needed`,
      "",
    );
  }

  lines.push(
    "## Verification",
    `- [ ] \`${FRAMEWORK_VERSION}\` reads \`${packagedVersion}\``,
    "- [ ] `context-tree verify` passes",
    "",
    "---",
    "",
    "**Important:** As you complete each task, check it off in" +
      ` \`${INSTALLED_PROGRESS}\` by changing \`- [ ]\` to \`- [x]\`.` +
      " Run `context-tree verify` when done — it will fail if any" +
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

  if (workingRepo.isLikelySourceRepo() && !workingRepo.looksLikeTreeRepo()) {
    console.error(
      "Error: no installed framework skill found here. This looks like a source/workspace repo. Run `context-tree init` to create a dedicated tree repo, or pass `--tree-path` to upgrade an existing tree repo.",
    );
    return 1;
  }

  if (!workingRepo.hasFramework()) {
    console.error(
      "Error: no installed framework skill found. Run `context-tree init` first.",
    );
    return 1;
  }

  const layout = workingRepo.frameworkLayout();
  if (layout === null) {
    console.error(
      "Error: no installed framework skill found. Run `context-tree init` first.",
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
      "The installed framework is newer than the skill bundled with this `first-tree` package. Install a newer package version before running `context-tree upgrade`.",
    );
    return 1;
  }

  if (layout === "skill" && packagedVersion === localVersion) {
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
      "Migrated legacy .context-tree/ layout to skills/first-tree/.",
    );
  } else if (layout === "legacy-skill") {
    console.log(
      "Migrated skills/first-tree-cli-framework/ to skills/first-tree/.",
    );
  } else {
    console.log(
      "Refreshed skills/first-tree/ from the bundled first-tree package.",
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
