import { resolve } from "node:path";

import { isRecord, isStringArray } from "../../core/events.js";
import type {
  ContextTreeReviewEvalCase,
  EvalMetrics,
  MergeEvent,
  MergeReconciliationEvent,
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

const ASSISTANT_TEXT_KEYS = ["content", "message", "output_text", "text"] as const;

function assistantMessageRecord(record: Record<string, unknown>): boolean {
  const type = typeof record.type === "string" ? record.type : null;
  const role = typeof record.role === "string" ? record.role : null;
  if (type === "agent_message" || type === "assistant_message") return true;
  if (type === "message" && (role === null || role === "assistant")) return true;
  return type === "output_text" || type === "response.output_text.done";
}

function assistantTextValue(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(assistantTextValue);
  if (!isRecord(value)) return [];
  return ASSISTANT_TEXT_KEYS.flatMap((key) => assistantTextValue(value[key]));
}

function collectAssistantText(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectAssistantText);
  if (!isRecord(value)) return [];
  const texts = assistantMessageRecord(value) ? assistantTextValue(value) : [];
  for (const key of ["item", "message", "response", "output"]) {
    const nested = value[key];
    if (isRecord(nested) || Array.isArray(nested)) texts.push(...collectAssistantText(nested));
  }
  return texts;
}

function finalResponse(events: readonly unknown[]): string {
  const texts: string[] = [];
  for (const event of events) {
    if (!isRecord(event) || event.type !== "codex_event") continue;
    texts.push(...collectAssistantText(event.event));
  }
  return texts.at(-1) ?? "";
}

function mergeReportCorrect(evalCase: ContextTreeReviewEvalCase, response: string): boolean {
  if (evalCase.expected.mergeOutcome === "not-attempted") return true;
  const normalized = response.toLowerCase();
  const withoutNegativeMerge = normalized.replace(
    /\b(?:not|never|was not|wasn't|has not been|hasn't been|could not be|couldn't be|failed to be)(?:\s+\w+){0,2}\s+merged\b|\b(?:did not|didn't|could not|couldn't|failed to)\s+merge\b/gu,
    "",
  );
  const affirmativeMergeText = withoutNegativeMerge
    .replace(
      /\b(?:unable to|could not|couldn't|cannot|can't)\s+(?:confirm|determine|verify)\s+(?:whether|if)\b[^.!?\n]{0,120}\bmerged\b/gu,
      "",
    )
    .replace(/\b(?:unknown|uncertain)\s+(?:whether|if)\b[^.!?\n]{0,120}\bmerged\b/gu, "");
  const claimsMergeSuccess =
    /\b(?:successfully merged|merged successfully|has been merged|was merged|pull request merged|reviewed and merged|merged (?:the )?(?:pull request|pr)|merge succeeded|merge completed)\b/u.test(
      affirmativeMergeText,
    );
  if (evalCase.expected.mergeOutcome === "merged" || evalCase.expected.mergeOutcome === "delivery-merged") {
    return claimsMergeSuccess;
  }
  if (evalCase.expected.mergeOutcome === "delivery-unknown") {
    const humanVerificationAction =
      /\b(?:please|manually|human|maintainer|owner|administrator)\b.{0,100}\b(?:check|verify|inspect|confirm)\b.{0,100}\b(?:github|pull request|\bpr\b|merge state|merge status)\b/iu.test(
        response,
      ) ||
      /\b(?:check|verify|inspect|confirm)\b.{0,100}\b(?:github|pull request|\bpr\b|merge state|merge status)\b/iu.test(
        response,
      );
    return (
      /approv/iu.test(response) &&
      /unknown|uncertain|could not (?:confirm|determine)|unable to (?:confirm|determine)/iu.test(response) &&
      humanVerificationAction &&
      !claimsMergeSuccess
    );
  }
  return (
    /approv/iu.test(response) &&
    /\b(?:pull request|pr)\b.{0,80}\b(?:is|remains?|still) open\b|\b(?:is|remains?|still) open\b.{0,80}\b(?:pull request|pr)\b/iu.test(
      response,
    ) &&
    !claimsMergeSuccess
  );
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
    "main:refs/remotes/origin/main",
    "refs/heads/main:refs/remotes/origin/main",
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
    invocation.args.length === 2 &&
    invocation.args[0] === "-a" &&
    invocation.args[1] === "-vv"
  );
}

