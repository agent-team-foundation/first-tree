export type ShellConnector = "&&" | "||" | ";" | "|";
export type ShellCommandSegment = { connectorBefore: ShellConnector | null; text: string };

export function unwrapShellCommand(text: string): string {
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

// Split a command without discarding the operators that determine whether a
// segment ran. Separators inside quoted arguments are data, not shell control
// flow (for example `sed -n '1;20p'`). This is deliberately a small shell
// scanner rather than an attempted full shell parser: it recognizes the
// top-level operators the graders reason about and treats everything else as
// opaque command text.
export function shellCommandSegmentsWithConnectors(text: string): ShellCommandSegment[] {
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

  for (let index = 0; index < command.length; index += 1) {
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
      index += 1;
      continue;
    }
    if (character === "|" && next === "|") {
      push("||");
      index += 1;
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

export function shellCommandSegments(text: string): string[] {
  return shellCommandSegmentsWithConnectors(text).map((segment) => segment.text);
}

export function shellWords(segment: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
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
    if (character === '"' || character === "'") {
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

// Redirections affect the shell process, not the argv seen by the command.
// Keep quoted redirect characters as data while removing both attached and
// separated redirect targets from the argument list used by graders.
export type ShellWordsWithRedirectsRemoved = {
  inputFileRedirected: boolean;
  words: string[];
};

export function shellWordsWithRedirectsRemoved(segment: string): ShellWordsWithRedirectsRemoved {
  const words: string[] = [];
  let inputFileRedirected = false;
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;
  const push = (): void => {
    if (current.length > 0) words.push(current);
    current = "";
  };

  for (let index = 0; index < segment.length; index += 1) {
    const character = segment[index] ?? "";
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
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    const ampersandRedirect = character === "&" && segment[index + 1] === ">";
    if (character === ">" || character === "<" || ampersandRedirect) {
      const descriptor = /^\d+$/u.test(current) ? current : null;
      if (character === "<" && (descriptor === null || descriptor === "0")) {
        const redirectSuffix = segment[index + 1] ?? "";
        inputFileRedirected = redirectSuffix !== "<" && redirectSuffix !== ">" && redirectSuffix !== "&";
      }
      if (descriptor !== null) current = "";
      else push();

      let targetStart = index + (ampersandRedirect ? 2 : 1);
      const next = segment[targetStart] ?? "";
      if (
        (character === "<" && (next === "<" || next === ">" || next === "&")) ||
        ((character === ">" || ampersandRedirect) && (next === ">" || next === "&" || next === "|"))
      ) {
        targetStart += 1;
        if (character === "<" && next === "<" && segment[targetStart] === "<") targetStart += 1;
      }
      while (/\s/u.test(segment[targetStart] ?? "")) targetStart += 1;

      let targetQuote: '"' | "'" | null = null;
      let targetEscaped = false;
      let targetEnd = targetStart;
      for (; targetEnd < segment.length; targetEnd += 1) {
        const targetCharacter = segment[targetEnd] ?? "";
        if (targetEscaped) {
          targetEscaped = false;
          continue;
        }
        if (targetCharacter === "\\" && targetQuote !== "'") {
          targetEscaped = true;
          continue;
        }
        if (targetQuote !== null) {
          if (targetCharacter === targetQuote) targetQuote = null;
          continue;
        }
        if (targetCharacter === '"' || targetCharacter === "'") {
          targetQuote = targetCharacter;
          continue;
        }
        if (/\s/u.test(targetCharacter)) break;
      }
      index = targetEnd - 1;
      continue;
    }
    if (/\s/u.test(character)) {
      push();
      continue;
    }
    current += character;
  }
  push();
  return { inputFileRedirected, words };
}
