import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  relativeRepoPath,
  resolveDedicatedTreeRepoForSource,
} from "#engine/dedicated-tree.js";
import { Repo } from "#engine/repo.js";
import { ONBOARDING_TEXT } from "#engine/onboarding.js";
import { evaluateAll } from "#engine/rules/index.js";
import type { RuleResult } from "#engine/rules/index.js";
import {
  copyCanonicalSkill,
  readSkillVersion,
  renderTemplateFile,
  resolveCanonicalFrameworkRoot,
  resolveBundledPackageRoot,
  writeTreeRuntimeVersion,
} from "#engine/runtime/installer.js";
import {
  collectContributorMembers,
  seedMembersFromContributors,
} from "#engine/member-seeding.js";
import type {
  ContributorCollector,
  SeedMembersResult,
} from "#engine/member-seeding.js";
import { writeBootstrapState } from "#engine/runtime/bootstrap.js";
import {
  AGENT_INSTRUCTIONS_FILE,
  AGENT_INSTRUCTIONS_TEMPLATE,
  CLAUDE_INSTRUCTIONS_FILE,
  FRAMEWORK_VERSION,
  FIRST_TREE_INDEX_FILE,
  INSTALLED_PROGRESS,
  LEGACY_AGENT_INSTRUCTIONS_FILE,
  LOCAL_TREE_CONFIG,
  installedSkillRootsDisplay,
  SOURCE_INTEGRATION_MARKER,
} from "#engine/runtime/asset-loader.js";
import {
  readLocalTreeConfig,
  upsertLocalTreeConfig,
  upsertLocalTreeGitIgnore,
} from "#engine/runtime/local-tree-config.js";
import {
  upsertFirstTreeIndexFile,
  upsertSourceIntegrationFiles,
} from "#engine/runtime/source-integration.js";

/**
 * The interactive prompt tool the agent should use to present choices.
 * Different agents may name this differently — change it here to update
 * all generated task text at once.
 */
export const INTERACTIVE_TOOL = "AskUserQuestion";
export const INIT_USAGE = `usage: first-tree init [--here] [--seed-members contributors] [--tree-name NAME] [--tree-path PATH]

Bootstrap a Context Tree. The default behavior depends on where you run it:

  Inside a source/workspace repo (the default case):
    1. Installs the first-tree skill into \`.agents/skills/first-tree/\`
    2. Symlinks \`.claude/skills/first-tree/\` to the same location
    3. Creates \`FIRST_TREE.md\` -> \`references/about.md\`
    4. Adds a managed \`${SOURCE_INTEGRATION_MARKER}\` block to AGENTS.md/CLAUDE.md
    5. Creates a sibling \`<repo>-tree\` directory and bootstraps the dedicated
       tree repo there with NODE.md, AGENTS.md, CLAUDE.md, members/NODE.md,
       and \`.first-tree/\` metadata
    6. Reuses an existing \`<repo>-context\` sibling if one is already bound

  Inside an empty/dedicated tree repo (with --here):
    1. Treats the current repo as the Context Tree
    2. Scaffolds NODE.md, AGENTS.md, CLAUDE.md, members/NODE.md
    3. Writes \`.first-tree/\` metadata
    4. Does NOT create a sibling repo

After init completes, the agent should follow the printed task list to fill
in NODE.md frontmatter, configure the agent integration, and run
\`first-tree verify\` when done.

Do not use \`--here\` inside a source/workspace repo unless you explicitly
want that repo itself to become the Context Tree (rare).

After publishing the dedicated tree repo with \`first-tree publish\`, treat
that submodule as the canonical local working copy. The bootstrap sibling
checkout can be deleted.

Options:
  --here             Initialize the current repo in place — use only when you have already switched into the dedicated tree repo
  --seed-members contributors
                     Seed initial \`members/*/NODE.md\` files from contributor history (GitHub API when available, falls back to local git log)
  --tree-name NAME   Override the default sibling repo name (\`<repo>-tree\`)
  --tree-path PATH   Use an explicit tree repo path instead of a sibling
  --help             Show this help message
`;

interface TemplateTarget {
  templateName: string;
  targetPath: string;
  skipIfExists?: string[];
}

