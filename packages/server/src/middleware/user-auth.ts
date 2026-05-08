import { eq } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { jwtVerify } from "jose";
import type { Database } from "../db/connection.js";
import { users } from "../db/schema/users.js";
import { UnauthorizedError } from "../errors.js";

/**
 * Replaces `memberAuthHook`. Verifies the JWT, confirms the user is still
 * active, and populates `request.user = { userId }`. The auth payload is
 * intentionally narrow — anything beyond `userId` (org / role / member)
 * is resolved per-request via the `scope/require-*` helpers.
 *
 * Forward-compat: legacy access tokens that still carry
 * `memberId / organizationId / role` continue to validate, because we only
 * read `sub` and `type`. The extra fields are ignored.
 */
export function userAuthHook(db: Database, jwtSecret: string) {
  const secret = new TextEncoder().encode(jwtSecret);

  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      throw new UnauthorizedError("Missing or invalid Authorization header", {
        "auth.failure_reason": "missing_authorization_header",
      });
    }

    const token = header.slice(7);

    let payload: { sub?: string; type?: string };
    try {
      const { payload: p } = await jwtVerify(token, secret);
      payload = p as typeof payload;
    } catch {
      throw new UnauthorizedError("Invalid or expired token", {
        "auth.failure_reason": "jwt_verify_failed",
      });
    }

    if (payload.type !== "access" || !payload.sub) {
      throw new UnauthorizedError("Invalid token type", {
        "auth.failure_reason": "wrong_token_type",
        "auth.token_type": String(payload.type ?? "<missing>"),
      });
    }

    const [user] = await db
      .select({ id: users.id, status: users.status })
      .from(users)
      .where(eq(users.id, payload.sub))
      .limit(1);

    if (!user) {
      throw new UnauthorizedError("User not found or suspended", {
        "auth.failure_reason": "user_not_found",
        "auth.user_id": payload.sub,
      });
    }
    if (user.status !== "active") {
      throw new UnauthorizedError("User not found or suspended", {
        "auth.failure_reason": "user_suspended",
        "auth.user_id": payload.sub,
        "auth.user_status": user.status,
      });
    }

    request.user = { userId: user.id };
  };
}
