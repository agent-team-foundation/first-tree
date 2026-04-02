import { Repo } from "#src/repo.js";
import { runValidateMembers } from "#src/validators/members.js";
import { runValidateNodes } from "#src/validators/nodes.js";

const UNCHECKED_RE = /^- \[ \] (.+)$/gm;

export function check(label: string, passed: boolean): boolean {
  const icon = passed ? "\u2713" : "\u2717";
  const status = passed ? "PASS" : "FAIL";
  console.log(`  ${icon} [${status}] ${label}`);
  return passed;
}

export function checkProgress(repo: Repo): string[] {
  const text = repo.readFile(".context-tree/progress.md");
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
  let allPassed = true;

  console.log("Context Tree Verification\n");

  // Progress file check
  const unchecked = checkProgress(r);
  if (unchecked.length > 0) {
    console.log("  Unchecked items in .context-tree/progress.md:\n");
    for (const item of unchecked) {
      console.log(`    - [ ] ${item}`);
    }
    console.log();
    console.log(
      "  Verify each step above and check it off in progress.md before running verify again.\n",
    );
    allPassed = false;
  }

  // Deterministic checks
  console.log("  Checks:\n");

  // 1. Framework exists
  allPassed = check(".context-tree/VERSION exists", r.hasFramework()) && allPassed;

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
