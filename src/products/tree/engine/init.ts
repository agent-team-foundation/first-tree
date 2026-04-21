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
import { readGitRemoteUrl, runBind } from "#products/tree/engine/bind.js";
import {
  relativeRepoPath,
  resolveDedicatedTreeRepoForSource,
} from "#products/tree/engine/dedicated-tree.js";
import { inspectRepo } from "#products/tree/engine/inspect.js";
import { Repo } from "#products/tree/engine/repo.js";
import { evaluateAll } from "#products/tree/engine/rules/index.js";
import type { RuleResult } from "#products/tree/engine/rules/index.js";
import {
  copyCanonicalSkill,
  readSkillVersion,
  renderTemplateFile,
  resolveCanonicalFrameworkRoot,
  resolveBundledPackageRoot,
  writeTreeRuntimeVersion,
} from "#products/tree/engine/runtime/installer.js";
import {
  collectContributorMembers,
  seedMembersFromContributors,
} from "#products/tree/engine/member-seeding.js";
import type {
  ContributorCollector,
  SeedMembersResult,
} from "#products/tree/engine/member-seeding.js";
import { writeBootstrapState } from "#products/tree/engine/runtime/bootstrap.js";
import {
  AGENT_INSTRUCTIONS_FILE,
  AGENT_INSTRUCTIONS_TEMPLATE,
  CLAUDE_INSTRUCTIONS_FILE,
  FRAMEWORK_VERSION,
  FIRST_TREE_INDEX_FILE,
  INSTALLED_PROGRESS,
  LEGACY_AGENT_INSTRUCTIONS_FILE,
  SOURCE_STATE,
  installedSkillRootsDisplay,
  SOURCE_INTEGRATION_MARKER,
  TREE_VERSION,
} from "#products/tree/engine/runtime/asset-loader.js";
import {
  upsertLocalTreeGitIgnore,
} from "#products/tree/engine/runtime/local-tree-config.js";
import {
  upsertFirstTreeIndexFile,
  upsertSourceIntegrationFiles,
} from "#products/tree/engine/runtime/source-integration.js";
import {
  ensureAgentContextHooks,
  formatAgentContextHookMessages,
} from "#products/tree/engine/runtime/adapters.js";
import { runWorkspaceSync } from "#products/tree/engine/workspace-sync.js";

/**
 * The interactive prompt tool the agent should use to present choices.
 * Different agents may name this differently — change it here to update
 * all generated task text at once.
 */
export const INTERACTIVE_TOOL = "structured user-input tool";
export const BOOTSTRAP_USAGE = `usage: first-tree tree bootstrap [--here] [--tree-path PATH] [--seed-members contributors]

Low-level tree-repo bootstrap for an explicit tree checkout.

Use this only when the current repo itself should become the tree repo, or
when you are intentionally creating / refreshing a dedicated tree checkout.

Examples:
  first-tree tree bootstrap --here
  first-tree tree bootstrap --tree-path ../my-org-tree

Legacy alias:
  first-tree tree init tree ...

Options:
  --here                     Initialize the current repo in place as a tree repo
  --seed-members contributors
                             Seed initial \`members/*/NODE.md\` files from contributor history
  --tree-path PATH           Use an explicit local tree repo path
  --help                     Show this help message
`;