const TEMPLATE_MAP: TemplateTarget[] = [
  { templateName: "root-node.md.template", targetPath: "NODE.md" },
  {
    templateName: AGENT_INSTRUCTIONS_TEMPLATE,
    targetPath: AGENT_INSTRUCTIONS_FILE,
    skipIfExists: [AGENT_INSTRUCTIONS_FILE, LEGACY_AGENT_INSTRUCTIONS_FILE],
  },
  { templateName: "members-domain.md.template", targetPath: "members/NODE.md" },
];

interface TaskListContext {
  sourceRepoPath?: string;
  sourceRepoName?: string;
  treeRepoName?: string;
  dedicatedTreeRepo?: boolean;
  frameworkVersionPath?: string;
  progressPath?: string;
}

function installSkill(source: string, target: string): void {
  copyCanonicalSkill(source, target);
  console.log(
    `  Installed ${installedSkillRootsDisplay()} from the bundled first-tree package`,
  );
}

function renderTemplates(frameworkDir: string, target: string): void {
  for (const { templateName, targetPath, skipIfExists } of TEMPLATE_MAP) {
    const existingPaths = skipIfExists ?? [targetPath];
    const existingPath = existingPaths.find((candidate) =>
      existsSync(join(target, candidate)),
    );

    if (existingPath !== undefined) {
      continue;
    }
    if (renderTemplateFile(frameworkDir, templateName, target, targetPath)) {
      console.log(`  Created ${targetPath}`);
    }
  }
  // CLAUDE.md is a symlink to AGENTS.md so they can never drift. Only
  // create the symlink if neither file exists; if a real CLAUDE.md is
  // already present, leave it alone (the user may be migrating).
  const claudePath = join(target, CLAUDE_INSTRUCTIONS_FILE);
  const agentsPath = join(target, AGENT_INSTRUCTIONS_FILE);
  if (!existsSync(claudePath) && existsSync(agentsPath)) {
    symlinkSync(AGENT_INSTRUCTIONS_FILE, claudePath);
    console.log(`  Linked ${CLAUDE_INSTRUCTIONS_FILE} -> ${AGENT_INSTRUCTIONS_FILE}`);
  }
}

export function formatTaskList(
  groups: RuleResult[],
  context?: TaskListContext,
): string {
  const lines: string[] = [
    "# Context Tree Init\n",
  ];

  if (context?.dedicatedTreeRepo) {
    lines.push(
      "This repository is the dedicated Context Tree. Keep decisions, rationale," +
        " cross-domain relationships, and ownership here; keep execution detail" +
        " in your source repositories.",
      "",
    );
    if (context.sourceRepoPath) {
      lines.push(`**Bootstrap source repo:** \`${context.sourceRepoPath}\``, "");
    }
    if (context.sourceRepoName) {
      lines.push(
        `**Source/workspace contract:** Keep \`${context.sourceRepoName}\` limited to the installed skill, \`${FIRST_TREE_INDEX_FILE}\`, and the managed \`${SOURCE_INTEGRATION_MARKER}\` section in \`${AGENT_INSTRUCTIONS_FILE}\` and \`${CLAUDE_INSTRUCTIONS_FILE}\`. Never add \`NODE.md\`, \`members/\`, or tree-scoped \`${AGENT_INSTRUCTIONS_FILE}\` / \`${CLAUDE_INSTRUCTIONS_FILE}\` there.`,
        "",
      );
      lines.push("## Source Workspace Workflow");
      lines.push(
        `- [ ] When this initial tree version is ready, run \`first-tree publish --open-pr\` from this dedicated tree repo. It will create or reuse the GitHub \`*-tree\` repo, continue supporting older \`*-context\` repos, record the published tree GitHub URL back in \`${context.sourceRepoName}\`, refresh the local tree checkout config, and open the source/workspace PR.`,
      );
      lines.push(
        `- [ ] After publish succeeds, treat the checkout recorded in \`${LOCAL_TREE_CONFIG}\` as the canonical local working copy for this tree. The bootstrap repo can be deleted when you no longer need it.`,
      );
      lines.push("");
    }
    lines.push(
      "When you publish this tree repo, keep it in the same GitHub organization" +
        " as the source repo unless you have a reason not to.",
      "",
    );
  }

  lines.push(
    "**Agent instructions:** Before starting work, analyze the full task list below and" +
      " identify all information you need from the user. Ask the user for their code" +
      " repositories or project directories so you can analyze the source yourself —" +
      " derive project descriptions, domains, and members from the code instead of" +
      " asking the user to describe them. Collect everything upfront using the" +
      ` **${INTERACTIVE_TOOL}** tool with structured options — present selectable choices` +
      " (with label and description) so the user can pick instead of typing free-form" +
      ` answers. You may batch up to 4 questions per ${INTERACTIVE_TOOL} call.\n`,
  );
  for (const group of groups) {
    lines.push(`## ${group.group}`);
    for (const task of group.tasks) {
      lines.push(`- [ ] ${task}`);
    }
    lines.push("");
  }
  lines.push("## Verification");
  lines.push(
    "After completing the tasks above, run `first-tree verify` to confirm:",
  );
  lines.push(
    `- [ ] \`${context?.frameworkVersionPath ?? FRAMEWORK_VERSION}\` exists`,
  );
  lines.push("- [ ] Root NODE.md has valid frontmatter (title, owners)");
  lines.push(
    `- [ ] \`${AGENT_INSTRUCTIONS_FILE}\` has framework markers and \`${CLAUDE_INSTRUCTIONS_FILE}\` mirrors the same workflow guidance`,
  );
  lines.push("- [ ] `first-tree verify` passes with no errors");
  lines.push("- [ ] At least one member node exists");
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(
    "**Important:** As you complete each task, check it off in" +
      ` \`${context?.progressPath ?? INSTALLED_PROGRESS}\` by changing \`- [ ]\` to \`- [x]\`.` +
      " Run `first-tree verify` when done — it will fail if any" +
      " items remain unchecked.",
  );
  lines.push("");
  return lines.join("\n");
}

