import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

import { runCommand } from "../../core/commands.js";
import { isRecord, isStringArray } from "../../core/events.js";
import type { RunPaths } from "../../core/types.js";
import { approvedSkeletonChatHistoryMarkdown } from "./fixture.js";
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
const SYNTHETIC_SOURCE_EVIDENCE_HINTS = [
  "Apollo Console",
  "CLI App",
  "Web Dashboard",
  "Team Practice",
  "Context Tree commands",
  "operator dashboard",
  "runtime coordination",
];
const REAL_FIRST_TREE_SOURCE_EVIDENCE_HINTS = [
  "Context-grounded agentic work for teams",
  "shared context, not isolated prompts",
  "human-agent work loop",
  "team-maintained memory of decisions",
  "first-tree-monorepo",
  "skill-evals",
];
const CHAT_HISTORY_PATH = ".first-tree-eval/chat-history.md";
const CHAT_HISTORY_EVIDENCE_HINTS = ["Skeleton proposal", "Approved"];

function sourceEvidenceHints(evalCase: FirstTreeSeedEvalCase): readonly string[] {
  return evalCase.fixture.sourceRepoState === "real-first-tree-bare-readable"
    ? REAL_FIRST_TREE_SOURCE_EVIDENCE_HINTS
    : SYNTHETIC_SOURCE_EVIDENCE_HINTS;
}

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

// Search tools whose operands are PATTERNS, not paths — a doc search with any of
// these (even one whose pattern quotes `git worktree add … seed-source-repo`)
// must not count as a worktree operation.
const WORKTREE_SEARCH_TOOLS = new Set(["grep", "egrep", "fgrep", "rg", "ripgrep", "ag", "ack"]);

