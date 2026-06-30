import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { runCommand } from "../../core/commands.js";
import { isRecord, isStringArray } from "../../core/events.js";
import type { RunPaths } from "../../core/types.js";
import type { EvalMetrics, FirstTreeSeedEvalCase, FixtureValidation } from "./types.js";

const TEXT_KEYS = ["content", "message", "output_text", "text"];
const SKILL_READ_INPUT_KEYS = new Set([
  "args",
  "arguments",
  "argv",
  "cmd",
  "command",
  "filePath",
  "file_path",
  "input",
  "params",
  "path",
  "relativePath",
  "relative_path",
  "targetFile",
  "target_file",
]);
const SKILL_READ_OUTPUT_KEYS = new Set([
  "aggregated_output",
  "content",
  "message",
  "output",
  "output_text",
  "stderr",
  "stdout",
  "text",
]);
const PROTECTED_BARE_SOURCE_REPO_PATTERN =
  /(?:^|[\s"'=])(?:\.\/|\/[^\s"']*\/)?(?:source-repos\/source-repo|\.first-tree-eval\/source-origin)(?:[\s"'/:]|$)/u;
const PROTECTED_BARE_SOURCE_CONTENT_PATHS = [
  "source-repos/source-repo/README.md",
  "source-repos/source-repo/package.json",
  "source-repos/source-repo/apps/",
  "source-repos/source-repo/docs/",
  "source-repos/source-repo/packages/",
  "source-repos/source-repo/raw-context/",
  "source-repos/source-repo/skills/",
  ".first-tree-eval/source-origin/objects/",
  ".first-tree-eval/source-origin/packed-refs",
  ".first-tree-eval/source-origin/refs/",
];

function eventType(event: Record<string, unknown>): string | null {
  return typeof event.type === "string" ? event.type : null;
}

function isModelPhase(event: Record<string, unknown>): boolean {
  return event.phase === "model";
}

function collectToolInputStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    const strings: string[] = [];
    for (const item of value) {
      strings.push(...collectToolInputStrings(item));
    }
    return strings;
  }
  if (!isRecord(value)) return [];

  const strings: string[] = [];
  for (const [key, item] of Object.entries(value)) {
    if (SKILL_READ_OUTPUT_KEYS.has(key)) continue;
    if (SKILL_READ_INPUT_KEYS.has(key)) {
      strings.push(...collectToolInputStrings(item));
    } else if (isRecord(item) || Array.isArray(item)) {
      strings.push(...collectToolInputStrings(item));
    }
  }
  return strings;
}

function containsSkillFileRead(event: unknown, skillName: string): boolean {
  if (!isRecord(event)) return false;
  if (eventType(event) !== "codex_event") return false;

  const nestedEvent = event.event;
  return collectToolInputStrings(nestedEvent).some(
    (value) =>
      (value.includes(".agents/skills/") || value.includes(".claude/skills/")) &&
      value.includes(`${skillName}/SKILL.md`),
  );
}

function containsPathAccess(event: unknown, patterns: readonly string[]): boolean {
  if (!isRecord(event)) return false;
  if (eventType(event) !== "codex_event") return false;
  return collectToolInputStrings(event.event).some((value) => patterns.some((pattern) => value.includes(pattern)));
}

function isAssistantMessageRecord(record: Record<string, unknown>): boolean {
  const type = eventType(record);
  const role = typeof record.role === "string" ? record.role : null;

  if (type === "agent_message" || type === "assistant_message") return true;
  if (type === "message" && (role === null || role === "assistant")) return true;
  if (type === "output_text" || type === "response.output_text.done") return true;

  return false;
}

function collectTextValue(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    const texts: string[] = [];
    for (const item of value) {
      texts.push(...collectTextValue(item));
    }
    return texts;
  }
  if (!isRecord(value)) return [];

  const texts: string[] = [];
  for (const key of TEXT_KEYS) {
    const item = value[key];
    if (typeof item === "string") {
      texts.push(item);
    } else if (Array.isArray(item)) {
      texts.push(...collectTextValue(item));
    }
  }
  return texts;
}

function collectAssistantText(value: unknown): string[] {
  if (Array.isArray(value)) {
    const texts: string[] = [];
    for (const item of value) {
      texts.push(...collectAssistantText(item));
    }
    return texts;
  }
  if (!isRecord(value)) return [];

  const texts: string[] = [];
  if (isAssistantMessageRecord(value)) {
    texts.push(...collectTextValue(value));
  }

  const item = value.item;
  if (isRecord(item)) {
    texts.push(...collectAssistantText(item));
  }

  const message = value.message;
  if (isRecord(message)) {
    texts.push(...collectAssistantText(message));
  }

  const response = value.response;
  if (isRecord(response) || Array.isArray(response)) {
    texts.push(...collectAssistantText(response));
  }

  const output = value.output;
  if (Array.isArray(output)) {
    texts.push(...collectAssistantText(output));
  }

  return texts;
}