function addSeededMemberReviewGroup(
  groups: RuleResult[],
  seedMembersResult: SeedMembersResult | null,
): RuleResult[] {
  if (seedMembersResult === null || seedMembersResult.created === 0) {
    return groups;
  }

  return [
    ...groups,
    {
      group: "Seeded Members",
      order: 4.1,
      tasks: [
        `Review the ${seedMembersResult.created} contributor-seeded member node(s) under \`members/\` and remove past contributors, bots, or placeholder ownership before you rely on them`,
      ],
    },
  ].sort((a, b) => a.order - b.order);
}

export function writeProgress(repo: Repo, content: string): void {
  const progressPath = join(repo.root, repo.preferredProgressPath());
  mkdirSync(dirname(progressPath), { recursive: true });
  writeFileSync(progressPath, content);
}

export interface InitOptions {
  contributorCollector?: ContributorCollector;
  sourceRoot?: string;
  here?: boolean;
  seedMembers?: "contributors";
  treeName?: string;
  treePath?: string;
  currentCwd?: string;
  gitInitializer?: (root: string) => void;
}

export function runInit(repo?: Repo, options?: InitOptions): number {
  const sourceRepo = repo ?? new Repo();
  const initTarget = resolveInitTarget(sourceRepo, options);
  if (initTarget.ok === false) {
    console.error(
      `Error: ${initTarget.message}`,
    );
    return 1;
  }
  const r = initTarget.repo;
  if (options?.here && sourceRepo.isLikelySourceRepo() && !sourceRepo.looksLikeTreeRepo()) {
    console.log(
      "Warning: `first-tree init --here` is initializing this source/workspace" +
        " repo in place. This will create `NODE.md`, `members/`, and tree-scoped" +
        ` ${AGENT_INSTRUCTIONS_FILE}/${CLAUDE_INSTRUCTIONS_FILE} here. Use plain \`first-tree init\` to create` +
        " a sibling dedicated tree repo instead.",
    );
    console.log();
  }
  const taskListContext = initTarget.dedicatedTreeRepo
    ? {
        dedicatedTreeRepo: true,
        frameworkVersionPath: r.frameworkVersionPath(),
        progressPath: r.preferredProgressPath(),
        sourceRepoName: sourceRepo.repoName(),
        sourceRepoPath: relativeRepoPath(r.root, sourceRepo.root),
        treeRepoName: initTarget.treeRepoName,
      }
    : {
        frameworkVersionPath: r.frameworkVersionPath(),
        progressPath: r.preferredProgressPath(),
      };
  let sourceRoot: string | null = null;

  const resolveSourceRoot = (): string => {
    if (sourceRoot !== null) {
      return sourceRoot;
    }
    sourceRoot = options?.sourceRoot ?? resolveBundledPackageRoot();
    return sourceRoot;
  };

  if (initTarget.dedicatedTreeRepo) {
    console.log(
      "Recommended workflow: keep the Context Tree in a dedicated repo separate" +
        " from your source/workspace repo.",
    );
    console.log(`  Source repo: ${sourceRepo.root}`);
    console.log(`  Tree repo:   ${r.root}`);
    if (initTarget.createdGitRepo) {
      console.log("  Initialized a new git repo for the tree.");
    }
    console.log(
      "  The source/workspace repo should keep only the installed skill," +
        ` ${FIRST_TREE_INDEX_FILE}, the managed ${SOURCE_INTEGRATION_MARKER}` +
        ` section in ${AGENT_INSTRUCTIONS_FILE} and ${CLAUDE_INSTRUCTIONS_FILE}, and local-only tree checkout state under \`${LOCAL_TREE_CONFIG}\`.`,
    );
    console.log(
      `  Never add NODE.md, members/, or tree-scoped ${AGENT_INSTRUCTIONS_FILE}/${CLAUDE_INSTRUCTIONS_FILE} to the source/workspace repo.`,
    );
    console.log();
  }

  if (initTarget.dedicatedTreeRepo) {
    try {
      const resolvedSourceRoot = resolveSourceRoot();
      const hadSourceSkill = sourceRepo.hasCurrentInstalledSkill();
      if (!hadSourceSkill) {
        console.log(
          "Installing the first-tree skill into the source/workspace repo...",
        );
        installSkill(resolvedSourceRoot, sourceRepo.root);
      }
      const firstTreeIndex = upsertFirstTreeIndexFile(sourceRepo.root);
      const updates = upsertSourceIntegrationFiles(
        sourceRepo.root,
        initTarget.treeRepoName,
      );
      const gitIgnore = upsertLocalTreeGitIgnore(sourceRepo.root);
      const existingLocalTreeConfig = readLocalTreeConfig(sourceRepo.root);
      const localTreeConfig = upsertLocalTreeConfig(sourceRepo.root, {
        localPath: relativeRepoPath(sourceRepo.root, r.root),
        treeRepoName: initTarget.treeRepoName,
        ...(existingLocalTreeConfig?.treeRepoName === initTarget.treeRepoName
          && existingLocalTreeConfig.treeRepoUrl
          ? { treeRepoUrl: existingLocalTreeConfig.treeRepoUrl }
          : {}),
      });
      const changedFiles = updates
        .filter((update) => update.action !== "unchanged")
        .map((update) => update.file);
      if (firstTreeIndex.action === "created") {
        console.log(`  Created \`${FIRST_TREE_INDEX_FILE}\``);
      } else if (firstTreeIndex.action === "updated") {
        console.log(`  Updated \`${FIRST_TREE_INDEX_FILE}\``);
      } else if (firstTreeIndex.action === "skipped") {
        console.log(
          `  Left \`${FIRST_TREE_INDEX_FILE}\` unchanged because it already contains unmanaged content`,
        );
      }
      if (changedFiles.length > 0) {
        console.log(
          `  Updated source/workspace instructions in ${changedFiles.map((file) => `\`${file}\``).join(" and ")}`,
        );
      } else {
        console.log(
          `  Source/workspace instructions already contain ${SOURCE_INTEGRATION_MARKER}`,
        );
      }
      if (gitIgnore.action === "created") {
        console.log("  Created `.gitignore` entries for local tree checkout state");
      } else if (gitIgnore.action === "updated") {
        console.log("  Updated `.gitignore` for local tree checkout state");
      }
      if (localTreeConfig.action === "created") {
        console.log(
          `  Created \`${LOCAL_TREE_CONFIG}\` with the local tree checkout path`,
        );
      } else if (localTreeConfig.action === "updated") {
        console.log(
          `  Updated \`${LOCAL_TREE_CONFIG}\` with the local tree checkout path`,
        );
      } else {
        console.log(
          `  Reused the existing \`${LOCAL_TREE_CONFIG}\` local tree checkout path`,
        );
      }
      console.log();
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      console.error(`Error: ${message}`);
      return 1;
    }
  }

  try {
    const resolvedSourceRoot = resolveSourceRoot();
    const frameworkDir = resolveCanonicalFrameworkRoot(resolvedSourceRoot);
    const bundledSkillVersion = readSkillVersion(resolvedSourceRoot);
    const layout = r.frameworkLayout();

    if (layout === null || layout === "tree") {
      console.log(
        "Bootstrapping dedicated tree metadata from the bundled first-tree package...",
      );
      writeTreeRuntimeVersion(r.root, bundledSkillVersion);
    } else {
      console.log(
        "Reusing the existing tree framework layout and filling any missing scaffold files...",
      );
    }

    renderTemplates(frameworkDir, r.root);
    console.log();
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error(`Error: ${message}`);
    return 1;
  }

  let seedMembersResult: SeedMembersResult | null = null;
  if (options?.seedMembers === "contributors") {
    try {
      const contributorSourceRepo = initTarget.dedicatedTreeRepo ? sourceRepo : r;
      console.log("Seeding member nodes from contributor history...");
      seedMembersResult = seedMembersFromContributors(
        contributorSourceRepo.root,
        r.root,
        options.contributorCollector ?? collectContributorMembers,
        resolveCanonicalFrameworkRoot(resolveSourceRoot()),
      );
      if (seedMembersResult.notice) {
        console.log(`  ${seedMembersResult.notice}`);
      }
      if (seedMembersResult.source === "none") {
        console.log("  No contributor records were available to seed member nodes.");
      } else {
        const sourceLabel = seedMembersResult.source === "github"
          ? "GitHub contributors"
          : "local git history";
        console.log(
          `  Created ${seedMembersResult.created} member node(s) from ${sourceLabel}.`,
        );
        if (seedMembersResult.skipped > 0) {
          console.log(
            `  Skipped ${seedMembersResult.skipped} contributor(s) because matching member directories already exist.`,
          );
        }
      }
      console.log();
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      console.error(`Error: ${message}`);
      return 1;
    }
  }

  if (initTarget.dedicatedTreeRepo) {
    writeBootstrapState(r.root, {
      sourceRepoName: sourceRepo.repoName(),
      sourceRepoPath: relativeRepoPath(r.root, sourceRepo.root),
      treeRepoName: initTarget.treeRepoName,
    });
  }

  console.log(ONBOARDING_TEXT);
  console.log("---\n");

  const groups = addSeededMemberReviewGroup(
    evaluateAll(r),
    seedMembersResult,
  );
  if (groups.length === 0) {
    console.log("All checks passed. Your context tree is set up.");
    return 0;
  }

  const output = formatTaskList(groups, {
    ...taskListContext,
    frameworkVersionPath: r.frameworkVersionPath(),
    progressPath: r.preferredProgressPath(),
  });
  console.log(output);
  writeProgress(r, output);
  console.log(`Progress file written to ${r.preferredProgressPath()}`);
  if (initTarget.dedicatedTreeRepo) {
    console.log(
      `Continue in ${relativeRepoPath(sourceRepo.root, r.root)} and keep your source repos available as additional working directories when you populate the tree.`,
    );
  }
  return 0;
}