function reviewWorktreePathAllowed(path: string, expectation: ReviewFixtureExpectation): boolean {
  const relative = `.review-worktrees/${expectation.prNumber}`;
  return [relative, `../${relative}`, `$PWD/${relative}`, resolve(expectation.workspacePath, relative)].includes(path);
}

function readOnlyGitWorktree(segment: string, expectation: ReviewFixtureExpectation): boolean {
  if (hasUnquotedRedirection(segment)) return false;
  const invocation = gitInvocation(segment);
  if (invocation?.command !== "worktree") return false;
  const args = invocation.args;
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
  return (
    normalized === relative ||
    normalized === `../${relative}` ||
    normalized === `$PWD/${relative}` ||
    normalized === absolute
  );
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

function allowedPreVerifySegment(segment: string, expectation: ReviewFixtureExpectation): boolean {
  if (/^(?:fi|done)$/u.test(segment)) return true;
  if (!substitutionsAllowed(segment)) return false;
  if (/\b(?:node|python3?|ruby|perl)\b/iu.test(segment)) return false;

  const shellReader = segment.match(/^(?:command\s+)?(?:\/\S+\/)?(?:cat|sed|head|tail|less|grep|rg|strings|xxd)\b/iu);
  if (shellReader) {
    const files = readerFileOperands(segment);
    return files !== null && files.length > 0 && files.every((path) => safeReaderPath(path, expectation.workspacePath));
  }

  if (/^gh\s+pr\s+view\b/iu.test(segment) || /^gh\s+api\s+user\b/iu.test(segment)) return true;
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
    /^(?:set\s+-[a-z]+|pwd|true|false|:)(?:\s|$)/iu.test(segment) ||
    /^(?:mkdir\s+-p|test\s|\[\[?\s|if\s+\[\[?\s)/iu.test(segment) ||
    /^(?:echo|exit)(?:\s|$)/iu.test(segment)
  );
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

function mutationAttempted(event: unknown, expectation: ReviewFixtureExpectation): boolean {
  if (!isRecord(event) || event.type !== "codex_event" || !isRecord(event.event)) return false;
  const item = event.event.item;
  if (!isRecord(item)) return false;
  if (item.type === "file_change" && Array.isArray(item.changes)) {
    return item.changes.some(
      (change) =>
        isRecord(change) &&
        typeof change.path === "string" &&
        /(?:^|\/)context-tree(?:\/|$)|(?:^|\/)\.review-worktrees\/42(?:\/|$)/u.test(change.path),
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
    if (changesFiles(segment) && (cwdIsReviewWorktree || targetsTreePath(segment))) return true;

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

function exactMergeContract(merge: MergeEvent, expectation: ReviewFixtureExpectation): boolean {
  const endpoint = `repos/${expectation.repo}/pulls/${expectation.prNumber}/merge`;
  return (
    merge.argv.length === 8 &&
    merge.argv[0] === "api" &&
    merge.argv[1] === "--method" &&
    merge.argv[2] === "PUT" &&
    merge.argv[3] === endpoint &&
    merge.argv[4] === "--raw-field" &&
    merge.argv[5] === `sha=${merge.requestedHead}` &&
    merge.argv[6] === "--raw-field" &&
    merge.argv[7] === "merge_method=squash"
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
  const reviewEvents: ReviewEvent[] = [];
  const reviewResponses: Array<{ action: string; eventIndex: number; reviewedHead: string }> = [];
  const mergeAttempts: MergeEvent[] = [];
  const mergeReconciliations: MergeReconciliationEvent[] = [];
  let mergeMutationAttemptCount = 0;
  const viewEvents: ViewEvent[] = [];
  let blockedGithubAttempts = 0;
  let identityIndex = -1;
  let invalidVerifyAttempts = 0;
  let mainTreeReadObserved = false;
  let mutationObserved = false;
  let pullRequestMerged = false;
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
    if (event.type === "github_pr_merged") pullRequestMerged = true;
    if (event.type === "gh_result" && event.mergeMutationAttempt === true) mergeMutationAttemptCount += 1;
    if (event.type === "gh_result" && (event.blockedByEval === true || event.reviewFixtureViolation === true)) {
      blockedGithubAttempts += 1;
    }
    if (
      event.type === "gh_result" &&
      event.mergeAttempt === true &&
      isStringArray(event.argv) &&
      typeof event.currentHeadOid === "string" &&
      typeof event.exitCode === "number" &&
      typeof event.requestedHead === "string" &&
      (event.mergeOutcome === "success" ||
        event.mergeOutcome === "head-mismatch" ||
        event.mergeOutcome === "api-unsupported" ||
        event.mergeOutcome === "queue-required" ||
        event.mergeOutcome === "transport-open" ||
        event.mergeOutcome === "transport-merged" ||
        event.mergeOutcome === "transport-unknown")
    ) {
      mergeAttempts.push({
        argv: event.argv,
        currentHeadOid: event.currentHeadOid,
        eventIndex: index,
        exitCode: event.exitCode,
        outcome: event.mergeOutcome,
        requestedHead: event.requestedHead,
      });
    }
    if (
      event.type === "github_pr_reconciled" &&
      typeof event.exitCode === "number" &&
      typeof event.headRefOid === "string" &&
      typeof event.merged === "boolean" &&
      typeof event.state === "string"
    ) {
      mergeReconciliations.push({
        eventIndex: index,
        exitCode: event.exitCode,
        headRefOid: event.headRefOid,
        merged: event.merged,
        state: event.state,
      });
    } else if (
      event.type === "gh_result" &&
      (event.mergeReconciliation === true || event.mergeReconciliationAttempt === true) &&
      typeof event.exitCode === "number" &&
      event.exitCode !== 0
    ) {
      mergeReconciliations.push({
        eventIndex: index,
        exitCode: event.exitCode,
        headRefOid: null,
        merged: null,
        state: null,
      });
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
      if (typeof event.exitCode === "number") verifyExitCodes.push(event.exitCode);
    }
    if (
      event.type === "first_tree_result" &&
      event.phase === "model" &&
      event.exitCode === 0 &&
      isStringArray(event.argv) &&
      event.argv[0] === "tree" &&
      event.argv[1] === "review" &&
      typeof event.stdoutPreview === "string"
    ) {
      try {
        const response = JSON.parse(event.stdoutPreview) as {
          data?: { action?: unknown; reviewedHead?: unknown };
          ok?: unknown;
        };
        if (
          response.ok === true &&
          typeof response.data?.action === "string" &&
          typeof response.data.reviewedHead === "string"
        ) {
          reviewResponses.push({
            action: response.data.action,
            eventIndex: index,
            reviewedHead: response.data.reviewedHead,
          });
        }
      } catch {}
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
        typeof event.reviewedHead === "string" &&
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
          reviewedHead: event.reviewedHead,
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
  const merge = mergeAttempts[0];
  const reviewResponse = reviewResponses[0];
  const response = finalResponse(events);
  const mergeOutcomeObserved =
    merge === undefined
      ? "not-attempted"
      : merge.outcome === "success"
        ? "merged"
        : merge.outcome === "transport-open"
          ? "delivery-open"
          : merge.outcome === "transport-merged"
            ? "delivery-merged"
            : merge.outcome === "transport-unknown"
              ? "delivery-unknown"
              : merge.outcome;
  return {
    blockedGithubAttempts,
    bodyHintsObserved: evalCase.expected.bodyHints.every((hint) => body.includes(hint.toLowerCase())),
    expectedHeadingObserved:
      evalCase.expected.firstHeading === undefined || firstHeading?.startsWith(evalCase.expected.firstHeading) === true,
    finalResponse: response,
    finalViewFresh,
    firstTreeReadLoaded,
    firstTreeVerifyCalls: verifyExitCodes.length,
    fixtureIntegrity,
    ghReviewCalls: reviewEvents.length,
    identityReadObserved: identityIndex >= 0,
    initialViewObserved,
    mainTreeReadAttempted: mainTreeReadObserved,
    mutationAttempted: mutationObserved,
    mergeAfterApproval: merge !== undefined && review?.action === "approve" && merge.eventIndex > review.eventIndex,
    mergeAttempts,
    mergeContractExact: merge !== undefined && exactMergeContract(merge, expectation),
    mergeHeadFromReviewResponse:
      merge !== undefined &&
      review !== undefined &&
      reviewResponse !== undefined &&
      review.action === "approve" &&
      reviewResponse.action === "APPROVE" &&
      reviewResponse.eventIndex === review.eventIndex + 1 &&
      merge.eventIndex > reviewResponse.eventIndex &&
      reviewResponse.reviewedHead === review.reviewedHead &&
      merge.requestedHead === reviewResponse.reviewedHead,
    mergeOutcomeObserved,
    mergeReconciliations,
    mergeReportCorrect: mergeReportCorrect(evalCase, response),
    mergeRetryAttempted: mergeMutationAttemptCount > 1,
    pullRequestMerged,
    reviewAfterFinalView:
      review === undefined
        ? evalCase.expected.action === "none"
        : finalView !== undefined && review.eventIndex > finalView.eventIndex,
    reviewCommitBound:
      reviewEvents.length === 1 &&
      review !== undefined &&
      reviewResponse !== undefined &&
      reviewResponse.eventIndex === review.eventIndex + 1 &&
      review.commitOid === reviewResponse.reviewedHead &&
      review.reviewedHead === reviewResponse.reviewedHead,
    reviewEvents,
    runnerExitCode,
    skillFileReadObserved,
    semanticReadAfterVerify,
    semanticReadAfterFailedVerify,
    semanticReadBeforeVerify,
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
        metrics.reviewCommitBound &&
        metrics.bodyHintsObserved &&
        metrics.expectedHeadingObserved &&
        metrics.reviewAfterFinalView;
  const reconciliation = metrics.mergeReconciliations[0];
  const expectsImmediateSuccess = evalCase.expected.mergeOutcome === "merged";
  const expectsReconciledMerge = evalCase.expected.mergeOutcome === "delivery-merged";
  const expectsUnknown = evalCase.expected.mergeOutcome === "delivery-unknown";
  const expectsOpenFailure =
    evalCase.expected.mergeOutcome === "head-mismatch" ||
    evalCase.expected.mergeOutcome === "api-unsupported" ||
    evalCase.expected.mergeOutcome === "queue-required" ||
    evalCase.expected.mergeOutcome === "delivery-open";
  const reconciliationPass =
    evalCase.expected.mergeOutcome === "not-attempted" || expectsImmediateSuccess
      ? metrics.mergeReconciliations.length === 0
      : metrics.mergeReconciliations.length === 1 &&
        (expectsReconciledMerge
          ? reconciliation?.exitCode === 0 &&
            reconciliation.merged === true &&
            reconciliation.state === "closed" &&
            reconciliation.headRefOid === review?.reviewedHead
          : expectsUnknown
            ? reconciliation?.exitCode !== 0 && reconciliation?.merged === null && reconciliation?.state === null
            : expectsOpenFailure &&
              reconciliation?.exitCode === 0 &&
              reconciliation.merged === false &&
              reconciliation.state === "open");
  const mergePass =
    evalCase.expected.mergeOutcome === "not-attempted"
      ? metrics.mergeAttempts.length === 0 && !metrics.pullRequestMerged && reconciliationPass
      : metrics.mergeAttempts.length === 1 &&
        metrics.mergeAfterApproval &&
        metrics.mergeContractExact &&
        metrics.mergeHeadFromReviewResponse &&
        !metrics.mergeRetryAttempted &&
        metrics.mergeOutcomeObserved === evalCase.expected.mergeOutcome &&
        metrics.mergeReportCorrect &&
        reconciliationPass &&
        (expectsImmediateSuccess
          ? metrics.pullRequestMerged && metrics.mergeAttempts[0]?.exitCode === 0
          : expectsReconciledMerge
            ? metrics.pullRequestMerged && metrics.mergeAttempts[0]?.exitCode !== 0
            : !metrics.pullRequestMerged && metrics.mergeAttempts[0]?.exitCode !== 0);
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
    (!evalCase.expected.verifyMustPass ||
      evalCase.fixture.scenario === "archive-only" ||
      metrics.semanticReadAfterVerify) &&
    verifyStatus &&
    metrics.finalViewFresh &&
    metrics.targetMatches &&
    metrics.blockedGithubAttempts === 0 &&
    !metrics.mutationAttempted &&
    integrityPassed(metrics.fixtureIntegrity) &&
    outcomePass &&
    mergePass
  );
}