function collectModelOutputText(event: unknown): string[] {
  if (!isRecord(event)) return [];
  if (eventType(event) !== "codex_event") return [];
  return collectAssistantText(event.event);
}

function collectCommandStrings(value: unknown): string[] {
  if (Array.isArray(value)) {
    const commands: string[] = [];
    for (const item of value) {
      commands.push(...collectCommandStrings(item));
    }
    return commands;
  }
  if (!isRecord(value)) return [];

  const commands: string[] = [];
  const command = value.command;
  if (typeof command === "string") commands.push(command);
  const cmd = value.cmd;
  if (typeof cmd === "string") commands.push(cmd);

  for (const item of Object.values(value)) {
    if (isRecord(item) || Array.isArray(item)) {
      commands.push(...collectCommandStrings(item));
    }
  }
  return commands;
}

function normalizeForMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function containsAny(haystack: string, needles: readonly string[]): boolean {
  const normalizedHaystack = normalizeForMatch(haystack);
  for (const needle of needles) {
    const normalizedNeedle = normalizeForMatch(needle);
    if (normalizedNeedle.length > 0 && normalizedHaystack.includes(normalizedNeedle)) {
      return true;
    }
  }
  return false;
}

function countMatches(haystack: string, needles: readonly string[]): number {
  const normalizedHaystack = normalizeForMatch(haystack);
  let count = 0;
  for (const needle of needles) {
    const normalizedNeedle = normalizeForMatch(needle);
    if (normalizedNeedle.length > 0 && normalizedHaystack.includes(normalizedNeedle)) {
      count += 1;
    }
  }
  return count;
}

