/**
 * Optional structured attributes attached to a thrown AppError. Surfaced into
 * the active OTel span by the central errorHandler so failures carry their
 * specific reason (e.g. `auth.refresh.reason: "user_suspended"`) instead of
 * being collapsed into the generic message.
 */
export type AppErrorAttrs = Record<string, string | number | boolean>;

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly attrs?: AppErrorAttrs,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not found", attrs?: AppErrorAttrs) {
    super(404, message, attrs);
    this.name = "NotFoundError";
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized", attrs?: AppErrorAttrs) {
    super(401, message, attrs);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Forbidden", attrs?: AppErrorAttrs) {
    super(403, message, attrs);
    this.name = "ForbiddenError";
  }
}

/**
 * Thrown by `inviteParticipantsToChat` when the caller is not currently a
 * speaker of the target chat. Subtypes `ForbiddenError` so existing 403
 * mapping still fires, but exposes a stable identity that callers can match
 * with `instanceof` instead of regex-sniffing the message — used by the web
 * `addMeChatParticipants` shell to remap into a probing-protection 404.
 */
export class CallerNotSpeakerError extends ForbiddenError {
  readonly code = "CALLER_NOT_SPEAKER";
  constructor(callerAgentId: string, chatId: string, attrs?: AppErrorAttrs) {
    super(`Caller "${callerAgentId}" is not a speaker of chat "${chatId}"`, attrs);
    this.name = "CallerNotSpeakerError";
  }
}

export class ConflictError extends AppError {
  constructor(message = "Conflict", attrs?: AppErrorAttrs) {
    super(409, message, attrs);
    this.name = "ConflictError";
  }
}

export class BadRequestError extends AppError {
  constructor(message = "Bad request", attrs?: AppErrorAttrs) {
    super(400, message, attrs);
    this.name = "BadRequestError";
  }
}

/**
 * 422 — the request is well-formed but a precondition the caller cannot fix
 * by retrying is missing (e.g. following an entity in a repo the org's
 * GitHub App installation does not cover).
 */
export class UnprocessableError extends AppError {
  constructor(message = "Unprocessable", attrs?: AppErrorAttrs) {
    super(422, message, attrs);
    this.name = "UnprocessableError";
  }
}

/**
 * 413 — a single request body exceeds a server-enforced byte cap. Pass a
 * stable `code` via attrs when the caller needs machine-readable identity
 * (the central error handler serializes `attrs.code` into the body).
 */
export class PayloadTooLargeError extends AppError {
  constructor(message = "Payload too large", attrs?: AppErrorAttrs) {
    super(413, message, attrs);
    this.name = "PayloadTooLargeError";
  }
}

/**
 * 411 — the request must declare `Content-Length` up front (streaming
 * uploads reserve quota from the declared size before consuming the body,
 * so chunked transfer encoding cannot be admitted).
 */
export class LengthRequiredError extends AppError {
  constructor(message = "Content-Length required", attrs?: AppErrorAttrs) {
    super(411, message, attrs);
    this.name = "LengthRequiredError";
  }
}

/**
 * 429 — the caller holds too many concurrent in-flight operations. Distinct
 * from @fastify/rate-limit's request-frequency 429: this guards sustained
 * parallel streams, not request count per window.
 */
export class TooManyRequestsError extends AppError {
  constructor(message = "Too many concurrent requests", attrs?: AppErrorAttrs) {
    super(429, message, attrs);
    this.name = "TooManyRequestsError";
  }
}

/**
 * 503 — an upstream dependency (GitHub API) is temporarily unreachable.
 * The operation was NOT performed; the caller may safely retry later.
 */
export class ServiceUnavailableError extends AppError {
  constructor(message = "Service temporarily unavailable", attrs?: AppErrorAttrs) {
    super(503, message, attrs);
    this.name = "ServiceUnavailableError";
  }
}

/** Upstream/computer unreachable — web model-catalog picker treats 502 as silent degrade. */
export class BadGatewayError extends AppError {
  constructor(message = "Bad gateway", attrs?: AppErrorAttrs) {
    super(502, message, attrs);
    this.name = "BadGatewayError";
  }
}

/** Upstream/computer reply timed out — web model-catalog picker treats 504 as silent degrade. */
export class GatewayTimeoutError extends AppError {
  constructor(message = "Gateway timeout", attrs?: AppErrorAttrs) {
    super(504, message, attrs);
    this.name = "GatewayTimeoutError";
  }
}

export class GoneError extends AppError {
  constructor(message = "Gone", attrs?: AppErrorAttrs) {
    super(410, message, attrs);
    this.name = "GoneError";
  }
}

/**
 * Thrown when an operation targets a client whose organization does not match
 * the caller's authenticated organization. Retained for wire compatibility:
 * the read paths that produced this error were retired in
 * decouple-client-from-identity §4.1, so the server itself no longer raises
 * it. SDK consumers may still pattern-match the `code` field on legacy
 * payloads.
 */
export class ClientOrgMismatchError extends AppError {
  readonly code = "CLIENT_ORG_MISMATCH";
  constructor(message = "Client belongs to a different organization", attrs?: AppErrorAttrs) {
    super(403, message, attrs);
    this.name = "ClientOrgMismatchError";
  }
}

/**
 * Thrown when a client.yaml is presented with a JWT whose user_id does not
 * match the row's owner. The CLI responds by guiding the operator through
 * local-client switching. There is no server-side ownership transfer; this row
 * and its pinned agents stay with the original owner (offline) until that owner
 * removes them.
 */
export class ClientUserMismatchError extends AppError {
  readonly code = "CLIENT_USER_MISMATCH";
  constructor(message = "Client belongs to a different user", attrs?: AppErrorAttrs) {
    super(403, message, attrs);
    this.name = "ClientUserMismatchError";
  }
}

export class ClientRetiredError extends GoneError {
  readonly code = "CLIENT_RETIRED";
  constructor(message = "Client has been retired", attrs?: AppErrorAttrs) {
    super(message, attrs);
    this.name = "ClientRetiredError";
  }
}
