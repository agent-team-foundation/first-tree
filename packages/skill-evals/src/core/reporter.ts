import { isRecord, isStringArray, previewText } from "./events.js";
import type { CommandResult } from "./types.js";

export type EvalReporter = {
  caseFinished(passed: boolean): void;
  caseStarted(): void;
  codexEvent(event: unknown): void;
  codexProcessFinished(exitCode: number): void;
  codexProcessStarted(args: readonly string[]): void;
  codexSpawnError(error: Error): void;
  codexStderrLine(line: string): void;
  codexStdoutLine(line: string): void;
  fixtureSetupFinished(workspaceKind: string, contextTreePath: string | null): void;
  fixtureSetupStarted(workspaceKind: string): void;
  fixtureValidationFinished(result: CommandResult): void;
  fixtureValidationSkipped(): void;
  fixtureValidationStarted(args: readonly string[], contextTreePath: string): void;
  shimTraceLines(text: string): void;
  summaryWritten(summaryJsonPath: string, summaryMdPath: string): void;
};

const CODex_EVENT_PREVIEW_LENGTH = 240;
const SHIM_TRACE_PATTERN = /^\[[^\]\r\n]+\] first-tree (call|result):/u;
const TEXT_KEYS = ["content", "message", "text"];
const FINAL_TYPE_PATTERN = /(?:agent_message|final|response\.completed|turn\.completed|message)/iu;

export function isShimTraceLine(line: string): boolean {
  return SHIM_TRACE_PATTERN.test(normalizeLine(line));
}

export function stripShimTraceLines(text: string): string {
  if (!text.includes("first-tree ")) return text;
  return text
    .split("\n")
    .filter((line) => !isShimTraceLine(line))
    .join("\n");
}

export function createEvalReporter(caseId: string, verbose: boolean): EvalReporter {
  if (!verbose) return SILENT_REPORTER;

  function write(message: string): void {
    process.stderr.write(`[${caseId}] ${message}\n`);
  }

  function writeShimTrace(line: string): void {
    process.stderr.write(`${normalizeLine(line)}\n`);
  }

  return {
    caseFinished(passed) {
      write(`case ${passed ? "passed" : "failed"}`);
    },
    caseStarted() {
      write("case started");
    },
    codexEvent(event) {
      const shimLines = collectShimTraceLines(event);
      for (const line of shimLines) {
        writeShimTrace(line);
      }

      const projection = projectCodexEvent(event, shimLines.length > 0);
      if (projection !== null) {
        write(projection);
      }
    },
    codexProcessFinished(exitCode) {
      write(`codex exec finished: exit=${exitCode}`);
    },
    codexProcessStarted(args) {
      write(`codex exec started: ${formatCommand(["codex", ...args])}`);
    },
    codexSpawnError(error) {
      write(`codex exec spawn error: ${previewText(error.message, CODex_EVENT_PREVIEW_LENGTH)}`);
    },
    codexStderrLine(line) {
      if (isShimTraceLine(line)) {
        writeShimTrace(line);
        return;
      }
      write(`codex stderr: ${previewText(line, CODex_EVENT_PREVIEW_LENGTH)}`);
    },
    codexStdoutLine(line) {
      write(`codex stdout: ${previewText(line, CODex_EVENT_PREVIEW_LENGTH)}`);
    },
    fixtureSetupFinished(workspaceKind, contextTreePath) {
      const suffix = contextTreePath === null ? "" : `: ${contextTreePath}`;
      write(`fixture setup done: ${workspaceKind}${suffix}`);
    },
    fixtureSetupStarted(workspaceKind) {
      write(`fixture setup: ${workspaceKind}`);
    },
    fixtureValidationFinished(result) {
      write(`fixture validation ${result.exitCode === 0 ? "passed" : "failed"}: exit=${result.exitCode}`);
    },
    fixtureValidationSkipped() {
      write("fixture validation skipped");
    },
    fixtureValidationStarted(args, contextTreePath) {
      write(`fixture validation: ${formatCommand(["first-tree", ...args])} (${contextTreePath})`);
    },
    shimTraceLines(text) {
      for (const line of collectShimTraceLines(text)) {
        writeShimTrace(line);
      }
    },
    summaryWritten(summaryJsonPath) {
      write(`summary written: ${summaryJsonPath}`);
    },
  };
}

function normalizeLine(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function formatCommand(args: readonly string[]): string {
  return args.map(formatArg).join(" ");
}

function formatArg(arg: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/u.test(arg)) return arg;
  return JSON.stringify(arg);
}

function collectShimTraceLines(value: unknown): string[] {
  const lines: string[] = [];

  function visit(candidate: unknown): void {
    if (typeof candidate === "string") {
      for (const line of candidate.split("\n")) {
        const normalized = normalizeLine(line);
        if (isShimTraceLine(normalized)) lines.push(normalized);
      }
      return;
    }

    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        visit(item);
      }
      return;
    }

    if (isRecord(candidate)) {
      for (const item of Object.values(candidate)) {
        visit(item);
      }
    }
  }

  visit(value);
  return lines;
}