export interface ParsedInitArgs {
  here?: boolean;
  seedMembers?: "contributors";
  treeName?: string;
  treePath?: string;
}

export function parseInitArgs(
  args: string[],
): ParsedInitArgs | { error: string } {
  const parsed: ParsedInitArgs = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--here":
        parsed.here = true;
        break;
      case "--seed-members": {
        const value = args[index + 1];
        if (!value) {
          return { error: "Missing value for --seed-members" };
        }
        if (value !== "contributors") {
          return { error: `Unsupported value for --seed-members: ${value}` };
        }
        parsed.seedMembers = value;
        index += 1;
        break;
      }
      case "--tree-name": {
        const value = args[index + 1];
        if (!value) {
          return { error: "Missing value for --tree-name" };
        }
        parsed.treeName = value;
        index += 1;
        break;
      }
      case "--tree-path": {
        const value = args[index + 1];
        if (!value) {
          return { error: "Missing value for --tree-path" };
        }
        parsed.treePath = value;
        index += 1;
        break;
      }
      default:
        return { error: `Unknown init option: ${arg}` };
    }
  }

  if (parsed.here && parsed.treeName) {
    return { error: "Cannot combine --here with --tree-name" };
  }
  if (parsed.here && parsed.treePath) {
    return { error: "Cannot combine --here with --tree-path" };
  }
  if (parsed.treeName && parsed.treePath) {
    return { error: "Cannot combine --tree-name with --tree-path" };
  }

  return parsed;
}