export const INIT_USAGE = `usage: first-tree tree init [--tree-path PATH | --tree-url URL] [--tree-mode dedicated|shared] [--scope repo|workspace] [--workspace-id ID] [--sync-members] [--seed-members contributors]

High-level onboarding wrapper for source repos, workspace roots, and shared trees.

Default behavior:
  - Single git repo: installs local skill integration, creates or reuses a
    dedicated \`<repo>-tree\` checkout, scaffolds the tree there, then binds the
    repo to it.
  - Workspace root (git repo with child repos or a plain folder containing
    child repos): installs local skill integration at the workspace root,
    creates or reuses one shared tree checkout, then binds discovered local child
    repos to that same tree.
  - Existing tree checkout or URL: binds the current repo/workspace root to
    the provided tree instead of creating a new sibling tree repo.

Low-level tree bootstrap:
  - Use \`first-tree tree bootstrap --here\` when the current repo should become the
    tree repo.
  - Use \`first-tree tree bootstrap --tree-path ../my-tree\` to create or refresh a
    tree checkout at an explicit path.

Recommended examples:
  first-tree tree init
  first-tree tree init --tree-path ../org-context --tree-mode shared
  first-tree tree init --scope workspace --tree-path ../org-context --tree-mode shared --sync-members
  mkdir my-org-tree && cd my-org-tree && git init && first-tree tree bootstrap --here

Options:
  --seed-members contributors
                             Seed initial \`members/*/NODE.md\` files from contributor history
  --tree-name NAME           Override the default sibling repo name (\`<repo>-tree\`)
  --tree-path PATH           Use an explicit local tree repo path
  --tree-url URL             Bind to an existing remote tree repo (uses a temporary local checkout when needed)
  --tree-mode MODE           dedicated or shared
  --scope MODE               repo or workspace
  --workspace-id ID          Workspace identifier for shared workspace onboarding
  --sync-members             After binding a workspace root, bind all discovered child repos too
  --help                     Show this help message
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
  sourceRepoName?: string;
  sourceRepoPath?: string;
  sourceRepoRemoteUrl?: string;
  treeRepoName?: string;
  dedicatedTreeRepo?: boolean;
  frameworkVersionPath?: string;
  progressPath?: string;
}

function runInitCommandRunner(
  command: string,
  args: string[],
  options: { cwd: string },
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
    if (context.sourceRepoRemoteUrl) {
      lines.push(`**Bootstrap source repo URL:** \`${context.sourceRepoRemoteUrl}\``, "");
    }
    if (context.sourceRepoName) {
      lines.push(
        `**Source/workspace contract:** Keep \`${context.sourceRepoName}\` limited to the installed skill, \`${FIRST_TREE_INDEX_FILE}\`, and the managed \`${SOURCE_INTEGRATION_MARKER}\` section in \`${AGENT_INSTRUCTIONS_FILE}\` and \`${CLAUDE_INSTRUCTIONS_FILE}\`. Never add \`NODE.md\`, \`members/\`, or tree-scoped \`${AGENT_INSTRUCTIONS_FILE}\` / \`${CLAUDE_INSTRUCTIONS_FILE}\` there.`,
        "",
      );
      lines.push("## Source Workspace Workflow");
      lines.push(
        `- [ ] When this initial tree version is ready, run \`first-tree tree publish --open-pr\` from this dedicated tree repo. It will create or reuse the GitHub \`*-tree\` repo, continue supporting older \`*-context\` repos, record the published tree GitHub URL back in \`${context.sourceRepoName}\`, and open the source/workspace PR when a local checkout is available.`,
      );
      lines.push(
        `- [ ] After publish succeeds, treat the tree repo URL recorded in \`${SOURCE_STATE}\` as the canonical source of truth. Local checkouts can live wherever is convenient on each machine.`,
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
      " asking the user to describe them. Collect everything upfront using your" +
      ` agent's **${INTERACTIVE_TOOL}** when available — present selectable choices` +
      " (with label and description) so the user can pick instead of typing free-form" +
      " answers.\n",
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
    "After completing the tasks above, run `first-tree tree verify` to confirm:",
  );
  lines.push(
    `- [ ] \`${context?.frameworkVersionPath ?? FRAMEWORK_VERSION}\` exists`,
  );
  lines.push("- [ ] Root NODE.md has valid frontmatter (title, owners)");
  lines.push(
    `- [ ] \`${AGENT_INSTRUCTIONS_FILE}\` has framework markers and \`${CLAUDE_INSTRUCTIONS_FILE}\` mirrors the same workflow guidance`,
  );
  lines.push("- [ ] `first-tree tree verify` passes with no errors");
  lines.push("- [ ] At least one member node exists");
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(
    "**Important:** As you complete each task, check it off in" +
      ` \`${context?.progressPath ?? INSTALLED_PROGRESS}\` by changing \`- [ ]\` to \`- [x]\`.` +
      " Run `first-tree tree verify` when done — it will fail if any" +
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
  seedSourceRoot?: string;
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
      "Warning: `first-tree tree bootstrap --here` is initializing this source/workspace" +
        " repo in place. This will create `NODE.md`, `members/`, and tree-scoped" +
        ` ${AGENT_INSTRUCTIONS_FILE}/${CLAUDE_INSTRUCTIONS_FILE} here. Use \`first-tree tree init\` to create` +
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
        sourceRepoRemoteUrl: sourceRepo.isGitRepo()
          ? readGitRemoteUrl(runInitCommandRunner, sourceRepo.root) ?? undefined
          : undefined,
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
        ` section in ${AGENT_INSTRUCTIONS_FILE} and ${CLAUDE_INSTRUCTIONS_FILE}, and local-only tree checkout state under \`${SOURCE_STATE}\`.`,
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
      console.log();
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      console.error(`Error: ${message}`);
      return 1;
    }
  }

  try {
    const resolvedSourceRoot = resolveSourceRoot();
    if (!r.hasCurrentInstalledSkill()) {
      console.log("Installing the first-tree skill into the tree repo...");
      installSkill(resolvedSourceRoot, r.root);
    } else {
      console.log("Reusing the existing first-tree skill in the tree repo.");
    }
    const treeAgentHooks = ensureAgentContextHooks(r.root);
    for (const message of formatAgentContextHookMessages(treeAgentHooks)) {
      console.log(`  ${message}`);
    }
    console.log();
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error(`Error: ${message}`);
    return 1;
  }

  try {
    const resolvedSourceRoot = resolveSourceRoot();
    const frameworkDir = resolveCanonicalFrameworkRoot(resolvedSourceRoot);
    const bundledSkillVersion = readSkillVersion(resolvedSourceRoot);
    const hadTreeMetadata = r.pathExists(TREE_VERSION);

    if (!hadTreeMetadata) {
      console.log(
        "Bootstrapping dedicated tree metadata from the bundled first-tree package...",
      );
    } else {
      console.log(
        "Reusing the existing tree framework layout and filling any missing scaffold files...",
      );
    }
    writeTreeRuntimeVersion(r.root, bundledSkillVersion);

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
      const contributorSourceRepo = options?.seedSourceRoot
        ? new Repo(resolve(options.seedSourceRoot))
        : initTarget.dedicatedTreeRepo
        ? sourceRepo
        : r;
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
      sourceRepoRemoteUrl: sourceRepo.isGitRepo()
        ? readGitRemoteUrl(runInitCommandRunner, sourceRepo.root) ?? undefined
        : undefined,
      treeRepoName: initTarget.treeRepoName,
    });
  }

  // Agents running `first-tree tree init` have already loaded the skill
  // payload, which includes the full onboarding handbook. Dumping 200+ lines
  // of the same markdown here is noise. Print a short pointer instead; any
  // caller that wants the full text can run `first-tree tree help onboarding`.
  console.log(
    "Onboarding handbook: run `first-tree tree help onboarding` for the full reference.",
  );
  console.log();

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

