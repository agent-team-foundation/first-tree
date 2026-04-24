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
 * the caller's authenticated organization. A client is bound to exactly one
 * org for its lifetime; re-registering or operating under a different org's
 * credentials is refused. CLI consumers recognize the `code` field and
 * respond by abandoning the local clientId to register a fresh one.
 */
export class ClientOrgMismatchError extends AppError {
  readonly code = "CLIENT_ORG_MISMATCH";
  constructor(message = "Client belongs to a different organization") {
    super(403, message);
    this.name = "ClientOrgMismatchError";
  }
}
