import { resolve } from "node:path";
import { formatDedicatedTreePathExample } from "#products/tree/engine/dedicated-tree.js";
import {
  countProjectSpecificPlaceholderBlocks,
  PROJECT_SPECIFIC_INSTRUCTIONS_HEADER,
  Repo,
} from "#products/tree/engine/repo.js";
import {
  AGENT_INSTRUCTIONS_FILE,
  CLAUDE_INSTRUCTIONS_FILE,
  LEGACY_AGENT_INSTRUCTIONS_FILE,
} from "#products/tree/engine/runtime/asset-loader.js";
import {
  formatAgentContextHookDriftMessages,
  inspectAgentContextHookReport,
} from "#products/tree/engine/runtime/adapters.js";
import { runValidateMembers } from "#products/tree/engine/validators/members.js";
import { runValidateNodes } from "#products/tree/engine/validators/nodes.js";

const UNCHECKED_RE = /^- \[ \] (.+)$/gm;
export const VERIFY_USAGE = `usage: first-tree tree verify [--tree-path PATH]

Run validation checks against a Context Tree repo. Reads the tree from the
current working directory unless \`--tree-path\` is provided.

Checks performed:
  - Installed skill version file exists
  - Root NODE.md has valid frontmatter (title, owners)
  - AGENTS.md and CLAUDE.md exist with framework markers
  - Claude Code / Codex SessionStart hook drift is reported without rewriting files
  - Node validation: frontmatter, owners syntax, soft_links resolve,
    directory listing consistency, no empty nodes, no title mismatches
  - Member validation: at least one member, required fields present
  - Progress checklist has no unchecked items

Exits 0 on success, 1 if any check fails. Failures print descriptive
messages so you can fix them and re-run.

When run inside a source/workspace repo (no tree content, only the source
integration), verify exits with an error and points you to the dedicated
tree repo. Pass \`--tree-path\` to verify the dedicated tree from elsewhere.
When \`--tree-path\` is used from a bound source/workspace root, verify also
reports caller-root Claude/Codex drift without rewriting those files.

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

export interface VerifyOptions {
  callerRepo?: Repo;
}

function defaultNodeValidator(root: string): ValidateNodesResult {
  const { exitCode } = runValidateNodes(root);
  return { exitCode };
}

function shouldCheckCallerRootAgentContext(
  targetRepo: Repo,
  callerRepo: Repo | undefined,
): callerRepo is Repo {
  return callerRepo !== undefined
    && callerRepo.root !== targetRepo.root
    && callerRepo.hasSourceWorkspaceIntegration();
}

function runAgentContextHookCheck(
  label: string,
  repo: Repo,
): { passed: boolean } {
  const agentContextHookReport = inspectAgentContextHookReport(repo.root);
  if (agentContextHookReport.overall !== "current") {
    console.log(`  ${label} drift detected:\n`);
    for (const message of formatAgentContextHookDriftMessages(
      agentContextHookReport,
    )) {
      console.log(`    - ${message}`);
    }
    console.log(`\n  ${agentContextHookReport.repairHint}\n`);
  }
  return {
    passed: agentContextHookReport.overall === "current",
  };
}

export function runVerify(
  repo?: Repo,
  nodeValidator?: NodeValidator,
  options?: VerifyOptions,
): number {
  const r = repo ?? new Repo();
  const validate = nodeValidator ?? defaultNodeValidator;

  if (r.hasSourceWorkspaceIntegration() && !r.looksLikeTreeRepo()) {
    console.error(
      `Error: this repo only has the first-tree source/workspace integration installed. Verify the dedicated tree repo instead, for example ${formatDedicatedTreePathExample("first-tree tree verify", r)}.`,
    );
    return 1;
  }

  if (r.isLikelySourceRepo() && !r.looksLikeTreeRepo()) {
    console.error(
      "Error: no first-tree framework metadata found here. This looks like a source/workspace repo. Run `first-tree tree init` to create a dedicated tree repo, or pass `--tree-path` to verify an existing tree repo.",
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

  // 3. AGENTS.md is canonical and both AGENTS.md / CLAUDE.md carry framework markers
  const hasCanonicalAgentInstructions = r.hasCanonicalAgentInstructionsFile();
  const hasLegacyAgentInstructions = r.hasLegacyAgentInstructionsFile();
  const hasClaudeInstructions = r.hasClaudeInstructionsFile();
  const duplicatePlaceholderFiles: string[] = [];
  const agentInstructionsText = r.readAgentInstructions();
  if (
    hasCanonicalAgentInstructions
    && agentInstructionsText !== null
    && countProjectSpecificPlaceholderBlocks(agentInstructionsText) > 1
  ) {
    duplicatePlaceholderFiles.push(AGENT_INSTRUCTIONS_FILE);
  }
  const claudeInstructionsText = r.readClaudeInstructions();
  if (
    hasClaudeInstructions
    && claudeInstructionsText !== null
    && countProjectSpecificPlaceholderBlocks(claudeInstructionsText) > 1
  ) {
    duplicatePlaceholderFiles.push(CLAUDE_INSTRUCTIONS_FILE);
  }
  if (hasLegacyAgentInstructions) {
    const followUp = hasCanonicalAgentInstructions
      ? `Remove legacy \`${LEGACY_AGENT_INSTRUCTIONS_FILE}\` after confirming its contents are in \`${AGENT_INSTRUCTIONS_FILE}\`.`
      : `Rename \`${LEGACY_AGENT_INSTRUCTIONS_FILE}\` to \`${AGENT_INSTRUCTIONS_FILE}\`.`;
    console.log(`  Legacy agent instructions detected. ${followUp}\n`);
  }
  if (duplicatePlaceholderFiles.length > 0) {
    console.log(
      `  Duplicate \`${PROJECT_SPECIFIC_INSTRUCTIONS_HEADER}\` placeholder blocks detected in ${duplicatePlaceholderFiles.map((file) => `\`${file}\``).join(" and ")}. Keep only one copy of the template section in each file.\n`,
    );
  }
  allPassed = check(
    `${AGENT_INSTRUCTIONS_FILE} is canonical and both ${AGENT_INSTRUCTIONS_FILE}/${CLAUDE_INSTRUCTIONS_FILE} have framework markers`,
    hasCanonicalAgentInstructions &&
      !hasLegacyAgentInstructions &&
      r.hasAgentInstructionsMarkers() &&
      hasClaudeInstructions &&
      r.hasClaudeInstructionsMarkers() &&
      duplicatePlaceholderFiles.length === 0,
  ) && allPassed;

  // 4. Agent context hook drift for the verified tree target
  const treeAgentContextCheck = runAgentContextHookCheck("Agent context", r);
  allPassed = check(
    "Managed Claude Code / Codex agent context files are current",
    treeAgentContextCheck.passed,
  ) && allPassed;

  // 5. Optional caller-root drift when verify targets another tree checkout
  if (shouldCheckCallerRootAgentContext(r, options?.callerRepo)) {
    const callerAgentContextCheck = runAgentContextHookCheck(
      `Caller root agent context (${options.callerRepo.root})`,
      options.callerRepo,
    );
    allPassed = check(
      "Caller root managed Claude Code / Codex agent context files are current",
      callerAgentContextCheck.passed,
    ) && allPassed;
  }

  // 6. Node validation
  const { exitCode } = validate(r.root);
  allPassed = check("Node validation passes", exitCode === 0) && allPassed;

  // 7. Member validation
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

  const callerRepo = treePath ? new Repo() : undefined;
  return runVerify(
    treePath ? new Repo(resolve(process.cwd(), treePath)) : undefined,
    undefined,
    { callerRepo },
  );
}
