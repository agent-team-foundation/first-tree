import { resolve } from "node:path";

import { isRecord, isStringArray } from "../../core/events.js";
import type {
  ContextTreeReviewEvalCase,
  EvalMetrics,
  LocalMergeEvent,
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

function decodeShellCommandWord(value: string): string | null {
  let decoded = "";
  let quote: '"' | "'" | null = null;
  let sawQuote = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? "";
    if (quote === "'") {
      if (character === "'") quote = null;
      else decoded += character;
      continue;
    }
    if (quote === '"') {
      if (character === '"') {
        quote = null;
        continue;
      }
      if (character === "\\") {
        const next = value[index + 1] ?? "";
        if (['"', "\\", "$", "`", "\n"].includes(next)) {
          decoded += next;
          index += 1;
        } else {
          decoded += character;
        }
        continue;
      }
      decoded += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      sawQuote = true;
      continue;
    }
    if (/\s/u.test(character)) return null;
    if (character === "\\") {
      const next = value[index + 1];
      if (next === undefined) return null;
      decoded += next;
      index += 1;
      continue;
    }
    decoded += character;
  }
  return sawQuote && quote === null ? decoded : null;
}

function shellStructure(command: string): { operators: string[]; segments: string[] } {
  const trimmed = command.trim();
  const shellPrefix = trimmed.match(/^\/?(?:usr\/)?bin\/(?:ba|z)?sh\s+-lc\s+/u)?.[0];
  let source = shellPrefix ? trimmed.slice(shellPrefix.length) : trimmed;
  // Codex records the host shell's serialized -lc argument. Decode the whole
  // concatenated shell word (including quote splices around $PWD) before
  // classifying the command that the inner shell actually executed.
  if (shellPrefix) source = decodeShellCommandWord(source) ?? source;

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
    // Codex records the display form of `shell -lc`. Its outer quote may be
    // spliced around variables, but a literal newline still separates the
    // commands executed by the shell.
    if (character === "\n") {
      finish();
      operators.push(character);
      quote = null;
      escaped = false;
      continue;
    }
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
    if (character === ";" || character === "|") {
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

function normalizeShellToken(value: string): string {
  return value.replace(/["']/gu, "");
}

function readOnlyGitFetch(segment: string, expectation: ReviewFixtureExpectation): boolean {
  if (hasUnquotedRedirection(segment)) return false;
  const invocation = gitInvocation(segment);
  if (invocation?.command !== "fetch" || invocation.args.length < 2 || invocation.args[0] !== "origin") return false;
  const pullRef = `refs/pull/${expectation.prNumber}/head`;
  const sourceRef = `refs/heads/${expectation.headRefName}`;
  const allowed = new Set([
    "main",
    "main:refs/remotes/origin/main",
    "refs/heads/main:refs/remotes/origin/main",
    sourceRef,
    pullRef,
    ...reviewRefNames(expectation).map((destination) => `${pullRef}:${destination}`),
  ]);
  const refs = invocation.args.slice(1);
  return refs.every((arg) => allowed.has(arg));
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
    invocation.args.length === 2 &&
    invocation.args[0] === "-a" &&
    invocation.args[1] === "-vv"
  );
}

function reviewWorktreePathAllowed(path: string, expectation: ReviewFixtureExpectation): boolean {
  const normalizedPath = normalizeShellToken(path);
  const relative = `.review-worktrees/${expectation.prNumber}`;
  return [`$PWD/${relative}`, resolve(expectation.workspacePath, relative)].includes(normalizedPath);
}

function readOnlyGitWorktree(segment: string, expectation: ReviewFixtureExpectation): boolean {
  if (hasUnquotedRedirection(segment)) return false;
  const invocation = gitInvocation(segment);
  if (invocation?.command !== "worktree") return false;
  const args = invocation.args;
  if (
    (args.length === 1 && args[0] === "list") ||
    (args.length === 2 && args[0] === "list" && args[1] === "--porcelain")
  ) {
    return true;
  }
  if (args.length === 2 && args[0] === "remove") {
    return reviewWorktreePathAllowed(args[1] ?? "", expectation);
  }
  return (
    args.length === 4 &&
    args[0] === "add" &&
    args[1] === "--detach" &&
    reviewWorktreePathAllowed(args[2] ?? "", expectation) &&
    ["$RUN_HEAD", expectation.headOid, ...reviewRefNames(expectation)].includes(normalizeShellToken(args[3] ?? ""))
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
    resolve(workspacePath, ".agents", "skills", "context-tree-review", "SKILL.md"),
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
    if (words.some((word) => word.startsWith("-") && !allowedOptions.has(word))) return null;
    const positionals = words.filter((word) => !word.startsWith("-"));
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
  const reviewFromPwd = `$PWD/${reviewRelative}`;
  const reviewAbsolute = `${resolve(expectation.workspacePath, ".review-worktrees", String(expectation.prNumber)).replaceAll("\\", "/")}/`;
  const workspaceAbsolute = `${resolve(expectation.workspacePath).replaceAll("\\", "/")}/`;
  if (normalized.startsWith(reviewAbsolute)) return normalized.slice(reviewAbsolute.length);
  if (normalized.startsWith(reviewFromPwd)) return normalized.slice(reviewFromPwd.length);
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
  return normalized === relative || normalized === `$PWD/${relative}` || normalized === absolute;
}

function pathUsesReviewWorktree(path: string, expectation: ReviewFixtureExpectation): boolean {
  const normalized = path.replaceAll("\\", "/");
  const relative = `.review-worktrees/${expectation.prNumber}/`;
  const absolute = `${resolve(expectation.workspacePath, relative).replaceAll("\\", "/").replace(/\/$/u, "")}/`;
  return (
    normalized.startsWith(relative) || normalized.startsWith(`$PWD/${relative}`) || normalized.startsWith(absolute)
  );
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
  if (requireSuccessfulCommand && structure.operators.length > 0) return [];
  const paths: string[] = [];
  for (const segment of structure.segments) {
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
  let segments = structure.segments;
  if (requireSuccessfulCommand) {
    if (structure.operators.length === 0 && segments.length === 1) {
      // A single completed command is directly attributable to its reader.
    } else if (structure.operators.length === 1 && structure.operators[0] === "&&" && segments.length === 2) {
      const cdWords = shellWords(segments[0] ?? "");
      if (cdWords[0] !== "cd" || !isReviewWorktreeOperand(cdWords[1] ?? "", expectation)) return [];
      cwdIsReviewWorktree = true;
      segments = segments.slice(1);
    } else {
      return [];
    }
  }
  for (const segment of segments) {
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

type RuntimeIdentityCheck = "agent" | "chat" | "token";

function runtimeIdentityCheck(segment: string, expectation: ReviewFixtureExpectation): RuntimeIdentityCheck | null {
  if (hasUnquotedRedirection(segment) || !substitutionsAllowed(segment)) return null;
  const words = shellWords(segment);
  if (words[0] === "if") words.shift();
  let operands: string[];
  if (words[0] === "test") {
    operands = words.slice(1);
  } else if ((words[0] === "[" || words[0] === "[[") && (words.at(-1) === "]" || words.at(-1) === "]]")) {
    operands = words.slice(1, -1);
  } else {
    return null;
  }
  if (operands.length === 2 && operands[0] === "-n" && operands[1] === "$FIRST_TREE_CHAT_ID") return "chat";
  if (
    operands.length === 3 &&
    operands[0] === "$FIRST_TREE_AGENT_ID" &&
    (operands[1] === "=" || operands[1] === "==") &&
    operands[2] === expectation.agentId
  ) {
    return "agent";
  }
  if (operands.length === 2 && operands[0] === "-r" && operands[1] === "$FIRST_TREE_RUNTIME_SESSION_TOKEN_FILE") {
    return "token";
  }
  return null;
}

function safeGithubIdentityRead(segment: string): boolean {
  if (hasUnquotedRedirection(segment) || !substitutionsAllowed(segment)) return false;
  const words = shellWords(segment);
  return (
    (words.length === 4 &&
      words[0] === "gh" &&
      words[1] === "api" &&
      words[2] === "user" &&
      words[3] === "--jq=.login") ||
    (words.length === 5 &&
      words[0] === "gh" &&
      words[1] === "api" &&
      words[2] === "user" &&
      words[3] === "--jq" &&
      words[4] === ".login")
  );
}

function safeReadonlyAssignment(segment: string, expectation: ReviewFixtureExpectation): boolean {
  if (
    /^readonly\s+(?:(?:CONTEXT_REVIEW_RUN_ID|RUN_HEAD|REVIEW_WORKTREE|WORKSPACE_ROOT|TREE_PATH)(?:\s+|$))+$/u.test(
      segment,
    )
  ) {
    return true;
  }
  if (
    /^readonly\s+(?:CONTEXT_REVIEW_RUN_ID|RUN_HEAD|REVIEW_WORKTREE|WORKSPACE_ROOT|TREE_PATH)=(?:'[^']*'|"[^"]*"|[A-Za-z0-9_$./:@+-]+)$/u.test(
      segment,
    )
  ) {
    return true;
  }
  const serialized = segment.replace(/[\\"']/gu, "");
  return serialized === `readonly REVIEW_WORKTREE=$PWD/.review-worktrees/${expectation.prNumber}`;
}

function allowedPreVerifySegment(segment: string, expectation: ReviewFixtureExpectation): boolean {
  if (/^(?:fi|done|esac)$/u.test(segment)) return true;
  if (!substitutionsAllowed(segment)) return false;
  if (/\b(?:node|python3?|ruby|perl)\b/iu.test(segment)) return false;
  if (runtimeIdentityCheck(segment, expectation) !== null) return true;

  const shellReader = segment.match(/^(?:command\s+)?(?:\/\S+\/)?(?:cat|sed|head|tail|less|grep|rg|strings|xxd)\b/iu);
  if (shellReader) {
    const files = readerFileOperands(segment);
    return files !== null && files.length > 0 && files.every((path) => safeReaderPath(path, expectation.workspacePath));
  }

  if (/^gh\s+pr\s+view\b/iu.test(segment) || safeGithubIdentityRead(segment)) return true;
  if (/^first-tree(?:-staging)?\s+tree\s+review\s+--check\b/iu.test(segment)) return true;
  if (/^first-tree(?:-staging)?\s+tree\s+verify\b/iu.test(segment)) return true;
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
    safeReadonlyAssignment(segment, expectation) ||
    /^[A-Z_][A-Z0-9_]*=(?:'[^']*'|"[^"]*"|[A-Za-z0-9_./:@+-]+)$/u.test(segment) ||
    /^(?:pwd|true|false|:)(?:\s|$)/iu.test(segment) ||
    /^(?:mkdir\s+-p|test\s|\[\[?\s|if\s+\[\[?\s)/iu.test(segment) ||
    /^(?:echo|exit)(?:\s|$)/iu.test(segment)
  );
}

function normalizeRunHeadValidationCase(command: string): string {
  return command.replace(/\bcase\b[\s\S]*?\besac\b/gu, (block) => {
    if (
      block.includes("$RUN_HEAD") &&
      block.includes("[!0-9a-f]") &&
      /\bexit\s+\d+/u.test(block) &&
      !/\b(?:awk|cat|dd|grep|head|less|node|perl|python3?|rg|ruby|sed|strings|tail|xxd)\b/iu.test(block) &&
      substitutionsAllowed(block) &&
      !hasUnquotedRedirection(block)
    ) {
      return "true";
    }
    return block;
  });
}

function semanticReadAttempted(event: unknown, expectation: ReviewFixtureExpectation): boolean {
  if (!isRecord(event) || event.type !== "codex_event" || !isRecord(event.event)) return false;
  const item = event.event.item;
  if (!isRecord(item)) return false;
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
  return shellSegments(normalizeRunHeadValidationCase(command)).some(
    (segment) => !allowedPreVerifySegment(segment, expectation),
  );
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

function allowedVerdictBodyPath(expectation: ReviewFixtureExpectation): string {
  return resolve(expectation.workspacePath, `.review-body-${expectation.prNumber}.md`);
}

function isAllowedVerdictBodyPath(path: string, expectation: ReviewFixtureExpectation): boolean {
  const normalized = normalizeShellToken(path).replace(/^\$PWD\//u, "");
  return resolve(expectation.workspacePath, normalized) === allowedVerdictBodyPath(expectation);
}

function allowedWorkspaceMutationSegment(segment: string, expectation: ReviewFixtureExpectation): boolean {
  const redirectionTargets = outputRedirectionTargets(segment);
  if (redirectionTargets.length > 0) {
    return redirectionTargets.every((target) => isAllowedVerdictBodyPath(target, expectation));
  }
  const words = shellWords(segment);
  const executable = words[0]?.split("/").at(-1);
  if (executable === "rm") {
    const paths = words.slice(1).filter((word) => !word.startsWith("-"));
    return paths.length > 0 && paths.every((path) => isAllowedVerdictBodyPath(path, expectation));
  }
  if (executable === "mkdir") {
    const paths = words.slice(1).filter((word) => word !== "-p");
    const allowedPaths = new Set(["$PWD/.review-worktrees", resolve(expectation.workspacePath, ".review-worktrees")]);
    return paths.length === 1 && allowedPaths.has(normalizeShellToken(paths[0] ?? ""));
  }
  return false;
}

function mutationAttempted(event: unknown, expectation: ReviewFixtureExpectation): boolean {
  if (!isRecord(event) || event.type !== "codex_event" || !isRecord(event.event)) return false;
  const item = event.event.item;
  if (!isRecord(item)) return false;
  if (item.type === "file_change" && Array.isArray(item.changes)) {
    return item.changes.some(
      (change) =>
        isRecord(change) && typeof change.path === "string" && !isAllowedVerdictBodyPath(change.path, expectation),
    );
  }
  const command = commandFromCodexEvent(event);
  if (!command) return false;
  let cwdIsReviewWorktree = false;
  for (const segment of shellSegments(command)) {
    const gitCommands = gitSubcommands(segment);
    if (gitCommands.includes("fetch") && !readOnlyGitFetch(segment, expectation)) return true;
    if (gitCommands.includes("worktree") && !readOnlyGitWorktree(segment, expectation)) return true;
    if (gitCommands.includes("config") && !readOnlyGitConfig(segment)) return true;
    if (gitCommands.includes("remote") && !readOnlyGitRemote(segment)) return true;
    if (/\bgit(?:\s+-C\s+\S+)?\s+(?:add|commit|push|reset|checkout|switch|clean|restore)\b/iu.test(segment)) {
      return true;
    }
    if (/\bgit(?:\s+-C\s+\S+)?\s+worktree\s+remove\b[^\n]*\s(?:--force|-f)(?:\s|$)/iu.test(segment)) return true;
    if (redirectsToTree(segment, cwdIsReviewWorktree)) return true;
    if (
      changesFiles(segment) &&
      (cwdIsReviewWorktree || targetsTreePath(segment) || !allowedWorkspaceMutationSegment(segment, expectation))
    ) {
      return true;
    }

    const cdMatch = segment.match(/\bcd\s+([^\s]+)/iu);
    if (cdMatch) {
      cwdIsReviewWorktree = /(?:\$PWD\/)?\.review-worktrees\/42(?:\/|["']?$)/u.test(cdMatch[1] ?? "");
    }
  }
  return false;
}

function integrityPassed(integrity: ReviewFixtureIntegrity): boolean {
  return Object.values(integrity).every(Boolean);
}

type TrustedFetchKind = "pull" | "source";

type FetchHeadPair = {
  checkCompletedIndex: number;
  checkCompletedOrder: number;
  fetchStartedIndex: number;
  fetchStartedOrder: number;
  kind: TrustedFetchKind;
};

function trustedFetchKind(command: string, expectation: ReviewFixtureExpectation): TrustedFetchKind | null {
  const structure = shellStructure(command);
  if (structure.operators.length > 0 || structure.segments.length !== 1) return null;
  const invocation = gitInvocation(structure.segments[0] ?? "");
  if (invocation?.command !== "fetch" || invocation.args.length !== 2 || invocation.args[0] !== "origin") return null;
  const ref = normalizeShellToken(invocation.args[1] ?? "");
  if (ref === `refs/heads/${expectation.headRefName}`) return "source";
  if (ref === `refs/pull/${expectation.prNumber}/head`) return "pull";
  return null;
}

function fetchHeadEqualityCheck(command: string, expectation: ReviewFixtureExpectation): boolean {
  const structure = shellStructure(command);
  if (structure.operators.length > 0 || structure.segments.length !== 1) return false;
  const segment = structure.segments[0] ?? "";
  if (hasUnquotedRedirection(segment) || !substitutionsAllowed(segment)) return false;
  const normalized = segment.replace(/["']/gu, "").replace(/\s+/gu, " ").trim();
  const expectedValues = new Set(["$RUN_HEAD", expectation.headOid]);
  const match = normalized.match(/^test \$\(git -C (context-tree|\$TREE_PATH) rev-parse FETCH_HEAD\) = ([^\s]+)$/u);
  return match !== null && expectedValues.has(match[2] ?? "");
}

function commandBatchesFetchHeadFence(command: string, expectation: ReviewFixtureExpectation): boolean {
  const structure = shellStructure(command);
  if (structure.segments.length <= 1) return false;
  return structure.segments.some((segment) => {
    const invocation = gitInvocation(segment);
    if (invocation?.command === "fetch") {
      const ref = normalizeShellToken(invocation.args[1] ?? "");
      return ref === `refs/heads/${expectation.headRefName}` || ref === `refs/pull/${expectation.prNumber}/head`;
    }
    return /\brev-parse\s+FETCH_HEAD\b/u.test(segment);
  });
}

function containsPairSequence(pairs: readonly FetchHeadPair[]): boolean {
  let sourceCompletedIndex = -1;
  for (const pair of pairs) {
    if (pair.kind === "source") sourceCompletedIndex = pair.checkCompletedIndex;
    if (pair.kind === "pull" && sourceCompletedIndex >= 0 && pair.fetchStartedIndex > sourceCompletedIndex) return true;
  }
  return false;
}

function containsSourcePair(pairs: readonly FetchHeadPair[]): boolean {
  return pairs.some((pair) => pair.kind === "source");
}

function fetchHeadChecksCompletionOrdered(
  events: readonly unknown[],
  expectation: ReviewFixtureExpectation,
  firstViewOrder: number,
  firstVerifyOrder: number,
  finalViewOrder: number,
  reviewOrder: number,
): boolean {
  let lifecycleObserved = false;
  let invalid = false;
  let activeFetch: { id: string; kind: TrustedFetchKind; startedIndex: number; startedOrder: number } | null = null;
  let pendingFetch: {
    completedIndex: number;
    kind: TrustedFetchKind;
    startedIndex: number;
    startedOrder: number;
  } | null = null;
  let activeCheck: {
    fetch: { completedIndex: number; kind: TrustedFetchKind; startedIndex: number; startedOrder: number };
    id: string;
    startedIndex: number;
  } | null = null;
  const pairs: FetchHeadPair[] = [];

  events.forEach((event, index) => {
    const command = commandFromCodexEvent(event);
    if (!command) return;
    if (commandBatchesFetchHeadFence(command, expectation)) invalid = true;
    if (!isRecord(event) || !isRecord(event.event) || !isRecord(event.event.item)) return;
    const item = event.event.item;
    const status = item.status;
    if (status !== "in_progress" && status !== "completed" && status !== "failed") return;
    const fetchKind = trustedFetchKind(command, expectation);
    const isCheck = fetchHeadEqualityCheck(command, expectation);
    if (!fetchKind && !isCheck) return;
    if (status === "in_progress") lifecycleObserved = true;
    if (!lifecycleObserved) return;
    const id = typeof item.id === "string" ? item.id : null;
    if (!id) {
      invalid = true;
      return;
    }

    if (fetchKind) {
      if (status === "in_progress") {
        if (activeFetch || pendingFetch || activeCheck) invalid = true;
        else activeFetch = { id, kind: fetchKind, startedIndex: index, startedOrder: eventOrder(event, index) };
        return;
      }
      if (!activeFetch || activeFetch.id !== id || activeFetch.kind !== fetchKind) {
        invalid = true;
        return;
      }
      const completedFetch = activeFetch;
      activeFetch = null;
      if (status !== "completed" || item.exit_code !== 0) {
        invalid = true;
        return;
      }
      pendingFetch = {
        completedIndex: index,
        kind: completedFetch.kind,
        startedIndex: completedFetch.startedIndex,
        startedOrder: completedFetch.startedOrder,
      };
      return;
    }

    if (status === "in_progress") {
      if (activeFetch || !pendingFetch || activeCheck) {
        invalid = true;
        return;
      }
      activeCheck = { fetch: pendingFetch, id, startedIndex: index };
      return;
    }
    if (!activeCheck || activeCheck.id !== id || activeCheck.startedIndex <= activeCheck.fetch.completedIndex) {
      invalid = true;
      return;
    }
    const completedCheck = activeCheck;
    activeCheck = null;
    pendingFetch = null;
    if (status !== "completed" || item.exit_code !== 0) {
      invalid = true;
      return;
    }
    pairs.push({
      checkCompletedIndex: index,
      checkCompletedOrder: eventOrder(event, index),
      fetchStartedIndex: completedCheck.fetch.startedIndex,
      fetchStartedOrder: completedCheck.fetch.startedOrder,
      kind: completedCheck.fetch.kind,
    });
  });

  if (invalid || activeFetch || pendingFetch || activeCheck) return false;
  // Existing compact unit fixtures intentionally omit command lifecycle
  // events. Live provider traces always contain them and are fail-closed.
  if (!lifecycleObserved) return true;
  if (reviewOrder < 0) return true;
  const initialFence = pairs.filter(
    (pair) => pair.fetchStartedOrder > firstViewOrder && pair.checkCompletedOrder < firstVerifyOrder,
  );
  const preVerdictFence = pairs.filter(
    (pair) => pair.fetchStartedOrder > finalViewOrder && pair.checkCompletedOrder < reviewOrder,
  );
  // Snapshot construction proves both the live source ref and GitHub's PR ref.
  // Later exact-head boundaries re-read the live PR and re-prove only the
  // remote source head, matching the product contract without inventing a
  // second PR-ref requirement for every edit/verdict/merge boundary.
  return containsPairSequence(initialFence) && containsSourcePair(preVerdictFence);
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
  const reviewEvents: ReviewEvent[] = [];
  const viewEvents: ViewEvent[] = [];
  const localMergeEvents: LocalMergeEvent[] = [];
  let blockedGithubAttempts = 0;
  let identityIndex = -1;
  let runtimeIdentityIndex = -1;
  const runtimeIdentityChecks = new Set<RuntimeIdentityCheck>();
  let invalidVerifyAttempts = 0;
  let mainTreeReadObserved = false;
  let mutationObserved = false;
  let firstVerifyIndex = -1;
  let firstVerifyOrder = -1;
  let firstReviewIndex = -1;
  let firstSemanticReadIndex = -1;
  let firstSemanticReadOrder = -1;
  const governedReadOrders = new Map<string, number>();
  const treeContentReadOrders: number[] = [];
  const gitSemanticReadOrders: number[] = [];

  events.forEach((event, index) => {
    if (skillRead(event, expectation)) skillFileReadObserved = true;
    if (firstTreeReadSkillRead(event, expectation)) firstTreeReadLoaded = true;
    if (mainTreeReadAttempted(event)) mainTreeReadObserved = true;
    if (mutationAttempted(event, expectation)) mutationObserved = true;
    const order = eventOrder(event, index);
    if (isRecord(event) && event.type === "codex_event" && isRecord(event.event) && isRecord(event.event.item)) {
      const item = event.event.item;
      if (item.type === "command_execution" && item.status === "completed" && item.exit_code === 0) {
        const command = commandFromCodexEvent(event);
        if (command) {
          for (const segment of shellSegments(command)) {
            const check = runtimeIdentityCheck(segment, expectation);
            if (check) runtimeIdentityChecks.add(check);
          }
          if (runtimeIdentityChecks.size === 3 && runtimeIdentityIndex < 0) runtimeIdentityIndex = index;
        }
      }
    }
    const observedPaths = snapshotReadPaths(event, expectation, true);
    for (const governedPath of expectation.governedPaths) {
      if (observedPaths.includes(governedPath) && !governedReadOrders.has(governedPath)) {
        governedReadOrders.set(governedPath, order);
      }
    }
    if (treeContentReadPaths(event, expectation).length > 0) treeContentReadOrders.push(order);
    if (gitSemanticReadAttempted(event)) gitSemanticReadOrders.push(order);
    if (semanticReadAttempted(event, expectation) && firstSemanticReadIndex < 0) {
      firstSemanticReadIndex = index;
      firstSemanticReadOrder = order;
    }
    if (!isRecord(event)) return;
    if (
      event.type === "github_pr_merged" &&
      typeof event.commitOid === "string" &&
      typeof event.prNumber === "number" &&
      typeof event.repo === "string"
    ) {
      localMergeEvents.push({
        commitOid: event.commitOid,
        eventIndex: index,
        prNumber: event.prNumber,
        repo: event.repo,
      });
    }
    if (event.type === "github_identity_read" && event.login === expectation.reviewerLogin && identityIndex < 0) {
      identityIndex = index;
    }
    if (event.type === "gh_result" && (event.blockedByEval === true || event.reviewFixtureViolation === true)) {
      blockedGithubAttempts += 1;
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
      if (typeof event.exitCode === "number") verifyExitCodes.push(event.exitCode);
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
          bodyFilePath: typeof event.bodyFile === "string" ? event.bodyFile : "",
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
    finalView.headRefOid === expectation.expectedFinalHeadOid &&
    finalView.state === expectation.expectedFinalState &&
    finalView.isDraft === expectation.expectedFinalDraft &&
    finalView.eventIndex > firstVerifyIndex;
  const semanticReadAfterVerify =
    expectation.governedPaths.length > 0 &&
    expectation.governedPaths.every((path) => (governedReadOrders.get(path) ?? -1) > firstVerifyOrder);
  const semanticReadAfterFailedVerify =
    verifyExitCodes[0] !== undefined &&
    verifyExitCodes[0] !== 0 &&
    [...treeContentReadOrders, ...gitSemanticReadOrders].some((order) => order > firstVerifyOrder);
  const semanticReadBeforeVerify = firstSemanticReadOrder >= 0 && firstSemanticReadOrder < firstVerifyOrder;
  const submissionRaceContained =
    review !== undefined &&
    review.commitOid === expectation.headOid &&
    review.currentHeadOid === expectation.submissionHeadOid &&
    review.currentHeadOid !== review.commitOid;
  const fetchHeadChecksOrdered = fetchHeadChecksCompletionOrdered(
    events,
    expectation,
    firstView ? eventOrder(events[firstView.eventIndex], firstView.eventIndex) : -1,
    firstVerifyOrder,
    finalView ? eventOrder(events[finalView.eventIndex], finalView.eventIndex) : -1,
    review ? eventOrder(events[review.eventIndex], review.eventIndex) : -1,
  );
  const mergeAllowed = evalCase.fixture.scenario === "passing" && evalCase.expected.action === "approve";
  const localMergeValid =
    localMergeEvents.length <= 1 &&
    localMergeEvents.every(
      (merge) =>
        mergeAllowed &&
        merge.commitOid === expectation.headOid &&
        merge.prNumber === expectation.prNumber &&
        merge.repo === expectation.repo &&
        review !== undefined &&
        merge.eventIndex > review.eventIndex,
    );
  return {
    blockedGithubAttempts,
    bodyHintsObserved: evalCase.expected.bodyHints.every((hint) => body.includes(hint.toLowerCase())),
    expectedHeadingObserved:
      evalCase.expected.firstHeading === undefined || firstHeading?.startsWith(evalCase.expected.firstHeading) === true,
    fetchHeadChecksCompletionOrdered: fetchHeadChecksOrdered,
    finalViewFresh,
    firstTreeReadLoaded,
    firstTreeVerifyCalls: verifyExitCodes.length,
    fixtureIntegrity,
    ghReviewCalls: reviewEvents.length,
    identityReadObserved: identityIndex >= 0 && (firstView === undefined || identityIndex < firstView.eventIndex),
    initialViewObserved,
    localMergeAttempts: localMergeEvents.length,
    localMergeValid,
    mainTreeReadAttempted: mainTreeReadObserved,
    mutationAttempted: mutationObserved,
    reviewAfterFinalView:
      review === undefined
        ? evalCase.expected.action === "none"
        : finalView !== undefined && review.eventIndex > finalView.eventIndex,
    reviewCommitBound: reviewEvents.length > 0 && reviewEvents.every((item) => item.commitOid === expectation.headOid),
    reviewEvents,
    runnerExitCode,
    runtimeIdentityChecksObserved:
      runtimeIdentityIndex >= 0 && (firstView === undefined || runtimeIdentityIndex < firstView.eventIndex),
    skillFileReadObserved,
    semanticReadAfterVerify,
    semanticReadAfterFailedVerify,
    semanticReadBeforeVerify,
    submissionRaceContained,
    targetMatches,
    verifyExitCodes,
    verifyFirst: firstVerifyIndex >= 0 && (firstReviewIndex < 0 || firstReviewIndex > firstVerifyIndex),
    verifyHeadBound: invalidVerifyAttempts === 0 && verifyExitCodes.length === 1,
    viewEvents,
  };
}

export function casePassed(evalCase: ContextTreeReviewEvalCase, metrics: EvalMetrics): boolean {
  const review = metrics.reviewEvents[0];
  const verifyStatus = evalCase.expected.verifyMustPass
    ? metrics.verifyExitCodes[0] === 0
    : metrics.verifyExitCodes[0] !== undefined && metrics.verifyExitCodes[0] !== 0;
  const outcomePass =
    evalCase.expected.action === "none"
      ? metrics.ghReviewCalls === 0
      : metrics.ghReviewCalls === 1 &&
        review?.action === evalCase.expected.action &&
        review.bodyFileUsed &&
        review.bodyFilePath === `.review-body-${review.prNumber}.md` &&
        metrics.reviewCommitBound &&
        metrics.bodyHintsObserved &&
        metrics.expectedHeadingObserved &&
        metrics.reviewAfterFinalView;
  const raceBehaviorPass = metrics.submissionRaceContained === (evalCase.fixture.scenario === "submission-race");
  return (
    metrics.runnerExitCode === 0 &&
    metrics.skillFileReadObserved &&
    !metrics.firstTreeReadLoaded &&
    !metrics.mainTreeReadAttempted &&
    metrics.identityReadObserved &&
    metrics.runtimeIdentityChecksObserved &&
    metrics.initialViewObserved &&
    metrics.fetchHeadChecksCompletionOrdered &&
    metrics.verifyFirst &&
    metrics.verifyHeadBound &&
    !metrics.semanticReadBeforeVerify &&
    !metrics.semanticReadAfterFailedVerify &&
    (!evalCase.expected.verifyMustPass ||
      evalCase.fixture.scenario === "archive-only" ||
      evalCase.fixture.scenario === "stale-head" ||
      metrics.semanticReadAfterVerify) &&
    verifyStatus &&
    metrics.finalViewFresh &&
    metrics.targetMatches &&
    metrics.blockedGithubAttempts === 0 &&
    metrics.localMergeValid &&
    !metrics.mutationAttempted &&
    integrityPassed(metrics.fixtureIntegrity) &&
    raceBehaviorPass &&
    outcomePass
  );
}
