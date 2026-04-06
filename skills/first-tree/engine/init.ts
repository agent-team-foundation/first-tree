import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  relativeRepoPath,
  resolveDedicatedTreeRepoForSource,
} from "#skill/engine/dedicated-tree.js";
import { Repo } from "#skill/engine/repo.js";
import { ONBOARDING_TEXT } from "#skill/engine/onboarding.js";
import { evaluateAll } from "#skill/engine/rules/index.js";
import type { RuleResult } from "#skill/engine/rules/index.js";
import {
  copyCanonicalSkill,
  readCanonicalFrameworkVersion,
  renderTemplateFile,
  resolveCanonicalFrameworkRoot,
  resolveBundledPackageRoot,
  writeTreeRuntimeVersion,
} from "#skill/engine/runtime/installer.js";
import {
  collectContributorMembers,
  seedMembersFromContributors,
} from "#skill/engine/member-seeding.js";
import type {
  ContributorCollector,
  SeedMembersResult,
} from "#skill/engine/member-seeding.js";
import { writeBootstrapState } from "#skill/engine/runtime/bootstrap.js";
import {
  AGENT_INSTRUCTIONS_FILE,
  AGENT_INSTRUCTIONS_TEMPLATE,
  BOOTSTRAP_STATE,
  CLAUDE_INSTRUCTIONS_FILE,
  CLAUDE_INSTRUCTIONS_TEMPLATE,
  FRAMEWORK_VERSION,
  FIRST_TREE_INDEX_FILE,
  INSTALLED_PROGRESS,
  LEGACY_AGENT_INSTRUCTIONS_FILE,
  installedSkillRootsDisplay,
  SOURCE_INTEGRATION_MARKER,
} from "#skill/engine/runtime/asset-loader.js";
import {
  upsertFirstTreeIndexFile,
  upsertSourceIntegrationFiles,
} from "#skill/engine/runtime/source-integration.js";

/**
 * The interactive prompt tool the agent should use to present choices.
 * Different agents may name this differently — change it here to update
 * all generated task text at once.
 */
