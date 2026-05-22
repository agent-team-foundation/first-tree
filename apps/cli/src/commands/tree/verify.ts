import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { Command } from "commander";

import type { CommandContext, SubcommandModule } from "../types.js";
import { TREE_PROGRESS_FILE, TREE_VERSION_FILE } from "./binding-state.js";
import { readSourceBindingContract } from "./binding-contract.js";
import { resolveRepoRoot } from "./shared.js";
import { readTreeIdentityContract } from "./tree-identity.js";
import { runValidateMembers } from "./validate-members.js";
import { runValidateNodes } from "./validate-nodes.js";

const FRONTMATTER_RE = /^---\s*\n(.*?)\n---/su;
const OWNERS_RE = /^owners:\s*\[([^\]]*)\]/mu;
const TITLE_RE = /^title:\s*['"]?(.+?)['"]?\s*$/mu;
const UNCHECKED_RE = /^- \[ \] (.+)$/gmu;

export const VERIFY_USAGE = `usage: first-tree tree verify [--tree-path PATH]

Run validation checks against a Context Tree repo.

Options:
  --tree-path PATH   Verify a tree repo from another working directory
  --help             Show this help message`;

type VerifyCheck = {
  errors?: string[];
  ok: boolean;
};

type VerifySummary = {
  checks: {
    agentInstructions: VerifyCheck;
    frameworkVersion: VerifyCheck;
    members: VerifyCheck;
    nodes: VerifyCheck;
    progress: VerifyCheck & { uncheckedItems: string[] };
    rootNodeFrontmatter: VerifyCheck;
    treeState: VerifyCheck;
  };
  ok: boolean;
  targetRoot: string;
};

function configureVerifyCommand(command: Command): void {
  command.option("--tree-path <path>", "verify a tree repo from another working directory");
}

function readTargetRoot(command: Command): string {
  const options = command.opts() as { treePath?: string };

  if (options.treePath) {
    return resolve(process.cwd(), options.treePath);
  }

  return resolveRepoRoot(process.cwd());
}

function parseFrontmatter(path: string): string | null {
  try {
    const text = readFileSync(path, "utf-8");
    const match = text.match(FRONTMATTER_RE);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function readUncheckedProgressItems(root: string): string[] {
  try {
    const text = readFileSync(join(root, TREE_PROGRESS_FILE), "utf-8");
    return [...text.matchAll(UNCHECKED_RE)].map((match) => match[1]);
  } catch {
    return [];
  }
}

function formatSourceRepoError(targetRoot: string): string {
  const sourceBinding = readSourceBindingContract(targetRoot);
  const treeRepoName = sourceBinding?.treeRepoName;
  const examplePath = treeRepoName ? `../${treeRepoName}` : "../<tree-repo>";
  return `This repo only has source/workspace integration installed. Verify the tree repo instead, for example \`first-tree tree verify --tree-path ${examplePath}\`.`;
}

function verifyTreeRoot(targetRoot: string): VerifySummary {
  if (
    readSourceBindingContract(targetRoot) !== undefined &&
    readTreeIdentityContract(targetRoot) === undefined
  ) {
    throw new Error(formatSourceRepoError(targetRoot));
  }

  const rootFrontmatter = parseFrontmatter(join(targetRoot, "NODE.md"));
  const rootNodeErrors: string[] = [];

  if (rootFrontmatter === null) {
    rootNodeErrors.push("Root NODE.md is missing frontmatter.");
  } else {
    if (!TITLE_RE.test(rootFrontmatter)) {
      rootNodeErrors.push("Root NODE.md is missing a title.");
    }
    if (!OWNERS_RE.test(rootFrontmatter)) {
      rootNodeErrors.push("Root NODE.md is missing owners.");
    }
  }

  const progressItems = readUncheckedProgressItems(targetRoot);
  const nodeResult = runValidateNodes(targetRoot);
  const memberResult = runValidateMembers(targetRoot);
  const summary: VerifySummary = {
    checks: {
      agentInstructions: {
        ok:
          existsSync(join(targetRoot, "AGENTS.md")) &&
          existsSync(join(targetRoot, "CLAUDE.md")) &&
          readFileSync(join(targetRoot, "AGENTS.md"), "utf-8").includes(
            "BEGIN CONTEXT-TREE FRAMEWORK",
          ),
        ...(existsSync(join(targetRoot, "AGENTS.md")) && existsSync(join(targetRoot, "CLAUDE.md"))
          ? {}
          : { errors: ["AGENTS.md and CLAUDE.md must both exist in the tree root."] }),
      },
      frameworkVersion: {
        ok: existsSync(join(targetRoot, TREE_VERSION_FILE)),
        ...(existsSync(join(targetRoot, TREE_VERSION_FILE))
          ? {}
          : { errors: [`.first-tree/VERSION is missing.`] }),
      },
      members: {
        ok: memberResult.exitCode === 0,
        ...(memberResult.exitCode === 0 ? {} : { errors: memberResult.errors }),
      },
      nodes: {
        ok: nodeResult.exitCode === 0,
        ...(nodeResult.exitCode === 0 ? {} : { errors: nodeResult.errors }),
      },
      progress: {
        ok: progressItems.length === 0,
        ...(progressItems.length === 0
          ? {}
          : { errors: progressItems.map((item) => `Unchecked progress item: ${item}`) }),
        uncheckedItems: progressItems,
      },
      rootNodeFrontmatter: {
        ok: rootNodeErrors.length === 0,
        ...(rootNodeErrors.length === 0 ? {} : { errors: rootNodeErrors }),
      },
      treeState: {
        ok: readTreeIdentityContract(targetRoot) !== undefined,
        ...(readTreeIdentityContract(targetRoot) !== undefined
          ? {}
          : { errors: ["Managed tree identity is missing from AGENTS.md / CLAUDE.md."] }),
      },
    },
    ok: false,
    targetRoot,
  };

  summary.ok = Object.values(summary.checks).every((check) => check.ok);
  return summary;
}

function printVerifySummary(summary: VerifySummary): void {
  console.log("Context Tree Verification\n");
  console.log(`  Tree root: ${summary.targetRoot}\n`);

  const rows: Array<[string, VerifyCheck]> = [
    ["framework version", summary.checks.frameworkVersion],
    ["tree state", summary.checks.treeState],
    ["root node frontmatter", summary.checks.rootNodeFrontmatter],
    ["agent instructions", summary.checks.agentInstructions],
    ["node validation", summary.checks.nodes],
    ["member validation", summary.checks.members],
    ["progress checklist", summary.checks.progress],
  ];

  for (const [label, check] of rows) {
    const icon = check.ok ? "PASS" : "FAIL";
    console.log(`  [${icon}] ${label}`);
    for (const error of check.errors ?? []) {
      console.log(`    - ${error}`);
    }
  }

  console.log("");
  console.log(summary.ok ? "All checks passed." : "Some checks failed. See above for details.");
}

function runVerifyCommand(context: CommandContext): void {
  try {
    const summary = verifyTreeRoot(readTargetRoot(context.command));

    if (context.options.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      printVerifySummary(summary);
    }

    if (!summary.ok) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export const verifyCommand: SubcommandModule = {
  name: "verify",
  alias: "",
  summary: "",
  description: "Validate a Context Tree repo.",
  action: runVerifyCommand,
  configure: configureVerifyCommand,
};