function gitHead(repoPath: string, ref = "HEAD"): string | null {
  const result = runCommand("git", ["rev-parse", ref], repoPath);
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

function gitStatus(repoPath: string): string {
  const result = runCommand("git", ["status", "--porcelain"], repoPath);
  if (result.exitCode !== 0) return result.stderr || result.stdout;
  return result.stdout;
}

function baselineHeads(events: readonly unknown[]): { contextTreeHead: string | null; sourceRepoHead: string | null } {
  let contextTreeHead: string | null = null;
  let sourceRepoHead: string | null = null;
  for (const event of events) {
    if (!isRecord(event) || eventType(event) !== "fixture_setup_finished") continue;
    if (typeof event.contextTreeHead === "string") contextTreeHead = event.contextTreeHead;
    if (typeof event.sourceRepoHead === "string") sourceRepoHead = event.sourceRepoHead;
  }
  return { contextTreeHead, sourceRepoHead };
}

function contextTreeChanged(paths: RunPaths, baselineHead: string | null): boolean {
  const contextTreePath = join(paths.workspacePath, "context-tree");
  if (baselineHead === null) return existsSync(contextTreePath);
  if (!existsSync(contextTreePath)) return true;

  const status = runCommand("git", ["status", "--porcelain"], contextTreePath);
  if (status.exitCode !== 0) return true;
  if (status.stdout.trim().length > 0) return true;
  return gitHead(contextTreePath) !== baselineHead;
}

function sourceWorktreePaths(paths: RunPaths): string[] {
  const worktreeRoot = join(paths.workspacePath, "worktrees");
  if (!existsSync(worktreeRoot)) return [];
  return readdirSync(worktreeRoot)
    .filter((entry) => entry.startsWith("seed-source-repo"))
    .map((entry) => join(worktreeRoot, entry));
}

function sourceWorktreeCreated(paths: RunPaths): boolean {
  return sourceWorktreePaths(paths).length > 0;
}

function sourceRepoChanged(paths: RunPaths, baselineHead: string | null): boolean {
  const sourceRepoPath = join(paths.workspacePath, "source-repos", "source-repo");
  if (baselineHead === null) return existsSync(sourceRepoPath);
  if (!existsSync(sourceRepoPath)) return true;

  const currentHead = gitHead(sourceRepoPath, "refs/remotes/origin/main");
  if (currentHead !== baselineHead) return true;

  for (const worktreePath of sourceWorktreePaths(paths)) {
    const status = runCommand("git", ["status", "--porcelain"], worktreePath);
    if (status.exitCode !== 0) return true;
    if (status.stdout.trim().length > 0) return true;
    if (gitHead(worktreePath) !== baselineHead) return true;
  }

  return false;
}

function firstTreeArgvFromEvent(event: Record<string, unknown>): string[] | null {
  const argv = event.argv;
  return isStringArray(argv) ? [...argv] : null;
}

function ghArgvIsForbidden(argv: readonly string[]): boolean {
  const command = argv[0] ?? "";
  const subcommand = argv[1] ?? "";
  if (command === "auth" || command === "pr" || command === "api") return true;
  if (command !== "repo") return false;
  return [
    "archive",
    "clone",
    "create",
    "delete",
    "deploy-key",
    "edit",
    "fork",
    "rename",
    "set-default",
    "sync",
  ].includes(subcommand);
}

function forbiddenSideEffectHits(events: readonly unknown[], firstTreeArgv: readonly (readonly string[])[]): string[] {
  const hits: string[] = [];

  for (const argv of firstTreeArgv) {
    if (argv[0] === "github") hits.push(`first-tree ${argv.join(" ")}`);
    if (argv[0] === "tree" && ["bind", "create", "init", "seed", "setup"].includes(argv[1] ?? "")) {
      hits.push(`first-tree ${argv.join(" ")}`);
    }
  }

  for (const event of events) {
    if (isRecord(event) && eventType(event) === "gh_call" && isModelPhase(event)) {
      const argv = isStringArray(event.argv) ? event.argv : [];
      if (ghArgvIsForbidden(argv)) {
        hits.push(`gh ${argv.join(" ")}`.trim());
      }
    }
    if (!isRecord(event) || eventType(event) !== "codex_event") continue;
    for (const command of collectCommandStrings(event.event)) {
      if (/\bgh\s+(auth|pr|api)\b/u.test(command)) hits.push(command);
      if (/\bgh\s+repo\s+(archive|clone|create|delete|deploy-key|edit|fork|rename|set-default|sync)\b/u.test(command)) {
        hits.push(command);
      }
      if (/\bgit\s+push\b/u.test(command)) hits.push(command);
      if (/\bgit\s+commit\b/u.test(command)) hits.push(command);
      if (/\bfirst-tree(?:-staging)?\s+github\b/u.test(command)) hits.push(command);
      if (/\bfirst-tree(?:-staging)?\s+tree\s+(bind|create|init|seed|setup)\b/u.test(command)) hits.push(command);
    }
  }

  return [...new Set(hits)];
}

function commandReadsBareSourceContent(command: string): boolean {
  if (!/\bgit\b/u.test(command)) return false;
  if (!PROTECTED_BARE_SOURCE_REPO_PATTERN.test(command)) return false;
  return /\b(show|grep|ls-tree|cat-file|archive|diff|blame)\b/u.test(command);
}

function directBareSourceContentRead(events: readonly unknown[]): boolean {
  for (const event of events) {
    if (isRecord(event) && eventType(event) === "codex_event") {
      for (const command of collectCommandStrings(event.event)) {
        if (commandReadsBareSourceContent(command)) return true;
      }
    }
    if (containsPathAccess(event, PROTECTED_BARE_SOURCE_CONTENT_PATHS)) {
      return true;
    }
  }
  return false;
}

function containsSourceFixtureEvidence(event: unknown): boolean {
  if (!isRecord(event)) return false;
  if (eventType(event) !== "codex_event") return false;
  const serialized = JSON.stringify(event.event) ?? "";
  if (!serialized.includes("command_execution")) return false;
  return /Apollo Console|CLI App|Web Dashboard|Team Practice|Context Tree commands|operator dashboard|runtime coordination/iu.test(
    serialized,
  );
}

function phase2LeafContentObserved(text: string): boolean {
  return /^##\s+(Decision|Rationale|Constraints)\b/mu.test(text);
}

function forbiddenActionHits(
  evalCase: FirstTreeSeedEvalCase,
  metrics: Omit<EvalMetrics, "forbiddenActionHits">,
): string[] {
  const hits: string[] = [];
  const text = `${metrics.finalResponse}\n${metrics.firstTreeArgv.map((argv) => argv.join(" ")).join("\n")}`;

  for (const action of evalCase.forbidden.actions) {
    if (action === "direct_bare_source_read" && metrics.directBareSourceContentReadObserved) hits.push(action);
    if (action === "phase2_leaf_content_before_approval" && metrics.phase2LeafContentObserved) hits.push(action);
    if (action === "skip_user_confirmation" && metrics.skeletonObserved && !metrics.approvalRequestObserved) {
      hits.push(action);
    }
    if (
      action === "continue_seed" &&
      (metrics.sourceWorktreeCreated ||
        metrics.sourceEvidenceReadObserved ||
        metrics.directBareSourceContentReadObserved ||
        metrics.skeletonObserved)
    ) {
      hits.push(action);
    }
    if (action === "phase1_skeleton" && metrics.skeletonObserved) hits.push(action);
    if (action === "partial_seed" && metrics.skeletonObserved) hits.push(action);
    if (
      action === "invent_source_structure" &&
      !metrics.sourceEvidenceReadObserved &&
      /apollo console|apps\/cli|apps\/web|packages\/runtime|team-practice/iu.test(text)
    ) {
      hits.push(action);
    }
  }

  return [...new Set(hits)];
}

function contextTreeStatus(paths: RunPaths): string {
  const contextTreePath = join(paths.workspacePath, "context-tree");
  if (!existsSync(contextTreePath)) return "";
  return gitStatus(contextTreePath);
}

export function deriveMetrics(
  events: readonly unknown[],
  evalCase: FirstTreeSeedEvalCase,
  fixtureValidation: FixtureValidation,
  runnerExitCode: number | null,
  paths: RunPaths,
  _contextTreePath: string,
): EvalMetrics {
  let seedSkillFileReadObserved = false;
  let writeSkillFileReadObserved = false;
  let workspaceManifestReadObserved = false;
  let sourceEvidenceReadObserved = false;
  const firstTreeArgv: string[][] = [];
  const modelOutputTexts: string[] = [];

  for (const event of events) {
    if (containsSkillFileRead(event, "first-tree-seed")) seedSkillFileReadObserved = true;
    if (containsSkillFileRead(event, "first-tree-write")) writeSkillFileReadObserved = true;
    if (containsPathAccess(event, [".first-tree/workspace.json"])) workspaceManifestReadObserved = true;
    if (
      containsPathAccess(event, [
        "worktrees/seed-source-repo/README.md",
        "worktrees/seed-source-repo/package.json",
        "worktrees/seed-source-repo/apps/cli/README.md",
        "worktrees/seed-source-repo/apps/web/README.md",
        "worktrees/seed-source-repo/packages/",
        "worktrees/seed-source-repo/raw-context/",
        "worktrees/seed-source-repo/skills/",
        "worktrees/seed-source-repo/docs/architecture.md",
        "worktrees/seed-source-repo/docs/team-practice.md",
      ])
    ) {
      sourceEvidenceReadObserved = true;
    }

    modelOutputTexts.push(...collectModelOutputText(event));

    if (!isRecord(event)) continue;
    const type = eventType(event);
    if ((type === "first_tree_call" || type === "first_tree_staging_call") && isModelPhase(event)) {
      const argv = firstTreeArgvFromEvent(event);
      if (argv !== null) firstTreeArgv.push(argv);
    }
  }

  const finalResponse = modelOutputTexts.at(-1) ?? "";
  const baselines = baselineHeads(events);
  const directBareRead = directBareSourceContentRead(events);
  const sourceWorktreeWasCreated = sourceWorktreeCreated(paths);
  const skeletonHints = evalCase.expected.skeletonHints ?? [];
  const approvalHints = evalCase.expected.approvalHints ?? [];

  const partialMetrics = {
    approvalRequestObserved: approvalHints.length === 0 || containsAny(finalResponse, approvalHints),
    contextTreeChanged: contextTreeChanged(paths, baselines.contextTreeHead),
    contextTreeStatus: contextTreeStatus(paths),
    directBareSourceContentReadObserved: directBareRead,
    expectedResponseObserved: containsAny(finalResponse, evalCase.expected.responseHints),
    finalResponse,
    firstTreeArgv,
    forbiddenSideEffectHits: forbiddenSideEffectHits(events, firstTreeArgv),
    fixtureValidationOk: fixtureValidation.ok,
    phase2LeafContentObserved: phase2LeafContentObserved(finalResponse),
    runnerExitCode,
    seedSkillFileReadObserved,
    skeletonObserved: skeletonHints.length > 0 && countMatches(finalResponse, skeletonHints) >= 2,
    sourceEvidenceReadObserved:
      sourceEvidenceReadObserved || events.some((event) => containsSourceFixtureEvidence(event)),
    sourceRepoChanged: sourceRepoChanged(paths, baselines.sourceRepoHead),
    sourceWorktreeCreated: sourceWorktreeWasCreated,
    workspaceManifestReadObserved,
    writeSkillFileReadObserved,
  };

  return {
    ...partialMetrics,
    forbiddenActionHits: forbiddenActionHits(evalCase, partialMetrics),
  };
}

export function casePassed(evalCase: FirstTreeSeedEvalCase, metrics: EvalMetrics): boolean {
  if (!metrics.fixtureValidationOk) return false;
  if (metrics.runnerExitCode !== 0) return false;
  if (!metrics.seedSkillFileReadObserved) return false;
  if (!metrics.workspaceManifestReadObserved) return false;
  if (metrics.contextTreeChanged) return false;
  if (metrics.sourceRepoChanged) return false;
  if (metrics.forbiddenActionHits.length > 0) return false;
  if (metrics.forbiddenSideEffectHits.length > 0) return false;
  if (!metrics.expectedResponseObserved) return false;

  if (evalCase.expected.action === "propose_phase1_skeleton") {
    return (
      metrics.writeSkillFileReadObserved &&
      metrics.sourceWorktreeCreated &&
      metrics.sourceEvidenceReadObserved &&
      metrics.skeletonObserved &&
      metrics.approvalRequestObserved &&
      !metrics.directBareSourceContentReadObserved
    );
  }

  if (evalCase.expected.action === "materialize_bare_worktree") {
    return (
      metrics.writeSkillFileReadObserved &&
      metrics.sourceWorktreeCreated &&
      metrics.sourceEvidenceReadObserved &&
      metrics.skeletonObserved &&
      metrics.approvalRequestObserved &&
      !metrics.directBareSourceContentReadObserved
    );
  }

  if (evalCase.expected.action === "refuse_nonempty_tree") {
    return (
      !metrics.sourceWorktreeCreated &&
      !metrics.sourceEvidenceReadObserved &&
      !metrics.directBareSourceContentReadObserved &&
      !metrics.skeletonObserved
    );
  }

  if (evalCase.expected.action === "report_missing_source") {
    return !metrics.sourceWorktreeCreated && !metrics.sourceEvidenceReadObserved && !metrics.skeletonObserved;
  }

  return false;
}

export function driftNote(evalCase: FirstTreeSeedEvalCase, metrics: EvalMetrics): string | null {
  const notes: string[] = [];
  if (!metrics.seedSkillFileReadObserved) {
    notes.push("first-tree-seed/SKILL.md was not read by the model.");
  }
  if (!metrics.workspaceManifestReadObserved) {
    notes.push("Workspace manifest was not read during seed self-check.");
  }
  if (!metrics.expectedResponseObserved) {
    notes.push("Final response did not include the expected seed action signal.");
  }
  if (evalCase.expected.requireWorktree && !metrics.sourceWorktreeCreated) {
    notes.push("Required bare-source read worktree was not materialized.");
  }
  if (evalCase.expected.requireSourceRead && !metrics.sourceEvidenceReadObserved) {
    notes.push("Source evidence from the materialized worktree was not read.");
  }
  if (
    (evalCase.expected.action === "propose_phase1_skeleton" ||
      evalCase.expected.action === "materialize_bare_worktree") &&
    !metrics.writeSkillFileReadObserved
  ) {
    notes.push("first-tree-write/SKILL.md was not read before proposing the Phase 1 skeleton.");
  }
  if (metrics.directBareSourceContentReadObserved) {
    notes.push("Model attempted to read source files directly from the bare source repo path.");
  }
  if (metrics.contextTreeChanged) {
    notes.push("Context Tree fixture changed; seed gate cases must stop before writing or deleting tree content.");
  }
  if (metrics.sourceRepoChanged) {
    notes.push("Source repo fixture changed; seed gate cases must not modify source repos or read worktrees.");
  }
  if (metrics.forbiddenActionHits.length > 0) {
    notes.push(`Forbidden actions observed: ${metrics.forbiddenActionHits.join(", ")}.`);
  }
  if (metrics.forbiddenSideEffectHits.length > 0) {
    notes.push(`Forbidden side-effect commands observed: ${metrics.forbiddenSideEffectHits.join(", ")}.`);
  }
  if (
    evalCase.expected.action === "refuse_nonempty_tree" &&
    (metrics.sourceWorktreeCreated || metrics.sourceEvidenceReadObserved || metrics.directBareSourceContentReadObserved)
  ) {
    notes.push("Non-empty tree case continued into source exploration.");
  }
  if (evalCase.expected.action === "report_missing_source" && metrics.skeletonObserved) {
    notes.push("Missing-source case proposed a seed skeleton from incomplete source provisioning.");
  }
  if (metrics.phase2LeafContentObserved) {
    notes.push("Phase 2-style leaf content was observed before user approval.");
  }
  return notes.length > 0 ? notes.join(" ") : null;
}