export function runInitCli(args: string[] = []): number {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(INIT_USAGE);
    return 0;
  }

  const parsed = parseInitArgs(args);
  if ("error" in parsed) {
    console.error(parsed.error);
    console.log(INIT_USAGE);
    return 1;
  }

  return runInit(undefined, parsed);
}

interface ResolvedInitTarget {
  ok: true;
  createdGitRepo: boolean;
  dedicatedTreeRepo: boolean;
  repo: Repo;
  treeRepoName: string;
}

interface FailedInitTarget {
  message: string;
  ok: false;
}

function resolveInitTarget(
  sourceRepo: Repo,
  options?: InitOptions,
): FailedInitTarget | ResolvedInitTarget {
  if (!sourceRepo.isGitRepo()) {
    return {
      ok: false,
      message:
        "not a git repository. Run this from your source/workspace repo, or create a dedicated tree repo first:\n  git init\n  first-tree init --here",
    };
  }

  let targetRoot: string;
  let treeRepoName: string;
  try {
    const resolvedTarget = determineTargetRoot(sourceRepo, options);
    targetRoot = resolvedTarget.root;
    treeRepoName = resolvedTarget.treeRepoName;
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return {
      ok: false,
      message,
    };
  }
  const dedicatedTreeRepo = targetRoot !== sourceRepo.root;
  let createdGitRepo = false;
  try {
    createdGitRepo = ensureGitRepo(targetRoot, options?.gitInitializer);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return {
      ok: false,
      message,
    };
  }

  return {
    ok: true,
    createdGitRepo,
    dedicatedTreeRepo,
    repo: new Repo(targetRoot),
    treeRepoName,
  };
}

