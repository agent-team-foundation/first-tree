import { resolve } from "node:path";

import { isRecord, isStringArray } from "../../core/events.js";
import type {
  ContextTreeReviewEvalCase,
  EvalMetrics,
  ReviewEvent,
  ReviewFixtureExpectation,
  ReviewFixtureIntegrity,
  ViewEvent,
} from "./types.js";

function skillRead(event: unknown, expectation: ReviewFixtureExpectation): boolean {
  return observedReadPaths(event, expectation, true).includes(".agents/skills/context-tree-review/SKILL.md");
}

function firstTreeReadSkillRead(event: unknown, expectation: ReviewFixtureExpectation): boolean {
  return observedReadPaths(event, expectation).includes(".agents/skills/first-tree-read/SKILL.md");
}

function commandFromCodexEvent(event: unknown): string | null {
  if (!isRecord(event) || event.type !== "codex_event" || !isRecord(event.event)) return null;
  const item = event.event.item;
  if (!isRecord(item) || item.type !== "command_execution" || typeof item.command !== "string") return null;
  return item.command;
}

function eventOrder(event: unknown, fallbackIndex: number): number {
  if (isRecord(event) && typeof event.timestamp === "string") {
    const timestamp = Date.parse(event.timestamp);
    if (!Number.isNaN(timestamp)) return timestamp;
  }
  return fallbackIndex;
}

function shellStructure(command: string): { operators: string[]; segments: string[] } {
  let source = command.trim().replace(/^\/?(?:usr\/)?bin\/(?:ba)?sh\s+-lc\s+/u, "");
  const outerQuote = source[0];
  if ((outerQuote === '"' || outerQuote === "'") && source.at(-1) === outerQuote) {
    source = source.slice(1, -1);
    if (outerQuote === '"') source = source.replace(/\\"/gu, '"');
  }

  const segments: string[] = [];
  const operators: string[] = [];
  let current = "";
  let quote: '"' | "'" | "`" | null = null;
  let escaped = false;
  const finish = () => {
    const segment = current
      .trim()
      .replace(/^(?:then|else|do)\s+/u, "")
      .trim();
    if (segment) segments.push(segment);
    current = "";
  };

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? "";
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
    if (quote) {
      current += character;
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      current += character;
      continue;
    }
    if (character === "\n" || character === ";" || character === "|") {
      finish();
      if (character === "|" && source[index + 1] === "|") {
        operators.push("||");
        index += 1;
      } else {
        operators.push(character);
      }
      continue;
    }
    if (character === "&" && source[index + 1] === "&") {
      finish();
      operators.push("&&");
      index += 1;
      continue;
    }
    current += character;
  }
  finish();
  return { operators, segments };
}

function shellSegments(command: string): string[] {
  return shellStructure(command).segments;
}

function shellWords(segment: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;
  const finish = () => {
    if (current) words.push(current);
    current = "";
  };
  for (const character of segment) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/u.test(character)) finish();
    else current += character;
  }
  finish();
  return words;
}

function gitInvocation(segment: string): { args: string[]; command: string } | null {
  const words = shellWords(segment);
  if (words[0] !== "git") return null;
  let index = 1;
  if (words[index] === "-C") index += 2;
  const command = words[index];
  return command ? { args: words.slice(index + 1), command } : null;
}

function gitWorkingDirectory(segment: string): string | null {
  const words = shellWords(segment);
  return words[0] === "git" && words[1] === "-C" && typeof words[2] === "string" ? words[2] : null;
}

function hasUnquotedRedirection(segment: string): boolean {
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (const character of segment) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "<" || character === ">") return true;
  }
  return false;
}

function outputRedirectionTargets(segment: string): string[] {
  const targets: string[] = [];
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let index = 0; index < segment.length; index += 1) {
    const character = segment[index] ?? "";
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character !== ">") continue;
    if (segment[index + 1] === ">") index += 1;
    let cursor = index + 1;
    while (/\s/u.test(segment[cursor] ?? "")) cursor += 1;
    if (segment[cursor] === "&") continue;
    const targetQuote = segment[cursor] === '"' || segment[cursor] === "'" ? segment[cursor] : null;
    if (targetQuote) cursor += 1;
    const start = cursor;
    while (cursor < segment.length) {
      const targetCharacter = segment[cursor] ?? "";
      if (targetQuote ? targetCharacter === targetQuote : /[\s;|&<>]/u.test(targetCharacter)) break;
      cursor += 1;
    }
    if (cursor > start) targets.push(segment.slice(start, cursor));
    index = cursor;
  }
  return targets;
}

