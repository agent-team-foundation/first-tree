export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not found") {
    super(404, message);
    this.name = "NotFoundError";
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized") {
    super(401, message);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Forbidden") {
    super(403, message);
    this.name = "ForbiddenError";
  }
}

export class ConflictError extends AppError {
  constructor(message = "Conflict") {
    super(409, message);
    this.name = "ConflictError";
  }
}

export class BadRequestError extends AppError {
  constructor(message = "Bad request") {
    super(400, message);
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
  constructor(message = "Client belongs to a different organization") {
    super(403, message);
    this.name = "ClientOrgMismatchError";
  }
}

/**
 * Thrown when a client.yaml is presented with a JWT whose user_id does not
 * match the row's owner. The CLI responds by guiding the operator through
 * `first-tree-hub client claim --confirm` to take over ownership, which
 * unpins the previous owner's agents from this machine.
 */
export class ClientUserMismatchError extends AppError {
  readonly code = "CLIENT_USER_MISMATCH";
  constructor(message = "Client belongs to a different user") {
    super(403, message);
    this.name = "ClientUserMismatchError";
  }
}