export interface ParsedInitCliArgs extends ParsedInitArgs {
  scope?: "repo" | "workspace";
  syncMembers?: boolean;
  treeMode?: "dedicated" | "shared";
  treeUrl?: string;
  workspaceId?: string;
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

export function parseBootstrapArgs(
  args: string[],
): ParsedInitArgs | { error: string } {
  return parseInitArgs(args);
}

export function runInitCli(args: string[] = []): number {
  if (args[0] === "tree") {
    return runBootstrapCli(args.slice(1));
  }
  if (args.includes("--help") || args.includes("-h")) {
    console.log(INIT_USAGE);
    return 0;
  }

  const parsed = parseInitCliArgs(args);
  if ("error" in parsed) {
    console.error(parsed.error);
    console.log(INIT_USAGE);
    return 1;
  }

  return runInitWorkflow(parsed);
}

export function runBootstrapCli(
  args: string[] = [],
  output: (text: string) => void = console.log,
): number {
  if (args.includes("--help") || args.includes("-h")) {
    output(BOOTSTRAP_USAGE);
    return 0;
  }

  const parsed = parseBootstrapArgs(args);
  if ("error" in parsed) {
    console.error(parsed.error);
    output(BOOTSTRAP_USAGE);
    return 1;
  }

  return runExplicitTreeInit(parsed);
}

export function parseInitCliArgs(
  args: string[],
): ParsedInitCliArgs | { error: string } {
  const parsed: ParsedInitCliArgs = {};
  let index = 0;

  for (; index < args.length; index += 1) {
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
      case "--tree-url": {
        const value = args[index + 1];
        if (!value) {
          return { error: "Missing value for --tree-url" };
        }
        parsed.treeUrl = value;
        index += 1;
        break;
      }
      case "--tree-mode": {
        const value = args[index + 1];
        if (!value) {
          return { error: "Missing value for --tree-mode" };
        }
        if (value !== "dedicated" && value !== "shared") {
          return { error: `Unsupported value for --tree-mode: ${value}` };
        }
        parsed.treeMode = value;
        index += 1;
        break;
      }
      case "--scope": {
        const value = args[index + 1];
        if (!value) {
          return { error: "Missing value for --scope" };
        }
        if (value !== "repo" && value !== "workspace") {
          return { error: `Unsupported value for --scope: ${value}` };
        }
        parsed.scope = value;
        index += 1;
        break;
      }
      case "--workspace-id": {
        const value = args[index + 1];
        if (!value) {
          return { error: "Missing value for --workspace-id" };
        }
        parsed.workspaceId = value;
        index += 1;
        break;
      }
      case "--sync-members":
        parsed.syncMembers = true;
        break;
      default:
        return { error: `Unknown init option: ${arg}` };
    }
  }

