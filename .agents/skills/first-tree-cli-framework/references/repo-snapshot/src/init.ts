import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { Repo } from "#src/repo.js";
import { ONBOARDING_TEXT } from "#src/onboarding.js";
import { evaluateAll } from "#src/rules/index.js";
import type { RuleResult } from "#src/rules/index.js";

const SEED_TREE_URL = "https://github.com/agent-team-foundation/seed-tree";
const FRAMEWORK_DIR = ".context-tree";

/**
 * The interactive prompt tool the agent should use to present choices.
 * Different agents may name this differently — change it here to update
 * all generated task text at once.
 */
export const INTERACTIVE_TOOL = "AskUserQuestion";

const TEMPLATE_MAP: [string, string][] = [
  ["root-node.md.template", "NODE.md"],
  ["agent.md.template", "AGENT.md"],
  ["members-domain.md.template", "members/NODE.md"],
];

function cloneSeedTree(): string {
  const tmp = mkdtempSync(join(tmpdir(), "context-tree-"));
  console.log(`Cloning seed-tree from ${SEED_TREE_URL}...`);
  try {
    execFileSync("git", ["clone", "--depth", "1", SEED_TREE_URL, tmp], {
      encoding: "utf-8",
      stdio: "pipe",
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "unknown error";
    console.error(`Failed to clone seed-tree: ${message}`);
    rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
  }
  return tmp;
}

function copyFramework(source: string, target: string): void {
  const src = join(source, FRAMEWORK_DIR);
  const dst = join(target, FRAMEWORK_DIR);
  if (existsSync(dst)) {
    rmSync(dst, { recursive: true, force: true });
  }
  cpSync(src, dst, { recursive: true });
  console.log(`  Copied ${FRAMEWORK_DIR}/`);
}

function renderTemplates(frameworkDir: string, target: string): void {
  const templatesDir = join(frameworkDir, "templates");
  for (const [templateName, targetPath] of TEMPLATE_MAP) {
    const src = join(templatesDir, templateName);
    const dst = join(target, targetPath);
    if (existsSync(dst)) {
      console.log(`  Skipped ${targetPath} (already exists)`);
    } else if (existsSync(src)) {
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
      console.log(`  Created ${targetPath}`);
    }
  }
}

function addUpstreamRemote(target: string): void {
  try {
    const result = execFileSync("git", ["remote"], {
      cwd: target,
      encoding: "utf-8",
    });
    if (!result.split(/\s+/).includes("context-tree-upstream")) {
      execFileSync(
        "git",
        ["remote", "add", "context-tree-upstream", SEED_TREE_URL],
        { cwd: target, encoding: "utf-8", stdio: "pipe" },
      );
      console.log(
        `  Added git remote 'context-tree-upstream' -> ${SEED_TREE_URL}`,
      );
    }
  } catch {
    // ignore
  }
}

export function formatTaskList(groups: RuleResult[]): string {
  const lines: string[] = [
    "# Context Tree Init\n",
    "**Agent instructions:** Before starting work, analyze the full task list below and" +
      " identify all information you need from the user. Ask the user for their code" +
      " repositories or project directories so you can analyze the source yourself —" +
      " derive project descriptions, domains, and members from the code instead of" +
      " asking the user to describe them. Collect everything upfront using the" +
      ` **${INTERACTIVE_TOOL}** tool with structured options — present selectable choices` +
      " (with label and description) so the user can pick instead of typing free-form" +
      ` answers. You may batch up to 4 questions per ${INTERACTIVE_TOOL} call.\n`,
  ];
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
  lines.push("- [ ] `.context-tree/VERSION` exists");
  lines.push("- [ ] Root NODE.md has valid frontmatter (title, owners)");
  lines.push("- [ ] AGENT.md exists with framework markers");
  lines.push("- [ ] `context-tree verify` passes with no errors");
  lines.push("- [ ] At least one member node exists");
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(
    "**Important:** As you complete each task, check it off in" +
      " `.context-tree/progress.md` by changing `- [ ]` to `- [x]`." +
      " Run `context-tree verify` when done — it will fail if any" +
      " items remain unchecked.",
  );
  lines.push("");
  return lines.join("\n");
}

export function writeProgress(repo: Repo, content: string): void {
  const progressPath = join(repo.root, ".context-tree", "progress.md");
  mkdirSync(dirname(progressPath), { recursive: true });
  writeFileSync(progressPath, content);
}

export function runInit(repo?: Repo): number {
  const r = repo ?? new Repo();

  if (!r.isGitRepo()) {
    console.error(
      "Error: not a git repository. Initialize one first:\n  git init",
    );
    return 1;
  }

  if (!r.hasFramework()) {
    const seed = cloneSeedTree();
    try {
      console.log("Copying framework and scaffolding...");
      copyFramework(seed, r.root);
      const frameworkDir = join(r.root, FRAMEWORK_DIR);
      renderTemplates(frameworkDir, r.root);
      addUpstreamRemote(r.root);
    } finally {
      rmSync(seed, { recursive: true, force: true });
    }
    console.log();
  }

  console.log(ONBOARDING_TEXT);
  console.log("---\n");

  const groups = evaluateAll(r);
  if (groups.length === 0) {
    console.log("All checks passed. Your context tree is set up.");
    return 0;
  }

  const output = formatTaskList(groups);
  console.log(output);
  writeProgress(r, output);
  console.log("Progress file written to .context-tree/progress.md");
  return 0;
}
