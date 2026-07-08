const THREAD_ID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const NO_ROLLOUT_RE = /thread\/resume[\s\S]*no rollout found/i;

export class CodexStaleRolloutError extends Error {
  readonly threadId: string | null;
  readonly causeValue: unknown;

  constructor(cause: unknown, fallbackThreadId?: string | null) {
    const causeMessage = errorMessage(cause);
    const threadId = extractCodexStaleRolloutThreadId(cause) ?? fallbackThreadId ?? null;
    super(
      threadId ? `codex stale rollout for thread ${threadId}: ${causeMessage}` : `codex stale rollout: ${causeMessage}`,
    );
    this.name = "CodexStaleRolloutError";
    this.threadId = threadId;
    this.causeValue = cause;
  }
}

export function isCodexStaleRolloutError(err: unknown): boolean {
  if (err instanceof CodexStaleRolloutError) return true;
  return NO_ROLLOUT_RE.test(errorText(err));
}

export function extractCodexStaleRolloutThreadId(err: unknown): string | null {
  const text = errorText(err);
  const match = text.match(/no rollout found for thread id\s+([0-9a-f-]{36})/i) ?? text.match(THREAD_ID_RE);
  return match?.[1] ?? match?.[0] ?? null;
}

export function staleRolloutRecoveryMessage(staleThreadId: string | null, replacementThreadId?: string | null): string {
  const stale = staleThreadId ? ` for stale thread ${staleThreadId}` : "";
  const replacement = replacementThreadId ? `; replacement thread ${replacementThreadId}` : "";
  return `codex local rollout missing${stale}; starting fresh thread${replacement}`;
}

function errorText(err: unknown): string {
  if (err instanceof CodexStaleRolloutError) {
    const cause = errorText(err.causeValue);
    return `${err.message}\n${cause}`;
  }
  if (err instanceof Error) {
    const record = err as unknown as Record<string, unknown>;
    const parts = [err.name, err.message];
    if (record.code !== undefined) parts.push(String(record.code));
    if (record.reason !== undefined) parts.push(String(record.reason));
    if (record.cause !== undefined) parts.push(errorText(record.cause));
    return parts.filter(Boolean).join("\n");
  }
  if (typeof err === "string") return err;
  if (!err || typeof err !== "object") return String(err);
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return String(err);
}