// True when a single shell SEGMENT operates on the source worktree
// `seed-source-repo` as a path / `git worktree` operand — not when it merely
// mentions the name (e.g. `grep seed-source-repo AGENTS.md` or
// `rg 'worktree add .*seed-source-repo' AGENTS.md`, which search the documented
// protocol in the fixture's AGENTS.md).
function segmentTouchesSourceWorktree(segment: string): boolean {
  const trimmed = segment.trim();
  if (trimmed.length === 0) return false;
  // A sub-path UNDER the worktree (`seed-source-repo/<file>`) is a real path
  // operand for ANY program — including a search-tool read of a worktree file
  // like `rg Apollo seed-source-repo/README.md`. The trailing slash marks a
  // path, so this does NOT fire on a bare name search
  // (`grep seed-source-repo AGENTS.md`) or a quoted pattern
  // (`rg 'worktree add .*seed-source-repo' AGENTS.md`) — neither has it.
  if (/\bseed-source-repo\//u.test(trimmed)) return true;
  // A `cd` INTO the worktree directory (`cd` is never a search tool).
  if (/\bcd\s+[^\s&|;]*seed-source-repo\b/u.test(trimmed)) return true;
  // A `git worktree add|remove|move … seed-source-repo` — materialization or
  // teardown, even with no trailing slash (the relative-path evasion). Skip
  // search tools here: their quoted PATTERN could otherwise spoof this regex
  // (`rg 'worktree add .*seed-source-repo' AGENTS.md`).
  const program = (trimmed.split(/\s+/u)[0] ?? "").split("/").pop() ?? "";
  if (
    !WORKTREE_SEARCH_TOOLS.has(program) &&
    /\bworktree\s+(?:add|remove|move)\b[^\n]*\bseed-source-repo\b/u.test(trimmed)
  ) {
    return true;
  }
  return false;
}

// True when a captured command string operates on the source worktree. Split on
// shell operators first so a search sub-command's quoted pattern is not
// attributed to a neighboring real operation.
function unwrapShellCommand(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^(?:\S*\/)?(?:bash|sh|zsh)\s+-lc\s+([\s\S]+)$/u);
  if (!match?.[1]) return trimmed;
  const wrapped = match[1].trim();
  const quote = wrapped[0];
  if ((quote === '"' || quote === "'") && wrapped.at(-1) === quote) {
    return wrapped.slice(1, -1).replace(/\\(["'])/gu, "$1");
  }
  return wrapped;
}

type ShellConnector = "&&" | "||" | ";" | "|";
type ShellCommandSegment = { connectorBefore: ShellConnector | null; text: string };

// Split the command without discarding the operators that determine whether a
// segment ran. Separators inside quoted arguments are data, not shell control
// flow (for example `sed -n '1;20p'`). This is deliberately a small shell
// scanner rather than an attempted full shell parser: it recognizes the
// top-level operators the grader reasons about and treats everything else as
// opaque command text.
function shellCommandSegmentsWithConnectors(text: string): ShellCommandSegment[] {
  const command = unwrapShellCommand(text);
  const segments: ShellCommandSegment[] = [];
  let connectorBefore: ShellConnector | null = null;
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  const push = (connector: ShellConnector | null): void => {
    if (current.trim().length > 0) {
      segments.push({ connectorBefore, text: current });
      current = "";
    }
    connectorBefore = connector;
  };

  for (let index = 0; index < command.length; index++) {
    const character = command[index] ?? "";
    const next = command[index + 1] ?? "";

    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      current += character;
      escaped = true;
      continue;
    }
    if (quote !== null) {
      current += character;
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      current += character;
      continue;
    }
    if (character === "&" && next === "&") {
      push("&&");
      index++;
      continue;
    }
    if (character === "|" && next === "|") {
      push("||");
      index++;
      continue;
    }
    if (character === "|") {
      push("|");
      continue;
    }
    if (character === ";" || character === "\n") {
      push(";");
      continue;
    }
    current += character;
  }
  push(null);
  return segments;
}

function shellCommandSegments(text: string): string[] {
  return shellCommandSegmentsWithConnectors(text).map((segment) => segment.text);
}

function commandTouchesSourceWorktree(text: string): boolean {
  return shellCommandSegments(text).some((segment) => segmentTouchesSourceWorktree(segment));
}

function eventTouchesSourceWorktree(event: unknown): boolean {
  if (!isRecord(event)) return false;
  if (eventType(event) !== "codex_event") return false;
  return collectToolInputStrings(event.event).some((value) => commandTouchesSourceWorktree(value));
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

type CommandExecution = { command: string; exitCode: number | null; output: string };

function collectCommandExecutions(value: unknown): CommandExecution[] {
  if (Array.isArray(value)) return value.flatMap(collectCommandExecutions);
  if (!isRecord(value)) return [];

  const executions: CommandExecution[] = [];
  if (value.type === "command_execution" && typeof value.command === "string") {
    executions.push({
      command: value.command,
      exitCode: typeof value.exit_code === "number" ? value.exit_code : null,
      output:
        typeof value.aggregated_output === "string"
          ? value.aggregated_output
          : typeof value.stdout === "string"
            ? value.stdout
            : typeof value.output === "string"
              ? value.output
              : "",
    });
  }
  for (const item of Object.values(value)) {
    if (isRecord(item) || Array.isArray(item)) executions.push(...collectCommandExecutions(item));
  }
  return executions;
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

function sourceWorkingTreeIsPristine(repoPath: string): boolean {
  const status = runCommand("git", ["status", "--porcelain", "--untracked-files=all", "--ignored=matching"], repoPath);
  if (status.exitCode !== 0 || status.stdout.trim().length > 0) return false;

  // Lowercase tags and `S` expose assume-unchanged / skip-worktree entries
  // that can hide modified source content from ordinary status/diff checks.
  const indexFlags = runCommand("git", ["ls-files", "-v"], repoPath);
  if (indexFlags.exitCode !== 0) return false;
  return indexFlags.stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .every((line) => line.startsWith("H "));
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

function sourceWorktreeMaterializedAtExpectedHead(paths: RunPaths, baselineHead: string | null): boolean {
  if (baselineHead === null) return false;
  const worktreePath = join(paths.workspacePath, "worktrees", "seed-source-repo");
  const sourceRepoPath = join(paths.workspacePath, "source-repos", "source-repo");
  if (!existsSync(worktreePath) || !existsSync(sourceRepoPath)) return false;
  let canonicalWorkspace: string;
  let canonicalWorktree: string;
  try {
    const worktreeStat = lstatSync(worktreePath);
    if (worktreeStat.isSymbolicLink() || !worktreeStat.isDirectory()) return false;
    canonicalWorkspace = realpathSync(paths.workspacePath);
    canonicalWorktree = realpathSync(worktreePath);
  } catch {
    return false;
  }
  if (canonicalWorktree !== join(canonicalWorkspace, "worktrees", "seed-source-repo")) return false;

  const commonDir = runCommand("git", ["rev-parse", "--git-common-dir"], worktreePath);
  const topLevel = runCommand("git", ["rev-parse", "--show-toplevel"], worktreePath);
  if (!sourceWorkingTreeIsPristine(worktreePath) || commonDir.exitCode !== 0 || topLevel.exitCode !== 0) {
    return false;
  }
  const rawCommonDir = commonDir.stdout.trim();
  const resolvedCommonDir = isAbsolute(rawCommonDir) ? rawCommonDir : resolve(worktreePath, rawCommonDir);
  let canonicalCommonDir: string;
  let canonicalSourceRepo: string;
  let canonicalTopLevel: string;
  try {
    canonicalCommonDir = realpathSync(resolvedCommonDir);
    canonicalSourceRepo = realpathSync(sourceRepoPath);
    canonicalTopLevel = realpathSync(topLevel.stdout.trim());
  } catch {
    return false;
  }
  return (
    canonicalTopLevel === canonicalWorktree &&
    canonicalCommonDir === canonicalSourceRepo &&
    gitHead(worktreePath) === baselineHead
  );
}

function sourceRepoChanged(paths: RunPaths, baselineHead: string | null, evalCase: FirstTreeSeedEvalCase): boolean {
  const chatLocal = evalCase.fixture.sourceRepoState === "chat-local-readable";
  const sourceRepoPath = join(paths.workspacePath, chatLocal ? "provided-source" : "source-repos/source-repo");
  if (baselineHead === null) return existsSync(sourceRepoPath);
  if (!existsSync(sourceRepoPath)) return true;

  const currentHead = gitHead(sourceRepoPath, chatLocal ? "HEAD" : "refs/remotes/origin/main");
  if (currentHead !== baselineHead) return true;

  if (chatLocal) {
    return !sourceWorkingTreeIsPristine(sourceRepoPath);
  }

  for (const worktreePath of sourceWorktreePaths(paths)) {
    if (!sourceWorkingTreeIsPristine(worktreePath)) return true;
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

function forbiddenSideEffectHits(
  events: readonly unknown[],
  firstTreeArgv: readonly (readonly string[])[],
  evalCase: FirstTreeSeedEvalCase,
): string[] {
  const hits: string[] = [];
  // In state A (create_tree_via_init) `first-tree tree init` is the
  // EXPECTED action, not a forbidden side effect: the eval shim blocks it from
  // any real side effect, and real repo creation is still caught via
  // `gh repo create` / `git push` / `git commit` below. Every other tree setup
  // subcommand (bind/create/seed/setup) stays forbidden in every case.
  const initExpected = evalCase.expected.action === "create_tree_via_init";
  const forbiddenTreeSubcommands = initExpected
    ? ["bind", "create", "seed", "setup"]
    : ["bind", "create", "init", "seed", "setup"];
  const forbiddenTreeCommandPattern = initExpected
    ? /\bfirst-tree(?:-staging)?\s+tree\s+(bind|create|seed|setup)\b/u
    : /\bfirst-tree(?:-staging)?\s+tree\s+(bind|create|init|seed|setup)\b/u;

  for (const argv of firstTreeArgv) {
    if (argv[0] === "github") hits.push(`first-tree ${argv.join(" ")}`);
    if (argv[0] === "tree" && forbiddenTreeSubcommands.includes(argv[1] ?? "")) {
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
      if (forbiddenTreeCommandPattern.test(command)) hits.push(command);
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
        // Bind the git content-reading verb and protected bare path to the
        // same shell segment. A valid compound command may inspect the Context
        // Tree with `git ls-tree` and separately fetch the source bare clone;
        // matching across those segments is not a bare-source content read.
        // This detector intentionally uses a coarse clause split after
        // unwrapping `sh -lc`. It only needs to bind one `git` invocation's
        // content verb to its own `-C`/`--git-dir` path; quote-aware parsing is
        // counterproductive here because shell snippets such as
        // `sed 's|...|...'` can otherwise keep later `&&` clauses inside one
        // apparent segment and recreate the cross-command false positive.
        const gitClauses = unwrapShellCommand(command)
          .split(/&&|\|\||[;|\n]/u)
          .map((clause) => clause.trim())
          .filter((clause) => clause.includes("git"));
        if (gitClauses.some(commandReadsBareSourceContent)) return true;
      }
    }
    if (containsPathAccess(event, PROTECTED_BARE_SOURCE_CONTENT_PATHS)) {
      return true;
    }
  }
  return false;
}

// The unbound (state A) case must route to `first-tree tree init` with a
// `--dir` that resolves to the workspace's `context-tree` checkout. `tree init`
// otherwise defaults its clone to `<cwd>/<repo>`, so a missing/wrong `--dir` is
// exactly the regression this case guards against.
const TREE_INIT_DIR_TARGET = "context-tree";

function stripQuotes(value: string): string {
  return value.replace(/^['"]|['"]$/gu, "");
}

// Canonicalize an absolute path for equality comparison, tolerating a
// non-existent leaf. The eval shim BLOCKS real `tree init`, and the unbound
// fixture returns `<workspace>/context-tree` WITHOUT creating it, so the target
// (and any candidate aimed at it) does NOT exist on disk. A plain
// `realpathSync(path)` therefore ENOENTs and never canonicalizes the symlinked
// ROOT (macOS `/var` -> `/private/var`, `/tmp` -> `/private/tmp`), which would
// wrongly reject a VALID managed path whose parents are symlinked. Instead we
// walk up to the deepest EXISTING ancestor, `realpathSync` that, and re-append
// the remaining non-existent suffix. The workspace root itself exists in the
// fixture, so `<workspacePath>/context-tree` canonicalizes to
// `realpath(<workspacePath>) + "/context-tree"`.
function canonicalizeExistingAncestor(inputPath: string): string {
  const normalized = normalize(inputPath);
  let existing = normalized;
  const trailing: string[] = [];
  // Walk up until we hit a path that exists (or the filesystem root).
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) {
      // Reached the root without finding an existing ancestor; nothing to
      // canonicalize — fall back to the normalized string.
      return normalized;
    }
    trailing.unshift(basename(existing));
    existing = parent;
  }
  let canonical: string;
  try {
    canonical = realpathSync(existing);
  } catch {
    return normalized;
  }
  return trailing.length === 0 ? canonical : join(canonical, ...trailing);
}

// True when a captured `--dir` value resolves to the workspace-managed
// `<baseDir>/context-tree`, NOT merely shares its basename. `tree init`
// otherwise clones to `<cwd>/<repo>`. A RELATIVE `--dir` (e.g. `./context-tree`,
// `context-tree`) is resolved against `baseDir` — which the CALLER supplies as
// the captured invocation cwd, falling back to workspacePath only when no cwd
// was recorded — while an absolute `--dir` is compared outright. Both the
// candidate and the target are canonicalized (symlinked-root aware) before the
// equality check. This ACCEPTS `./context-tree` / `context-tree` / an absolute
// `<workspacePath>/context-tree`; it REJECTS `/tmp/context-tree`,
// `../context-tree`, `<other>/context-tree`, and a relative `--dir` launched
// from a cwd outside the workspace — all of which land the checkout outside the
// workspace-managed path.
function dirResolvesToWorkspaceContextTree(dirValue: string, baseDir: string, workspacePath: string): boolean {
  const cleaned = stripQuotes(dirValue).replace(/\/+$/u, "");
  if (cleaned.length === 0) return false;
  const target = join(workspacePath, TREE_INIT_DIR_TARGET);
  const candidate = isAbsolute(cleaned) ? normalize(cleaned) : resolve(baseDir, cleaned);
  if (normalize(candidate) === normalize(target)) return true;
  // Symlinked-root aware compare (macOS /var, /tmp, /private/*) that tolerates
  // the non-existent `context-tree` leaf.
  return canonicalizeExistingAncestor(candidate) === canonicalizeExistingAncestor(target);
}

// Detect a `tree init` invocation from a captured first-tree argv vector.
function argvIsTreeInit(argv: readonly string[]): boolean {
  return argv[0] === "tree" && argv[1] === "init";
}

// Extract the EFFECTIVE `--dir` value from a captured argv vector, mirroring
// Commander's parsing of `.option("--dir <path>")` so the grader sees the same
// target the real CLI would use:
//   - accept BOTH spellings: space form (`--dir <value>`) and equals form
//     (`--dir=<value>`) — else a valid `--dir=<managed>/context-tree` is wrongly
//     rejected;
//   - LAST occurrence wins (Commander overwrites a scalar option), so a later
//     outside-workspace `--dir` overrides an earlier managed one and must not
//     false-green;
//   - stop at a `--` terminator: tokens after it are positionals, not options.
// Scanning the vector is safe (unlike a raw command string): it is a single
// invocation's argv, so any option `--dir` in it belongs to this `tree init`.
function treeInitDirValueFromArgv(argv: readonly string[]): string | null {
  let dirValue: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined) continue;
    if (token === "--") break; // option terminator; the rest are positionals
    if (token === "--dir") {
      dirValue = argv[i + 1] ?? null;
      i++; // consume the value token Commander binds to --dir
    } else if (token.startsWith("--dir=")) {
      dirValue = token.slice("--dir=".length);
    }
  }
  return dirValue;
}

// Detect `tree init --dir <workspacePath>/context-tree` from a captured argv
// vector. A relative `--dir` is resolved against the invocation's captured
// `cwd` (the shim records `process.cwd()` on every `first_tree_call`) — so
// `cd /tmp && first-tree tree init --dir ./context-tree` resolves against
// `/tmp`, NOT the workspace, and is correctly rejected. When no cwd was
// captured we fall back to workspacePath.
function argvIsTreeInitWithContextTreeDir(argv: readonly string[], cwd: string | null, workspacePath: string): boolean {
  if (!argvIsTreeInit(argv)) return false;
  const dirValue = treeInitDirValueFromArgv(argv);
  return dirValue !== null && dirResolvesToWorkspaceContextTree(dirValue, cwd ?? workspacePath, workspacePath);
}

// Detect a `first-tree[-staging] tree init` invocation inside a raw command
// string captured from a real command/exec event. Reports ONLY presence — it
// deliberately does NOT parse `--dir` or credit `withContextTreeDir`.
//
// A raw command string cannot soundly bind a `--dir` token to the matched
// `tree init`: the model may chain unrelated commands
// (`first-tree tree init --title X && echo --dir <ws>/context-tree`), so a later
// `--dir` in the same string is not necessarily an option of that `tree init`;
// and the string carries no structured cwd for resolving a relative `--dir`.
// The authoritative, cwd-aware, per-invocation `--dir` signal is the shim
// `first_tree_call` argv event, which fires for EVERY real invocation with the
// exact argv vector — so `withContextTreeDir` is derived SOLELY from that
// structured path (see `deriveTreeInitObservation`). This path only backstops
// `observed` (a `tree init` was attempted).
//
// This must only ever be fed captured COMMAND strings, never free-text prose:
// a run where the model merely describes the command in its final response
// (without invoking it) must NOT satisfy the invocation signal.
function commandMentionsTreeInit(text: string): boolean {
  return /\bfirst-tree(?:-staging)?\s+tree\s+init\b/u.test(text);
}

type FirstTreeCall = { argv: readonly string[]; cwd: string | null };

type TreeInitObservation = { observed: boolean; withContextTreeDir: boolean };

// The tree-init signal is derived ONLY from captured invocation evidence — the
// shimmed `first-tree` argv+cwd vectors and the real codex exec/command-string
// events. The model's final response prose is deliberately NOT consulted here:
// describing `tree init --dir .../context-tree` without invoking it must not
// pass a gate whose whole point is to prove a real `tree init` invocation. The
// `--dir` must RESOLVE to `<workspacePath>/context-tree`, not merely share a
// basename, so a checkout aimed outside the workspace fails the gate.
function deriveTreeInitObservation(
  events: readonly unknown[],
  firstTreeCalls: readonly FirstTreeCall[],
  workspacePath: string,
): TreeInitObservation {
  let observed = false;
  let withContextTreeDir = false;

  for (const call of firstTreeCalls) {
    if (argvIsTreeInit(call.argv)) observed = true;
    if (argvIsTreeInitWithContextTreeDir(call.argv, call.cwd, workspacePath)) withContextTreeDir = true;
  }

  for (const event of events) {
    if (!isRecord(event) || eventType(event) !== "codex_event") continue;
    for (const command of collectCommandStrings(event.event)) {
      // Command strings backstop `observed` only; `withContextTreeDir` comes
      // solely from the structured argv+cwd path above (see the comment on
      // `commandMentionsTreeInit`).
      if (commandMentionsTreeInit(command)) observed = true;
    }
  }

  return { observed, withContextTreeDir };
}

function shellWords(segment: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  const push = (): void => {
    if (current.length > 0) words.push(current);
    current = "";
  };

  for (const character of segment.trim()) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/u.test(character)) {
      push();
      continue;
    }
    current += character;
  }
  push();
  return words;
}

function positionalShellArgs(segment: string, optionsWithValues: ReadonlySet<string>): string[] {
  const words = shellWords(segment).slice(1);
  const positionals: string[] = [];
  let optionsEnded = false;
  for (let index = 0; index < words.length; index++) {
    const word = words[index] ?? "";
    if (!optionsEnded && word === "--") {
      optionsEnded = true;
      continue;
    }
    if (word === "-") {
      positionals.push(word);
      continue;
    }
    if (!optionsEnded && word.startsWith("-")) {
      if (optionsWithValues.has(word)) index++;
      continue;
    }
    positionals.push(word);
  }
  return positionals;
}

function trustedContentReaderProgram(segment: string): "cat" | "head" | "tail" | null {
  // Reject shell syntax anywhere in the segment before option parsing. A token
  // such as `-<other-file` is an input redirection at execution time, but an
  // option-looking word to the lightweight parser; expansion/glob syntax has
  // the same provenance ambiguity.
  if (/[$`*?[\]{}()<>;&!~]/u.test(segment) || segment.includes("\n")) return null;
  const executable = shellWords(segment)[0] ?? "";
  const program = basename(executable);
  if (!["cat", "head", "tail"].includes(program)) return null;
  if (executable !== program && executable !== `/bin/${program}` && executable !== `/usr/bin/${program}`) return null;
  return program as "cat" | "head" | "tail";
}

// A content-reading program can be a pure stdin filter in a pipeline. It is
// attributable to the source stream only when it has no independent file
// operand; `cat source | head -50` qualifies, while
// `cat source | head context-tree/NODE.md` does not.
function segmentIsPurePipelineFilter(segment: string): boolean {
  const program = trustedContentReaderProgram(segment);
  if (program === null) return false;
  if (program === "cat") {
    return positionalShellArgs(segment, new Set()).length === 0;
  }
  if (["head", "tail"].includes(program)) {
    return positionalShellArgs(segment, new Set(["-c", "--bytes", "-n", "--lines"])).length === 0;
  }
  return false;
}

function contentReaderFileOperands(segment: string): string[] | null {
  const program = trustedContentReaderProgram(segment);
  if (program === null) return null;
  if (program === "cat") return positionalShellArgs(segment, new Set());
  if (["head", "tail"].includes(program)) {
    return positionalShellArgs(segment, new Set(["-c", "--bytes", "-n", "--lines"]));
  }
  return null;
}

function pathIsWithinRoot(value: string, root: string, workspacePath: string): boolean {
  // Grade only literal operands. Shell expansion, globbing, brace expansion,
  // redirection, and control syntax can resolve somewhere different from the
  // lexical token the grader sees, so they cannot prove file provenance.
  if (/[$`*?[\]{}()<>;&|!~]/u.test(value) || value.includes("\n")) return false;
  const candidate = resolve(workspacePath, value);
  const relativePath = relative(root, candidate);
  return (
    relativePath === "" || (!isAbsolute(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${sep}`))
  );
}

function pathBelongsToSourceEvidence(value: string, paths: RunPaths, evalCase: FirstTreeSeedEvalCase): boolean {
  const sourceRoot =
    evalCase.fixture.sourceRepoState === "chat-local-readable"
      ? join(paths.workspacePath, "provided-source")
      : join(paths.workspacePath, "worktrees", "seed-source-repo");
  if (!pathIsWithinRoot(value, sourceRoot, paths.workspacePath)) return false;
  // Parser-focused unit events do not materialize a repository. Live fixtures
  // always do; if a live source disappears, sourceRepoChanged/final-state
  // checks fail the case independently.
  if (!existsSync(sourceRoot)) return true;
  const candidate = resolve(paths.workspacePath, value);
  let canonicalRoot: string;
  let canonicalCandidate: string;
  try {
    if (lstatSync(sourceRoot).isSymbolicLink() || lstatSync(candidate).isSymbolicLink()) return false;
    canonicalRoot = realpathSync(sourceRoot);
    canonicalCandidate = realpathSync(candidate);
  } catch {
    return false;
  }
  if (!pathIsWithinRoot(canonicalCandidate, canonicalRoot, paths.workspacePath)) return false;

  const relativePath = relative(sourceRoot, candidate).split(sep).join("/");
  const tracked = runCommand("git", ["ls-files", "--error-unmatch", "--", relativePath], sourceRoot);
  const worktreeHash = runCommand("git", ["hash-object", "--no-filters", "--", relativePath], sourceRoot);
  const headHash = runCommand("git", ["rev-parse", `HEAD:${relativePath}`], sourceRoot);
  return (
    tracked.exitCode === 0 &&
    worktreeHash.exitCode === 0 &&
    headHash.exitCode === 0 &&
    worktreeHash.stdout.trim() === headHash.stdout.trim()
  );
}

function pathIsChatHistory(value: string, paths: RunPaths): boolean {
  const candidate = resolve(paths.workspacePath, value);
  if (candidate !== join(paths.workspacePath, CHAT_HISTORY_PATH)) return false;
  try {
    if (lstatSync(candidate).isSymbolicLink()) return false;
    const canonicalCandidate = realpathSync(candidate);
    const canonicalWorkspace = realpathSync(paths.workspacePath);
    return (
      canonicalCandidate === join(canonicalWorkspace, CHAT_HISTORY_PATH) &&
      readFileSync(candidate, "utf8") === approvedSkeletonChatHistoryMarkdown()
    );
  } catch {
    return false;
  }
}

function commandProvesStandaloneContentRead(
  command: string,
  exitCode: number | null,
  output: string,
  workspacePath: string,
  acceptsFileOperand: (operand: string) => boolean,
): boolean {
  if (exitCode !== 0) return false;
  const segments = shellCommandSegmentsWithConnectors(unwrapShellCommand(command));
  if (segments.length === 0) return false;
  const fileOperands: string[] = [];
  const isReader = (segment: ShellCommandSegment): boolean => {
    const operands = contentReaderFileOperands(segment.text);
    if (operands === null || operands.length === 0 || !operands.every(acceptsFileOperand)) return false;
    fileOperands.push(...operands);
    return true;
  };

  const pipeline = segments.some((segment) => segment.connectorBefore === "|");
  if (pipeline) {
    const first = segments[0];
    if (!first || first.connectorBefore !== null || !isReader(first)) return false;
    if (
      !segments.slice(1).every((segment) => {
        const program = trustedContentReaderProgram(segment.text);
        return segment.connectorBefore === "|" && program !== null && segmentIsPurePipelineFilter(segment.text);
      })
    ) {
      return false;
    }
  } else if (
    !segments.every((segment, index) => segment.connectorBefore === (index === 0 ? null : "&&") && isReader(segment))
  ) {
    return false;
  }

  // Parser-focused unit events intentionally omit a filesystem fixture. Live
  // cases always materialize these operands; there, replay the validated
  // cat/head/tail shape against the final protected files. Exact output
  // equality binds evidence to content that survived the run, so temporarily
  // replacing a source/transcript, reading fabricated hints, and restoring the
  // original cannot earn credit from the earlier command output.
  if (!fileOperands.every((operand) => existsSync(resolve(workspacePath, operand)))) return true;

  let replayed = "";
  let pipelineInput: string | undefined;
  for (const segment of segments) {
    const words = shellWords(segment.text);
    const executable = words[0];
    if (!executable || trustedContentReaderProgram(segment.text) === null) return false;
    const result = spawnSync(executable, words.slice(1), {
      cwd: workspacePath,
      encoding: "utf8",
      input: pipeline && segment.connectorBefore === "|" ? pipelineInput : undefined,
      maxBuffer: 20 * 1024 * 1024,
    });
    if (result.status !== 0 || result.error) return false;
    const stdout = result.stdout ?? "";
    if (pipeline) pipelineInput = stdout;
    else replayed += stdout;
  }
  if (pipeline) replayed = pipelineInput ?? "";
  return replayed === output;
}

function containsSourceFixtureEvidence(event: unknown, evalCase: FirstTreeSeedEvalCase, paths: RunPaths): boolean {
  if (!isRecord(event)) return false;
  if (eventType(event) !== "codex_event") return false;
  const evidenceHints = sourceEvidenceHints(evalCase);
  return collectCommandExecutions(event.event).some((execution) => {
    if (
      execution.exitCode !== 0 ||
      /(?:fatal:|invalid reference|no such file|not a git repository)/iu.test(execution.output)
    ) {
      return false;
    }
    const command = unwrapShellCommand(execution.command);
    return (
      commandProvesStandaloneContentRead(
        command,
        execution.exitCode,
        execution.output,
        paths.workspacePath,
        (operand) => pathBelongsToSourceEvidence(operand, paths, evalCase),
      ) && countMatches(execution.output, evidenceHints) >= 2
    );
  });
}

function containsChatHistoryEvidence(event: unknown, paths: RunPaths): boolean {
  if (!isRecord(event)) return false;
  if (eventType(event) !== "codex_event") return false;
  return collectCommandExecutions(event.event).some((execution) => {
    if (execution.exitCode !== 0 || /(?:no such file|not a directory|permission denied)/iu.test(execution.output)) {
      return false;
    }
    return (
      commandProvesStandaloneContentRead(
        execution.command,
        execution.exitCode,
        execution.output,
        paths.workspacePath,
        (operand) => pathIsChatHistory(operand, paths),
      ) && countMatches(execution.output, CHAT_HISTORY_EVIDENCE_HINTS) === CHAT_HISTORY_EVIDENCE_HINTS.length
    );
  });
}

function leafContentObserved(text: string): boolean {
  return /^##\s+(Decision|Rationale|Constraints)\b/mu.test(text);
}

function singlePrBuildRefusalObserved(text: string): boolean {
  return text.split(/[.!?;\n]+/u).some((segment) => {
    if (!/(?:single[- ]pr|seed\s+build|structure|lea(?:f|ves))/iu.test(segment)) return false;
    if (
      /\b(?:eval|fixture|test)\s+(?:restriction|rule)\b/iu.test(segment) &&
      /\b(?:stopp?\w*|pause\w*)\s+before\b/iu.test(segment)
    ) {
      return false;
    }
    const withoutNegatedRefusal = segment
      .replace(
        /\b(?:(?:do not|don't|will not|won't|should not|shouldn't)\s+(?:refuse|stop)|(?:is|are|was|were)\s+not\s+(?:blocked|refused|stopped)|(?:should|must|will|would|can)\s+not\s+be\s+(?:blocked|refused|stopped))\b/giu,
        "continue",
      )
      .replace(
        /\b(?:without\s+(?:an?\s+)?|with\s+no\s+)(?:intermediate\s+)?(?:stop(?:ping)?|pause|wait)(?:\s+point)?\b/giu,
        "continue",
      );
    return /\b(?:cannot|can't|won't|will not|unable|unauthoriz\w*|not\s+authoriz\w*|refus(?:e|es|ed|ing|al)|blocked|stop(?:s|ped|ping)?)\b/iu.test(
      withoutNegatedRefusal,
    );
  });
}

function singlePrBuildObserved(text: string): boolean {
  if (singlePrBuildRefusalObserved(text)) return false;
  const actionObserved =
    /\b(?:begin|build|continue|dispatch|draft|enter|move|open|proceed|route|start|write|writing)\w*\b/iu.test(text);
  const singlePrObserved =
    /\b(?:one|single)\s+(?:reviewable\s+)?(?:seed\s+)?(?:pr|pull\s+request)\b|chore\/seed-tree/iu.test(text);
  const structureAndLeavesObserved =
    /structure[\s\S]{0,240}\b(?:initial\s+)?lea(?:f|ves)\b|\b(?:initial\s+)?lea(?:f|ves)\b[\s\S]{0,240}structure/iu.test(
      text,
    );
  return actionObserved && singlePrObserved && structureAndLeavesObserved;
}

function passiveHandoffRefersToCandidatePr(localClauses: string[], passiveClauseIndex: number): boolean {
  if (passiveClauseIndex === 0 || passiveClauseIndex === 1) return true;

  let candidatePrIsCurrentReferent = true;
  let candidatePrCoreferenceObserved = false;
  for (const interveningClause of localClauses.slice(1, passiveClauseIndex)) {
    if (
      /\b(?:(?:this|that|the)\s+)?(?:(?:seed|structure|phase\s*1)\s+)?(?:pr|pull\s+request)\b/iu.test(interveningClause)
    ) {
      candidatePrIsCurrentReferent = true;
      candidatePrCoreferenceObserved = true;
      continue;
    }
    if (
      /\b(?:sub-?agent|agent)\b[^.!?;\n]{0,50}\b(?:branches?|changes?|drafts?|work)\b|\b(?:branches?|drafts?)\b/iu.test(
        interveningClause,
      )
    ) {
      candidatePrIsCurrentReferent = false;
      continue;
    }
    if (/\bit\b/iu.test(interveningClause) && candidatePrIsCurrentReferent) {
      candidatePrCoreferenceObserved = true;
    }
  }

  return candidatePrIsCurrentReferent && candidatePrCoreferenceObserved;
}

function legacyHandoffObserved(text: string): boolean {
  const affirmativeText = text
    .replace(/\b(?:rather\s+than|instead\s+of)\b[^,.;!?\n]*(?:,|(?=[.;!?\n]|$))/giu, "")
    .replace(
      /\b(?:do not|don't|will not|won't|must not|should not|never)\s+(?:open|create|submit|raise|wait|ask|require)\b[^.!?;\n]*/giu,
      "",
    )
    .replace(
      /\b(?:no|without(?:\s+an|\s+any)?)\s+(?:intermediate(?:\s+structure(?:-only)?)?|structure(?:-only)?|phase\s*1|first)\s+(?:seed\s+)?(?:pr|pull\s+request)\b[^.!?;\n]*/giu,
      "",
    )
    .replace(
      /\b(?:no|without)\s+(?:intermediate\s+)?(?:merge(?:\s+wait)?|ping|return-to-chat|handoff)\b[^.!?;\n]*/giu,
      "",
    );
  const clauses = affirmativeText
    .split(/[.!?;\n]+/u)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
  return clauses.some((clause, index) => {
    const structurePrObserved =
      /\b(?:intermediate(?:\s+structure(?:-only)?)?|structure(?:-only)?|phase\s*1|first)\s+(?:seed\s+)?(?:pr|pull\s+request)\b/iu.test(
        clause,
      ) ||
      /\b(?:seed\s+)?(?:pr|pull\s+request)\b[\s\S]{0,80}\b(?:with|for|containing|covering)\b[\s\S]{0,50}\b(?:structure|skeleton|phase\s*1)\b/iu.test(
        clause,
      );
    if (!structurePrObserved) return false;

    const localClauses = clauses.slice(index, index + 4);
    const handoffContext = localClauses.join(". ");
    const explicitHandoffMatch =
      /(?:\b(?:it|(?:(?:this|that|the)\s+)?(?:(?:seed|structure|phase\s*1)\s+)?(?:pr|pull\s+request))\b\s+(?:(?:(?:has|have|had)\s+been|will\s+be|is|gets|was|has|have|had)\s+)?(?:merge\w*|land(?:s|ed|ing)?)\b)|(?:\b(?:merge\w*|land(?:s|ed|ing)?)\b\s+(?:it|(?:(?:this|that|the)\s+)?(?:(?:seed|structure|phase\s*1)\s+)?(?:pr|pull\s+request))\b)/iu.exec(
        handoffContext,
      );
    let handoffIndex = explicitHandoffMatch?.index ?? Number.POSITIVE_INFINITY;
    let handoffLength = explicitHandoffMatch?.[0].length ?? 0;
    for (const localIndex of [0, 1, 2]) {
      const passiveClause = localClauses[localIndex];
      if (!passiveClause) continue;
      const passiveMatch = /\b(?:once|after|when)\s+merged\b/iu.exec(passiveClause);
      if (!passiveMatch) continue;
      const isBoundToCandidate =
        localIndex === 0 || (passiveMatch.index === 0 && passiveHandoffRefersToCandidatePr(localClauses, localIndex));
      if (!isBoundToCandidate) continue;
      const prefixLength = localClauses.slice(0, localIndex).join(". ").length + (localIndex > 0 ? 2 : 0);
      const passiveIndex = prefixLength + passiveMatch.index;
      if (passiveIndex >= handoffIndex) continue;
      handoffIndex = passiveIndex;
      handoffLength = passiveMatch[0].length;
    }
    if (!Number.isFinite(handoffIndex)) return false;
    const beforeHandoff = handoffContext.slice(0, handoffIndex);
    const samePrIncludesLeaves =
      /\b(?:pr|pull\s+request)\b[\s\S]{0,100}\b(?:with|for|containing|covering)\b[\s\S]{0,80}\b(?:structure|skeleton)\b[\s\S]{0,50}\b(?:and|plus|alongside|together\s+with)\b[\s\S]{0,50}\b(?:content|lea(?:f|ves))\b/iu.test(
        beforeHandoff,
      ) ||
      /\b(?:it|this\s+(?:seed\s+)?(?:pr|pull\s+request)|that\s+(?:seed\s+)?(?:pr|pull\s+request)|the\s+same\s+(?:seed\s+)?(?:pr|pull\s+request))\b[\s\S]{0,80}\b(?:contain\w*|includ\w*|cover\w*|carr\w*|hold\w*)\b[\s\S]{0,50}\b(?:content|lea(?:f|ves))\b/iu.test(
        beforeHandoff,
      ) ||
      /\b(?:content|lea(?:f|ves))\b[\s\S]{0,60}\b(?:to|in|into|on)\b[\s\S]{0,40}\b(?:it|this\s+(?:seed\s+)?(?:pr|pull\s+request)|that\s+same\s+(?:seed\s+)?(?:pr|pull\s+request)|the\s+same\s+(?:seed\s+)?(?:pr|pull\s+request))\b/iu.test(
        beforeHandoff,
      );
    if (samePrIncludesLeaves) return false;

    const afterHandoff = handoffContext.slice(handoffIndex + handoffLength);
    if (/\b(?:return|reply|ping|come\s+back|continue)\b/iu.test(afterHandoff)) return true;
    if (/\b(?:lea(?:f|ves)|phase\s*2)\b/iu.test(afterHandoff)) return true;
    if (!/\bcontent\b/iu.test(afterHandoff)) return false;
    return !/\b(?:first-tree-write|future|follow-up|subsequent|later\s+source-backed)\b/iu.test(afterHandoff);
  });
}

function githubAppRequirementObserved(text: string): boolean {
  return text.split(/[.!?;\n]+/u).some((segment) => {
    if (!/github app/iu.test(segment)) return false;
    if (
      /\b(?:do not|don't|does not|doesn't|did not|didn't)\s+(?:need|require|install|connect)\b/iu.test(segment) ||
      /\b(?:no\s+need\s+to|need\s+not)\s+(?:install|connect|require)\b/iu.test(segment) ||
      /\bwithout\s+(?:needing|requiring|installing|connecting)\b/iu.test(segment) ||
      /\bno\s+github app\s+(?:is\s+)?(?:needed|required)\b/iu.test(segment) ||
      /\bgithub app\s+(?:is\s+)?not\s+(?:needed|required)\b/iu.test(segment)
    ) {
      return false;
    }
    return /\b(?:connect|install|need|require|settings)\w*\b|\bmust\b/iu.test(segment);
  });
}

function skeletonRestartObserved(text: string): boolean {
  return text.split(/[.!?;\n]+/u).some((segment) => {
    if (!/skeleton/iu.test(segment)) return false;
    if (
      /\bwithout\s+(?:restarting|repeating|redoing|re-proposing)\b/iu.test(segment) ||
      /\b(?:do not|don't|will not|won't|should not|shouldn't)\s+(?:restart|repeat|redo|re-propose)\b/iu.test(segment) ||
      /\bno\s+skeleton\s+(?:restart|repeat|redo|re-proposal)\b/iu.test(segment)
    ) {
      return false;
    }
    return /\b(?:restart|repeat|redo|re-propos)\w*\b|\b(?:propos|approval|confirm)\w*\b[^.]{0,40}\bagain\b/iu.test(
      segment,
    );
  });
}

function forbiddenActionHits(
  evalCase: FirstTreeSeedEvalCase,
  metrics: Omit<EvalMetrics, "forbiddenActionHits">,
): string[] {
  const hits: string[] = [];
  const text = `${metrics.finalResponse}\n${metrics.firstTreeArgv.map((argv) => argv.join(" ")).join("\n")}`;

  for (const action of evalCase.forbidden.actions) {
    if (action === "direct_bare_source_read" && metrics.directBareSourceContentReadObserved) hits.push(action);
    if (action === "content_before_confirmation" && metrics.leafContentObserved) hits.push(action);
    if (action === "legacy_two_pr_handoff" && metrics.legacyHandoffObserved) hits.push(action);
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
    if (action === "skeleton_proposal" && metrics.skeletonObserved) hits.push(action);
    if (action === "partial_seed" && metrics.skeletonObserved) hits.push(action);
    if (action === "require_github_app" && metrics.githubAppRequirementObserved) {
      hits.push(action);
    }
    if (action === "refuse_nonempty_tree" && metrics.singlePrBuildRefusalObserved) hits.push(action);
    if (action === "build_single_pr" && metrics.singlePrBuildObserved) hits.push(action);
    if (action === "restart_skeleton_proposal" && skeletonRestartObserved(text)) {
      hits.push(action);
    }
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
  let chatHistoryReadObserved = false;
  let seedSkillFileReadObserved = false;
  let writeSkillFileReadObserved = false;
  let workspaceManifestReadObserved = false;
  let sourceWorktreeAccessObserved = false;
  const firstTreeArgv: string[][] = [];
  const firstTreeCalls: FirstTreeCall[] = [];
  const modelOutputTexts: string[] = [];

  for (const event of events) {
    if (containsSkillFileRead(event, "first-tree-seed")) seedSkillFileReadObserved = true;
    if (containsSkillFileRead(event, "first-tree-write")) writeSkillFileReadObserved = true;
    if (containsPathAccess(event, [".first-tree/workspace.json"])) workspaceManifestReadObserved = true;
    if (containsChatHistoryEvidence(event, paths)) chatHistoryReadObserved = true;
    // Any operation ON the source worktree (`git worktree add/remove`, reading a
    // `seed-source-repo/...` path, `cd` into it) — an event-level signal that
    // survives a later `git worktree remove`, so an add/read/cleanup
    // cannot pass the state check by leaving the final filesystem clean. Detected
    // structurally (see `commandTouchesSourceWorktree`) so both full-path and
    // `cd worktrees && … seed-source-repo …` relative forms are caught, while a
    // mere name search of the docs (`grep seed-source-repo AGENTS.md`) and the
    // bare clone `source-repos/source-repo` are NOT treated as access.
    if (eventTouchesSourceWorktree(event)) {
      sourceWorktreeAccessObserved = true;
    }
    modelOutputTexts.push(...collectModelOutputText(event));

    if (!isRecord(event)) continue;
    const type = eventType(event);
    if ((type === "first_tree_call" || type === "first_tree_staging_call") && isModelPhase(event)) {
      const argv = firstTreeArgvFromEvent(event);
      if (argv !== null) {
        firstTreeArgv.push(argv);
        // The shim records the invocation cwd (`process.cwd()`) alongside argv;
        // keep it so a relative `--dir` resolves against the real launch cwd.
        const cwd = typeof event.cwd === "string" ? event.cwd : null;
        firstTreeCalls.push({ argv, cwd });
      }
    }
  }

  const finalResponse = modelOutputTexts.at(-1) ?? "";
  const baselines = baselineHeads(events);
  const directBareRead = directBareSourceContentRead(events);
  const sourceWorktreeWasCreated = sourceWorktreeCreated(paths);
  const sourceWorktreeIsMaterialized = sourceWorktreeMaterializedAtExpectedHead(paths, baselines.sourceRepoHead);
  const skeletonHints = evalCase.expected.skeletonHints ?? [];
  const approvalHints = evalCase.expected.approvalHints ?? [];
  const treeInit = deriveTreeInitObservation(events, firstTreeCalls, paths.workspacePath);

  const partialMetrics = {
    approvalRequestObserved: approvalHints.length === 0 || containsAny(finalResponse, approvalHints),
    chatHistoryReadObserved,
    contextTreeChanged: contextTreeChanged(paths, baselines.contextTreeHead),
    contextTreeStatus: contextTreeStatus(paths),
    directBareSourceContentReadObserved: directBareRead,
    expectedResponseObserved: containsAny(finalResponse, evalCase.expected.responseHints),
    finalResponse,
    firstTreeArgv,
    forbiddenSideEffectHits: forbiddenSideEffectHits(events, firstTreeArgv, evalCase),
    fixtureValidationOk: fixtureValidation.ok,
    githubAppRequirementObserved: githubAppRequirementObserved(finalResponse),
    legacyHandoffObserved: legacyHandoffObserved(finalResponse),
    singlePrBuildObserved: singlePrBuildObserved(finalResponse),
    leafContentObserved: leafContentObserved(finalResponse),
    singlePrBuildRefusalObserved: singlePrBuildRefusalObserved(finalResponse),
    runnerExitCode,
    seedSkillFileReadObserved,
    skeletonObserved: skeletonHints.length > 0 && countMatches(finalResponse, skeletonHints) >= 2,
    sourceEvidenceReadObserved: events.some((event) => containsSourceFixtureEvidence(event, evalCase, paths)),
    sourceRepoChanged: sourceRepoChanged(paths, baselines.sourceRepoHead, evalCase),
    sourceWorktreeAccessObserved,
    sourceWorktreeCreated: sourceWorktreeWasCreated,
    // Command text cannot prove which executable or Git subcommand actually
    // ran. Credit materialization only from the final clean managed worktree,
    // at the expected source HEAD, whose git-common-dir is the declared bare
    // clone. Eval prompts that require a worktree therefore leave it in place.
    sourceWorktreeMaterializedObserved: sourceWorktreeIsMaterialized,
    treeInitObserved: treeInit.observed,
    treeInitWithContextTreeDirObserved: treeInit.withContextTreeDir,
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
  if (evalCase.expected.requireChatHistoryRead && !metrics.chatHistoryReadObserved) return false;
  if (metrics.contextTreeChanged) return false;
  if (metrics.sourceRepoChanged) return false;
  if (metrics.forbiddenActionHits.length > 0) return false;
  if (metrics.forbiddenSideEffectHits.length > 0) return false;
  if (!metrics.expectedResponseObserved) return false;

  if (evalCase.expected.action === "propose_skeleton") {
    return (
      (evalCase.expected.requireWorktree
        ? metrics.sourceWorktreeMaterializedObserved
        : !metrics.sourceWorktreeCreated && !metrics.sourceWorktreeAccessObserved) &&
      metrics.sourceEvidenceReadObserved &&
      metrics.skeletonObserved &&
      metrics.approvalRequestObserved &&
      !metrics.directBareSourceContentReadObserved
    );
  }

  if (evalCase.expected.action === "materialize_bare_worktree") {
    return (
      metrics.sourceWorktreeMaterializedObserved &&
      metrics.sourceEvidenceReadObserved &&
      metrics.skeletonObserved &&
      metrics.approvalRequestObserved &&
      !metrics.directBareSourceContentReadObserved
    );
  }

  if (evalCase.expected.action === "refuse_nonempty_tree") {
    return (
      !metrics.sourceWorktreeCreated &&
      !metrics.sourceWorktreeAccessObserved &&
      !metrics.sourceEvidenceReadObserved &&
      !metrics.directBareSourceContentReadObserved &&
      !metrics.skeletonObserved
    );
  }

  if (evalCase.expected.action === "report_missing_source") {
    return (
      !metrics.sourceWorktreeCreated &&
      !metrics.sourceWorktreeAccessObserved &&
      !metrics.sourceEvidenceReadObserved &&
      !metrics.skeletonObserved
    );
  }

  if (evalCase.expected.action === "create_tree_via_init") {
    // PASS only when the state check routes to `tree init` WITH a `--dir` resolving to
    // the workspace `context-tree`. `tree init` without that `--dir` (or with a
    // default/wrong dir) leaves `treeInitWithContextTreeDirObserved` false and
    // fails — that omission is the regression this case guards.
    //
    // The state check's real invariant is the `tree init --dir <managed>` routing above.
    // Going past the state check into source exploration still fails, via three
    // signals: materializing a source worktree (`sourceWorktreeCreated`, final
    // filesystem), TOUCHING a source worktree at all (`sourceWorktreeAccessObserved`,
    // event-level — so an add/read/`git worktree remove` sequence cannot pass by
    // leaving the filesystem clean), and reading the bare source clone directly.
    // We deliberately do NOT fail on `sourceEvidenceReadObserved` alone: a model
    // creating the tree may incidentally glance at a source file (e.g. to derive
    // the team name for `--title`) WITHOUT touching a worktree, and hard-failing
    // that made this gate ~1/3 model-flaky (2026-07, liuchao approved relaxing
    // it) while the `--dir` routing — the thing this case exists to prove — was
    // correct every time. This is where state A intentionally diverges from the
    // stricter report_missing_source sibling (a pure refuse case, where any
    // source read is off-contract).
    return (
      metrics.treeInitWithContextTreeDirObserved &&
      !metrics.directBareSourceContentReadObserved &&
      !metrics.sourceWorktreeCreated &&
      !metrics.sourceWorktreeAccessObserved
    );
  }

  if (evalCase.expected.action === "build_single_pr") {
    return (
      metrics.sourceWorktreeMaterializedObserved &&
      metrics.sourceEvidenceReadObserved &&
      metrics.singlePrBuildObserved &&
      !metrics.singlePrBuildRefusalObserved &&
      !metrics.legacyHandoffObserved &&
      !metrics.directBareSourceContentReadObserved
    );
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
  if (evalCase.expected.requireChatHistoryRead && !metrics.chatHistoryReadObserved) {
    notes.push("Required visible prior-turn transcript was not read.");
  }
  if (!metrics.expectedResponseObserved) {
    notes.push("Final response did not include the expected seed action signal.");
  }
  if (evalCase.expected.requireWorktree && !metrics.sourceWorktreeMaterializedObserved) {
    notes.push("Required bare-source read worktree was not materialized.");
  }
  if (evalCase.expected.requireSourceRead && !metrics.sourceEvidenceReadObserved) {
    notes.push("Source evidence from the materialized worktree was not read.");
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
  if (evalCase.expected.action === "create_tree_via_init") {
    if (!metrics.treeInitObserved) {
      notes.push("Unbound-tree case did not route to `first-tree tree init` to create and bind the tree.");
    } else if (!metrics.treeInitWithContextTreeDirObserved) {
      notes.push(
        "Unbound-tree case ran `first-tree tree init` without a `--dir` resolving to the workspace `context-tree` checkout; the created clone would land in the wrong directory and the seed build would read a missing/stale tree.",
      );
    }
  }
  if (metrics.leafContentObserved && evalCase.expected.action !== "build_single_pr") {
    notes.push("Leaf content was observed before user confirmation.");
  }
  if (evalCase.expected.action === "build_single_pr" && !metrics.singlePrBuildObserved) {
    notes.push("Approved same-chat setup did not route into the single-PR structure-and-leaves build.");
  }
  if (metrics.singlePrBuildRefusalObserved) {
    notes.push("Model refused the verified same-chat single-PR seed build.");
  }
  if (metrics.legacyHandoffObserved) {
    notes.push("Model reintroduced an intermediate PR merge/wait/return handoff into the single-PR seed build.");
  }
  return notes.length > 0 ? notes.join(" ") : null;
}
