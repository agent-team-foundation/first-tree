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
import { copyCanonicalSkill } from "#skill/engine/runtime/installer.js";
import {
  cleanupUpstreamRepo,
  cloneUpstreamRepo,
  FIRST_TREE_REPO_URL,
  readUpstreamVersion,
} from "#skill/engine/runtime/upgrader.js";

function writeProgress(repo: Repo, content: string): void {
  const progressPath = join(repo.root, repo.preferredProgressPath());
  mkdirSync(dirname(progressPath), { recursive: true });
  writeFileSync(progressPath, content);
}

function formatUpgradeTaskList(
  repo: Repo,
  localVersion: string,
  upstreamVersion: string,
  migratedFromLegacy: boolean,
): string {
  const lines: string[] = [
    `# Context Tree Upgrade — v${localVersion} -> v${upstreamVersion}\n`,
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
    `- [ ] \`${FRAMEWORK_VERSION}\` reads \`${upstreamVersion}\``,
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
  upstreamRoot?: string;
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

  console.log(`Checking ${FIRST_TREE_REPO_URL} for the latest framework skill...`);

  const clonedUpstream = options?.upstreamRoot === undefined;
  const upstreamRoot = options?.upstreamRoot ?? cloneUpstreamRepo();

  try {
    const upstreamVersion = readUpstreamVersion(upstreamRoot);
    if (upstreamVersion === null) {
      console.log(
        "Could not read the upstream framework version. Check your network and try again.",
      );
      return 1;
    }

    if (layout === "skill" && upstreamVersion === localVersion) {
      console.log(`Already up to date (${FRAMEWORK_VERSION} = ${localVersion}).`);
      return 0;
    }

    copyCanonicalSkill(upstreamRoot, workingRepo.root);
    if (layout === "legacy") {
      rmSync(join(workingRepo.root, LEGACY_FRAMEWORK_ROOT), {
        recursive: true,
        force: true,
      });
      console.log(
        "Migrated legacy .context-tree/ layout to skills/first-tree-cli-framework/.",
      );
    } else {
      console.log("Refreshed skills/first-tree-cli-framework/ from upstream.");
    }

    const output = formatUpgradeTaskList(
      workingRepo,
      localVersion,
      upstreamVersion,
      layout === "legacy",
    );
    console.log(`\n${output}`);
    writeProgress(workingRepo, output);
    console.log(`Progress file written to ${workingRepo.preferredProgressPath()}`);
    return 0;
  } finally {
    if (clonedUpstream) {
      cleanupUpstreamRepo(upstreamRoot);
    }
  }
}
