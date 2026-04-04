import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { Repo } from "#skill/engine/repo.js";
import { ONBOARDING_TEXT } from "#skill/engine/onboarding.js";
import { evaluateAll } from "#skill/engine/rules/index.js";
import type { RuleResult } from "#skill/engine/rules/index.js";
import {
  copyCanonicalSkill,
  renderTemplateFile,
  resolveBundledPackageRoot,
} from "#skill/engine/runtime/installer.js";
import {
  AGENT_INSTRUCTIONS_FILE,
  AGENT_INSTRUCTIONS_TEMPLATE,
  FRAMEWORK_ASSET_ROOT,
  FRAMEWORK_VERSION,
  INSTALLED_PROGRESS,
  LEGACY_AGENT_INSTRUCTIONS_FILE,
  installedSkillRootsDisplay,
} from "#skill/engine/runtime/asset-loader.js";

/**
 * The interactive prompt tool the agent should use to present choices.
 * Different agents may name this differently — change it here to update
 * all generated task text at once.
 */
export const INTERACTIVE_TOOL = "AskUserQuestion";
export const INIT_USAGE = `usage: context-tree init [--here] [--tree-name NAME] [--tree-path PATH]

By default, running \`context-tree init\` inside a source or workspace repo creates
a sibling dedicated tree repo named \`<repo>-context\`.

Options:
  --here             Initialize the current repo in place
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
  { templateName: "members-domain.md.template", targetPath: "members/NODE.md" },
];

interface TaskListContext {
  sourceRepoPath?: string;
  dedicatedTreeRepo?: boolean;
}

function installSkill(source: string, target: string): void {
  copyCanonicalSkill(source, target);
  console.log(
    `  Installed ${installedSkillRootsDisplay()} from the bundled first-tree package`,
  );
}

function renderTemplates(target: string): void {
  const frameworkDir = join(target, FRAMEWORK_ASSET_ROOT);
  for (const { templateName, targetPath, skipIfExists } of TEMPLATE_MAP) {
    const existingPaths = skipIfExists ?? [targetPath];
    const existingPath = existingPaths.find((candidate) =>
      existsSync(join(target, candidate)),
    );

    if (existingPath !== undefined) {
      console.log(`  Skipped ${targetPath} (found existing ${existingPath})`);
    } else if (renderTemplateFile(frameworkDir, templateName, target, targetPath)) {
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
    "After completing the tasks above, run `context-tree verify` to confirm:",
  );
  lines.push(`- [ ] \`${FRAMEWORK_VERSION}\` exists`);
  lines.push("- [ ] Root NODE.md has valid frontmatter (title, owners)");
  lines.push(
    `- [ ] \`${AGENT_INSTRUCTIONS_FILE}\` is the only agent instructions file and has framework markers`,
  );
  lines.push("- [ ] `context-tree verify` passes with no errors");
  lines.push("- [ ] At least one member node exists");
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(
    "**Important:** As you complete each task, check it off in" +
      ` \`${INSTALLED_PROGRESS}\` by changing \`- [ ]\` to \`- [x]\`.` +
      " Run `context-tree verify` when done — it will fail if any" +
      " items remain unchecked.",
  );
  lines.push("");
  return lines.join("\n");
}

export function writeProgress(repo: Repo, content: string): void {
  const progressPath = join(repo.root, repo.preferredProgressPath());
  mkdirSync(dirname(progressPath), { recursive: true });
  writeFileSync(progressPath, content);
}

export interface InitOptions {
  sourceRoot?: string;
  here?: boolean;
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
  const taskListContext = initTarget.dedicatedTreeRepo
    ? {
        dedicatedTreeRepo: true,
        sourceRepoPath: relativePathFrom(r.root, sourceRepo.root),
      }
    : undefined;

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
    console.log();
  }

  if (!r.hasCurrentInstalledSkill()) {
    try {
      const sourceRoot = options?.sourceRoot ?? resolveBundledPackageRoot();
      console.log(
        "Installing the framework skill bundled with this first-tree package...",
      );
      console.log("Installing skill and scaffolding...");
      installSkill(sourceRoot, r.root);
      renderTemplates(r.root);
      console.log();
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      console.error(`Error: ${message}`);
      return 1;
    }
  }

  console.log(ONBOARDING_TEXT);
  console.log("---\n");

  const groups = evaluateAll(r);
  if (groups.length === 0) {
    console.log("All checks passed. Your context tree is set up.");
    return 0;
  }

  const output = formatTaskList(groups, taskListContext);
  console.log(output);
  writeProgress(r, output);
  console.log(`Progress file written to ${r.preferredProgressPath()}`);
  if (initTarget.dedicatedTreeRepo) {
    console.log(
      `Continue in ${relativePathFrom(sourceRepo.root, r.root)} and keep your source repos available as additional working directories when you populate the tree.`,
    );
  }
  return 0;
}

export interface ParsedInitArgs {
  here?: boolean;
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
        "not a git repository. Run this from your source/workspace repo, or create a dedicated tree repo first:\n  git init\n  context-tree init --here",
    };
  }

  const targetRoot = determineTargetRoot(sourceRepo, options);
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
  };
}

function determineTargetRoot(sourceRepo: Repo, options?: InitOptions): string {
  if (options?.treePath) {
    return resolve(options.currentCwd ?? process.cwd(), options.treePath);
  }

  if (options?.here) {
    return sourceRepo.root;
  }

  if (options?.treeName) {
    return join(dirname(sourceRepo.root), options.treeName);
  }

  if (
    sourceRepo.looksLikeTreeRepo()
    || sourceRepo.isLikelyEmptyRepo()
    || !sourceRepo.isLikelySourceRepo()
  ) {
    return sourceRepo.root;
  }

  return join(dirname(sourceRepo.root), `${sourceRepo.repoName()}-context`);
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

function relativePathFrom(from: string, to: string): string {
  const rel = relative(from, to);
  if (rel === "") {
    return ".";
  }
  return rel.startsWith("..") ? rel : `./${rel}`;
}
