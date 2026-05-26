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
 * `first-tree login <token> --override` to take over ownership, which
 * unpins the previous owner's agents from this machine.
 */
export class ClientUserMismatchError extends AppError {
  readonly code = "CLIENT_USER_MISMATCH";
  constructor(message = "Client belongs to a different user", attrs?: AppErrorAttrs) {
    super(403, message, attrs);
    this.name = "ClientUserMismatchError";
  }
}