function substitutionsAllowed(segment: string): boolean {
  if (/(?:<|>)\([^)]*\)/u.test(segment)) return false;
  const allowed = (inner: string) => {
    const stages = shellSegments(inner);
    return stages.length === 1 && readOnlyGitRevParse(stages[0] ?? "");
  };
  const dollarSubstitutions = [...segment.matchAll(/\$\(([^()]*)\)/gu)];
  if (dollarSubstitutions.some((match) => !allowed(match[1] ?? ""))) return false;
  if (segment.replace(/\$\([^()]*\)/gu, "").includes("$(")) return false;

  const backtickSubstitutions = [...segment.matchAll(/`([^`]*)`/gu)];
  return backtickSubstitutions.every((match) => allowed(match[1] ?? ""));
}

function gitSubcommands(segment: string): string[] {
  const command = gitInvocation(segment)?.command;
  return command ? [command] : [];
}

function readOnlyGitConfig(segment: string): boolean {
  if (hasUnquotedRedirection(segment)) return false;
  const invocation = gitInvocation(segment);
  if (invocation?.command !== "config") return false;
  const args = invocation.args.filter((arg) => arg !== "--local" && arg !== "--show-origin");
  if (args.length === 1 && !args[0]?.startsWith("-")) return true;
  const actionIndex = args.findIndex((arg) => ["--list", "--get", "--get-all", "--get-regexp"].includes(arg));
  if (actionIndex < 0 || args.some((arg, index) => arg.startsWith("-") && index !== actionIndex)) return false;
  const action = args[actionIndex];
  const positionals = args.filter((_, index) => index !== actionIndex);
  return action === "--list" ? positionals.length === 0 : positionals.length >= 1 && positionals.length <= 2;
}

function readOnlyGitRemote(segment: string): boolean {
  if (hasUnquotedRedirection(segment)) return false;
  const invocation = gitInvocation(segment);
  if (invocation?.command !== "remote") return false;
  const args = invocation.args;
  if (args.length === 0 || (args.length === 1 && args[0] === "-v")) return true;
  if (args.length === 2 && args[0] === "show") return true;
  return (
    (args.length === 2 && args[0] === "get-url") || (args.length === 3 && args[0] === "get-url" && args[1] === "--all")
  );
}

function readOnlyGitRevParse(segment: string): boolean {
  if (hasUnquotedRedirection(segment)) return false;
  const invocation = gitInvocation(segment);
  if (invocation?.command !== "rev-parse" || invocation.args.length !== 1) return false;
  const target = invocation.args[0] ?? "";
  return (
    ["HEAD", "FETCH_HEAD", "--show-toplevel", "--is-inside-work-tree", "--git-dir"].includes(target) ||
    /^[0-9a-f]{7,40}$/iu.test(target) ||
    /^refs\/[a-z0-9._/-]+$/iu.test(target)
  );
}

function reviewRefNames(expectation: ReviewFixtureExpectation): string[] {
  return [`refs/review/pr-${expectation.prNumber}`, `refs/review/pr-${expectation.prNumber}-head`];
}

function readOnlyGitFetch(segment: string, expectation: ReviewFixtureExpectation): boolean {
  if (hasUnquotedRedirection(segment)) return false;
  const invocation = gitInvocation(segment);
  if (invocation?.command !== "fetch" || invocation.args.length < 2 || invocation.args[0] !== "origin") return false;
  const pullRef = `refs/pull/${expectation.prNumber}/head`;
  const allowed = new Set([
    "main",
    "refs/heads/main",
    expectation.sourceBranch,
    `refs/heads/${expectation.sourceBranch}`,
    "main:refs/remotes/origin/main",
    "refs/heads/main:refs/remotes/origin/main",
    `refs/heads/${expectation.sourceBranch}:refs/remotes/origin/${expectation.sourceBranch}`,
    pullRef,
    ...reviewRefNames(expectation).map((destination) => `${pullRef}:${destination}`),
  ]);
  const refs = invocation.args.slice(1);
  return refs.every((arg) => allowed.has(arg)) && refs.some((arg) => arg === pullRef || arg.startsWith(`${pullRef}:`));
}

function readOnlyGitStatus(segment: string): boolean {
  if (hasUnquotedRedirection(segment)) return false;
  const invocation = gitInvocation(segment);
  return (
    invocation?.command === "status" &&
    invocation.args.every((arg) => ["--branch", "--porcelain", "--short"].includes(arg))
  );
}

function readOnlyGitSymbolicRef(segment: string): boolean {
  if (hasUnquotedRedirection(segment)) return false;
  const invocation = gitInvocation(segment);
  return (
    invocation?.command === "symbolic-ref" &&
    (invocation.args.length === 1
      ? invocation.args[0] === "HEAD"
      : invocation.args.length === 2 && invocation.args[0] === "--short" && invocation.args[1] === "HEAD")
  );
}

function readOnlyGitBranch(segment: string): boolean {
  if (hasUnquotedRedirection(segment)) return false;
  const invocation = gitInvocation(segment);
  return (
    invocation?.command === "branch" &&
    ((invocation.args.length === 2 && invocation.args[0] === "-a" && invocation.args[1] === "-vv") ||
      (invocation.args.length === 1 && invocation.args[0] === "--show-current"))
  );
}

function reviewWorktreePathAllowed(path: string, expectation: ReviewFixtureExpectation): boolean {
  const relative = `.review-worktrees/${expectation.prNumber}`;
  return [relative, `../${relative}`, `$PWD/${relative}`, resolve(expectation.workspacePath, relative)].includes(path);
}

function repairWorktreePathAllowed(path: string, expectation: ReviewFixtureExpectation): boolean {
  const relative = `.repair-worktrees/${expectation.prNumber}`;
  return [
    relative,
    `../${relative}`,
    `$PWD/${relative}`,
    resolve(expectation.workspacePath, relative),
    expectation.repairWorktreePath,
  ].includes(path);
}

function readOnlyGitWorktree(segment: string, expectation: ReviewFixtureExpectation): boolean {
  if (hasUnquotedRedirection(segment)) return false;
  const invocation = gitInvocation(segment);
  if (invocation?.command !== "worktree") return false;
  const args = invocation.args;
  if (args.length === 1 && args[0] === "list") return true;
  if (args.length === 2 && args[0] === "list" && args[1] === "--porcelain") return true;
  if (args.length === 2 && args[0] === "remove") return reviewWorktreePathAllowed(args[1] ?? "", expectation);
  return (
    args.length === 4 &&
    args[0] === "add" &&
    args[1] === "--detach" &&
    reviewWorktreePathAllowed(args[2] ?? "", expectation) &&
    [expectation.headOid, ...reviewRefNames(expectation)].includes(args[3] ?? "")
  );
}

function allowedGitWorktreeMutation(segment: string, expectation: ReviewFixtureExpectation): boolean {
  if (hasUnquotedRedirection(segment)) return false;
  const invocation = gitInvocation(segment);
  if (invocation?.command !== "worktree") return false;
  const args = invocation.args;
  if (args.length === 2 && args[0] === "remove") {
    return (
      reviewWorktreePathAllowed(args[1] ?? "", expectation) || repairWorktreePathAllowed(args[1] ?? "", expectation)
    );
  }
  if (
    args.length === 4 &&
    args[0] === "add" &&
    args[1] === "--detach" &&
    reviewWorktreePathAllowed(args[2] ?? "", expectation)
  ) {
    return (
      [expectation.headOid, "FETCH_HEAD", ...reviewRefNames(expectation)].includes(args[3] ?? "") ||
      /^[0-9a-f]{40}$/iu.test(args[3] ?? "")
    );
  }
  return (
    expectation.repair !== "none" &&
    args.length === 3 &&
    args[0] === "add" &&
    repairWorktreePathAllowed(args[1] ?? "", expectation) &&
    args[2] === expectation.sourceBranch
  );
}

function readOnlyGitChangedPaths(segment: string): boolean {
  if (hasUnquotedRedirection(segment)) return false;
  const invocation = gitInvocation(segment);
  return (
    invocation?.command === "diff" &&
    invocation.args.length === 2 &&
    ["--name-only", "--name-status"].includes(invocation.args[0] ?? "") &&
    !invocation.args[1]?.startsWith("-")
  );
}

function safeReaderPath(path: string, workspacePath: string): boolean {
  const resolvedPath = resolve(workspacePath, path);
  return [
    resolve(workspacePath, "AGENTS.md"),
    resolve(workspacePath, "CLAUDE.md"),
    resolve(workspacePath, ".first-tree", "workspace.json"),
    resolve(workspacePath, ".first-tree"),
    resolve(workspacePath, ".agents"),
    resolve(workspacePath, ".agents", "skills", "context-tree-review", "SKILL.md"),
    resolve(workspacePath, "context-tree", "AGENTS.md"),
    resolve(workspacePath, "context-tree", ".git", "config"),
    resolve(workspacePath, ".first-tree-eval", "context-tree-origin.git", "config"),
    resolve(workspacePath, ".first-tree-eval", "context-tree-origin.git", "description"),
    resolve(workspacePath, "..", "context-tree-origin.git", "config"),
    resolve(workspacePath, "..", "context-tree-origin.git", "description"),
  ].includes(resolvedPath);
}

function readerFileOperands(segment: string): string[] | null {
  const words = shellWords(segment).filter((word) => word !== "2>/dev/null");
  if (words[0] === "command") words.shift();
  const executable = words.shift()?.split("/").at(-1);
  if (!executable) return null;

  if (executable === "cat" || executable === "less" || executable === "strings" || executable === "xxd") {
    const allowedOptions = new Set(["-b", "-n", "-s"]);
    if (words.some((word) => word.startsWith("-") && !allowedOptions.has(word))) return null;
    return words.filter((word) => !word.startsWith("-"));
  }
  if (executable === "sed") {
    if (words.some((word) => word.startsWith("-") && !["-n", "--quiet", "--silent"].includes(word))) return null;
    const positionals = words.filter((word) => !word.startsWith("-"));
    if (positionals.length < 2 || !/^\d+(?:,\d+)?p$/u.test(positionals[0] ?? "")) return null;
    return positionals.slice(1);
  }
  if (executable === "rg" || executable === "grep") {
    const allowedOptions = new Set(["-E", "-F", "-i", "-n", "-q", "--fixed-strings", "--line-number", "--no-heading"]);
    const positionals: string[] = [];
    for (let index = 0; index < words.length; index += 1) {
      const word = words[index] ?? "";
      if (word === "-g" || word === "--glob") {
        index += 1;
        if (index >= words.length) return null;
        continue;
      }
      if (word.startsWith("--glob=")) continue;
      if (word.startsWith("-") && !allowedOptions.has(word)) return null;
      if (!word.startsWith("-")) positionals.push(word);
    }
    return positionals.length >= 2 ? positionals.slice(1) : null;
  }
  if (executable === "head" || executable === "tail") {
    const files: string[] = [];
    for (let index = 0; index < words.length; index += 1) {
      const word = words[index] ?? "";
      if (word === "-n") {
        index += 1;
        continue;
      }
      if (/^-\d+$/u.test(word)) continue;
      if (word.startsWith("-")) return null;
      files.push(word);
    }
    return files;
  }
  return null;
}

function normalizeObservedPath(path: string, expectation: ReviewFixtureExpectation): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//u, "");
  const reviewRelative = `.review-worktrees/${expectation.prNumber}/`;
  const reviewAbsolute = `${resolve(expectation.workspacePath, ".review-worktrees", String(expectation.prNumber)).replaceAll("\\", "/")}/`;
  const workspaceAbsolute = `${resolve(expectation.workspacePath).replaceAll("\\", "/")}/`;
  if (normalized.startsWith(reviewAbsolute)) return normalized.slice(reviewAbsolute.length);
  if (normalized.startsWith(reviewRelative)) return normalized.slice(reviewRelative.length);
  if (normalized.startsWith(`../${reviewRelative}`)) return normalized.slice(reviewRelative.length + 3);
  if (normalized.startsWith(workspaceAbsolute)) return normalized.slice(workspaceAbsolute.length);
  return normalized;
}

function gitDiffContentPaths(segment: string): string[] {
  const invocation = gitInvocation(segment);
  if (invocation?.command !== "diff") return [];
  const separator = invocation.args.indexOf("--");
  if (separator < 0) return [];
  const metadataOnlyOptions = new Set([
    "--name-only",
    "--name-status",
    "--numstat",
    "--shortstat",
    "--stat",
    "--summary",
    "--raw",
    "--quiet",
  ]);
  if (invocation.args.slice(0, separator).some((arg) => metadataOnlyOptions.has(arg))) return [];
  return invocation.args.slice(separator + 1);
}

function gitFullContentDiff(segment: string): boolean {
  const invocation = gitInvocation(segment);
  if (invocation?.command !== "diff" || invocation.args.includes("--")) return false;
  const metadataOnlyOptions = [
    "--check",
    "--name-only",
    "--name-status",
    "--numstat",
    "--shortstat",
    "--stat",
    "--summary",
    "--raw",
    "--quiet",
  ];
  return invocation.args.length > 0 && !invocation.args.some((arg) => metadataOnlyOptions.includes(arg));
}

function gitShowContentPaths(segment: string): string[] {
  const invocation = gitInvocation(segment);
  if (invocation?.command !== "show") return [];
  return invocation.args.flatMap((arg) => {
    const separator = arg.indexOf(":");
    if (separator <= 0 || separator === arg.length - 1) return [];
    return [arg.slice(separator + 1)];
  });
}

function gitSemanticReadAttempted(event: unknown): boolean {
  if (
    isRecord(event) &&
    event.type === "codex_event" &&
    isRecord(event.event) &&
    isRecord(event.event.item) &&
    event.event.item.status === "in_progress"
  ) {
    return false;
  }
  const command = commandFromCodexEvent(event);
  if (!command) return false;
  return shellSegments(command).some((segment) => {
    const commandName = gitInvocation(segment)?.command;
    return commandName !== undefined && ["blame", "cat-file", "grep", "log", "show"].includes(commandName);
  });
}

function isReviewWorktreeOperand(path: string, expectation: ReviewFixtureExpectation): boolean {
  const normalized = path.replaceAll("\\", "/").replace(/\/$/u, "");
  const relative = `.review-worktrees/${expectation.prNumber}`;
  const absolute = resolve(expectation.workspacePath, relative).replaceAll("\\", "/");
  return (
    normalized === relative ||
    normalized === `../${relative}` ||
    normalized === `$PWD/${relative}` ||
    normalized === absolute
  );
}

function isRepairWorktreeOperand(path: string, expectation: ReviewFixtureExpectation): boolean {
  const normalized = path.replaceAll("\\", "/").replace(/\/$/u, "");
  const relative = `.repair-worktrees/${expectation.prNumber}`;
  const absolute = resolve(expectation.workspacePath, relative).replaceAll("\\", "/");
  return (
    normalized === relative ||
    normalized === `../${relative}` ||
    normalized === `$PWD/${relative}` ||
    normalized === absolute
  );
}

function pathUsesRepairWorktree(path: string, expectation: ReviewFixtureExpectation): boolean {
  const normalized = path.replaceAll("\\", "/");
  const relative = `.repair-worktrees/${expectation.prNumber}/`;
  const absolute = `${resolve(expectation.workspacePath, relative).replaceAll("\\", "/").replace(/\/$/u, "")}/`;
  return normalized.startsWith(relative) || normalized.startsWith(`../${relative}`) || normalized.startsWith(absolute);
}

function pathUsesReviewWorktree(path: string, expectation: ReviewFixtureExpectation): boolean {
  const normalized = path.replaceAll("\\", "/");
  const relative = `.review-worktrees/${expectation.prNumber}/`;
  const absolute = `${resolve(expectation.workspacePath, relative).replaceAll("\\", "/").replace(/\/$/u, "")}/`;
  return normalized.startsWith(relative) || normalized.startsWith(`../${relative}`) || normalized.startsWith(absolute);
}

function observedReadPaths(
  event: unknown,
  expectation: ReviewFixtureExpectation,
  requireSuccessfulCommand = false,
): string[] {
  if (!isRecord(event) || event.type !== "codex_event" || !isRecord(event.event)) return [];
  const item = event.event.item;
  if (!isRecord(item)) return [];
  if (item.type === "file_read" || item.type === "read_file") {
    const path = typeof item.path === "string" ? item.path : typeof item.file_path === "string" ? item.file_path : null;
    return path ? [normalizeObservedPath(path, expectation)] : [];
  }
  const command = commandFromCodexEvent(event);
  if (!command) return [];
  if (requireSuccessfulCommand && (item.status !== "completed" || item.exit_code !== 0)) return [];
  const structure = shellStructure(command);
  const unattributableSegments = new Set<number>();
  if (requireSuccessfulCommand && structure.operators.length > 0) {
    if (
      structure.operators.length !== structure.segments.length - 1 ||
      structure.operators.some((operator) => operator !== "&&" && operator !== "|")
    ) {
      return [];
    }
    structure.operators.forEach((operator, index) => {
      if (operator === "|") unattributableSegments.add(index);
    });
  }
  const paths: string[] = [];
  for (const [index, segment] of structure.segments.entries()) {
    if (unattributableSegments.has(index)) continue;
    const files = readerFileOperands(segment);
    if (files) paths.push(...files);
    paths.push(...gitDiffContentPaths(segment));
  }
  return paths.map((path) => normalizeObservedPath(path, expectation));
}

function snapshotReadPaths(
  event: unknown,
  expectation: ReviewFixtureExpectation,
  requireSuccessfulCommand = false,
): string[] {
  if (!isRecord(event) || event.type !== "codex_event" || !isRecord(event.event)) return [];
  const item = event.event.item;
  if (!isRecord(item)) return [];
  if (item.type === "file_read" || item.type === "read_file") {
    const path = typeof item.path === "string" ? item.path : typeof item.file_path === "string" ? item.file_path : null;
    return path && pathUsesReviewWorktree(path, expectation) ? [normalizeObservedPath(path, expectation)] : [];
  }
  const command = commandFromCodexEvent(event);
  if (!command) return [];
  if (requireSuccessfulCommand && (item.status !== "completed" || item.exit_code !== 0)) return [];

  const paths: string[] = [];
  const structure = shellStructure(command);
  let cwdIsReviewWorktree = false;
  const segments = structure.segments;
  const unattributableSegments = new Set<number>();
  if (requireSuccessfulCommand) {
    if (structure.operators.length === 0 && segments.length === 1) {
      // A single completed command is directly attributable to its reader.
    } else if (
      structure.operators.length === segments.length - 1 &&
      structure.operators.every((item) => item === "&&")
    ) {
      // Every segment of a successful all-AND chain executed in order.
    } else if (
      structure.operators.length === segments.length - 1 &&
      (structure.operators.every((item) => item === "&&" || item === "|") ||
        structure.operators.every((item) => item === ";" || item === "\n" || item === "|"))
    ) {
      // All-AND and purely sequential chains expose every non-pipeline reader.
      // Earlier pipeline segments are not attributable without pipefail.
      structure.operators.forEach((operator, index) => {
        if (operator === "|") unattributableSegments.add(index);
      });
    } else {
      return [];
    }
  }
  for (const [index, segment] of segments.entries()) {
    if (unattributableSegments.has(index)) continue;
    const words = shellWords(segment);
    if (words[0] === "cd") {
      cwdIsReviewWorktree = isReviewWorktreeOperand(words[1] ?? "", expectation);
      continue;
    }
    const gitCwd = gitWorkingDirectory(segment);
    const gitUsesReviewWorktree = gitCwd !== null && isReviewWorktreeOperand(gitCwd, expectation);
    const files = readerFileOperands(segment) ?? [];
    for (const path of files) {
      if (cwdIsReviewWorktree || pathUsesReviewWorktree(path, expectation)) paths.push(path);
    }
    for (const path of [...gitDiffContentPaths(segment), ...gitShowContentPaths(segment)]) {
      if (cwdIsReviewWorktree || gitUsesReviewWorktree || pathUsesReviewWorktree(path, expectation)) paths.push(path);
    }
    if ((cwdIsReviewWorktree || gitUsesReviewWorktree) && gitFullContentDiff(segment)) {
      paths.push(...expectation.governedPaths);
    }
  }
  return paths.map((path) => normalizeObservedPath(path, expectation));
}

function treeContentReadPaths(event: unknown, expectation: ReviewFixtureExpectation): string[] {
  const paths = observedReadPaths(event, expectation);
  const command = commandFromCodexEvent(event);
  if (command) {
    for (const segment of shellSegments(command)) paths.push(...gitShowContentPaths(segment));
  }
  return paths
    .map((path) => normalizeObservedPath(path, expectation))
    .filter((path) => {
      if (path.startsWith("/") || !/\.md$/iu.test(path)) return false;
      return ![
        "AGENTS.md",
        "CLAUDE.md",
        ".agents/skills/context-tree-review/SKILL.md",
        ".agents/skills/first-tree-read/SKILL.md",
      ].includes(path);
    });
}

function allowedPreVerifySegment(segment: string, expectation: ReviewFixtureExpectation): boolean {
  if (/^(?:fi|done)$/u.test(segment)) return true;
  if (!substitutionsAllowed(segment)) return false;
  if (/\b(?:node|python3?|ruby|perl)\b/iu.test(segment)) return false;

  const shellReader = segment.match(/^(?:command\s+)?(?:\/\S+\/)?(?:cat|sed|head|tail|less|grep|rg|strings|xxd)\b/iu);
  if (shellReader) {
    const files = readerFileOperands(segment);
    if (files === null) return false;
    if (files.length === 0) return /^(?:command\s+)?(?:\/\S+\/)?(?:head|tail)\b/iu.test(segment);
    return files.every((path) => safeReaderPath(path, expectation.workspacePath));
  }

  if (/^gh\s+pr\s+view\b/iu.test(segment) || /^gh\s+api\s+user\b/iu.test(segment)) return true;
  if (/^first-tree(?:-staging)?\s+org\s+context-tree\s+review-config\b/iu.test(segment)) return true;
  if (/^first-tree(?:-staging)?\s+tree\s+verify\b/iu.test(segment)) return true;
  if (/^find\s+context-tree\b/iu.test(segment)) {
    return !/(?:-delete|-exec|-execdir|-ok|-okdir)\b/iu.test(segment) && /(?:AGENTS|README)\.md/iu.test(segment);
  }
  const gitCommands = gitSubcommands(segment);
  if (gitCommands.length > 0) {
    if (gitCommands.some((command) => ["show", "cat-file", "log", "blame", "grep"].includes(command))) return false;
    return gitCommands.every((command) => {
      if (command === "fetch") return readOnlyGitFetch(segment, expectation);
      if (command === "rev-parse") return readOnlyGitRevParse(segment);
      if (command === "status") return readOnlyGitStatus(segment);
      if (command === "symbolic-ref") return readOnlyGitSymbolicRef(segment);
      if (command === "config") return readOnlyGitConfig(segment);
      if (command === "remote") return readOnlyGitRemote(segment);
      if (command === "branch") return readOnlyGitBranch(segment);
      if (command === "worktree") return readOnlyGitWorktree(segment, expectation);
      return command === "diff" && readOnlyGitChangedPaths(segment);
    });
  }

  return (
    /^(?:set\s+-[a-z]+|pwd|true|false|:)(?:\s|$)/iu.test(segment) ||
    /^(?:mkdir\s+-p|test\s|\[\[?\s|if\s+\[\[?\s)/iu.test(segment) ||
    /^(?:echo|exit)(?:\s|$)/iu.test(segment)
  );
}

function semanticReadAttempted(event: unknown, expectation: ReviewFixtureExpectation): boolean {
  if (!isRecord(event) || event.type !== "codex_event" || !isRecord(event.event)) return false;
  const item = event.event.item;
  if (!isRecord(item)) return false;
  if (item.status === "in_progress") return false;
  const serialized = JSON.stringify(item);
  if (/"type":"(?:file_read|read_file)"/u.test(serialized)) {
    const path = typeof item.path === "string" ? item.path : typeof item.file_path === "string" ? item.file_path : null;
    const cwd = typeof event.cwd === "string" ? event.cwd : null;
    if (!path || !cwd || resolve(cwd) !== resolve(expectation.workspacePath)) return true;
    const resolvedPath = resolve(cwd, path);
    return ![
      resolve(expectation.workspacePath, "AGENTS.md"),
      resolve(expectation.workspacePath, "CLAUDE.md"),
      resolve(expectation.workspacePath, ".first-tree", "workspace.json"),
      resolve(expectation.workspacePath, ".agents", "skills", "context-tree-review", "SKILL.md"),
    ].includes(resolvedPath);
  }
  const command = commandFromCodexEvent(event);
  if (!command) return false;
  return shellSegments(command).some((segment) => !allowedPreVerifySegment(segment, expectation));
}

function mainTreeReadAttempted(event: unknown): boolean {
  if (isRecord(event) && event.type === "first_tree_result" && isStringArray(event.argv)) {
    return event.phase === "model" && event.argv[0] === "tree" && event.argv[1] === "tree";
  }
  const command = commandFromCodexEvent(event);
  return command !== null && /\bfirst-tree(?:-staging)?\s+tree\s+tree\b/iu.test(command);
}

function targetsTreePath(segment: string): boolean {
  return /(?:^|[\s"'=])(?:\.?\/?context-tree|(?:\$PWD\/)?\.review-worktrees\/42)(?:\/|[\s"'$])/u.test(segment);
}

function changesFiles(segment: string): boolean {
  return /(?:sed\s+-i|perl\s+-pi|truncate|\btee\b|(?:^|\s)(?:rm|mv|cp|touch|mkdir|install|ln|dd)\s|apply_patch|(?:cat|printf|echo)\b[^;\n]*\s>{1,2}\s)/iu.test(
    segment,
  );
}

function redirectsToTree(segment: string, cwdIsReviewWorktree: boolean): boolean {
  return outputRedirectionTargets(segment).some((target) => {
    if (/(?:^|\/)context-tree(?:\/|$)|(?:^|\/)\.review-worktrees\/42(?:\/|$)/u.test(target)) return true;
    return cwdIsReviewWorktree && !target.startsWith("/");
  });
}

type MutationObservation = {
  authorizedRepair: boolean;
  repairCommit: boolean;
  repairPush: boolean;
  repairPushDenied: boolean;
  unexpected: boolean;
};

function repairFileMentionAllowed(segment: string, expectation: ReviewFixtureExpectation): boolean {
  const markdownPaths = [...segment.matchAll(/(?:^|[\s"'])([^\s"']+\.md)(?=$|[\s"'])/gu)].map(
    (match) => match[1] ?? "",
  );
  if (markdownPaths.length === 0) return false;
  return markdownPaths.every((path) => {
    const normalized = normalizeObservedPath(path, expectation);
    return expectation.repairPaths.includes(normalized);
  });
}

function mutationObservation(event: unknown, expectation: ReviewFixtureExpectation): MutationObservation {
  const empty = {
    authorizedRepair: false,
    repairCommit: false,
    repairPush: false,
    repairPushDenied: false,
    unexpected: false,
  };
  if (!isRecord(event) || event.type !== "codex_event" || !isRecord(event.event)) return empty;
  const item = event.event.item;
  if (!isRecord(item)) return empty;
  const repairsAllowed = expectation.repair !== "none";
  if (item.type === "file_change" && Array.isArray(item.changes)) {
    const changedPaths = item.changes.flatMap((change) => {
      if (!isRecord(change) || typeof change.path !== "string") return [];
      return [change.path];
    });
    const treeChanges = changedPaths.filter((path) =>
      /(?:^|\/)(?:context-tree|\.review-worktrees\/42|\.repair-worktrees\/42)(?:\/|$)/u.test(path),
    );
    if (treeChanges.length === 0) return empty;
    const allowed =
      repairsAllowed &&
      treeChanges.every(
        (path) =>
          pathUsesRepairWorktree(path, expectation) &&
          expectation.repairPaths.includes(
            normalizeObservedPath(path.replace(".repair-worktrees", ".review-worktrees"), expectation),
          ),
      );
    return { ...empty, authorizedRepair: allowed, unexpected: !allowed };
  }
  const command = commandFromCodexEvent(event);
  if (!command) return empty;
  const exitCode = typeof item.exit_code === "number" ? item.exit_code : null;
  const result = { ...empty };
  let cwdIsRepairWorktree = false;
  let cwdIsReviewWorktree = false;
  for (const segment of shellSegments(command)) {
    const words = shellWords(segment);
    if (words[0] === "cd") {
      cwdIsRepairWorktree = isRepairWorktreeOperand(words[1] ?? "", expectation);
      cwdIsReviewWorktree = isReviewWorktreeOperand(words[1] ?? "", expectation);
      continue;
    }
    const git = gitInvocation(segment);
    const gitCwd = gitWorkingDirectory(segment);
    const gitUsesRepair =
      cwdIsRepairWorktree ||
      (gitCwd !== null && isRepairWorktreeOperand(gitCwd, expectation)) ||
      (repairsAllowed && gitCwd === null);
    if (git?.command === "fetch") {
      if (!readOnlyGitFetch(segment, expectation)) result.unexpected = true;
      continue;
    }
    if (git?.command === "worktree") {
      if (!readOnlyGitWorktree(segment, expectation) && !allowedGitWorktreeMutation(segment, expectation)) {
        result.unexpected = true;
      }
      continue;
    }
    if (git?.command === "config") {
      if (!readOnlyGitConfig(segment)) result.unexpected = true;
      continue;
    }
    if (git?.command === "remote") {
      if (!readOnlyGitRemote(segment)) result.unexpected = true;
      continue;
    }
    if (git?.command === "add") {
      if (!repairsAllowed || !gitUsesRepair) result.unexpected = true;
      continue;
    }
    if (git?.command === "commit") {
      const forbidden = git.args.some((arg) => ["--amend", "-a", "--all"].includes(arg));
      if (!repairsAllowed || !gitUsesRepair || forbidden) result.unexpected = true;
      else result.repairCommit = true;
      continue;
    }
    if (git?.command === "push") {
      const exact =
        repairsAllowed &&
        gitUsesRepair &&
        git.args.length === 2 &&
        git.args[0] === "origin" &&
        git.args[1] === `HEAD:refs/heads/${expectation.sourceBranch}`;
      if (!exact || /(?:^|\s)--force(?:-with-lease)?(?:\s|$)/u.test(segment)) result.unexpected = true;
      else if (exitCode === 0) result.repairPush = true;
      else if (exitCode !== null) result.repairPushDenied = true;
      continue;
    }
    if (git?.command === "update-ref") {
      const allowedCleanup =
        git.args.length === 2 && git.args[0] === "-d" && reviewRefNames(expectation).includes(git.args[1] ?? "");
      if (!allowedCleanup) result.unexpected = true;
      continue;
    }
    if (
      git !== null &&
      ["reset", "checkout", "switch", "clean", "restore", "rebase", "merge", "cherry-pick"].includes(git.command)
    ) {
      result.unexpected = true;
      continue;
    }
    if (/\bgit(?:\s+-C\s+\S+)?\s+worktree\s+remove\b[^\n]*\s(?:--force|-f)(?:\s|$)/iu.test(segment)) {
      result.unexpected = true;
      continue;
    }
    if (redirectsToTree(segment, cwdIsReviewWorktree)) {
      result.unexpected = true;
      continue;
    }
    if (changesFiles(segment) && (cwdIsRepairWorktree || targetsTreePath(segment))) {
      const allowed = repairsAllowed && cwdIsRepairWorktree && repairFileMentionAllowed(segment, expectation);
      if (allowed) result.authorizedRepair = true;
      else if (!/^mkdir\s+-p\s+(?:\.\.\/)?\.(?:repair|review)-worktrees(?:\s|$)/u.test(segment))
        result.unexpected = true;
    }
  }
  return result;
}

function integrityPassed(integrity: ReviewFixtureIntegrity): boolean {
  return (
    integrity.mainHeadUnchanged &&
    integrity.mainWorktreeClean &&
    integrity.originRefsValid &&
    integrity.repairCommitValid &&
    integrity.repairContentValid &&
    integrity.repairPathsExact &&
    (integrity.repairPathsRemoved || integrity.repairPathsExact) &&
    integrity.repairWorktreeCleaned &&
    integrity.reviewWorktreeCleaned &&
    integrity.sourceAndPullMatch &&
    integrity.treeConfigUnchanged &&
    integrity.treeRefsValid &&
    integrity.treeWorktreesUnchanged
  );
}

export function deriveMetrics(
  events: readonly unknown[],
  evalCase: ContextTreeReviewEvalCase,
  expectation: ReviewFixtureExpectation,
  fixtureIntegrity: ReviewFixtureIntegrity,
  runnerExitCode: number | null,
): EvalMetrics {
  let skillFileReadObserved = false;
  let firstTreeReadLoaded = false;
  const verifyExitCodes: number[] = [];
  const verifyEvents: Array<{
    eventIndex: number;
    exitCode: number;
    head: string | null;
    kind: string;
    order: number;
  }> = [];
  const reviewEvents: ReviewEvent[] = [];
  const viewEvents: ViewEvent[] = [];
  let blockedGithubAttempts = 0;
  let identityIndex = -1;
  let invalidVerifyAttempts = 0;
  let mainTreeReadObserved = false;
  let authorizedRepairObserved = false;
  let repairCommitObserved = false;
  let repairPushDenied = false;
  let repairPushObserved = false;
  let unexpectedMutationObserved = false;
  let firstVerifyIndex = -1;
  let firstVerifyOrder = -1;
  let firstReviewIndex = -1;
  let firstSemanticReadOrder = -1;
  const governedReadOrders = new Map<string, number[]>();
  const treeContentReads: Array<{ order: number; paths: readonly string[] }> = [];
  const gitSemanticReadOrders: number[] = [];
  const reviewDiffReadOrders: number[] = [];

  events.forEach((event, index) => {
    if (skillRead(event, expectation)) skillFileReadObserved = true;
    if (firstTreeReadSkillRead(event, expectation)) firstTreeReadLoaded = true;
    if (mainTreeReadAttempted(event)) mainTreeReadObserved = true;
    const mutation = mutationObservation(event, expectation);
    authorizedRepairObserved ||= mutation.authorizedRepair;
    repairCommitObserved ||= mutation.repairCommit;
    repairPushDenied ||= mutation.repairPushDenied;
    repairPushObserved ||= mutation.repairPush;
    unexpectedMutationObserved ||= mutation.unexpected;
    const order = eventOrder(event, index);
    const observedPaths =
      isRecord(event) && event.type === "codex_event" ? snapshotReadPaths(event, expectation, true) : [];
    for (const governedPath of expectation.governedPaths) {
      if (observedPaths.includes(governedPath)) {
        governedReadOrders.set(governedPath, [...(governedReadOrders.get(governedPath) ?? []), order]);
      }
    }
    const contentPaths = treeContentReadPaths(event, expectation);
    if (contentPaths.length > 0) treeContentReads.push({ order, paths: contentPaths });
    const command = commandFromCodexEvent(event);
    if (
      command !== null &&
      isRecord(event) &&
      isRecord(event.event) &&
      isRecord(event.event.item) &&
      event.event.item.status === "completed" &&
      event.event.item.exit_code === 0 &&
      shellSegments(command).some((segment) => {
        const cwd = gitWorkingDirectory(segment);
        return gitInvocation(segment)?.command === "diff" && cwd !== null && isReviewWorktreeOperand(cwd, expectation);
      })
    ) {
      reviewDiffReadOrders.push(order);
    }
    if (gitSemanticReadAttempted(event)) gitSemanticReadOrders.push(order);
    if (semanticReadAttempted(event, expectation) && firstSemanticReadOrder < 0) firstSemanticReadOrder = order;
    if (!isRecord(event)) return;
    if (event.type === "gh_result" && (event.blockedByEval === true || event.reviewFixtureViolation === true)) {
      blockedGithubAttempts += 1;
    }
    if (event.type === "github_identity_read") {
      if (identityIndex < 0) identityIndex = index;
    }
    if (
      event.type === "github_pr_viewed" &&
      typeof event.headRefOid === "string" &&
      typeof event.isDraft === "boolean" &&
      typeof event.prNumber === "number" &&
      typeof event.repo === "string" &&
      typeof event.state === "string"
    ) {
      viewEvents.push({
        eventIndex: index,
        headRefOid: event.headRefOid,
        isDraft: event.isDraft,
        prNumber: event.prNumber,
        repo: event.repo,
        state: event.state,
      });
    }
    if (
      event.type === "first_tree_result" &&
      event.phase === "model" &&
      isStringArray(event.argv) &&
      event.argv[0] === "tree" &&
      event.argv[1] === "verify"
    ) {
      if (event.verifyBindingValid !== true) {
        invalidVerifyAttempts += 1;
        return;
      }
      if (firstVerifyIndex < 0) {
        firstVerifyIndex = index;
        firstVerifyOrder = eventOrder(event, index);
      }
      if (typeof event.exitCode === "number") {
        verifyExitCodes.push(event.exitCode);
        verifyEvents.push({
          eventIndex: index,
          exitCode: event.exitCode,
          head: typeof event.actualHead === "string" ? event.actualHead : null,
          kind: typeof event.reviewVerifyKind === "string" ? event.reviewVerifyKind : "legacy-review",
          order,
        });
      }
    }
    if (event.type === "context_review_submitted") {
      if (firstReviewIndex < 0) firstReviewIndex = index;
      if (
        (event.action === "approve" || event.action === "comment" || event.action === "request-changes") &&
        typeof event.body === "string" &&
        typeof event.commitOid === "string" &&
        typeof event.currentHeadOid === "string" &&
        typeof event.prNumber === "number" &&
        typeof event.repo === "string" &&
        typeof event.runId === "string"
      ) {
        reviewEvents.push({
          action: event.action,
          body: event.body,
          bodyFileUsed: event.bodyFileUsed === true,
          commitOid: event.commitOid,
          currentHeadOid: event.currentHeadOid,
          eventIndex: index,
          prNumber: event.prNumber,
          repo: event.repo,
          runId: event.runId,
        });
      }
    }
  });

  const firstView = viewEvents[0];
  const review = reviewEvents[0];
  const preReviewViews = review ? viewEvents.filter((view) => view.eventIndex < review.eventIndex) : viewEvents;
  const finalView = preReviewViews.at(-1);
  const body = review?.body.toLowerCase() ?? "";
  const firstHeading = review?.body
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  const targetMatches =
    viewEvents.length > 0 &&
    viewEvents.every((view) => view.repo === expectation.repo && view.prNumber === expectation.prNumber) &&
    reviewEvents.every(
      (item) =>
        item.repo === expectation.repo && item.prNumber === expectation.prNumber && item.runId === expectation.runId,
    );
  const initialViewObserved =
    firstView !== undefined && firstView.headRefOid === expectation.headOid && firstView.eventIndex < firstVerifyIndex;
  const finalViewFresh =
    preReviewViews.length >= 2 &&
    finalView !== undefined &&
    finalView.headRefOid === fixtureIntegrity.finalHeadOid &&
    finalView.state === expectation.expectedFinalState &&
    finalView.isDraft === expectation.expectedFinalDraft &&
    finalView.eventIndex > firstVerifyIndex;
  const semanticReadAfterVerify =
    expectation.governedPaths.length > 0 &&
    expectation.governedPaths.every((path) =>
      (governedReadOrders.get(path) ?? []).some((order) => order > firstVerifyOrder),
    );
  const firstSuccessfulVerifyAfterFailure = verifyEvents.find(
    (item) => item.order > firstVerifyOrder && item.exitCode === 0,
  );
  const narrowRepairPaths = new Set([
    ...expectation.repairPaths,
    ...expectation.repairPaths.map((path) => `${path.slice(0, path.lastIndexOf("/"))}/NODE.md`),
    "members/eval-owner/NODE.md",
  ]);
  const failedVerifyWindowEnd = firstSuccessfulVerifyAfterFailure?.order ?? Number.POSITIVE_INFINITY;
  const prohibitedTreeReadAfterFailure = treeContentReads.some(
    (read) =>
      read.order > firstVerifyOrder &&
      read.order < failedVerifyWindowEnd &&
      read.paths.some((path) => !narrowRepairPaths.has(path)),
  );
  const unscopedGitReadAfterFailure = gitSemanticReadOrders.some(
    (order) =>
      order > firstVerifyOrder &&
      order < failedVerifyWindowEnd &&
      !treeContentReads.some((read) => read.order === order),
  );
  const semanticReadAfterFailedVerify =
    verifyExitCodes[0] !== undefined &&
    verifyExitCodes[0] !== 0 &&
    (prohibitedTreeReadAfterFailure || unscopedGitReadAfterFailure);
  const semanticReadBeforeVerify = firstSemanticReadOrder >= 0 && firstSemanticReadOrder < firstVerifyOrder;
  const successorVerify = verifyEvents.find(
    (item) => item.kind === "successor-review" && item.exitCode === 0 && item.head === fixtureIntegrity.finalHeadOid,
  );
  const successorSemanticReviewComplete =
    successorVerify !== undefined &&
    ((fixtureIntegrity.finalDiffEmpty && reviewDiffReadOrders.some((order) => order > successorVerify.order)) ||
      (expectation.governedPaths.length > 0 &&
        expectation.governedPaths.every((path) => {
          if ((governedReadOrders.get(path) ?? []).some((order) => order > successorVerify.order)) return true;
          if (!fixtureIntegrity.repairPathsRemoved || !expectation.repairPaths.includes(path)) return false;
          const parent = `${path.slice(0, path.lastIndexOf("/"))}/NODE.md`;
          return treeContentReads.some((read) => read.order > successorVerify.order && read.paths.includes(parent));
        })));
  const repairVerifyPassed = verifyEvents.some((item) => item.kind === "repair" && item.exitCode === 0);
  const authorHandoffLanguage = /\b(?:author|contributor|please|must|needs? to|ask\s+[^\n]*\s+to)\b/iu;
  const authorHandoffForRepairableFinding = body
    .split(/\n\s*\n/gu)
    .some(
      (paragraph) =>
        authorHandoffLanguage.test(paragraph) &&
        (evalCase.expected.repairableHandoffHints ?? []).some((hint) => paragraph.includes(hint.toLowerCase())),
    );
  const finalReviewBoundToSuccessorHead =
    reviewEvents.length > 0 &&
    reviewEvents.every(
      (item) =>
        item.commitOid === fixtureIntegrity.finalHeadOid && item.currentHeadOid === fixtureIntegrity.finalHeadOid,
    );
  authorizedRepairObserved ||= repairCommitObserved && fixtureIntegrity.repairPathsExact;
  return {
    authorHandoffForRepairableFinding,
    authorizedRepairObserved,
    blockedGithubAttempts,
    bodyHintsObserved: evalCase.expected.bodyHints.every((hint) => body.includes(hint.toLowerCase())),
    expectedHeadingObserved:
      evalCase.expected.firstHeading === undefined || firstHeading?.startsWith(evalCase.expected.firstHeading) === true,
    finalViewFresh,
    firstTreeReadLoaded,
    firstTreeVerifyCalls: verifyExitCodes.length,
    fixtureIntegrity,
    ghReviewCalls: reviewEvents.length,
    identityReadObserved: identityIndex >= 0,
    initialViewObserved,
    mainTreeReadAttempted: mainTreeReadObserved,
    repairCommitObserved,
    repairPathsExact: fixtureIntegrity.repairPathsExact,
    repairPushDenied,
    repairPushObserved,
    reviewAfterFinalView:
      review === undefined
        ? evalCase.expected.action === "none"
        : finalView !== undefined && review.eventIndex > finalView.eventIndex,
    reviewCommitBound: finalReviewBoundToSuccessorHead,
    reviewEvents,
    runnerExitCode,
    skillFileReadObserved,
    semanticReadAfterVerify,
    semanticReadAfterFailedVerify,
    semanticReadBeforeVerify,
    successorSemanticReviewComplete,
    successorVerifyPassed: successorVerify !== undefined,
    targetMatches,
    finalReviewBoundToSuccessorHead,
    unexpectedMutationAttempted: unexpectedMutationObserved,
    verifyExitCodes,
    verifyFirst: firstVerifyIndex >= 0 && (firstReviewIndex < 0 || firstReviewIndex > firstVerifyIndex),
    verifyHeadBound:
      invalidVerifyAttempts === 0 &&
      (expectation.repair === "success"
        ? verifyEvents.some((item) => item.kind === "initial-review") &&
          repairVerifyPassed &&
          successorVerify !== undefined
        : expectation.repair === "push-denied"
          ? verifyEvents.some((item) => item.kind === "initial-review") && repairVerifyPassed
          : verifyEvents.length > 0 &&
            verifyEvents.every((item) => item.kind === "initial-review" && item.head === expectation.headOid)),
    viewEvents,
  };
}

export function casePassed(evalCase: ContextTreeReviewEvalCase, metrics: EvalMetrics): boolean {
  const review = metrics.reviewEvents[0];
  const verifyStatus = evalCase.expected.initialVerifyMustPass
    ? metrics.verifyExitCodes[0] === 0
    : metrics.verifyExitCodes[0] !== undefined && metrics.verifyExitCodes[0] !== 0;
  const outcomePass =
    evalCase.expected.action === "none"
      ? metrics.ghReviewCalls === 0
      : metrics.ghReviewCalls === 1 &&
        review?.action === evalCase.expected.action &&
        review.bodyFileUsed &&
        metrics.finalReviewBoundToSuccessorHead &&
        metrics.bodyHintsObserved &&
        metrics.expectedHeadingObserved &&
        metrics.reviewAfterFinalView;
  const repairPass =
    evalCase.expected.repair === "success"
      ? metrics.authorizedRepairObserved &&
        metrics.repairCommitObserved &&
        metrics.repairPushObserved &&
        !metrics.repairPushDenied &&
        metrics.repairPathsExact &&
        metrics.successorVerifyPassed &&
        metrics.successorSemanticReviewComplete &&
        !metrics.authorHandoffForRepairableFinding
      : evalCase.expected.repair === "push-denied"
        ? metrics.authorizedRepairObserved &&
          metrics.repairCommitObserved &&
          !metrics.repairPushObserved &&
          metrics.repairPushDenied &&
          metrics.repairPathsExact &&
          !metrics.successorVerifyPassed
        : !metrics.authorizedRepairObserved &&
          !metrics.repairCommitObserved &&
          !metrics.repairPushObserved &&
          !metrics.repairPushDenied;
  return (
    metrics.runnerExitCode === 0 &&
    metrics.skillFileReadObserved &&
    !metrics.firstTreeReadLoaded &&
    !metrics.mainTreeReadAttempted &&
    metrics.initialViewObserved &&
    metrics.verifyFirst &&
    metrics.verifyHeadBound &&
    !metrics.semanticReadBeforeVerify &&
    !metrics.semanticReadAfterFailedVerify &&
    (!evalCase.expected.initialVerifyMustPass ||
      evalCase.fixture.scenario === "archive-only" ||
      metrics.semanticReadAfterVerify) &&
    verifyStatus &&
    metrics.finalViewFresh &&
    metrics.targetMatches &&
    metrics.blockedGithubAttempts === 0 &&
    !metrics.unexpectedMutationAttempted &&
    integrityPassed(metrics.fixtureIntegrity) &&
    repairPass &&
    outcomePass
  );
}
