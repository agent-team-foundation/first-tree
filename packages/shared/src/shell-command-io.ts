export type ShellIoPathKindHint = "file" | "directory" | "unknown";

export type ShellIoPathArg = {
  raw: string;
  pathKindHint: ShellIoPathKindHint;
};

export type ShellIoUnsupportedReason =
  | "empty"
  | "unsupported_tool"
  | "complex_shell"
  | "write_or_mutation"
  | "no_explicit_path"
  | "dynamic_path";

export type ShellIoClassification =
  | {
      supported: true;
      action: "read";
      commandName: string;
      pathArgs: ShellIoPathArg[];
    }
  | {
      supported: false;
      reason: ShellIoUnsupportedReason;
      commandName?: string;
    };

type ShellToken = {
  value: string;
  dynamic: boolean;
};

type TokenizeResult =
  | {
      ok: true;
      tokens: ShellToken[];
    }
  | {
      ok: false;
      reason: ShellIoUnsupportedReason;
    };

const MUTATING_OR_AMBIGUOUS_TOOLS = new Set([
  "awk",
  "bash",
  "chmod",
  "chown",
  "cp",
  "dd",
  "echo",
  "install",
  "mkdir",
  "mv",
  "node",
  "perl",
  "printf",
  "python",
  "python3",
  "rm",
  "rmdir",
  "sed-i",
  "sh",
  "tee",
  "touch",
  "truncate",
  "xargs",
  "zsh",
]);

/**
 * Codex CLI (and any other runtime that shells out via the user's login shell)
 * wraps every command it emits as `/bin/<shell> -lc '<inner>'` — observed shells
 * include `bash` (Linux daemons), `zsh` (macOS daemons), and `sh`. Without
 * unwrapping, the outer shell basename hits {@link MUTATING_OR_AMBIGUOUS_TOOLS}
 * below and every codex read of a Context Tree file falls through to
 * `unsupported_shell_command`, breaking the Context tab's usage dashboard.
 * Both the client (file-ref extraction at emit time) and the server
 * (`shellToolCanRead` at record time) call into the same classifier, so this
 * one shared unwrap fixes both ends with no per-runtime adapter.
 */
const SHELL_WRAPPER_BASENAMES = new Set(["sh", "bash", "zsh"]);
const SHELL_WRAPPER_FLAGS = new Set(["-c", "-lc"]);
/**
 * Bound recursion so a pathological `bash -lc 'bash -lc "bash -lc ..."'`
 * chain (real or adversarial) can't loop. Two levels covers the codex case
 * with margin and matches the depth a human operator would reasonably write.
 */
const MAX_WRAPPER_UNWRAPS = 2;

const SIMPLE_FILE_READ_TOOLS = new Set(["cat", "head", "nl", "tail", "wc"]);
const HEAD_TAIL_VALUE_OPTIONS = new Set(["-c", "--bytes", "-n", "--lines"]);
const SED_SCRIPT_OPTIONS = new Set(["-e", "--expression", "-f", "--file"]);
const GREP_PATTERN_OPTIONS = new Set(["-e", "--regexp", "-f", "--file"]);
const GREP_VALUE_OPTIONS = new Set([
  ...GREP_PATTERN_OPTIONS,
  "-A",
  "--after-context",
  "-B",
  "--before-context",
  "-C",
  "--context",
  "-D",
  "--devices",
  "-d",
  "--directories",
  "-m",
  "--max-count",
  "--binary-files",
  "--color",
  "--colour",
  "--exclude",
  "--exclude-dir",
  "--exclude-from",
  "--group-separator",
  "--include",
  "--include-dir",
  "--label",
]);
const GREP_BOOLEAN_OPTIONS = new Set([
  "-a",
  "--text",
  "-b",
  "--byte-offset",
  "-c",
  "--count",
  "-E",
  "--extended-regexp",
  "-F",
  "--fixed-strings",
  "-G",
  "--basic-regexp",
  "-H",
  "--with-filename",
  "-h",
  "--no-filename",
  "-I",
  "-i",
  "--ignore-case",
  "-L",
  "--files-without-match",
  "-l",
  "--files-with-matches",
  "-n",
  "--line-number",
  "-o",
  "--only-matching",
  "-P",
  "--perl-regexp",
  "-q",
  "--quiet",
  "--silent",
  "-R",
  "-r",
  "--recursive",
  "--dereference-recursive",
  "-s",
  "--no-messages",
  "-U",
  "--binary",
  "-v",
  "--invert-match",
  "-w",
  "--word-regexp",
  "-x",
  "--line-regexp",
  "-z",
  "--null-data",
]);
const RG_VALUE_OPTIONS = new Set([
  "-A",
  "--after-context",
  "-B",
  "--before-context",
  "-C",
  "--context",
  "-e",
  "--regexp",
  "-f",
  "--file",
  "-g",
  "--glob",
  "-m",
  "--max-count",
  "-t",
  "--type",
  "-T",
  "--type-not",
]);
const FIND_MUTATING_PRIMARIES = new Set([
  "-delete",
  "-exec",
  "-execdir",
  "-fls",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-ok",
  "-okdir",
]);

