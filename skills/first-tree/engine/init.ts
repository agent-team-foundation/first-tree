import {
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
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
  FRAMEWORK_ASSET_ROOT,
  FRAMEWORK_VERSION,
  INSTALLED_PROGRESS,
} from "#skill/engine/runtime/asset-loader.js";

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

function installSkill(source: string, target: string): void {
  copyCanonicalSkill(source, target);
  console.log(
    "  Installed skills/first-tree/ from the bundled first-tree package",
  );
}

function renderTemplates(target: string): void {
  const frameworkDir = join(target, FRAMEWORK_ASSET_ROOT);
  for (const [templateName, targetPath] of TEMPLATE_MAP) {
    if (existsSync(join(target, targetPath))) {
      console.log(`  Skipped ${targetPath} (already exists)`);
    } else if (renderTemplateFile(frameworkDir, templateName, target, targetPath)) {
      console.log(`  Created ${targetPath}`);
    }
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
  lines.push(`- [ ] \`${FRAMEWORK_VERSION}\` exists`);
  lines.push("- [ ] Root NODE.md has valid frontmatter (title, owners)");
  lines.push("- [ ] AGENT.md exists with framework markers");
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
}

export function runInit(repo?: Repo, options?: InitOptions): number {
  const r = repo ?? new Repo();

  if (!r.isGitRepo()) {
    console.error(
      "Error: not a git repository. Initialize one first:\n  git init",
    );
    return 1;
  }

  if (!r.hasFramework()) {
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

  const output = formatTaskList(groups);
  console.log(output);
  writeProgress(r, output);
  console.log(`Progress file written to ${r.preferredProgressPath()}`);
  return 0;
}
