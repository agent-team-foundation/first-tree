import { eq } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { jwtVerify } from "jose";
import type { Database } from "../db/connection.js";
import { users } from "../db/schema/users.js";
import { UnauthorizedError } from "../errors.js";

/**
 * Authenticate via either a `type: "user"` (rootless) or `type: "access"`
 * (per-org) JWT. Used by routes that exist BEFORE a user has picked a
 * workspace — `/me`, `/me/workspaces*`, `/auth/switch-org`. The handler
 * receives `request.authedUser = { userId }`; org-scoped state lives on
 * `request.member` only when the token is `type: "access"` and the
 * caller-side `memberAuthHook` ran first.
 *
 * Why a second hook instead of relaxing `memberAuthHook`: existing routes
 * rely on `request.member` being populated and reject the request if any
 * piece is missing. A rootless user must NOT pass that gate. Splitting the
 * hooks keeps the membership invariant for everything downstream of
 * `memberAuthHook` without forcing every route to do a second narrowing
 * check.
 */
export function userAuthHook(db: Database, jwtSecret: string) {
  const secret = new TextEncoder().encode(jwtSecret);

  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      throw new UnauthorizedError("Missing or invalid Authorization header");
    }
    const token = header.slice(7);

    let payload: { sub?: string; type?: string };
    try {
      const { payload: p } = await jwtVerify(token, secret);
      payload = p as typeof payload;
    } catch {
      throw new UnauthorizedError("Invalid or expired token");
    }

    if ((payload.type !== "access" && payload.type !== "user") || !payload.sub) {
      throw new UnauthorizedError("Invalid token type");
    }

    const [user] = await db
      .select({ id: users.id, status: users.status })
      .from(users)
      .where(eq(users.id, payload.sub))
      .limit(1);
    if (!user || user.status !== "active") {
      throw new UnauthorizedError("User not found or suspended");
    }

    request.authedUser = { userId: user.id };
  };
}
