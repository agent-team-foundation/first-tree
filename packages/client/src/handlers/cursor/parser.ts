/**
 * Pure, tolerant parser for the Cursor Agent CLI `--output-format stream-json`
 * protocol (newline-delimited JSON on stdout).
 *
 * Tolerance contract: the CLI is beta and auto-updates, so unknown event
 * types, unknown tool-call union members, and unparsable lines must NEVER
 * throw — they surface as `unknown` events carrying a diagnostic note.
 * Protocol-required fields (a stream-confirmed `session_id`, a terminal
 * `result`) are enforced by the HANDLER as explicit protocol/configuration
 * failures, not here.
 *
 * Event shapes locked against real Phase 0 captures (CLI 2026.07.09):
 *   - `system:init`  → top-level: type, subtype, apiKeySource, cwd,
 *     session_id, model, permissionMode
 *   - `thinking` delta/completed
 *   - `assistant` full/partial message fragments (NOT canonical final text —
 *     the successful `result.result` is)
 *   - `tool_call` started/completed correlated by `call_id`, with a
 *     provider-native union (`shellToolCall` / `readToolCall` /
 *     `editToolCall` / `writeToolCall` observed so far)
 *   - `result` success/error with `usage` token counts
 */

export type CursorUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export type CursorToolCall =
  | { name: "shell"; command: string | null; workingDirectory: string | null }
  | { name: "read"; path: string | null }
  | { name: "edit"; path: string | null }
  | { name: "write"; path: string | null }
  | { name: "unknown"; unionKey: string | null };

export type CursorToolResult = {
  /** `completed` union carried a `result.failure` (e.g. shell non-zero exit). */
  failed: boolean;
  /** Shell exit code when the union reports one. */
  exitCode: number | null;
  /** Bounded human preview (stdout tail / diff summary / error message). */
  preview: string | null;
};

export type CursorStreamEvent =
  | {
      kind: "init";
      sessionId: string | null;
      model: string | null;
      permissionMode: string | null;
    }
  | { kind: "user_echo" }
  | { kind: "thinking_delta"; text: string }
  | { kind: "thinking_completed" }
  | { kind: "assistant_message"; text: string }
  | { kind: "tool_started"; callId: string; tool: CursorToolCall; rawArgs: unknown }
  | {
      kind: "tool_completed";
      callId: string;
      tool: CursorToolCall;
      rawArgs: unknown;
      result: CursorToolResult;
    }
  | {
      kind: "result";
      isError: boolean;
      text: string;
      sessionId: string | null;
      usage: CursorUsage | null;
    }
  | { kind: "unknown"; note: string; raw: string };

const RESULT_PREVIEW_LIMIT = 400;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Concatenate the `text` blocks of a Cursor `message.content` array. */
function messageText(message: unknown): string {
  const record = asRecord(message);
  const content = record?.content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const blockRecord = asRecord(block);
    if (blockRecord?.type === "text" && typeof blockRecord.text === "string") parts.push(blockRecord.text);
  }
  return parts.join("");
}

/**
 * Extract the provider-native tool union. The wire nests one
 * `<name>ToolCall: { args, result? }` member under `tool_call`; unknown
 * members degrade to `{ name: "unknown" }` so a CLI update cannot crash a
 * turn — the handler treats unknown tools as unproven side effects.
 */
function extractToolCall(toolCall: unknown): { tool: CursorToolCall; args: unknown; result: unknown } {
  const record = asRecord(toolCall);
  if (!record) return { tool: { name: "unknown", unionKey: null }, args: undefined, result: undefined };

  const unionKey = Object.keys(record).find((key) => key.endsWith("ToolCall")) ?? null;
  const member = unionKey ? asRecord(record[unionKey]) : null;
  const args = member?.args;
  const result = member?.result;
  const argsRecord = asRecord(args);

  switch (unionKey) {
    case "shellToolCall":
      return {
        tool: {
          name: "shell",
          command: asString(argsRecord?.command),
          workingDirectory: asString(argsRecord?.workingDirectory),
        },
        args,
        result,
      };
    case "readToolCall":
      return { tool: { name: "read", path: asString(argsRecord?.path) }, args, result };
    case "editToolCall":
      return { tool: { name: "edit", path: asString(argsRecord?.path) }, args, result };
    case "writeToolCall":
      return { tool: { name: "write", path: asString(argsRecord?.path) }, args, result };
    default:
      return { tool: { name: "unknown", unionKey }, args, result };
  }
}

