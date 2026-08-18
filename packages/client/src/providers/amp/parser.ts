/**
 * Pure, tolerant parser for Amp CLI `--execute --stream-json` output
 * (Claude Code-compatible JSONL on stdout).
 *
 * Tolerance contract: unknown event types and unparsable lines never throw —
 * they surface as `unknown` events. Protocol-required fields (a stream-confirmed
 * `session_id`, a terminal `result`) are enforced by the handler.
 */

export type AmpUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export type AmpToolCall = {
  name: string;
  args: Record<string, unknown>;
};

export type AmpStreamEvent =
  | { kind: "init"; sessionId: string | null }
  | { kind: "user_echo" }
  | { kind: "thinking_delta"; text: string }
  | { kind: "assistant_message"; text: string }
  | { kind: "tool_started"; callId: string; tool: AmpToolCall }
  | { kind: "tool_completed"; callId: string; preview: string | null; failed: boolean }
  | { kind: "usage"; usage: AmpUsage }
  | {
      kind: "result";
      isError: boolean;
      text: string;
      sessionId: string | null;
      usage: AmpUsage | null;
    }
  | { kind: "unknown"; note: string; raw: string };

/** Sum per-message Amp usage records (assistant stream examples emit one per message). */
export function addAmpUsage(left: AmpUsage | null, right: AmpUsage): AmpUsage {
  if (!left) return right;
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
  };
}

const PREVIEW_LIMIT = 400;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function extractUsage(usage: unknown): AmpUsage | null {
  const record = asRecord(usage);
  if (!record) return null;
  const inputTokens = asFiniteNumber(record.input_tokens) ?? asFiniteNumber(record.inputTokens);
  const outputTokens = asFiniteNumber(record.output_tokens) ?? asFiniteNumber(record.outputTokens);
  const cacheReadTokens = asFiniteNumber(record.cache_read_input_tokens) ?? asFiniteNumber(record.cacheReadTokens);
  const cacheWriteTokens =
    asFiniteNumber(record.cache_creation_input_tokens) ?? asFiniteNumber(record.cacheWriteTokens);
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

function unknownEvent(note: string, raw: string): AmpStreamEvent {
  return { kind: "unknown", note, raw: raw.slice(0, PREVIEW_LIMIT) };
}

function previewFromUnknown(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed.slice(0, PREVIEW_LIMIT) : null;
  }
  if (value == null) return null;
  try {
    const serialized = JSON.stringify(value);
    return serialized ? serialized.slice(0, PREVIEW_LIMIT) : null;
  } catch {
    return null;
  }
}

/**
 * Parse ONE stream-json line into ordered events. Amp content arrays may
 * contain multiple text/thinking/tool blocks; each block becomes its own
 * event so replay safety sees every tool. Never throws.
 */
export function parseAmpStreamLine(line: string): AmpStreamEvent[] {
  const trimmed = line.trim();
  if (trimmed.length === 0) return [];

  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return [unknownEvent("unparsable stream line", trimmed)];
  }
  const record = asRecord(value);
  if (!record) return [unknownEvent("non-object stream line", trimmed)];

  const type = asString(record.type);
  switch (type) {
    case "system": {
      if (record.subtype === "init") {
        return [{ kind: "init", sessionId: asString(record.session_id) }];
      }
      if (record.subtype === "error_during_execution" || record.subtype === "error_max_turns") {
        return [
          {
            kind: "result",
            isError: true,
            text: asString(record.error) ?? "Amp system error",
            sessionId: asString(record.session_id),
            usage: null,
          },
        ];
      }
      return [unknownEvent(`unknown system subtype ${String(record.subtype)}`, trimmed)];
    }
    case "user": {
      const message = asRecord(record.message);
      const content = Array.isArray(message?.content) ? message.content : [];
      const events: AmpStreamEvent[] = [];
      for (const block of content) {
        const blockRecord = asRecord(block);
        if (blockRecord?.type !== "tool_result") continue;
        const callId = asString(blockRecord.tool_use_id);
        if (!callId) {
          events.push(unknownEvent("tool_result without tool_use_id", trimmed));
          continue;
        }
        events.push({
          kind: "tool_completed",
          callId,
          preview: previewFromUnknown(blockRecord.content),
          failed: blockRecord.is_error === true,
        });
      }
      return events.length > 0 ? events : [{ kind: "user_echo" }];
    }
    case "assistant": {
      const message = asRecord(record.message);
      const content = Array.isArray(message?.content) ? message.content : [];
      const events: AmpStreamEvent[] = [];
      for (const block of content) {
        const blockRecord = asRecord(block);
        if (!blockRecord) continue;
        if (blockRecord.type === "text" && typeof blockRecord.text === "string") {
          events.push({ kind: "assistant_message", text: blockRecord.text });
        } else if (blockRecord.type === "thinking" && typeof blockRecord.thinking === "string") {
          events.push({ kind: "thinking_delta", text: blockRecord.thinking });
        } else if (blockRecord.type === "tool_use") {
          const callId = asString(blockRecord.id);
          const name = asString(blockRecord.name);
          if (callId && name) {
            events.push({
              kind: "tool_started",
              callId,
              tool: { name, args: asRecord(blockRecord.input) ?? {} },
            });
          }
        }
      }
      // Official Amp stream examples put usage on each assistant message and
      // often omit it from the terminal result — retain it as a fallback.
      const usage = extractUsage(message?.usage) ?? extractUsage(record.usage);
      if (usage) events.push({ kind: "usage", usage });
      return events.length > 0 ? events : [{ kind: "user_echo" }];
    }
    case "result": {
      const isError = record.is_error === true || asString(record.subtype)?.startsWith("error_") === true;
      return [
        {
          kind: "result",
          isError,
          text: isError
            ? (asString(record.error) ?? asString(record.result) ?? "Amp turn failed")
            : (asString(record.result) ?? ""),
          sessionId: asString(record.session_id),
          usage: extractUsage(record.usage),
        },
      ];
    }
    default:
      return [unknownEvent(`unknown stream type ${String(type)}`, trimmed)];
  }
}

export class AmpStreamParser {
  private buffer = "";

  push(chunk: string): AmpStreamEvent[] {
    this.buffer += chunk;
    const events: AmpStreamEvent[] = [];
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      events.push(...parseAmpStreamLine(line));
    }
    return events;
  }

  flush(): AmpStreamEvent[] {
    const leftover = this.buffer;
    this.buffer = "";
    return parseAmpStreamLine(leftover);
  }
}
