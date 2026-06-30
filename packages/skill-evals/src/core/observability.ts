import { isRecord } from "./events.js";

export type RunObservability = {
  firstResponseLatencyMs: number | null;
  turns: number | null;
};

function isNumber(value: number | null): value is number {
  return value !== null;
}

function timestampMs(value: unknown): number | null {
  if (!isRecord(value) || typeof value.timestamp !== "string") return null;
  const ms = Date.parse(value.timestamp);
  return Number.isFinite(ms) ? ms : null;
}

function nestedCodexEvent(value: unknown): unknown {
  if (!isRecord(value) || value.type !== "codex_event") return value;
  return value.event;
}

function eventType(value: unknown): string | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  return value.type;
}

function roleValue(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const direct = value.role;
  if (typeof direct === "string") return direct;
  const item = value.item;
  if (isRecord(item) && typeof item.role === "string") return item.role;
  const message = value.message;
  if (isRecord(message) && typeof message.role === "string") return message.role;
  return null;
}

function hasTextPayload(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.some((item) => hasTextPayload(item));
  if (!isRecord(value)) return false;

  for (const [key, item] of Object.entries(value)) {
    if ((key === "content" || key === "message" || key === "text" || key === "output") && hasTextPayload(item)) {
      return true;
    }
  }
  return false;
}

function isAssistantResponseEvent(value: unknown): boolean {
  const event = nestedCodexEvent(value);
  const type = eventType(event);
  const role = roleValue(event);
  if (role === "assistant" && hasTextPayload(event)) return true;
  if (type === null) return false;
  if (/tool|function|command|exec|stderr|stdout|error|reasoning/iu.test(type)) return false;
  return (
    (type === "agent_message" ||
      type === "assistant_message" ||
      type === "final" ||
      type === "response.completed" ||
      type === "turn.completed") &&
    hasTextPayload(event)
  );
}

export function deriveRunObservability(events: readonly unknown[]): RunObservability {
  const runStartedAt =
    events.find(
      (event) => isRecord(event) && (event.type === "codex_run_started" || event.type === "claude_run_started"),
    ) ?? null;
  const startedAtMs = timestampMs(runStartedAt);
  const responseTimes = events.filter(isAssistantResponseEvent).map(timestampMs).filter(isNumber);
  const firstResponseAtMs = responseTimes[0] ?? null;

  return {
    firstResponseLatencyMs:
      startedAtMs === null || firstResponseAtMs === null ? null : Math.max(0, firstResponseAtMs - startedAtMs),
    turns: responseTimes.length === 0 ? null : responseTimes.length,
  };
}