  if (parsed.here && parsed.treeUrl) {
    return { error: "Cannot combine --here with --tree-url" };
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

function resolveInitScope(parsed: ParsedInitCliArgs): "repo" | "workspace" {
  if (parsed.scope !== undefined) {
    return parsed.scope;
  }
  const inspection = inspectRepo();
  return inspection.childRepos.length > 0 ? "workspace" : "repo";
}

function resolveTreeModeForWorkflow(
  repo: Repo,
  scope: "repo" | "workspace",
  parsed: ParsedInitCliArgs,
): "dedicated" | "shared" {
  if (parsed.treeMode !== undefined) {
    return parsed.treeMode;
  }
  if (scope === "workspace") {
    return "shared";
  }
  if (parsed.treeUrl !== undefined) {
    return "shared";
  }
  if (parsed.treePath !== undefined) {
    const treeRepoName = new Repo(resolve(process.cwd(), parsed.treePath)).repoName();
    return treeRepoName === `${repo.repoName()}-tree`
      || treeRepoName === `${repo.repoName()}-context`
      ? "dedicated"
      : "shared";
  }
  return "dedicated";
}

function resolveDefaultTreeRoot(
  sourceRepo: Repo,
  parsed: ParsedInitCliArgs,
): string {
  if (parsed.treePath !== undefined) {
    return resolve(process.cwd(), parsed.treePath);
  }
  if (parsed.treeName !== undefined) {
    return join(dirname(sourceRepo.root), parsed.treeName);
  }
  if (sourceRepo.isGitRepo()) {
    const existingBinding = resolveDedicatedTreeRepoForSource(sourceRepo);
    if (existingBinding.ok) {
      return existingBinding.value.root;
    }
  }
  return join(dirname(sourceRepo.root), `${sourceRepo.repoName()}-tree`);
}

function initTreeCheckout(
  treeRoot: string,
  sourceRepo: Repo | null,
  parsed: ParsedInitCliArgs,
): number {
  try {
    ensureGitRepo(treeRoot);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error(`Error: ${message}`);
    return 1;
  }
  return runInit(new Repo(treeRoot), {
    here: true,
    seedMembers: parsed.seedMembers,
    seedSourceRoot: sourceRepo?.root,
  });
}

function runExplicitTreeInit(parsed: ParsedInitCliArgs): number {
  const treeRoot = parsed.here
    ? new Repo().root
    : parsed.treePath
    ? resolve(process.cwd(), parsed.treePath)
    : process.cwd();
  return initTreeCheckout(treeRoot, null, parsed);
}

function runInitWorkflow(parsed: ParsedInitCliArgs): number {
  if (parsed.here) {
    return runExplicitTreeInit(parsed);
  }

  const sourceRepo = new Repo();
  const scope = resolveInitScope(parsed);
  const treeMode = resolveTreeModeForWorkflow(sourceRepo, scope, parsed);
  const bindMode = scope === "workspace"
    ? "workspace-root"
    : treeMode === "shared"
    ? "shared-source"
    : "standalone-source";

  if (parsed.treePath !== undefined || parsed.treeUrl !== undefined) {
    const bindCode = runBind(undefined, {
      mode: bindMode,
      treeMode,
      treePath: parsed.treePath,
      treeUrl: parsed.treeUrl,
      workspaceId: parsed.workspaceId,
    });
    if (bindCode !== 0) {
      return bindCode;
    }
    if (scope === "workspace" && (parsed.syncMembers ?? true)) {
      return runWorkspaceSync(undefined, {
        treePath: parsed.treePath,
        treeUrl: parsed.treeUrl,
        workspaceId: parsed.workspaceId,
      });
    }
    return 0;
  }

  const treeRoot = resolveDefaultTreeRoot(sourceRepo, parsed);
  const initCode = initTreeCheckout(treeRoot, sourceRepo, parsed);
  if (initCode !== 0) {
    return initCode;
  }

  const bindCode = runBind(undefined, {
    mode: bindMode,
    treeMode,
    treePath: relativeRepoPath(sourceRepo.root, treeRoot),
    workspaceId: parsed.workspaceId,
  });
  if (bindCode !== 0) {
    return bindCode;
  }

  if (scope === "workspace" && (parsed.syncMembers ?? true)) {
    return runWorkspaceSync(undefined, {
      treePath: relativeRepoPath(sourceRepo.root, treeRoot),
      workspaceId: parsed.workspaceId,
    });
  }

  return 0;
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
        "not a git repository. Run this from your source/workspace repo, or create a dedicated tree repo first:\n  git init\n  first-tree tree bootstrap --here",
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
