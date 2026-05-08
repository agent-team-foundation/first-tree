import type { FastifyRequest } from "fastify";
import { UnauthorizedError } from "../errors.js";
import type { UserScope } from "./types.js";

/**
 * Pull the JWT-verified `UserScope` off the request. The `userAuthHook`
 * middleware populates `request.user` synchronously before any handler
 * runs; this helper just narrows the optional and throws a clean 401 if
 * the route was misconfigured (mounted without the auth hook).
 */
export function requireUser(request: FastifyRequest): UserScope {
  const user = request.user;
  if (!user) {
    throw new UnauthorizedError("User authentication required");
  }
  return user;
}
