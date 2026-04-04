import { resolve } from "node:path";
import { Repo } from "#skill/engine/repo.js";
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

  // 3. AGENT.md exists with framework markers
  allPassed = check(
    "AGENT.md exists with framework markers",
    r.hasAgentMdMarkers(),
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