function tokenizeSimpleShell(command: string): TokenizeResult {
  if (command.trim().length === 0) return { ok: false, reason: "empty" };

  const tokens: ShellToken[] = [];
  let value = "";
  let dynamic = false;
  let quote: "'" | '"' | null = null;

  const flush = (): void => {
    if (value.length === 0) return;
    tokens.push({ value, dynamic });
    value = "";
    dynamic = false;
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === undefined) break;

    if (quote === "'") {
      if (ch === "'") {
        quote = null;
      } else {
        value += ch;
      }
      continue;
    }

    if (quote === '"') {
      if (ch === '"') {
        quote = null;
        continue;
      }
      if (ch === "\\") {
        const next = command[i + 1];
        if (next === undefined) return { ok: false, reason: "complex_shell" };
        value += next;
        i++;
        continue;
      }
      if (ch === "$" || ch === "`") dynamic = true;
      value += ch;
      continue;
    }

    if (/\s/.test(ch)) {
      flush();
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "#" && value.length === 0) {
      return { ok: false, reason: "complex_shell" };
    }
    if (ch === "\\") {
      const next = command[i + 1];
      if (next === undefined) return { ok: false, reason: "complex_shell" };
      value += next;
      i++;
      continue;
    }
    if (ch === "|" || ch === ";" || ch === "&" || ch === ">" || ch === "<" || ch === "\n" || ch === "\r") {
      return { ok: false, reason: "complex_shell" };
    }
    if (ch === "`") dynamic = true;
    if (ch === "$") dynamic = true;
    value += ch;
  }

  if (quote !== null) return { ok: false, reason: "complex_shell" };
  flush();
  return tokens.length === 0 ? { ok: false, reason: "empty" } : { ok: true, tokens };
}

function commandBasename(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  const parts = normalized.split("/").filter((part) => part.length > 0);
  return (parts.at(-1) ?? normalized).toLowerCase();
}

function isOptionToken(value: string): boolean {
  return value !== "-" && value !== "--" && value.startsWith("-");
}

function optionBase(value: string): string {
  const equalsAt = value.indexOf("=");
  return equalsAt === -1 ? value : value.slice(0, equalsAt);
}

function optionConsumesSeparateValue(value: string, options: ReadonlySet<string>): boolean {
  if (value.includes("=")) return false;
  return options.has(value);
}

function isKnownBooleanOption(value: string, options: ReadonlySet<string>): boolean {
  if (options.has(value)) return true;
  if (!/^-[A-Za-z]+$/.test(value) || value.startsWith("--")) return false;
  return value
    .slice(1)
    .split("")
    .every((flag) => options.has(`-${flag}`));
}

function hasDynamicPathSyntax(token: ShellToken): boolean {
  return (
    token.dynamic ||
    token.value.startsWith("~") ||
    token.value.includes("$") ||
    token.value.includes("`") ||
    /[*?[\]{}]/.test(token.value)
  );
}