export const INTERACTIVE_TOOL = "AskUserQuestion";
export const INIT_USAGE = `usage: first-tree init [--here] [--seed-members contributors] [--tree-name NAME] [--tree-path PATH]

By default, running \`first-tree init\` inside a source or workspace repo installs
the first-tree skill in the current repo, links \`FIRST_TREE.md\` to the local
\`about.md\` reference, updates
\`AGENTS.md\` and \`CLAUDE.md\` with a managed \`${SOURCE_INTEGRATION_MARKER}\`
section, and creates a sibling dedicated tree repo named \`<repo>-tree\`.
Existing sibling \`*-context\` repos and existing local tree checkouts are
still reused when already bound.

Do not use \`--here\` inside a source/workspace repo unless you explicitly want
that repo itself to become the Context Tree.

Options:
  --here             Initialize the current repo in place after you are already in the dedicated tree repo
  --seed-members contributors
                     Seed initial member nodes from contributor history (GitHub when available, otherwise local git)
  --tree-name NAME   Name the dedicated sibling tree repo to create
  --tree-path PATH   Use an explicit tree repo path
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
  {
    templateName: CLAUDE_INSTRUCTIONS_TEMPLATE,
    targetPath: CLAUDE_INSTRUCTIONS_FILE,
    skipIfExists: [CLAUDE_INSTRUCTIONS_FILE],
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
        `- [ ] When this initial tree version is ready, run \`first-tree publish --open-pr\` from this dedicated tree repo. It will create or reuse the GitHub \`*-tree\` repo, continue supporting older \`*-context\` repos, add the published tree back to \`${context.sourceRepoName}\` as a git submodule, and open the source/workspace PR.`,
      );
      const localCheckoutName = context.treeRepoName ?? "dedicated tree";
      lines.push(
        `- [ ] After publish succeeds, treat the source/workspace repo's \`${localCheckoutName}\` submodule checkout as the canonical local working copy for this tree. The temporary sibling bootstrap repo can be deleted when you no longer need it.`,
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
        ` ${FIRST_TREE_INDEX_FILE}, and the managed ${SOURCE_INTEGRATION_MARKER}` +
        ` section in ${AGENT_INSTRUCTIONS_FILE} and ${CLAUDE_INSTRUCTIONS_FILE}.`,
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
    const bundledVersion = readCanonicalFrameworkVersion(resolvedSourceRoot);
    const layout = r.frameworkLayout();

    if (layout === null || layout === "tree") {
      console.log(
        "Bootstrapping dedicated tree metadata from the bundled first-tree package...",
      );
      writeTreeRuntimeVersion(r.root, bundledVersion);
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

  if (initTarget.dedicatedTreeRepo) {
    const repairedSubmodule = repairSourceSubmoduleIfSafe(
      sourceRepo,
      r,
      initTarget.treeRepoName,
    );
    if (repairedSubmodule) {
      console.log(
        `  Added missing \`${initTarget.treeRepoName}\` submodule checkout to the source/workspace repo.`,
      );
      console.log();
    }
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

function repairSourceSubmoduleIfSafe(
  sourceRepo: Repo,
  treeRepo: Repo,
  treeRepoName: string,
): boolean {
  if (
    !canRunGitCommands(sourceRepo.root)
    || !canRunGitCommands(treeRepo.root)
    || treeRepo.root === sourceRepo.root
    || dirname(treeRepo.root) !== dirname(sourceRepo.root)
  ) {
    return false;
  }

  if (isTrackedSubmodule(sourceRepo.root, treeRepoName)) {
    return false;
  }

  const submoduleRoot = join(sourceRepo.root, treeRepoName);
  if (existsSync(submoduleRoot)) {
    return false;
  }

  const remoteUrl = readGitRemoteUrl(treeRepo.root, "origin");
  if (remoteUrl === null || isLocalGitRemote(remoteUrl)) {
    return false;
  }

  if (
    !hasGitHead(treeRepo.root)
    || !hasOnlyAllowedWorkingTreeChanges(treeRepo.root, [BOOTSTRAP_STATE])
  ) {
    return false;
  }

  const localClonePath = relativeRepoPath(sourceRepo.root, treeRepo.root);
  try {
    execFileSync(
      "git",
      ["-c", "protocol.file.allow=always", "submodule", "add", localClonePath, treeRepoName],
      { cwd: sourceRepo.root, stdio: "ignore" },
    );
    execFileSync(
      "git",
      ["submodule", "set-url", "--", treeRepoName, remoteUrl],
      { cwd: sourceRepo.root, stdio: "ignore" },
    );
    execFileSync(
      "git",
      ["submodule", "sync", "--", treeRepoName],
      { cwd: sourceRepo.root, stdio: "ignore" },
    );
    return true;
  } catch {
    return false;
  }
}

function canRunGitCommands(root: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], {
      cwd: root,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function hasGitHead(root: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: root,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function hasOnlyAllowedWorkingTreeChanges(
  root: string,
  allowedPaths: string[] = [],
): boolean {
  try {
    const output = execFileSync("git", ["status", "--porcelain"], {
      cwd: root,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const lines = output
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean);
    if (lines.length === 0) {
      return true;
    }
    if (allowedPaths.length === 0) {
      return false;
    }
    return lines.every((line) => {
      const rawPath = line.slice(3);
      const finalPath = rawPath.includes(" -> ")
        ? rawPath.split(" -> ").at(-1) ?? rawPath
        : rawPath;
      return allowedPaths.includes(finalPath.trim());
    });
  } catch {
    return false;
  }
}

function readGitRemoteUrl(root: string, remote: string): string | null {
  try {
    return execFileSync("git", ["remote", "get-url", remote], {
      cwd: root,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function isTrackedSubmodule(root: string, submodulePath: string): boolean {
  try {
    const output = execFileSync("git", ["ls-files", "--stage", "--", submodulePath], {
      cwd: root,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output
      .split(/\r?\n/)
      .some((line) => line.startsWith("160000 "));
  } catch {
    return false;
  }
}

function isLocalGitRemote(remoteUrl: string): boolean {
  return !(remoteUrl.includes("://") || remoteUrl.startsWith("git@"));
}