function projectCodexEvent(event: unknown, containsShimTrace: boolean): string | null {
  const type = findEventType(event);
  const command = findCommand(event);
  if (command !== null) {
    return `codex tool: ${previewText(command, CODex_EVENT_PREVIEW_LENGTH)}`;
  }

  const output = outputPreview(event);
  if (output !== null) {
    if (containsShimTrace && output.length === 0) return null;
    return `codex output: ${output}`;
  }

  const finalMessage = finalMessagePreview(event, type);
  if (finalMessage !== null) {
    return `codex final: ${finalMessage}`;
  }

  if (type !== null) {
    return `codex event: ${type}`;
  }

  return `codex event: ${previewText(safeJsonPreview(event), CODex_EVENT_PREVIEW_LENGTH)}`;
}

function outputPreview(event: unknown): string | null {
  const stdout = findStringByKey(event, ["stdout", "stdoutPreview"]);
  const stderr = stripShimTraceLines(findStringByKey(event, ["stderr", "stderrPreview"]) ?? "");
  const output = findStringByKey(event, ["output"]);
  const pieces: string[] = [];

  const stdoutText = stdout?.trim();
  if (stdoutText) {
    pieces.push(`stdout=${previewText(stdoutText, CODex_EVENT_PREVIEW_LENGTH)}`);
  }
  if (stderr.trim()) {
    pieces.push(`stderr=${previewText(stderr.trim(), CODex_EVENT_PREVIEW_LENGTH)}`);
  }
  if (pieces.length === 0 && output !== null && output.trim()) {
    pieces.push(previewText(output.trim(), CODex_EVENT_PREVIEW_LENGTH));
  }

  return pieces.length > 0 ? pieces.join(" ") : null;
}

function finalMessagePreview(event: unknown, type: string | null): string | null {
  if (type === null || !FINAL_TYPE_PATTERN.test(type)) return null;
  const text = findStringByKey(event, TEXT_KEYS);
  if (text === null || !text.trim()) return null;
  return previewText(text.trim(), CODex_EVENT_PREVIEW_LENGTH);
}

function findCommand(event: unknown): string | null {
  const argv = findStringArrayByKey(event, ["argv", "args"]);
  if (argv !== null && argv.length > 0) {
    return formatCommand(argv);
  }

  const directCommand = findStringByKey(event, ["command", "cmd"]);
  const directCommandText = directCommand?.trim();
  if (directCommandText) {
    return directCommandText;
  }

  const argumentsText = findStringByKey(event, ["arguments"]);
  if (argumentsText === null) return null;

  const parsed = parseJson(argumentsText);
  if (parsed === null) return null;
  const nestedArgv = findStringArrayByKey(parsed, ["argv", "args"]);
  if (nestedArgv !== null && nestedArgv.length > 0) {
    return formatCommand(nestedArgv);
  }
  const nestedCommand = findStringByKey(parsed, ["command", "cmd"]);
  const nestedCommandText = nestedCommand?.trim();
  if (nestedCommandText) {
    return nestedCommandText;
  }

  return null;
}

function findEventType(event: unknown): string | null {
  if (!isRecord(event)) return null;
  const type = event.type;
  if (typeof type === "string") return type;
  return null;
}

function findStringByKey(value: unknown, keys: readonly string[]): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStringByKey(item, keys);
      if (found !== null) return found;
    }
    return null;
  }

  if (!isRecord(value)) return null;

  for (const [key, item] of Object.entries(value)) {
    if (keys.includes(key) && typeof item === "string") {
      return item;
    }
  }

  for (const item of Object.values(value)) {
    const found = findStringByKey(item, keys);
    if (found !== null) return found;
  }

  return null;
}

function findStringArrayByKey(value: unknown, keys: readonly string[]): string[] | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStringArrayByKey(item, keys);
      if (found !== null) return found;
    }
    return null;
  }

  if (!isRecord(value)) return null;

  for (const [key, item] of Object.entries(value)) {
    if (keys.includes(key) && isStringArray(item)) {
      return item;
    }
  }

  for (const item of Object.values(value)) {
    const found = findStringArrayByKey(item, keys);
    if (found !== null) return found;
  }

  return null;
}

function parseJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function safeJsonPreview(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    return json ?? String(value);
  } catch {
    return String(value);
  }
}

const SILENT_REPORTER: EvalReporter = {
  caseFinished() {},
  caseStarted() {},
  codexEvent() {},
  codexProcessFinished() {},
  codexProcessStarted() {},
  codexSpawnError() {},
  codexStderrLine() {},
  codexStdoutLine() {},
  fixtureSetupFinished() {},
  fixtureSetupStarted() {},
  fixtureValidationFinished() {},
  fixtureValidationSkipped() {},
  fixtureValidationStarted() {},
  shimTraceLines() {},
  summaryWritten() {},
};
