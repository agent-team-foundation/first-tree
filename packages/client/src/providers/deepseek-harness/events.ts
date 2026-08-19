import type { HarnessNotification } from "@deepseek-ai/dsh-sdk-client";
import type { SessionEvent } from "@deepseek-ai/dsh-session";

export type DeepseekStreamChunk = {
  kind: "text_delta" | "reasoning_delta" | "assistant_message" | "tool_call" | "tool_result" | "turn_end" | "unknown";
  text?: string;
  toolCallId?: string;
  toolName?: string;
  toolArgs?: unknown;
  toolFailed?: boolean;
  toolPreview?: string;
  turnEndError?: string;
  credentialFailure?: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function sessionEventFromNotification(notification: HarnessNotification): SessionEvent | null {
  if (notification.method !== "session.event") return null;
  const event = notification.params.event;
  if (!event || typeof event !== "object") return null;
  return event as SessionEvent;
}

export function mapDeepseekSessionEvent(event: SessionEvent): DeepseekStreamChunk {
  switch (event.type) {
    case "assistant/chunk": {
      const chunk = event.data.chunk;
      if (chunk.type === "text-delta") {
        return { kind: "text_delta", text: chunk.text };
      }
      if (chunk.type === "reasoning-delta") {
        return { kind: "reasoning_delta", text: chunk.text };
      }
      if (chunk.type === "finish") {
        const reason = chunk.reason;
        if (reason.kind === "error") {
          const failure = reason.failure;
          const code = failure.code;
          const message = failure.message;
          return {
            kind: "turn_end",
            turnEndError: message,
            credentialFailure: isDeepseekCredentialCode(code) || isDeepseekCredentialText(message),
          };
        }
      }
      return { kind: "unknown" };
    }
    case "assistant/message":
      return {
        kind: "assistant_message",
        text: extractAssistantMessageText(event.data.message),
      };
    case "tool/call":
      return {
        kind: "tool_call",
        toolCallId: String(event.data.callId),
        toolName: event.data.name,
        toolArgs: parseToolArguments(event.data.arguments),
      };
    case "tool/result": {
      const toolResult = event.data.message.content[0];
      return {
        kind: "tool_result",
        toolCallId: String(toolResult?.toolCallId ?? event.data.message.source.callId ?? ""),
        toolFailed: Boolean(event.data.error) || Boolean(toolResult?.isError),
        toolPreview: previewToolResult(event.data.message),
      };
    }
    case "turn/end": {
      const reason = event.data.reason;
      if (reason.kind === "error") {
        const code = reason.error.code;
        const message = reason.error.message;
        return {
          kind: "turn_end",
          turnEndError: message,
          credentialFailure: isDeepseekCredentialCode(code) || isDeepseekCredentialText(message),
        };
      }
      if (reason.kind === "aborted") {
        return { kind: "turn_end", turnEndError: "DeepSeek turn aborted" };
      }
      return { kind: "turn_end" };
    }
    default:
      return { kind: "unknown" };
  }
}

export function classifyDeepseekRunFailure(input: {
  finalResponse: string;
  events: readonly SessionEvent[];
  aborted: boolean;
}): string | null {
  if (input.aborted) return null;
  for (const event of input.events) {
    const mapped = mapDeepseekSessionEvent(event);
    if (mapped.credentialFailure) {
      return mapped.turnEndError ?? "MISSING_CREDENTIAL";
    }
    if (mapped.kind === "turn_end" && mapped.turnEndError) {
      return mapped.turnEndError;
    }
  }
  if (input.finalResponse.trim().length === 0) {
    const lastError = [...input.events]
      .reverse()
      .map((event) => mapDeepseekSessionEvent(event))
      .find((mapped) => mapped.kind === "turn_end" && mapped.turnEndError);
    if (lastError?.turnEndError) return lastError.turnEndError;
    return "DeepSeek Harness returned an empty response";
  }
  return null;
}

function isDeepseekCredentialCode(code: string): boolean {
  return /missing_credential|invalid_credential|provider\.auth|auth\./i.test(code);
}

function isDeepseekCredentialText(text: string): boolean {
  return /missing_credential|deepseek_api_key|missing api key|not authenticated|unauthorized|invalid api key/i.test(
    text,
  );
}

function extractAssistantMessageText(message: unknown): string {
  const record = asRecord(message);
  const content = record?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const row = asRecord(block);
      if (row?.type === "text" && typeof row.text === "string") return row.text;
      return "";
    })
    .join("");
}

function parseToolArguments(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

function previewToolResult(message: unknown): string {
  const record = asRecord(message);
  const content = record?.content;
  if (typeof content === "string") return content.slice(0, 400);
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        const row = asRecord(block);
        if (row?.type === "text" && typeof row.text === "string") return row.text;
        return "";
      })
      .join("")
      .slice(0, 400);
  }
  return "";
}