function pathArg(token: ShellToken, pathKindHint: ShellIoPathKindHint): ShellIoPathArg | ShellIoUnsupportedReason {
  if (token.value.length === 0 || hasDynamicPathSyntax(token)) return "dynamic_path";
  return { raw: token.value, pathKindHint };
}

function finishPathArgs(
  commandName: string,
  tokens: ShellToken[],
  pathKindHint: ShellIoPathKindHint,
): ShellIoClassification {
  if (tokens.length === 0) return { supported: false, reason: "no_explicit_path", commandName };
  const pathArgs: ShellIoPathArg[] = [];
  for (const token of tokens) {
    if (token.value === "-") continue;
    const arg = pathArg(token, pathKindHint);
    if (typeof arg === "string") return { supported: false, reason: arg, commandName };
    pathArgs.push(arg);
  }
  if (pathArgs.length === 0) return { supported: false, reason: "no_explicit_path", commandName };
  return { supported: true, action: "read", commandName, pathArgs };
}

function classifySimpleFileRead(commandName: string, tokens: ShellToken[]): ShellIoClassification {
  const paths: ShellToken[] = [];
  let afterDoubleDash = false;
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) break;
    const value = token.value;
    if (!afterDoubleDash && value === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (!afterDoubleDash && (commandName === "head" || commandName === "tail")) {
      if (optionConsumesSeparateValue(value, HEAD_TAIL_VALUE_OPTIONS)) {
        i++;
        continue;
      }
    }
    if (!afterDoubleDash && isOptionToken(value)) continue;
    paths.push(token);
  }
  return finishPathArgs(commandName, paths, "file");
}

function classifySed(tokens: ShellToken[]): ShellIoClassification {
  const commandName = "sed";
  const paths: ShellToken[] = [];
  let scriptProvided = false;
  let afterDoubleDash = false;

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) break;
    const value = token.value;
    if (!afterDoubleDash && value === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (!afterDoubleDash && (value === "-i" || value.startsWith("-i") || optionBase(value) === "--in-place")) {
      return { supported: false, reason: "write_or_mutation", commandName };
    }
    if (!afterDoubleDash && isOptionToken(value)) {
      const base = optionBase(value);
      if (SED_SCRIPT_OPTIONS.has(base)) {
        scriptProvided = true;
        if (optionConsumesSeparateValue(value, SED_SCRIPT_OPTIONS)) i++;
      }
      continue;
    }
    if (!scriptProvided) {
      scriptProvided = true;
      continue;
    }
    paths.push(token);
  }

  return finishPathArgs(commandName, paths, "file");
}

function classifyGrep(tokens: ShellToken[]): ShellIoClassification {
  const commandName = "grep";
  const paths: ShellToken[] = [];
  let patternProvided = false;
  let afterDoubleDash = false;

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) break;
    const value = token.value;
    if (!afterDoubleDash && value === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (!afterDoubleDash && isOptionToken(value)) {
      const base = optionBase(value);
      if (GREP_PATTERN_OPTIONS.has(base)) {
        patternProvided = true;
      }
      if (optionConsumesSeparateValue(value, GREP_VALUE_OPTIONS)) i++;
      if (!GREP_VALUE_OPTIONS.has(base) && !isKnownBooleanOption(value, GREP_BOOLEAN_OPTIONS)) {
        return { supported: false, reason: "unsupported_tool", commandName };
      }
      continue;
    }
    if (!patternProvided) {
      patternProvided = true;
      continue;
    }
    paths.push(token);
  }

  return finishPathArgs(commandName, paths, "unknown");
}

