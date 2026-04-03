import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Repo } from "#skill/engine/repo.js";
import {
  FRAMEWORK_WORKFLOWS_DIR,
  FRAMEWORK_TEMPLATES_DIR,
  FRAMEWORK_VERSION,
  INSTALLED_PROGRESS,
  LEGACY_FRAMEWORK_ROOT,
  SKILL_ROOT,
} from "#skill/engine/runtime/asset-loader.js";
import {
  copyCanonicalSkill,
  resolveBundledPackageRoot,
} from "#skill/engine/runtime/installer.js";
import {
  compareFrameworkVersions,
  readSourceVersion,
} from "#skill/engine/runtime/upgrader.js";

function writeProgress(repo: Repo, content: string): void {
  const progressPath = join(repo.root, repo.preferredProgressPath());
  mkdirSync(dirname(progressPath), { recursive: true });
  writeFileSync(progressPath, content);
}

function formatUpgradeTaskList(
  repo: Repo,
  localVersion: string,
  packagedVersion: string,
  migratedFromLegacy: boolean,
): string {
  const lines: string[] = [
    `# Context Tree Upgrade — v${localVersion} -> v${packagedVersion}\n`,
    "## Installed Skill",
    `- [ ] Review local customizations under \`${SKILL_ROOT}/\` and reapply them if needed`,
    `- [ ] Re-copy any workflow updates you want from \`${FRAMEWORK_WORKFLOWS_DIR}/\` into \`.github/workflows/\``,
    `- [ ] Re-check any local agent setup that references \`${SKILL_ROOT}/assets/framework/examples/\` or \`${SKILL_ROOT}/assets/framework/helpers/\``,
    "",
  ];

  if (migratedFromLegacy) {
    lines.push(
      "## Migration",
      "- [ ] Remove any stale `.context-tree/` references from repo-specific docs, scripts, or workflow files",
      "",
    );
  }

  if (repo.hasAgentMdMarkers()) {
    lines.push(
      "## Agent Instructions",
      `- [ ] Compare the framework section in \`AGENT.md\` with \`${FRAMEWORK_TEMPLATES_DIR}/agent.md.template\` and update the content between the markers if needed`,
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

  if (!workingRepo.hasFramework()) {
    console.error(
      "Error: no installed framework skill found. Run `context-tree init` first.",
    );
    return 1;
  }

  const layout = workingRepo.frameworkLayout();
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
      "Migrated legacy .context-tree/ layout to skills/first-tree-cli-framework/.",
    );
  } else {
    console.log(
      "Refreshed skills/first-tree-cli-framework/ from the bundled first-tree package.",
    );
  }

  const output = formatUpgradeTaskList(
    workingRepo,
    localVersion,
    packagedVersion,
    layout === "legacy",
  );
  console.log(`\n${output}`);
  writeProgress(workingRepo, output);
  console.log(`Progress file written to ${workingRepo.preferredProgressPath()}`);
  return 0;
}