function determineTargetRoot(
  sourceRepo: Repo,
  options?: InitOptions,
): { root: string; treeRepoName: string } {
  if (options?.treePath) {
    const root = resolve(options.currentCwd ?? process.cwd(), options.treePath);
    return { root, treeRepoName: new Repo(root).repoName() };
  }

  if (options?.here) {
    return { root: sourceRepo.root, treeRepoName: sourceRepo.repoName() };
  }

  if (options?.treeName) {
    return {
      root: join(dirname(sourceRepo.root), options.treeName),
      treeRepoName: options.treeName,
    };
  }

  if (
    sourceRepo.looksLikeTreeRepo()
    || sourceRepo.isLikelyEmptyRepo()
    || !sourceRepo.isLikelySourceRepo()
  ) {
    return { root: sourceRepo.root, treeRepoName: sourceRepo.repoName() };
  }

  const resolved = resolveDedicatedTreeRepoForSource(sourceRepo);
  if (resolved.ok) {
    return {
      root: resolved.value.root,
      treeRepoName: resolved.value.treeRepoName,
    };
  }
  throw new Error(resolved.message);
}

function ensureGitRepo(
  targetRoot: string,
  gitInitializer?: (root: string) => void,
): boolean {
  if (existsSync(targetRoot)) {
    if (!statSync(targetRoot).isDirectory()) {
      throw new Error(`Target path is not a directory: ${targetRoot}`);
    }
    if (new Repo(targetRoot).isGitRepo()) {
      return false;
    }
    if (readdirSync(targetRoot).length !== 0) {
      throw new Error(
        `Target path exists and is not a git repository: ${targetRoot}. Run \`git init\` there first or choose a different tree path.`,
      );
    }
  } else {
    mkdirSync(targetRoot, { recursive: true });
  }

  (gitInitializer ?? defaultGitInitializer)(targetRoot);
  return true;
}

function defaultGitInitializer(root: string): void {
  execFileSync("git", ["init"], {
    cwd: root,
    stdio: "ignore",
  });
}