function classifyRipgrep(tokens: ShellToken[]): ShellIoClassification {
  const commandName = "rg";
  const paths: ShellToken[] = [];
  let filesMode = false;
  let patternProvided = false;
  let afterDoubleDash = false;

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) break;
    const value = token.value;
    if (!afterDoubleDash && value === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (!afterDoubleDash && value === "--files") {
      filesMode = true;
      continue;
    }
    if (!afterDoubleDash && isOptionToken(value)) {
      const base = optionBase(value);
      if (RG_VALUE_OPTIONS.has(base)) {
        if (base === "-e" || base === "--regexp" || base === "-f" || base === "--file") patternProvided = true;
        if (optionConsumesSeparateValue(value, RG_VALUE_OPTIONS)) i++;
      }
      continue;
    }
    if (filesMode) {
      paths.push(token);
      continue;
    }
    if (!patternProvided) {
      patternProvided = true;
      continue;
    }
    paths.push(token);
  }

  return finishPathArgs(commandName, paths, filesMode ? "directory" : "unknown");
}

function classifyFind(tokens: ShellToken[]): ShellIoClassification {
  const commandName = "find";
  const paths: ShellToken[] = [];
  let afterDoubleDash = false;
  let expressionStart = tokens.length;

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) break;
    const value = token.value;
    if (!afterDoubleDash && value === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (!afterDoubleDash && (value.startsWith("-") || value === "!" || value === "(" || value === ")")) {
      expressionStart = i;
      break;
    }
    paths.push(token);
  }

  for (let i = expressionStart; i < tokens.length; i++) {
    const value = tokens[i]?.value;
    if (value && FIND_MUTATING_PRIMARIES.has(value)) {
      return { supported: false, reason: "write_or_mutation", commandName };
    }
  }

  return finishPathArgs(commandName, paths, "directory");
}

function classifyLs(tokens: ShellToken[]): ShellIoClassification {
  const commandName = "ls";
  const paths: ShellToken[] = [];
  let afterDoubleDash = false;

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) break;
    const value = token.value;
    if (!afterDoubleDash && value === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (!afterDoubleDash && isOptionToken(value)) continue;
    paths.push(token);
  }

  return finishPathArgs(commandName, paths, "unknown");
}

export function classifyShellCommandIo(command: string): ShellIoClassification {
  return classifyShellCommandIoInternal(command, 0);
}

function classifyShellCommandIoInternal(command: string, wrapperDepth: number): ShellIoClassification {
  const tokenized = tokenizeSimpleShell(command);
  if (!tokenized.ok) return { supported: false, reason: tokenized.reason };

  const commandToken = tokenized.tokens[0];
  if (!commandToken) return { supported: false, reason: "empty" };
  if (commandToken.dynamic) return { supported: false, reason: "dynamic_path" };

  const commandName = commandBasename(commandToken.value);

  // Unwrap `/bin/<shell> -lc '<inner>'` before the mutating-shell rejection
  // below — see `SHELL_WRAPPER_BASENAMES`. Two-step shape check: the second
  // token must be `-c` or `-lc` and the third token must be a non-empty,
  // statically-known inner command. If any condition fails we fall through to
  // the normal rejection path (which still safely returns `write_or_mutation`).
  if (wrapperDepth < MAX_WRAPPER_UNWRAPS && SHELL_WRAPPER_BASENAMES.has(commandName)) {
    const flagToken = tokenized.tokens[1];
    const innerToken = tokenized.tokens[2];
    if (
      flagToken &&
      innerToken &&
      SHELL_WRAPPER_FLAGS.has(flagToken.value) &&
      innerToken.value.length > 0 &&
      !innerToken.dynamic
    ) {
      return classifyShellCommandIoInternal(innerToken.value, wrapperDepth + 1);
    }
  }

  if (MUTATING_OR_AMBIGUOUS_TOOLS.has(commandName)) {
    return { supported: false, reason: "write_or_mutation", commandName };
  }
  if (SIMPLE_FILE_READ_TOOLS.has(commandName)) return classifySimpleFileRead(commandName, tokenized.tokens);
  if (commandName === "sed") return classifySed(tokenized.tokens);
  if (commandName === "grep") return classifyGrep(tokenized.tokens);
  if (commandName === "rg") return classifyRipgrep(tokenized.tokens);
  if (commandName === "find") return classifyFind(tokenized.tokens);
  if (commandName === "ls") return classifyLs(tokenized.tokens);

  return { supported: false, reason: "unsupported_tool", commandName };
}
