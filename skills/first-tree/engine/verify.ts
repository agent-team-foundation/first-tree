import { resolve } from "node:path";
import { Repo } from "#skill/engine/repo.js";
import {
  AGENT_INSTRUCTIONS_FILE,
  LEGACY_AGENT_INSTRUCTIONS_FILE,
} from "#skill/engine/runtime/asset-loader.js";
import { runValidateMembers } from "#skill/engine/validators/members.js";
import { runValidateNodes } from "#skill/engine/validators/nodes.js";

const UNCHECKED_RE = /^- \[ \] (.+)$/gm;
export const VERIFY_USAGE = `usage: context-tree verify [--tree-path PATH]

Options:
  --tree-path PATH   Verify a tree repo from another working directory
  --help             Show this help message
`;

export function check(label: string, passed: boolean): boolean {
  const icon = passed ? "\u2713" : "\u2717";
  const status = passed ? "PASS" : "FAIL";
  console.log(`  ${icon} [${status}] ${label}`);
  return passed;
}

export function checkProgress(repo: Repo): string[] {
  const progressPath = repo.progressPath();
  const text = progressPath === null ? null : repo.readFile(progressPath);
  if (text === null) return [];
  const matches: string[] = [];
  let m: RegExpExecArray | null;
  UNCHECKED_RE.lastIndex = 0;
  while ((m = UNCHECKED_RE.exec(text)) !== null) {
    matches.push(m[1]);
  }
  return matches;
}

export interface ValidateNodesResult {
  exitCode: number;
}

export type NodeValidator = (root: string) => ValidateNodesResult;

function defaultNodeValidator(root: string): ValidateNodesResult {
  const { exitCode } = runValidateNodes(root);
  return { exitCode };
}

export function runVerify(repo?: Repo, nodeValidator?: NodeValidator): number {
  const r = repo ?? new Repo();
  const validate = nodeValidator ?? defaultNodeValidator;

  if (r.isLikelySourceRepo() && !r.looksLikeTreeRepo()) {
    console.error(
      "Error: no installed framework skill found here. This looks like a source/workspace repo. Run `context-tree init` to create a dedicated tree repo, or pass `--tree-path` to verify an existing tree repo.",
    );
    return 1;
  }

  let allPassed = true;
  const progressPath = r.progressPath() ?? r.preferredProgressPath();
  const frameworkVersionPath = r.frameworkVersionPath();

  console.log("Context Tree Verification\n");

  // Progress file check
  const unchecked = checkProgress(r);
  if (unchecked.length > 0) {
    console.log(`  Unchecked items in ${progressPath}:\n`);
    for (const item of unchecked) {
      console.log(`    - [ ] ${item}`);
    }
    console.log();
    console.log(
      `  Verify each step above and check it off in ${progressPath} before running verify again.\n`,
    );
    allPassed = false;
  }

  // Deterministic checks
  console.log("  Checks:\n");

  // 1. Framework exists
  allPassed = check(`${frameworkVersionPath} exists`, r.hasFramework()) && allPassed;

  // 2. Root NODE.md has valid frontmatter
  const fm = r.frontmatter("NODE.md");
  const hasValidNode =
    fm !== null && fm.title !== undefined && fm.owners !== undefined;
  allPassed = check(
    "Root NODE.md has valid frontmatter (title, owners)",
    hasValidNode,
  ) && allPassed;

  // 3. AGENTS.md is canonical and contains framework markers
  const hasCanonicalAgentInstructions = r.hasCanonicalAgentInstructionsFile();
  const hasLegacyAgentInstructions = r.hasLegacyAgentInstructionsFile();
  if (hasLegacyAgentInstructions) {
    const followUp = hasCanonicalAgentInstructions
      ? `Remove legacy \`${LEGACY_AGENT_INSTRUCTIONS_FILE}\` after confirming its contents are in \`${AGENT_INSTRUCTIONS_FILE}\`.`
      : `Rename \`${LEGACY_AGENT_INSTRUCTIONS_FILE}\` to \`${AGENT_INSTRUCTIONS_FILE}\`.`;
    console.log(`  Legacy agent instructions detected. ${followUp}\n`);
  }
  allPassed = check(
    `${AGENT_INSTRUCTIONS_FILE} is the only agent instructions file and has framework markers`,
    hasCanonicalAgentInstructions &&
      !hasLegacyAgentInstructions &&
      r.hasAgentInstructionsMarkers(),
  ) && allPassed;

  // 4. Node validation
  const { exitCode } = validate(r.root);
  allPassed = check("Node validation passes", exitCode === 0) && allPassed;

  // 5. Member validation
  const members = runValidateMembers(r.root);
  allPassed = check("Member validation passes", members.exitCode === 0) && allPassed;

  console.log();
  if (allPassed) {
    console.log("All checks passed.");
  } else {
    console.log("Some checks failed. See above for details.");
  }
  return allPassed ? 0 : 1;
}

export function runVerifyCli(args: string[] = []): number {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(VERIFY_USAGE);
    return 0;
  }

  let treePath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--tree-path") {
      const value = args[index + 1];
      if (!value) {
        console.error("Missing value for --tree-path");
        console.log(VERIFY_USAGE);
        return 1;
      }
      treePath = value;
      index += 1;
      continue;
    }

    console.error(`Unknown verify option: ${arg}`);
    console.log(VERIFY_USAGE);
    return 1;
  }

  return runVerify(treePath ? new Repo(resolve(process.cwd(), treePath)) : undefined);
}