function extractToolResult(result: unknown): CursorToolResult {
  const record = asRecord(result);
  const failure = asRecord(record?.failure);
  const success = asRecord(record?.success);
  const terminal = failure ?? success;
  const exitCode = asFiniteNumber(terminal?.exitCode);
  const previewSource =
    asString(failure?.stderr) ??
    asString(failure?.message) ??
    asString(success?.stdout) ??
    asString(success?.message) ??
    asString(success?.diffString) ??
    null;
  const preview =
    previewSource && previewSource.trim().length > 0 ? previewSource.slice(0, RESULT_PREVIEW_LIMIT) : null;
  return { failed: failure !== null, exitCode, preview };
}

function extractUsage(usage: unknown): CursorUsage | null {
  const record = asRecord(usage);
  if (!record) return null;
  const inputTokens = asFiniteNumber(record.inputTokens);
  const outputTokens = asFiniteNumber(record.outputTokens);
  const cacheReadTokens = asFiniteNumber(record.cacheReadTokens);
  const cacheWriteTokens = asFiniteNumber(record.cacheWriteTokens);
  if (inputTokens === null && outputTokens === null && cacheReadTokens === null && cacheWriteTokens === null) {
    return null;
  }
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    cacheReadTokens: cacheReadTokens ?? 0,
    cacheWriteTokens: cacheWriteTokens ?? 0,
  };
}

function unknownEvent(note: string, raw: string): CursorStreamEvent {
  return { kind: "unknown", note, raw: raw.slice(0, RESULT_PREVIEW_LIMIT) };
}

/** Parse ONE stream-json line into an event. Never throws. */
export function parseCursorStreamLine(line: string): CursorStreamEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;

  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return unknownEvent("unparsable stream line", trimmed);
  }
  const record = asRecord(value);
  if (!record) return unknownEvent("non-object stream line", trimmed);

  const type = asString(record.type);
  switch (type) {
    case "system": {
      if (record.subtype !== "init") return unknownEvent(`unknown system subtype ${String(record.subtype)}`, trimmed);
      return {
        kind: "init",
        sessionId: asString(record.session_id),
        model: asString(record.model),
        permissionMode: asString(record.permissionMode),
      };
    }
    case "user":
      return { kind: "user_echo" };
    case "thinking": {
      if (record.subtype === "delta") return { kind: "thinking_delta", text: asString(record.text) ?? "" };
      if (record.subtype === "completed") return { kind: "thinking_completed" };
      return unknownEvent(`unknown thinking subtype ${String(record.subtype)}`, trimmed);
    }
    case "assistant":
      return { kind: "assistant_message", text: messageText(record.message) };
    case "tool_call": {
      const callId = asString(record.call_id);
      if (!callId) return unknownEvent("tool_call without call_id", trimmed);
      const { tool, args, result } = extractToolCall(record.tool_call);
      if (record.subtype === "started") return { kind: "tool_started", callId, tool, rawArgs: args };
      if (record.subtype === "completed") {
        return { kind: "tool_completed", callId, tool, rawArgs: args, result: extractToolResult(result) };
      }
      return unknownEvent(`unknown tool_call subtype ${String(record.subtype)}`, trimmed);
    }
    case "result": {
      return {
        kind: "result",
        isError: record.is_error === true,
        text: asString(record.result) ?? "",
        sessionId: asString(record.session_id),
        usage: extractUsage(record.usage),
      };
    }
    default:
      return unknownEvent(`unknown event type ${String(type)}`, trimmed);
  }
}

/**
 * Incremental line splitter over stdout chunks. Each provider attempt uses a
 * FRESH parser instance (retries must not inherit partial-line state).
 */
export class CursorStreamParser {
  private buffer = "";

  push(chunk: string): CursorStreamEvent[] {
    this.buffer += chunk;
    const events: CursorStreamEvent[] = [];
    // Offset-cursor scan with ONE tail slice — reslicing the whole remaining
    // buffer per line would be quadratic on dense small-event chunks.
    let start = 0;
    for (;;) {
      const newline = this.buffer.indexOf("\n", start);
      if (newline === -1) break;
      const event = parseCursorStreamLine(this.buffer.slice(start, newline));
      if (event) events.push(event);
      start = newline + 1;
    }
    if (start > 0) this.buffer = this.buffer.slice(start);
    return events;
  }

  /** Drain any trailing unterminated line at stream close. */
  flush(): CursorStreamEvent[] {
    const rest = this.buffer;
    this.buffer = "";
    const event = parseCursorStreamLine(rest);
    return event ? [event] : [];
  }
}
