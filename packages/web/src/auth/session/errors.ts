export const sessionErrorCodes = {
  admissionDenied: "admission_denied",
  invalidState: "invalid_state",
  persistenceUnavailable: "persistence_unavailable",
  platformUnavailable: "platform_unavailable",
  recoveryRequired: "recovery_required",
  staleOperation: "stale_operation",
} as const;

export type SessionErrorCode = (typeof sessionErrorCodes)[keyof typeof sessionErrorCodes];

/** A fail-closed browser-session failure safe to branch on without parsing text. */
export class SessionError extends Error {
  public readonly code: SessionErrorCode;
  public readonly detail: unknown;

  public constructor(code: SessionErrorCode, message: string, detail?: unknown) {
    super(message);
    this.name = "SessionError";
    this.code = code;
    this.detail = detail;
  }
}

export function toSessionError(error: unknown, code: SessionErrorCode, message: string): SessionError {
  if (error instanceof SessionError) return error;
  return new SessionError(code, message, error);
}
