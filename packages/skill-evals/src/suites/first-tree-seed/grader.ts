import { existsSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";

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
function commandTouchesSourceWorktree(text: string): boolean {
  return text.split(/&&|\|\||[;|\n]/u).some((segment) => segmentTouchesSourceWorktree(segment));
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

function forbiddenSideEffectHits(
  events: readonly unknown[],
  firstTreeArgv: readonly (readonly string[])[],
  evalCase: FirstTreeSeedEvalCase,
): string[] {
  const hits: string[] = [];
  // In Step 0 state A (create_tree_via_init) `first-tree tree init` is the
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
        if (commandReadsBareSourceContent(command)) return true;
      }
    }
    if (containsPathAccess(event, PROTECTED_BARE_SOURCE_CONTENT_PATHS)) {
      return true;
    }
  }
  return false;
}

// The unbound (Step 0 state A) case must route to `first-tree tree init` with a
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
  let sourceWorktreeAccessObserved = false;
  const firstTreeArgv: string[][] = [];
  const firstTreeCalls: FirstTreeCall[] = [];
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
    // Any operation ON the source worktree (`git worktree add/remove`, reading a
    // `seed-source-repo/...` path, `cd` into it) — an event-level signal that
    // survives a later `git worktree remove`, so a Phase-1 add/read/cleanup
    // cannot pass Step 0 by leaving the final filesystem clean. Detected
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
  const skeletonHints = evalCase.expected.skeletonHints ?? [];
  const approvalHints = evalCase.expected.approvalHints ?? [];
  const treeInit = deriveTreeInitObservation(events, firstTreeCalls, paths.workspacePath);

  const partialMetrics = {
    approvalRequestObserved: approvalHints.length === 0 || containsAny(finalResponse, approvalHints),
    contextTreeChanged: contextTreeChanged(paths, baselines.contextTreeHead),
    contextTreeStatus: contextTreeStatus(paths),
    directBareSourceContentReadObserved: directBareRead,
    expectedResponseObserved: containsAny(finalResponse, evalCase.expected.responseHints),
    finalResponse,
    firstTreeArgv,
    forbiddenSideEffectHits: forbiddenSideEffectHits(events, firstTreeArgv, evalCase),
    fixtureValidationOk: fixtureValidation.ok,
    phase2LeafContentObserved: phase2LeafContentObserved(finalResponse),
    runnerExitCode,
    seedSkillFileReadObserved,
    skeletonObserved: skeletonHints.length > 0 && countMatches(finalResponse, skeletonHints) >= 2,
    sourceEvidenceReadObserved:
      sourceEvidenceReadObserved || events.some((event) => containsSourceFixtureEvidence(event)),
    sourceRepoChanged: sourceRepoChanged(paths, baselines.sourceRepoHead),
    sourceWorktreeAccessObserved,
    sourceWorktreeCreated: sourceWorktreeWasCreated,
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
    // PASS only when Step 0 routes to `tree init` WITH a `--dir` resolving to
    // the workspace `context-tree`. `tree init` without that `--dir` (or with a
    // default/wrong dir) leaves `treeInitWithContextTreeDirObserved` false and
    // fails — that omission is the regression this case guards.
    //
    // Step 0's real invariant is the `tree init --dir <managed>` routing above.
    // Going past Step 0 into Phase 1 source exploration still fails, via three
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
  if (evalCase.expected.action === "create_tree_via_init") {
    if (!metrics.treeInitObserved) {
      notes.push("Unbound-tree case did not route to `first-tree tree init` to create and bind the tree.");
    } else if (!metrics.treeInitWithContextTreeDirObserved) {
      notes.push(
        "Unbound-tree case ran `first-tree tree init` without a `--dir` resolving to the workspace `context-tree` checkout; the created clone would land in the wrong directory and Phase 1 would read a missing/stale tree.",
      );
    }
  }
  if (metrics.phase2LeafContentObserved) {
    notes.push("Phase 2-style leaf content was observed before user approval.");
  }
  return notes.length > 0 ? notes.join(" ") : null;
}
